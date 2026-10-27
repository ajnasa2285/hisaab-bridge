// The supervisor's request list (docs/CONTRACTS.md section 8). One append-only table of its own,
// request_events, inside the contractor's SQLite file; a request's status is never stored, it is
// replayed from its events. Above the approval limit (or when the value is unknown) the contractor
// decides; a supervisor never approves his own request. Triggers refuse UPDATE and DELETE.

import { DatabaseSync } from 'node:sqlite';

/**
 * @typedef {object} Request
 * @property {number} id
 * @property {string} site
 * @property {string} what
 * @property {'jcb'|'material'|'note'} kind
 * @property {number|null} qtyHundredths
 * @property {string|null} unit
 * @property {string|null} neededOn       YYYY-MM-DD
 * @property {'requested'|'approved'|'declined'|'sent'|'done'} status
 * @property {string|null} approvedBy
 * @property {string|null} orderId
 * @property {string} by                  who asked (needed for "never approves his own")
 * @property {number|null} estimatePaise  estimated value, null when nobody gave one
 */

/** @typedef {DatabaseSync | {db: DatabaseSync}} Db a database, or a ledger that carries one */

const KINDS = new Set(['jcb', 'material', 'note']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 200;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS request_events (
     seq        INTEGER PRIMARY KEY,
     request_id INTEGER NOT NULL,
     type       TEXT NOT NULL CHECK (type IN ('REQUESTED', 'APPROVED', 'DECLINED', 'SENT', 'DONE')),
     actor      TEXT NOT NULL,
     body_json  TEXT NOT NULL,
     at         TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS request_events_request ON request_events (request_id, seq)`,
  `CREATE TRIGGER IF NOT EXISTS request_events_no_update BEFORE UPDATE ON request_events
     BEGIN SELECT RAISE(ABORT, 'request_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS request_events_no_delete BEFORE DELETE ON request_events
     BEGIN SELECT RAISE(ABORT, 'request_events are append-only'); END`,
];

export class RequestError extends Error {
  /**
   * @param {'BAD_INPUT'|'NOT_FOUND'|'OWN_REQUEST'|'WRONG_STATE'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

/** @type {WeakMap<DatabaseSync, ReturnType<typeof prepare>>} */
const prepared = new WeakMap();

/** @param {DatabaseSync} db */
function prepare(db) {
  for (const sql of SCHEMA) db.exec(sql);
  return {
    nextId: db.prepare('SELECT COALESCE(MAX(request_id), 0) + 1 AS id FROM request_events'),
    insert: db.prepare('INSERT INTO request_events (request_id, type, actor, body_json, at) VALUES (?, ?, ?, ?, ?)'),
    byRequest: db.prepare('SELECT * FROM request_events WHERE request_id = ? ORDER BY seq'),
    all: db.prepare('SELECT * FROM request_events ORDER BY seq'),
  };
}

/** @param {Db} db */
function stmts(db) {
  const sqlite = db instanceof DatabaseSync ? db : db.db;
  let q = prepared.get(sqlite);
  if (!q) {
    q = prepare(sqlite);
    prepared.set(sqlite, q);
  }
  return { sqlite, q };
}

/**
 * The approval limit in paise, from the environment. Unset or unreadable means 0: every request
 * with a value goes to the contractor until the owner sets a limit.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function approvalLimitPaise(env = process.env) {
  const n = Number(env.CONTRACTOR_APPROVAL_LIMIT_PAISE);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Replays one request's events into its current shape.
 * @param {any[]} rows request_events rows in sequence
 * @returns {Request|null}
 */
function fold(rows) {
  /** @type {Request|null} */
  let r = null;
  for (const row of rows) {
    const body = JSON.parse(row.body_json);
    switch (row.type) {
      case 'REQUESTED':
        r = {
          id: row.request_id, site: body.site, what: body.what, kind: body.kind, qtyHundredths: body.qtyHundredths,
          unit: body.unit, neededOn: body.neededOn, status: body.approval === 'within_limit' ? 'approved' : 'requested',
          approvedBy: null, orderId: null, by: row.actor, estimatePaise: body.estimatePaise,
        };
        break;
      case 'APPROVED':
        if (r) r = Object.assign({}, r, { status: 'approved', approvedBy: row.actor });
        break;
      case 'DECLINED':
        if (r) r = Object.assign({}, r, { status: 'declined' });
        break;
      case 'SENT':
        if (r) r = Object.assign({}, r, { status: 'sent', orderId: body.orderId });
        break;
      case 'DONE':
        if (r) r = Object.assign({}, r, { status: 'done' });
        break;
      default:
        throw new Error(`requests: unknown event type ${row.type}`);
    }
  }
  return r;
}

/** @param {Db} db @param {number} id */
function load(db, id) {
  const { q } = stmts(db);
  const r = Number.isSafeInteger(id) && id > 0 ? fold(q.byRequest.all(id)) : null;
  if (r === null) throw new RequestError('NOT_FOUND', `request #${id} not found`);
  return r;
}

/** @param {unknown} s @param {string} what @returns {string} */
function requireText(s, what) {
  if (typeof s !== 'string' || s.trim().length === 0 || s.length > MAX_TEXT) throw new RequestError('BAD_INPUT', `${what} must be a short non-empty text`);
  return s.trim();
}

/** @param {string} [at] */
const stamp = (at) => at ?? new Date().toISOString();

/**
 * Records a supervisor's request. Below or at the approval limit it is approved at once (no one's
 * name on it); above the limit, or when the estimated value is unknown, it waits for the
 * contractor's decision. Returns the request as stored.
 * @param {Db} db
 * @param {{site: string, what: string, kind: 'jcb'|'material'|'note', qtyHundredths?: number|null,
 *   unit?: string|null, neededOn?: string|null, by: string, estimatePaise?: number|null,
 *   limitPaise?: number, at?: string}} r
 * @returns {Request}
 */
export function addRequest(db, r) {
  const site = requireText(r.site, 'site');
  const what = requireText(r.what, 'what');
  const by = requireText(r.by, 'by');
  if (!KINDS.has(r.kind)) throw new RequestError('BAD_INPUT', 'kind must be jcb, material or note');
  const qtyHundredths = r.qtyHundredths ?? null;
  const unit = r.unit ?? null;
  if (qtyHundredths !== null && !(Number.isSafeInteger(qtyHundredths) && qtyHundredths > 0)) throw new RequestError('BAD_INPUT', 'qtyHundredths must be a positive integer or null');
  if (unit !== null) requireText(unit, 'unit');
  if (qtyHundredths !== null && unit === null) throw new RequestError('BAD_INPUT', 'a quantity needs a unit');
  const neededOn = r.neededOn ?? null;
  if (neededOn !== null && !(DAY_RE.test(neededOn) && !Number.isNaN(Date.parse(`${neededOn}T00:00:00Z`)))) throw new RequestError('BAD_INPUT', 'neededOn must be YYYY-MM-DD or null');
  const estimatePaise = r.estimatePaise ?? null;
  if (estimatePaise !== null && !(Number.isSafeInteger(estimatePaise) && estimatePaise >= 0)) throw new RequestError('BAD_INPUT', 'estimatePaise must be a non-negative integer or null');
  const limitPaise = r.limitPaise ?? approvalLimitPaise();
  if (!(Number.isSafeInteger(limitPaise) && limitPaise >= 0)) throw new RequestError('BAD_INPUT', 'limitPaise must be a non-negative integer');
  // Never guess: an unknown value is treated as above the limit.
  const approval = estimatePaise !== null && estimatePaise <= limitPaise ? 'within_limit' : 'contractor';

  const { sqlite, q } = stmts(db);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const id = /** @type {{id: number}} */ (q.nextId.get()).id;
    const body = { site, what, kind: r.kind, qtyHundredths, unit, neededOn, estimatePaise, approval, limitPaise };
    q.insert.run(id, 'REQUESTED', by, JSON.stringify(body), stamp(r.at));
    sqlite.exec('COMMIT');
    return load(db, id);
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Current state of every request, oldest first; filtered by site and/or requester when given.
 * @param {Db} db
 * @param {{site?: string, by?: string}} [f]
 * @returns {Request[]}
 */
export function listRequests(db, f = {}) {
  const { q } = stmts(db);
  /** @type {Map<number, any[]>} */
  const byId = new Map();
  for (const row of q.all.all()) {
    const rows = byId.get(/** @type {number} */ (row.request_id)) ?? [];
    rows.push(row);
    byId.set(/** @type {number} */ (row.request_id), rows);
  }
  /** @type {Request[]} */
  const out = [];
  for (const rows of byId.values()) {
    const r = fold(rows);
    if (r && (f.site === undefined || r.site === f.site) && (f.by === undefined || r.by === f.by)) out.push(r);
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The contractor's decision on a waiting request. Refused when the request is not waiting, or
 * when the decider is the one who asked. The caller checks that `by` may decide at all (role).
 * @param {Db} db
 * @param {{id: number, approve: boolean, by: string, at?: string}} d
 * @returns {Request}
 */
export function decideRequest(db, d) {
  const by = requireText(d.by, 'by');
  if (typeof d.approve !== 'boolean') throw new RequestError('BAD_INPUT', 'approve must be true or false');
  const { sqlite, q } = stmts(db);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const r = load(db, d.id);
    if (r.status !== 'requested') throw new RequestError('WRONG_STATE', `request #${r.id} is ${r.status}, not waiting`);
    if (r.by === by) throw new RequestError('OWN_REQUEST', `request #${r.id}: a supervisor never approves his own request`);
    q.insert.run(r.id, d.approve ? 'APPROVED' : 'DECLINED', by, '{}', stamp(d.at));
    sqlite.exec('COMMIT');
    return load(db, r.id);
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * After the decision: approved -> sent (with the order it became) -> done. Each step is one event.
 * @param {Db} db
 * @param {{id: number, status: 'sent'|'done', orderId?: string, by: string, at?: string}} s
 * @returns {Request}
 */
export function advanceRequest(db, s) {
  const by = requireText(s.by, 'by');
  const { sqlite, q } = stmts(db);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const r = load(db, s.id);
    if (s.status === 'sent') {
      if (r.status !== 'approved') throw new RequestError('WRONG_STATE', `request #${r.id} is ${r.status}, not approved`);
      const orderId = requireText(s.orderId, 'orderId');
      q.insert.run(r.id, 'SENT', by, JSON.stringify({ orderId }), stamp(s.at));
    } else if (s.status === 'done') {
      if (r.status !== 'sent') throw new RequestError('WRONG_STATE', `request #${r.id} is ${r.status}, not sent`);
      q.insert.run(r.id, 'DONE', by, '{}', stamp(s.at));
    } else {
      throw new RequestError('BAD_INPUT', 'status must be sent or done');
    }
    sqlite.exec('COMMIT');
    return load(db, r.id);
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The full history of one request, oldest first (for the judge page and explanations).
 * @param {Db} db
 * @param {number} id
 * @returns {{seq: number, type: string, by: string, body: Record<string, any>, at: string}[]}
 */
export function requestHistory(db, id) {
  const { q } = stmts(db);
  return q.byRequest.all(id).map((row) => ({
    seq: /** @type {number} */ (row.seq), type: /** @type {string} */ (row.type), by: /** @type {string} */ (row.actor),
    body: JSON.parse(/** @type {string} */ (row.body_json)), at: /** @type {string} */ (row.at),
  }));
}
