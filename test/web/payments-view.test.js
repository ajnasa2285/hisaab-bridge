import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentPanel, paymentMoney } from '../../web/payments-view.js';
import { TEXTS } from '../../web/texts.js';

/** @param {string} type @param {string} msgId @param {Record<string, any>} body @param {number} seq */
const ev = (type, msgId, body, seq) => ({ type, msgId, body: { body }, seq, orderId: 'o1', direction: /** @type {const} */ ('in'), at: '', hash: '', prevHash: '' });
const group = { id: 'group-1', totalPaise: 130000, orders: ['o1', 'o2'] };
const events = [
  ev('PAYMENT_RECEIVED', 'advance', { bill: null, method: 'cash', amountPaise: 20000, receivedOn: '2026-10-29' }, 1),
  ev('BILL', 'bill', { totalPaise: 100000 }, 2),
  ev('PAYMENT_CLAIM', 'cash', { bill: 'bill', method: 'cash', amountPaise: 10000 }, 3),
  ev('PAYMENT_ACK', 'ack', { payment: 'cash', received: true, amountPaise: 10000 }, 4),
  ev('PAYMENT_CLAIM', 'clubbed', { bill: 'bill', method: 'upi', amountPaise: 70000, utr: '000000000003', group }, 5),
  ev('PAYMENT_CLAIM', 'denied', { bill: 'bill', method: 'cash', amountPaise: 5000 }, 6),
  ev('PAYMENT_ACK', 'no', { payment: 'denied', received: false, amountPaise: 5000 }, 7),
];

test('payment rendering includes every method, advance, group reference, status and exact balance', () => {
  const p = paymentPanel(events, { o1: 'P-1', o2: 'P-2' }, TEXTS.hi);
  assert.deepEqual([p.summary.billTotalPaise, p.summary.confirmedPaise, p.summary.waitingPaise, p.summary.duePaise, p.summary.creditPaise], [100000, 30000, 70000, 70000, 0]);
  assert.match(p.rows[0].text, /₹200 · नकद · अग्रिम · पक्का/);
  assert.match(p.rows[1].text, /₹100 · नकद · बिल के लिए · पक्का/);
  assert.match(p.rows[2].text, /₹700 · UPI · बिल के लिए · हाँ का इंतज़ार/);
  assert.match(p.rows[3].text, /मिलने से इनकार/);
  assert.deepEqual(p.rows[2].group?.orders, [{ id: 'o1', ref: 'P-1' }, { id: 'o2', ref: 'P-2' }]);
  assert.equal(p.rows[2].group?.text, 'एक साथ कुल ₹1,300');
  assert.doesNotMatch(JSON.stringify(p), /—/);
  assert.match(p.balance, /बाक़ी ₹700/);
});

test('no bill is stated without a made-up due; credit is shown after a correction', () => {
  const advance = paymentPanel(events.slice(0, 1), {}, TEXTS.en);
  assert.match(advance.balance, /No bill yet/);
  assert.doesNotMatch(advance.balance, /Due/);
  const credit = paymentPanel([...events, ev('CORRECTION', 'correction', { totalPaise: 10000, replaces: 'bill' }, 8)], {}, TEXTS.en);
  assert.match(credit.balance, /Due ₹0 · Credit ₹200/);
  assert.equal(paymentMoney(12345678), '₹1,23,456.78');
});

test('refused outgoing payments do not enter balances or payment rows', () => {
  const outgoing = { ...events[4], direction: /** @type {const} */ ('out') };
  const p = paymentPanel([...events.slice(0, 4), outgoing, ev('REFUSE', 'refusal', { refers_to: 'clubbed' }, 6)], {}, TEXTS.hi);
  assert.equal(p.summary.waitingPaise, 0);
  assert.equal(p.rows.length, 2);
});
