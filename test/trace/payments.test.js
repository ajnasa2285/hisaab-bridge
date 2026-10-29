import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentChecks } from '../../src/trace/payments.js';
import { traceLedger, traceReader } from '../../src/trace/hooks.js';
import { openTrace } from '../../src/trace/trace.js';

/** @param {number} seq @param {string} orderId @param {string} type @param {string} msgId @param {Record<string, any>} body */
const ev = (seq, orderId, type, msgId, body) => ({ seq, orderId, type, msgId, body: { body }, direction: /** @type {const} */ ('in'), at: '', hash: '', prevHash: '' });
const group = { id: 'group-1', totalPaise: 130000, orders: ['o1', 'o2'] };
const b1 = ev(1, 'o1', 'BILL', 'b1', { totalPaise: 70000 });
const b2 = ev(2, 'o2', 'BILL', 'b2', { totalPaise: 80000 });
const p1 = ev(3, 'o1', 'PAYMENT_CLAIM', 'p1', { bill: 'b1', amountPaise: 70000, method: 'upi', utr: '000000000003', group });
const p2 = ev(4, 'o2', 'PAYMENT_CLAIM', 'p2', { bill: 'b2', amountPaise: 60000, method: 'upi', utr: '000000000003', group });

test('group shares checked only once complete; same-group UTR is allowed and allocation agrees', () => {
  const first = paymentChecks(p1, [{ orderId: 'o1', events: [b1, p1] }, { orderId: 'o2', events: [b2] }]);
  assert.equal(first.find((x) => x.detail.name === 'payment_shares'), undefined);
  const all = paymentChecks(p2, [{ orderId: 'o1', events: [b1, p1] }, { orderId: 'o2', events: [b2, p2] }]);
  assert.equal(all.find((x) => x.detail.name === 'payment_utr')?.detail.pass, true);
  const share = all.find((x) => x.detail.name === 'payment_shares');
  assert.deepEqual([share?.detail.pass, share?.detail.sharesPaise, share?.detail.allocationMatches], [true, 130000, true]);
  const balance = all.find((x) => x.detail.name === 'payment_balance');
  assert.deepEqual([balance?.detail.confirmedPaise, balance?.detail.waitingPaise, balance?.detail.duePaise], [0, 60000, 80000]);
});

test('wrong group total, duplicate shares and reuse by another payment fail audit checks', () => {
  const bad = { ...p2, body: { body: { ...p2.body.body, amountPaise: 50000 } } };
  const rows = [{ orderId: 'o1', events: [b1, p1] }, { orderId: 'o2', events: [b2, bad] }];
  assert.equal(paymentChecks(bad, rows).find((x) => x.detail.name === 'payment_shares')?.detail.pass, false);
  const reused = ev(5, 'o2', 'PAYMENT_CLAIM', 'again', { bill: 'b2', amountPaise: 10000, utr: '000000000003' });
  rows[1].events.push(reused);
  assert.equal(paymentChecks(reused, rows).find((x) => x.detail.name === 'payment_utr')?.detail.pass, false);
});

test('ledger trace hook records a balance after append and never changes its return', () => {
  const rec = openTrace({ agent: 'supplier' });
  /** @type {any} */
  const ledger = { append: () => b1, ensureOrder: () => {}, order: () => ({ counterparty: 'buyer' }),
    orders: () => [{ order_id: 'o1', counterparty: 'buyer' }], events: () => [b1] };
  try {
    traceLedger(ledger, rec);
    assert.equal(ledger.append({}), b1);
    assert.equal(rec.list().find((x) => x.detail.name === 'payment_balance')?.detail.pass, true);
    rec.close();
    assert.equal(ledger.append({}), b1);
  } finally { rec.close(); }
});

test('cash receipt trace keeps safe figures, never names, references, raw text or image bytes', async () => {
  const rec = openTrace({ agent: 'site' });
  const result = { ok: true, kind: 'cash_receipt', amountPaise: 25000, date: '2026-10-29', receiverMark: true,
    clear: true, receiverName: 'invented private name', reference: 'private serial', amountRaw: 'raw private text', model: 'muse-spark-1.3', latencyMs: 100 };
  const read = traceReader('cash_receipt', async () => result, rec);
  try {
    assert.equal(await read?.({ bytes: new Uint8Array([1, 2]) }), result);
    const rows = rec.list();
    assert.equal(rows[0].detail.amountPaise, 25000);
    assert.equal(rows[0].detail.receiverMark, true);
    assert.doesNotMatch(JSON.stringify(rows), /private|bytes|amountRaw|receiverName/);
  } finally { rec.close(); }
});
