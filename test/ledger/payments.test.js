import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, paymentSummary } from '../../src/ledger/payments.js';

let seq = 0;
/** A signed message as the ledger keeps it. @param {string} type @param {Record<string, any>} body @param {string} [msgId] */
const msg = (type, body, msgId = `m-${++seq}`) => /** @type {any} */ ({ seq, direction: 'in', type, msgId, body: { body }, at: '2026-10-30T10:00:00.000Z' });

test('no bill, no payments: nothing due yet', () => {
  const s = paymentSummary([msg('BOOKING_REQUEST', {})]);
  assert.deepEqual([s.billTotalPaise, s.duePaise, s.confirmedPaise, s.payments.length], [null, null, 0, 0]);
});

test('part payments: confirmed adds up, waiting is apart, due is what is left', () => {
  const s = paymentSummary([
    msg('BILL', { totalPaise: 2065000 }, 'bill-1'),
    msg('ACCEPT', { bill: 'bill-1' }),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', amountPaise: 1000000, utr: '412300000001', paidOn: '2026-10-30', screenshot: { sha256: 'a'.repeat(64) } }, 'p-1'),
    msg('PAYMENT_ACK', { payment: 'p-1', received: true, amountPaise: 1000000 }),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', method: 'cash', amountPaise: 500000, paidOn: '2026-10-31' }, 'p-2'),
  ]);
  assert.equal(s.confirmedPaise, 1000000);
  assert.equal(s.waitingPaise, 500000);
  assert.deepEqual(s.pending, ['p-2']);
  assert.equal(s.duePaise, 1065000);
  assert.equal(s.payments[1].method, 'cash');
  assert.equal(s.payments[1].utr, null);
});

test('an advance counts towards the bill when it comes; a seller\'s own cash entry is confirmed at once', () => {
  const s = paymentSummary([
    msg('PAYMENT_CLAIM', { bill: null, method: 'cash', amountPaise: 500000, paidOn: '2026-10-29' }, 'adv'),
    msg('PAYMENT_ACK', { payment: 'adv', received: true, amountPaise: 500000 }),
    msg('BILL', { totalPaise: 1900000 }, 'bill-1'),
    msg('PAYMENT_RECEIVED', { method: 'cash', amountPaise: 1400000, receivedOn: '2026-10-30', bill: 'bill-1' }, 'cash-2'),
  ]);
  assert.equal(s.payments[0].advance, true);
  assert.equal(s.payments[1].from, 'seller');
  assert.equal(s.confirmedPaise, 1900000);
  assert.equal(s.duePaise, 0);
  assert.equal(s.creditPaise, 0);
});

test('a denied claim counts for nothing; a correction changes the total, never the payments; more paid shows as credit', () => {
  const s = paymentSummary([
    msg('BILL', { totalPaise: 1000000 }, 'bill-1'),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', amountPaise: 300000, utr: 'U1', paidOn: '2026-10-30' }, 'p-1'),
    msg('PAYMENT_ACK', { payment: 'p-1', received: false, amountPaise: 300000 }),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', amountPaise: 900000, utr: 'U2', paidOn: '2026-10-30' }, 'p-2'),
    msg('PAYMENT_ACK', { payment: 'p-2', received: true, amountPaise: 900000 }),
    msg('CORRECTION', { totalPaise: 800000, replaces: 'bill-1' }, 'bill-2'),
  ]);
  assert.equal(s.payments[0].status, 'denied');
  assert.equal(s.billTotalPaise, 800000);
  assert.equal(s.duePaise, 0);
  assert.equal(s.creditPaise, 100000);
});

test('an old-form SETTLED confirms the claim it names', () => {
  const s = paymentSummary([
    msg('BILL', { totalPaise: 732000 }, 'bill-1'),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', amountPaise: 732000, utr: 'U', paidOn: '2026-10-29' }, 'p-1'),
    msg('SETTLED', { bill: 'bill-1', payment: 'p-1', amountPaise: 732000 }),
  ]);
  assert.deepEqual([s.confirmedPaise, s.duePaise, s.settled], [732000, 0, true]);
});

test('a clubbed payment keeps its group on each order\'s share', () => {
  const group = { id: 'g-1', totalPaise: 3965000, orders: ['o-1', 'o-2'] };
  const s = paymentSummary([
    msg('BILL', { totalPaise: 1900000 }, 'bill-1'),
    msg('PAYMENT_CLAIM', { bill: 'bill-1', amountPaise: 1900000, utr: 'U9', paidOn: '2026-10-30', group }, 'p-1'),
  ]);
  assert.deepEqual(s.payments[0].group, group);
});

