// Short references for orders (docs/BUILD2.md section 4): `J-n` for a JCB order, `P-n` for a
// material order, numbered per agent in order of creation and stable for ever. Two append-only
// tables of their own inside the agent's ledger file (the ledger's own tables and hash chain are not
// touched): `refs` gives out the numbers, `ref_orders` ties a number to its order once. A held step
// takes its number before its order exists (`reserve`); the order is tied to it when the step runs.

/** @typedef {'J' | 'P'} RefKind */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refs (
     ref  TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('J', 'P')),
     n    INTEGER NOT NULL CHECK (n > 0),
     at   TEXT NOT NULL,
     UNIQUE (kind, n)
   )`,
  `CREATE TABLE IF NOT EXISTS ref_orders (
     ref      TEXT PRIMARY KEY REFERENCES refs (ref),
     order_id TEXT NOT NULL UNIQUE,
     at       TEXT NOT NULL
   )`,
  `CREATE TRIGGER IF NOT EXISTS refs_no_update BEFORE UPDATE ON refs
     BEGIN SELECT RAISE(ABORT, 'refs are never changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS refs_no_delete BEFORE DELETE ON refs
     BEGIN SELECT RAISE(ABORT, 'refs are never deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS ref_orders_no_update BEFORE UPDATE ON ref_orders
     BEGIN SELECT RAISE(ABORT, 'ref_orders are never changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS ref_orders_no_delete BEFORE DELETE ON ref_orders
     BEGIN SELECT RAISE(ABORT, 'ref_orders are never deleted'); END`,
];

/** @param {string} orderKind the ledger's order kind @returns {RefKind} */
export const refKind = (orderKind) => (orderKind === 'material' ? 'P' : 'J');

/**
 * A reference as a person may write it: "J-1", "j1", "P 12", "पी-3", "जे 2". Returns "J-1" style, or
 * null when it is not one.
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseRef(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(j|p|जे|पी)\s*-?\s*(\d{1,6})\s*$/iu.exec(text.normalize('NFC'));
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1) return null;
  const kind = /^(j|जे)$/iu.test(m[1]) ? 'J' : 'P';
  return `${kind}-${n}`;
}

/** @type {WeakMap<object, ReturnType<typeof create>>} */
const opened = new WeakMap();

/**
 * The references of one ledger. One instance per ledger, however many callers ask.
 * @param {import('./store.js').Ledger} ledger
 */
export function openRefs(ledger) {
  let r = opened.get(ledger.db);
  if (!r) {
    r = create(ledger);
    opened.set(ledger.db, r);
  }
  return r;
}

/** @param {import('./store.js').Ledger} ledger */
function create(ledger) {
  const db = ledger.db;
  for (const sql of SCHEMA) db.exec(sql);
  const q = {
    next: db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM refs WHERE kind = ?'),
    insertRef: db.prepare('INSERT INTO refs (ref, kind, n, at) VALUES (?, ?, ?, ?)'),
    bind: db.prepare('INSERT INTO ref_orders (ref, order_id, at) VALUES (?, ?, ?)'),
    tie: db.prepare('INSERT OR IGNORE INTO ref_orders (ref, order_id, at) VALUES (?, ?, ?)'),
    unnumbered: db.prepare(`SELECT o.order_id, o.kind, o.created_at FROM orders o LEFT JOIN ref_orders r ON r.order_id = o.order_id
                            WHERE r.order_id IS NULL ORDER BY o.created_at, o.order_id`),
    byOrder: db.prepare('SELECT ref FROM ref_orders WHERE order_id = ?'),
    byRef: db.prepare('SELECT order_id FROM ref_orders WHERE ref = ?'),
    known: db.prepare('SELECT ref FROM refs WHERE ref = ?'),
  };
  const nowIso = () => new Date().toISOString();

  /** @param {RefKind} kind @returns {string} */
  function take(kind) {
    const n = /** @type {{n: number}} */ (q.next.get(kind)).n;
    const ref = `${kind}-${n}`;
    q.insertRef.run(ref, kind, n, nowIso());
    return ref;
  }

  /** Gives every order without a reference the next one of its kind, oldest first. */
  function sync() {
    const missing = /** @type {{order_id: string, kind: string}[]} */ (q.unnumbered.all());
    if (missing.length === 0) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const o of missing) q.bind.run(take(refKind(o.kind)), o.order_id, nowIso());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    sync,
    /** @param {string} orderId @returns {string | null} */
    refOf(orderId) {
      sync();
      const r = /** @type {{ref: string} | undefined} */ (q.byOrder.get(orderId));
      return r ? r.ref : null;
    },
    /** @param {string} ref as written by a person @returns {string | null} the order, or null (unknown, or held and not run yet) */
    orderOfRef(ref) {
      const want = parseRef(ref);
      if (want === null) return null;
      sync();
      const r = /** @type {{order_id: string} | undefined} */ (q.byRef.get(want));
      return r ? r.order_id : null;
    },
    /** Does this reference exist at all (an order's, or one held for a step)? @param {string} ref */
    exists(ref) {
      const want = parseRef(ref);
      return want !== null && q.known.get(want) !== undefined;
    },
    /** The next reference of a kind, for an order that does not exist yet. @param {RefKind} kind */
    reserve(kind) {
      sync();
      return take(kind);
    },
    /**
     * Ties a reserved reference to its order, once; nothing happens when either is already tied.
     * Never numbers other orders first, so a held step's new order can be tied before anything else
     * gives it a number of its own.
     * @param {string} ref @param {string} orderId @returns {boolean} whether it was tied now
     */
    bind(ref, orderId) {
      return Number(q.tie.run(ref, orderId, nowIso()).changes) === 1;
    },
  };
}
