// Display-only payment rows. Browser and agent use exactly the same balance function.
import { paymentSummary } from '../src/ledger/payments.js';

/** @typedef {import('../src/ledger/store.js').LedgerEvent} Ev */
/** @typedef {typeof import('./texts.js').TEXTS['hi']} Texts */

/** Sent messages refused by the other side or expired undelivered remain in history but do not count. @param {Ev[]} events */
export function countedEvents(events) {
  const refused = new Set(events.filter((e) => e.direction === 'in' && e.type === 'REFUSE').map((e) => e.body.body?.refers_to));
  for (const e of events) if (e.direction === 'local' && e.type === 'NOTE' && e.body?.kind === 'undelivered') refused.add(e.body.msg_id);
  return events.filter((e) => !(e.direction === 'out' && refused.has(e.msgId)));
}

/** @param {number} paise */
export function paymentMoney(paise) {
  const whole = String(Math.trunc(Math.abs(paise) / 100));
  const grouped = whole.length <= 3 ? whole : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  const cents = Math.abs(paise) % 100;
  return `${paise < 0 ? '-' : ''}₹${grouped}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

/**
 * Pure view data, escaped by the DOM's textContent in judge.js. Missing fields are omitted.
 * A group is displayed on every participating order, with local references and navigable ids.
 * @param {Ev[]} events @param {Record<string, string>} refs @param {Texts} t
 */
export function paymentPanel(events, refs, t) {
  const summary = paymentSummary(countedEvents(events));
  const balance = [
    ...(summary.billTotalPaise === null ? [t.payment_no_bill] : [`${t.bill} ${paymentMoney(summary.billTotalPaise)}`]),
    `${t.payment_confirmed} ${paymentMoney(summary.confirmedPaise)}`,
    `${t.payment_waiting} ${paymentMoney(summary.waitingPaise)}`,
    ...(summary.duePaise === null ? [] : [`${t.payment_due} ${paymentMoney(summary.duePaise)}`]),
    `${t.payment_credit} ${paymentMoney(summary.creditPaise)}`,
  ].join(' · ');
  const rows = summary.payments.map((p) => ({
    msgId: p.msgId, status: p.status,
    text: [paymentMoney(p.amountPaise), p.method === 'cash' ? t.payment_cash : 'UPI',
      p.advance ? t.payment_advance : t.payment_against_bill,
      t[`payment_${p.status}`], p.paidOn, p.paidAt, p.utr ? `UTR ${p.utr}` : null].filter(Boolean).join(' · '),
    group: p.group ? {
      id: p.group.id, text: `${t.payment_group} ${paymentMoney(p.group.totalPaise)}`,
      orders: p.group.orders.map((id) => ({ id, ref: refs[id] ?? id })),
    } : null,
  }));
  return { summary, balance, rows };
}
