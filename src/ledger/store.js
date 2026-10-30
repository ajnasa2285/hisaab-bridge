// One agent's ledger (docs/CONTRACTS.md section 5): an append-only SQLite file. Every message
// sent or received and every local decision is one event; each event's hash covers the previous
// hash, so any later edit of history is detectable. Triggers refuse UPDATE and DELETE.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalize } from '../protocol/canonical.js';
import { refusedIds, step, emptyView } from './states.js';
import { evidenceMetadata } from '../protocol/evidence.js';

const GENESIS = '0'.repeat(64);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
     order_id     TEXT PRIMARY KEY,
     kind         TEXT NOT NULL CHECK (kind IN ('jcb_hours', 'material')),
     counterparty TEXT NOT NULL,
     site         TEXT NOT NULL,
     created_at   TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     seq       INTEGER PRIMARY KEY,
     order_id  TEXT NOT NULL REFERENCES orders (order_id),
     direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'local')),
     type      TEXT NOT NULL,
     msg_id    TEXT UNIQUE,
     body_json TEXT NOT NULL,
     at        TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash      TEXT NOT NULL UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS events_order ON events (order_id, seq)`,
  `CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
     BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
     BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS orders_no_update BEFORE UPDATE ON orders
     BEGIN SELECT RAISE(ABORT, 'orders are never changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders
     BEGIN SELECT RAISE(ABORT, 'orders are never deleted'); END`,
];

/**
 * @typedef {object} LedgerEvent
 * @property {number} seq
 * @property {string} orderId
 * @property {'in'|'out'|'local'} direction
 * @property {string} type
 * @property {string|null} msgId
 * @property {Record<string, any>} body     for messages: the whole signed message; for local events: their body
 * @property {string} at
 * @property {string} prevHash
 * @property {string} hash
 */

/**
 * @param {{seq: number, orderId: string, direction: string, type: string, msgId: string|null, body: unknown, at: string}} e
 * @param {string} prevHash
 * @returns {string}
 */
function eventHash(e, prevHash) {
  const content = canonicalize({ seq: e.seq, order_id: e.orderId, direction: e.direction, type: e.type, msg_id: e.msgId, body: e.body, at: e.at });
  return createHash('sha256').update(prevHash).update(content).digest('hex');
}

/** @param {any} r @returns {LedgerEvent} */
function toEvent(r) {
  return {
    seq: r.seq, orderId: r.order_id, direction: r.direction, type: r.type, msgId: r.msg_id,
    body: JSON.parse(r.body_json), at: r.at, prevHash: r.prev_hash, hash: r.hash,
  };
}

/**
 * For a message, the state machine sees the message's body; for a local event, its own body.
 * @param {LedgerEvent} e
 */
function stepEvent(e) {
  return { type: e.type, msg_id: e.msgId, body: e.direction === 'local' ? e.body : e.body.body };
}

/**
 * @param {string} file a path, or ':memory:' for tests
 */
export function openLedger(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of SCHEMA) db.exec(sql);

  const q = {
    insertOrder: db.prepare('INSERT OR IGNORE INTO orders (order_id, kind, counterparty, site, created_at) VALUES (?, ?, ?, ?, ?)'),
    order: db.prepare('SELECT * FROM orders WHERE order_id = ?'),
    orders: db.prepare('SELECT * FROM orders ORDER BY created_at, order_id'),
    head: db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1'),
    insertEvent: db.prepare('INSERT INTO events (seq, order_id, direction, type, msg_id, body_json, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    byOrder: db.prepare('SELECT * FROM events WHERE order_id = ? ORDER BY seq'),
    byMsg: db.prepare('SELECT * FROM events WHERE msg_id = ?'),
    all: db.prepare('SELECT * FROM events ORDER BY seq'),
  };

  /** @param {string} orderId */
  function events(orderId) {
    return q.byOrder.all(orderId).map(toEvent);
  }

  /** @param {string} orderId */
  function view(orderId) {
    const all = events(orderId);
    // A message we sent that the other side refused, or that expired undelivered, never happened for
    // either ledger: it stays in our history (with the refusal) but does not count in our state.
    const refused = refusedIds(all);
    let v = emptyView();
    for (const e of all) {
      if (e.direction === 'out' && refused.has(e.msgId)) continue;
      const next = step(v, stepEvent(e));
      if (next === null) throw new Error(`ledger: stored history of ${orderId} does not fit at seq ${e.seq}`);
      v = next;
    }
    return v;
  }

  return {
    db,

    /**
     * Registers an order once (the first message or decision about it). Identity never changes.
     * @param {{orderId: string, kind: 'jcb_hours'|'material', counterparty: string, site: string, at: string}} o
     */
    ensureOrder(o) {
      q.insertOrder.run(o.orderId, o.kind, o.counterparty, o.site, o.at);
      return q.order.get(o.orderId);
    },

    /** @param {string} orderId */
    order(orderId) {
      return q.order.get(orderId) ?? null;
    },

    orders() {
      return q.orders.all();
    },

    events,
    view,

    /**
     * Would this event fit the order's current state? (Checked before signing or accepting.)
     * @param {string} orderId
     * @param {{type: string, msg_id: string|null, body: Record<string, any>}} e as the state machine sees it
     */
    fits(orderId, e) {
      return step(view(orderId), e) !== null;
    },

    /**
     * Appends one event in a single transaction: state check, hash, insert. Returns the stored event,
     * or null when it does not fit the state (nothing written).
     * @param {{orderId: string, direction: 'in'|'out'|'local', type: string, msgId: string|null,
     *   body: Record<string, any>, at: string}} e
     * @returns {LedgerEvent|null}
     */
    append(e) {
      // This separately signed projection is the only EVIDENCE representation in history.
      // Projection also prevents arbitrary wire properties from retaining image payloads.
      if (e.type === 'EVIDENCE' && e.direction !== 'local' && e.body.body?.items) {
        e = { ...e, body: e.body.body.metadata_sig ? evidenceMetadata(e.body) : e.body };
        if (e.body.body.items.some((/** @type {any} */ i) => i.bytes !== undefined)) throw new Error('ledger: evidence bytes are private media');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (q.order.get(e.orderId) === undefined) throw new Error(`ledger: unknown order ${e.orderId}`);
        const probe = { type: e.type, msg_id: e.msgId, body: e.direction === 'local' ? e.body : e.body.body };
        if (step(view(e.orderId), probe) === null) {
          db.exec('ROLLBACK');
          return null;
        }
        const head = /** @type {{seq: number, hash: string}|undefined} */ (q.head.get());
        const seq = head ? head.seq + 1 : 1;
        const prevHash = head ? head.hash : GENESIS;
        const hash = eventHash({ ...e, seq }, prevHash);
        q.insertEvent.run(seq, e.orderId, e.direction, e.type, e.msgId, JSON.stringify(e.body), e.at, prevHash, hash);
        db.exec('COMMIT');
        return { seq, ...e, prevHash, hash };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** @param {string} msgId */
    hasMessage(msgId) {
      return q.byMsg.get(msgId) !== undefined;
    },

    /** @param {string} msgId @returns {LedgerEvent|null} */
    eventOfMessage(msgId) {
      const r = q.byMsg.get(msgId);
      return r === undefined ? null : toEvent(r);
    },

    /** @returns {string} hash of the last event, or the genesis hash */
    chainHead() {
      const head = /** @type {{hash: string}|undefined} */ (q.head.get());
      return head ? head.hash : GENESIS;
    },

    /**
     * Recomputes every hash from the start.
     * @returns {{ok: true, events: number} | {ok: false, brokenAt: number}}
     */
    verifyChain() {
      let prev = GENESIS;
      let n = 0;
      for (const r of q.all.all()) {
        const e = toEvent(r);
        if (e.prevHash !== prev || eventHash(e, prev) !== e.hash) return { ok: false, brokenAt: e.seq };
        prev = e.hash;
        n += 1;
      }
      return { ok: true, events: n };
    },

    close() {
      db.close();
    },
  };
}

/** @typedef {ReturnType<typeof openLedger>} Ledger */
