// Audit-only payment checks, after a ledger append. These never accept or reject a payment.
import { allocate, paymentSummary } from '../ledger/payments.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../ledger/store.js').LedgerEvent} Ev */
/** @param {Ev[]} events */
const counted = (events) => {
  const refused = new Set(events.filter((e) => e.direction === 'in' && e.type === 'REFUSE').map((e) => e.body.body?.refers_to));
  return events.filter((e) => !(e.direction === 'out' && refused.has(e.msgId)));
};

/**
 * `orders` contains only this order's counterparty. Group checks wait for all shares: an
 * in-flight group is not a failed check. Prefixes reconstruct what was due before allocation.
 * @param {Ev} event @param {{orderId: string, events: Ev[]}[]} orders
 * @returns {{title: string, detail: Record<string, any>, orderId: string}[]}
 */
export function paymentChecks(event, orders) {
  if (!['BILL', 'CORRECTION', 'PAYMENT_CLAIM', 'PAYMENT_RECEIVED', 'PAYMENT_ACK', 'SETTLED', 'REFUSE'].includes(event.type)) return [];
  const clean = orders.map((o) => ({ ...o, events: counted(o.events) }));
  const own = clean.find((o) => o.orderId === event.orderId);
  if (!own) return [];
  const s = paymentSummary(own.events);
  const balanced = s.billTotalPaise === null || (s.confirmedPaise + /** @type {number} */ (s.duePaise) - s.creditPaise === s.billTotalPaise);
  /** @type {{title: string, detail: Record<string, any>, orderId: string}[]} */
  const out = [{ title: t('trace.payment.balance'), orderId: event.orderId, detail: {
    name: 'payment_balance', pass: balanced, billTotalPaise: s.billTotalPaise, confirmedPaise: s.confirmedPaise,
    waitingPaise: s.waitingPaise, duePaise: s.duePaise, creditPaise: s.creditPaise,
  } }];
  const p = s.payments.find((x) => x.msgId === event.msgId);
  if (!p) return out;
  if (p.utr) {
    const previous = clean.flatMap((o) => paymentSummary(o.events.filter((e) => e.seq < event.seq)).payments)
      .filter((q) => q.utr === p.utr && !(p.group && q.group?.id === p.group.id));
    out.push({ title: t('trace.payment.utr'), orderId: event.orderId,
      detail: { name: 'payment_utr', pass: previous.length === 0, utr: p.utr, previous: previous.map((q) => q.msgId) } });
  }
  if (p.group) {
    const group = p.group;
    const members = group.orders.map((id) => {
      const o = clean.find((x) => x.orderId === id);
      return { orderId: id, events: o?.events ?? [], payments: o ? paymentSummary(o.events).payments.filter((q) => q.group?.id === group.id) : [] };
    });
    if (members.every((m) => m.payments.length > 0)) {
      const total = members.reduce((a, m) => a + m.payments.reduce((v, q) => v + q.amountPaise, 0), 0);
      const expected = allocate(group.totalPaise, members.map((m) => {
        const first = m.events.find((e) => e.msgId === m.payments[0].msgId);
        return { orderId: m.orderId, duePaise: paymentSummary(m.events.filter((e) => first && e.seq < first.seq)).duePaise };
      }));
      const coherent = members.every((m) => m.payments.length === 1 && m.payments[0].group?.totalPaise === group.totalPaise
        && JSON.stringify(m.payments[0].group?.orders) === JSON.stringify(group.orders));
      const allocationMatches = expected !== null && expected.length === members.length && members.every((m) => expected.some((x) => x.orderId === m.orderId && x.amountPaise === m.payments[0].amountPaise));
      out.push({ title: t('trace.payment.shares'), orderId: event.orderId, detail: {
        name: 'payment_shares', pass: coherent && total === group.totalPaise, group: group.id,
        totalPaise: group.totalPaise, sharesPaise: total, allocationMatches,
      } });
    }
  }
  return out;
}
