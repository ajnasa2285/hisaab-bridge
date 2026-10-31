// Read-only payment text for status and missed-window lists. The summary owns every balance.
import { paymentSummary } from '../ledger/payments.js';
import { openRefs } from '../ledger/refs.js';
import { refusedIds } from '../ledger/states.js';
import { rupees, day as dayName } from '../i18n/format.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {import('../ledger/payments.js').Payment} Payment */

/** Refused outgoing records remain history, but never figures. @param {LedgerEvent[]} events */
export function paymentEvents(events) {
  const refused = refusedIds(events);
  return events.filter((e) => !(e.direction === 'out' && refused.has(e.msgId)));
}

/** @param {import('../ledger/payments.js').PaymentSummary} s */
export function balanceText(s) {
  return t(s.billTotalPaise === null ? 'payview.balance_before_bill' : 'payview.balance', {
    billed: s.billTotalPaise === null ? '' : rupees(s.billTotalPaise),
    confirmed: rupees(s.confirmedPaise), waiting: rupees(s.waitingPaise),
    due: s.duePaise === null ? '' : rupees(s.duePaise), credit: rupees(s.creditPaise),
  });
}

/** @param {Ledger} ledger @param {string} orderId */
export const orderBalanceText = (ledger, orderId) => balanceText(paymentSummary(paymentEvents(ledger.events(orderId))));

/** @param {Payment} p */
function details(p) {
  return [t(`payview.method.${p.method}`), ...(p.advance ? [t('payview.advance')] : []),
    ...(p.paidOn ? [dayName(p.paidOn)] : []), ...(p.paidAt ? [p.paidAt] : []),
    ...(p.utr ? [t('payview.utr', { utr: p.utr })] : [])].join(', ');
}

/** @param {Ledger} ledger @param {string} orderId */
export function orderPaymentText(ledger, orderId) {
  const s = paymentSummary(paymentEvents(ledger.events(orderId)));
  const refs = openRefs(ledger);
  return [balanceText(s), ...s.payments.filter((p) => p.status === 'waiting').map((p) => {
    const group = p.group ? t('payview.group', {
      refs: p.group.orders.map((id) => refs.refOf(id)).filter(Boolean).join(', '), total: rupees(p.group.totalPaise),
    }) : '';
    return t('payview.waiting_share', { amount: rupees(p.amountPaise), details: details(p), group });
  })].join('\n');
}

/**
 * A group is one waiting item, even before a bill or after some of its claims have been answered.
 * `ref` is its first reference; `refs` lets missed-window replay match any member's old notice.
 * @param {Ledger} ledger
 * @returns {{key: string, params: Record<string, string | number>}[]}
 */
export function paymentWaiting(ledger) {
  const refs = openRefs(ledger);
  /** @type {Map<string, {payment: Payment, refs: string[], shares: string[], waiting: number}>} */
  const groups = new Map();
  for (const order of /** @type {{order_id: string, counterparty: string}[]} */ (ledger.orders())) {
    const s = paymentSummary(paymentEvents(ledger.events(order.order_id)));
    for (const p of s.payments.filter((p) => p.status === 'waiting')) {
      const key = `${order.counterparty}\0${p.group ? `group:${p.group.id}` : `claim:${p.msgId}`}`;
      let g = groups.get(key);
      if (!g) {
        g = { payment: p, refs: (p.group?.orders ?? [order.order_id]).map((id) => refs.refOf(id)).filter((r) => r !== null), shares: [], waiting: 0 };
        groups.set(key, g);
      }
      const ref = refs.refOf(order.order_id);
      if (ref) g.shares.push(t('payview.share', { ref, amount: rupees(p.amountPaise) }));
      g.waiting += p.amountPaise;
    }
  }
  return [...groups.values()].map((g) => ({ key: 'payview.waiting', params: {
    ref: g.refs[0] ?? '', refs: g.refs.join(', '), amount: rupees(g.waiting),
    details: details(g.payment), shares: g.shares.join(', '),
    group: g.payment.group ? t('payview.group_total', { total: rupees(g.payment.group.totalPaise) }) : '',
  } }));
}

/**
 * Rebuild only previously missed notices. One group can have missed notices under several refs;
 * send its current text once. The old UPI keys and the recording side's pay.seller.* notices both match.
 * `also`: other keys of the same question on that reference. A bill's key can change after it was
 * missed (a correction replaced it; the "usual" line came or went), and the bill in force is what is told.
 * @template {{key: string, params: Record<string, string | number>, also?: RegExp}} N
 * @param {{ref: string, key: string}[]} missed
 * @param {N[]} open
 * @returns {N[]}
 */
export function missedWaiting(missed, open) {
  return open.filter((n) => missed.some((m) =>
    (n.params.ref === m.ref && (n.key === m.key || n.also?.test(m.key))) ||
    (n.key === 'payview.waiting' && /^(?:(?:jcb|supplier)\.payment_claimed(?:_at)?|pay\.seller\.(?:group_)?claimed(?:_advance)?|payview\.waiting)$/u.test(m.key)
      && String(n.params.refs).split(', ').includes(m.ref))));
}