test('a2a4: a message of ours the other side refused, or noted undelivered, does not count in the balance', () => {
  /** @param {string} type @param {Record<string, any>} body @param {string} id */
  const out = (type, body, id) => ({ ...msg(type, body, id), direction: 'out' });
  /** @param {string} refersTo */
  const refuse = (refersTo) => msg('REFUSE', { refers_to: refersTo, code: 'WRONG_STATE' });
  // A refused bill: no bill in force.
  let s = paymentSummary([out('BILL', { totalPaise: 2000000 }, 'b-1'), refuse('b-1')]);
  assert.deepEqual([s.billTotalPaise, s.duePaise], [null, null]);
  // A refused correction: the bill before it stays in force.
  s = paymentSummary([out('BILL', { totalPaise: 2000000 }, 'b-1'), out('CORRECTION', { totalPaise: 900000 }, 'b-2'), refuse('b-2')]);
  assert.equal(s.billTotalPaise, 2000000);
  // Refused money: not confirmed, not forever waiting.
  s = paymentSummary([msg('BILL', { totalPaise: 2000000 }, 'b-1'), out('PAYMENT_RECEIVED', { amountPaise: 1000000, method: 'cash', receivedOn: '2026-10-30', bill: 'b-1' }, 'p-1'), refuse('p-1')]);
  assert.equal(s.confirmedPaise, 0);
  s = paymentSummary([msg('BILL', { totalPaise: 2000000 }, 'b-1'), out('PAYMENT_CLAIM', { bill: 'b-1', amountPaise: 1000000, utr: 'U', paidOn: '2026-10-30' }, 'p-1'), refuse('p-1')]);
  assert.deepEqual([s.pending, s.payments.length], [[], 0]);
  // A refused answer or settlement changes nothing.
  s = paymentSummary([msg('BILL', { totalPaise: 1000 }, 'b-1'), msg('PAYMENT_CLAIM', { bill: 'b-1', amountPaise: 1000, utr: 'U', paidOn: '2026-10-30' }, 'p-1'),
    out('PAYMENT_ACK', { payment: 'p-1', received: true, amountPaise: 1000 }, 'a-1'), refuse('a-1'), out('SETTLED', { bill: 'b-1', amountPaise: 1000, payments: ['p-1'] }, 's-1'), refuse('s-1')]);
  assert.deepEqual([s.confirmedPaise, s.pending, s.settled], [0, ['p-1'], false]);
  // Our own note that a message expired undelivered counts the same.
  s = paymentSummary([out('BILL', { totalPaise: 2000000 }, 'b-1'), /** @type {any} */ ({ seq: 9, direction: 'local', type: 'NOTE', msgId: 'n-1', body: { kind: 'undelivered', msg_id: 'b-1', type: 'BILL' }, at: '2026-10-30T10:00:00.000Z' })]);
  assert.equal(s.billTotalPaise, null);
  // A refusal of something the other side sent us (direction in) is not about our message.
  s = paymentSummary([msg('BILL', { totalPaise: 2000000 }, 'b-1'), refuse('b-1')]);
  assert.equal(s.billTotalPaise, 2000000);
});

test('allocate: oldest first, each takes its due, the rest goes to the last; shares add up exactly', () => {
  assert.deepEqual(allocate(3965000, [{ orderId: 'P-1', duePaise: 1900000 }, { orderId: 'P-2', duePaise: 2065000 }]),
    [{ orderId: 'P-1', amountPaise: 1900000 }, { orderId: 'P-2', amountPaise: 2065000 }]);
  // Less than both dues: the first is paid in full, the second in part.
  assert.deepEqual(allocate(2500000, [{ orderId: 'P-1', duePaise: 1900000 }, { orderId: 'P-2', duePaise: 2065000 }]),
    [{ orderId: 'P-1', amountPaise: 1900000 }, { orderId: 'P-2', amountPaise: 600000 }]);
  // More than both: the rest lands on the last (credit, or an advance when it has no bill).
  assert.deepEqual(allocate(4000000, [{ orderId: 'P-1', duePaise: 1900000 }, { orderId: 'P-3', duePaise: null }]),
    [{ orderId: 'P-1', amountPaise: 1900000 }, { orderId: 'P-3', amountPaise: 2100000 }]);
  // Not enough for the first: the second takes nothing and is left out.
  assert.deepEqual(allocate(1000000, [{ orderId: 'P-1', duePaise: 1900000 }, { orderId: 'P-2', duePaise: 2065000 }]),
    [{ orderId: 'P-1', amountPaise: 1000000 }]);
  assert.equal(allocate(0, [{ orderId: 'P-1', duePaise: 1 }]), null);
  assert.equal(allocate(100, []), null);
});
