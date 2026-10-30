// Payments on one order and its balance (docs/CONTRACTS.md section 4.1), pure. Every agent, the
// judge page and ask-anything read payments through here, so both sides always agree on what is
// due. Nothing here writes; amounts are integer paise.

/** @typedef {import('./store.js').LedgerEvent} LedgerEvent */
/**
 * @typedef {{msgId: string, from: 'buyer' | 'seller', kind: 'claim' | 'received', method: 'upi' | 'cash',
 *   amountPaise: number, bill: string | null, advance: boolean, paidOn: string | null, paidAt: string | null,
 *   utr: string | null, screenshot: string | null, group: {id: string, totalPaise: number, orders: string[]} | null,
 *   status: 'waiting' | 'confirmed' | 'denied'}} Payment
 */
/**
 * @typedef {{billTotalPaise: number | null, payments: Payment[], confirmedPaise: number, waitingPaise: number,
 *   pending: string[], duePaise: number | null, creditPaise: number, settled: boolean}} PaymentSummary
 */

/** The message body of a ledger event: a signed message's own body, or a local entry's. @param {LedgerEvent} e */
const bodyOf = (e) => (e.direction === 'local' ? e.body : e.body?.body ?? {}) ?? {};
/** @param {unknown} v */
const posInt = (v) => Number.isInteger(v) && /** @type {number} */ (v) > 0;
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/** @param {any} g */
function groupOf(g) {
  if (!g || typeof g !== 'object' || !str(g.id) || !posInt(g.totalPaise) || !Array.isArray(g.orders)) return null;
  return { id: g.id, totalPaise: g.totalPaise, orders: g.orders.filter((/** @type {unknown} */ o) => typeof o === 'string') };
}

/**
 * Messages of ours that never happened for the order, as in the ledger's own view (refusedIds in
 * src/ledger/states.js; a copy, because this file is also served to the browser alone).
 * @param {LedgerEvent[]} events
 */
function refusedOf(events) {
  const ids = new Set();
  for (const e of events) {
    if (e.direction === 'in' && e.type === 'REFUSE') ids.add(e.body?.body?.refers_to);
    else if (e.direction === 'local' && e.type === 'NOTE' && e.body?.kind === 'undelivered') ids.add(e.body.msg_id);
  }
  return ids;
}

/**
 * Every payment on an order and the balance, from the order's events in sequence. A message of ours
 * that the other side refused, or that was noted undelivered, does not count.
 * @param {LedgerEvent[]} events
 * @returns {PaymentSummary}
 */
export function paymentSummary(events) {
  const refused = refusedOf(events);
  /** @type {Map<string, number>} bill or correction msg_id → its total */
  const totals = new Map();
  /** @type {string | null} */
  let currentBill = null;
  /** @type {Payment[]} */
  const payments = [];
  /** @type {Map<string, Payment>} */
  const byId = new Map();
  let settled = false;
  for (const e of events) {
    if (e.direction === 'out' && refused.has(e.msgId)) continue;
    const b = bodyOf(e);
    if ((e.type === 'BILL' || e.type === 'CORRECTION') && e.msgId && posInt(b.totalPaise)) {
      totals.set(e.msgId, b.totalPaise);
      currentBill = e.msgId;
    } else if ((e.type === 'PAYMENT_CLAIM' || e.type === 'PAYMENT_RECEIVED') && e.msgId && posInt(b.amountPaise)) {
      const received = e.type === 'PAYMENT_RECEIVED';
      /** @type {Payment} */
      const p = {
        msgId: e.msgId, from: received ? 'seller' : 'buyer', kind: received ? 'received' : 'claim',
        method: b.method === 'cash' ? 'cash' : 'upi', amountPaise: b.amountPaise,
        bill: str(b.bill), advance: !str(b.bill),
        paidOn: str(received ? b.receivedOn : b.paidOn), paidAt: str(b.paidAt), utr: str(b.utr),
        screenshot: str(b.screenshot?.sha256), group: groupOf(b.group),
        status: received ? 'confirmed' : 'waiting',
      };
      payments.push(p);
      byId.set(p.msgId, p);
    } else if (e.type === 'PAYMENT_ACK') {
      const p = byId.get(b.payment);
      if (p && p.kind === 'claim' && p.status === 'waiting') p.status = b.received === true ? 'confirmed' : 'denied';
    } else if (e.type === 'SETTLED') {
      // The old form names the one claim it settles; the new form lists every payment it counted.
      const named = Array.isArray(b.payments) ? b.payments : [b.payment];
      for (const id of named) {
        const p = byId.get(id);
        if (p && p.status === 'waiting') p.status = 'confirmed';
      }
      settled = true;
    }
  }
  const sum = (/** @type {Payment['status']} */ s) => payments.filter((p) => p.status === s).reduce((a, p) => a + p.amountPaise, 0);
  const confirmedPaise = sum('confirmed');
  const billTotalPaise = currentBill === null ? null : /** @type {number} */ (totals.get(currentBill));
  return {
    billTotalPaise, payments, confirmedPaise, waitingPaise: sum('waiting'),
    pending: payments.filter((p) => p.status === 'waiting').map((p) => p.msgId),
    duePaise: billTotalPaise === null ? null : Math.max(billTotalPaise - confirmedPaise, 0),
    creditPaise: billTotalPaise === null ? 0 : Math.max(confirmedPaise - billTotalPaise, 0),
    settled,
  };
}

/**
 * Shares one payment among orders, in the given order (CONTRACTS 4.1, "one payment for several
 * orders"): each order takes what is due on it, up to what is left; what is left over goes to the
 * last order (an advance when it has no bill yet, else a credit). Code's split, never the model's.
 * @param {number} totalPaise
 * @param {{orderId: string, duePaise: number | null}[]} orders in allocation order; `duePaise` null = no bill yet
 * @returns {{orderId: string, amountPaise: number}[] | null} shares adding up to totalPaise exactly; null when it cannot be split
 */
export function allocate(totalPaise, orders) {
  if (!posInt(totalPaise) || orders.length === 0) return null;
  let left = totalPaise;
  /** @type {{orderId: string, amountPaise: number}[]} */
  const shares = orders.map((o) => {
    const take = Math.min(Math.max(o.duePaise ?? 0, 0), left);
    left -= take;
    return { orderId: o.orderId, amountPaise: take };
  });
  shares[shares.length - 1].amountPaise += left;
  // A share of nothing is no payment: an order that takes nothing is left out of the group.
  const out = shares.filter((s) => s.amountPaise > 0);
  return out.length ? out : null;
}
