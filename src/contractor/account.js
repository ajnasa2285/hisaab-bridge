// The site account (docs/CONTRACTS.md section 8): a pure reading of the contractor's ledger for
// one site. Nothing is written, nothing is invented: every figure comes from a stored message.
// Hours and amounts come from the bill in force of each order; materials from signed deliveries;
// paid only from SETTLED (a claim or a screenshot settles nothing by itself). A value the ledger
// does not hold is null here and "—" in the text.

import { DatabaseSync } from 'node:sqlite';
import { emptyView, step } from '../ledger/states.js';
import { t } from '../i18n/index.js';
import { rupees, hours, qty, orNone, NONE } from '../i18n/format.js';

/**
 * @typedef {object} AccountLine
 * @property {string} orderId
 * @property {'jcb_hours'|'material'} kind
 * @property {string} what
 * @property {number|null} amountPaise   total of the bill in force; null before any bill
 * @property {string} state
 * @property {number} evidenceCount      local evidence + evidence named in the bill in force + the delivery challan
 */

/**
 * @typedef {object} SiteAccount
 * @property {string} site
 * @property {number} jcbHoursTenths
 * @property {boolean} jcbBilled          false when no JCB order has a bill yet (hours unknown, not 0)
 * @property {{name: string, qtyHundredths: number, unit: string}[]} materials
 * @property {number} billedPaise
 * @property {number} paidPaise
 * @property {number} pendingPaise
 * @property {number} openDisputes
 * @property {AccountLine[]} lines
 */

/** @param {DatabaseSync | {db: DatabaseSync}} db */
function sqliteOf(db) {
  return db instanceof DatabaseSync ? db : db.db;
}

/** @param {DatabaseSync} sqlite */
function hasLedgerTables(sqlite) {
  const n = /** @type {{n: number}} */ (sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('orders', 'events')").get()).n;
  return n === 2;
}

/**
 * @param {DatabaseSync | {db: DatabaseSync}} db the contractor's ledger
 * @param {{site: string}} o
 * @returns {SiteAccount}
 */
export function siteAccount(db, { site }) {
  if (typeof site !== 'string' || site.length === 0) throw new TypeError('siteAccount: site must be a non-empty string');
  const sqlite = sqliteOf(db);
  /** @type {SiteAccount} */
  const acc = { site, jcbHoursTenths: 0, jcbBilled: false, materials: [], billedPaise: 0, paidPaise: 0, pendingPaise: 0, openDisputes: 0, lines: [] };
  if (!hasLedgerTables(sqlite)) return acc;

  const orders = sqlite.prepare('SELECT order_id, kind FROM orders WHERE site = ? ORDER BY created_at, order_id').all(site);
  const eventsOf = sqlite.prepare('SELECT direction, type, msg_id, body_json FROM events WHERE order_id = ? ORDER BY seq');
  /** @type {Map<string, {name: string, qtyHundredths: number, unit: string}>} */
  const materials = new Map();

  for (const o of orders) {
    const orderId = /** @type {string} */ (o.order_id);
    const kind = /** @type {'jcb_hours'|'material'} */ (o.kind);
    let view = emptyView();
    let evidenceCount = 0;
    /** @type {Record<string, any>|null} */
    let billInForce = null;
    /** @type {string[]} */
    let requested = [];
    let settledPaise = 0;

    for (const row of eventsOf.all(orderId)) {
      const stored = JSON.parse(/** @type {string} */ (row.body_json));
      const body = row.direction === 'local' ? stored : stored.body ?? {};
      const next = step(view, { type: /** @type {string} */ (row.type), msg_id: /** @type {string|null} */ (row.msg_id), body });
      if (next === null) throw new Error(`siteAccount: stored history of ${orderId} does not fit at ${row.type}`);
      view = next;
      switch (row.type) {
        case 'EVIDENCE':
          evidenceCount += 1;
          break;
        case 'BOOKING_REQUEST':
          requested = kind === 'jcb_hours' ? ['JCB'] : (body.items ?? []).map((/** @type {any} */ it) => String(it.name));
          break;
        case 'DELIVERY':
          evidenceCount += 1;
          for (const it of body.items ?? []) {
            if (!Number.isSafeInteger(it.qtyHundredths)) continue;
            const key = `${it.name}\u0000${it.unit}`;
            const cur = materials.get(key) ?? { name: String(it.name), qtyHundredths: 0, unit: String(it.unit) };
            cur.qtyHundredths += it.qtyHundredths;
            materials.set(key, cur);
          }
          break;
        case 'BILL':
        case 'CORRECTION':
          if (row.msg_id === view.currentBill) billInForce = body;
          break;
        case 'SETTLED':
          if (Number.isSafeInteger(body.amountPaise)) settledPaise += body.amountPaise;
          break;
        default:
          break;
      }
    }

    /** @type {number|null} */
    let amountPaise = null;
    let what = requested.join(', ') || t(kind === 'jcb_hours' ? 'kind.jcb' : 'kind.material');
    if (billInForce !== null) {
      const lines = Array.isArray(billInForce.lines) ? billInForce.lines : [];
      amountPaise = Number.isSafeInteger(billInForce.totalPaise) ? billInForce.totalPaise : null;
      evidenceCount += Array.isArray(billInForce.evidence) ? billInForce.evidence.length : 0;
      const whats = lines.map((/** @type {any} */ l) => String(l.what)).filter((/** @type {string} */ w) => w.length > 0);
      if (whats.length > 0) what = [...new Set(whats)].join(', ');
      if (kind === 'jcb_hours') {
        acc.jcbBilled = true;
        for (const l of lines) if (Number.isSafeInteger(l.hoursTenths)) acc.jcbHoursTenths += l.hoursTenths;
      }
      if (amountPaise !== null) acc.billedPaise += amountPaise;
    }
    acc.paidPaise += settledPaise;
    if (view.state === 'disputed') acc.openDisputes += 1;
    acc.lines.push({ orderId, kind, what, amountPaise, state: view.state, evidenceCount });
  }

  acc.materials = [...materials.values()];
  acc.pendingPaise = acc.billedPaise - acc.paidPaise;
  return acc;
}

/**
 * The account as the contractor reads it on the phone. A value the ledger does not hold is "—".
 * @param {SiteAccount} a
 * @returns {string}
 */
export function accountText(a) {
  if (a.lines.length === 0) return t('account.empty', { site: a.site });
  const anyBill = a.lines.some((l) => l.amountPaise !== null);
  const summary = t('account.summary', {
    site: a.site,
    hours: a.jcbBilled ? hours(a.jcbHoursTenths) : NONE,
    materials: a.materials.length === 0 ? NONE : a.materials.map((m) => t('account.material', { name: m.name, qty: qty(m.qtyHundredths, m.unit) })).join(', '),
    billed: anyBill ? rupees(a.billedPaise) : NONE,
    paid: a.paidPaise > 0 ? rupees(a.paidPaise) : NONE,
    pending: anyBill ? rupees(a.pendingPaise) : NONE,
    disputes: a.openDisputes,
  });
  const lines = a.lines.map((l) => t('account.line', {
    what: l.what, amount: orNone(l.amountPaise, rupees), state: t(`state.${l.state}`), evidence: l.evidenceCount,
  }));
  return [summary, ...lines].join('\n');
}
