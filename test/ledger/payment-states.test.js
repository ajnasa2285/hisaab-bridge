// Payments in the state machine and the protocol (docs/CONTRACTS.md section 4.1): the new message
// shapes, part_paid, payments from the booking on, SETTLED only when the contract allows, and old
// ledgers (one claim, old SETTLED) still replay. Invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyView, replay, step } from '../../src/ledger/states.js';
import { bodyIsValid, buildMessage } from '../../src/protocol/messages.js';
import { generateKeys } from '../../src/protocol/keys.js';

const SHA = 'c'.repeat(64);
/** @param {string} type @param {Record<string, any>} body @param {string} [id] */
const ev = (type, body, id = randomUUID()) => ({ type, msg_id: id, body });

/** Request → yes → (start) → bill of `total` paise; returns the events and the bill's id. @param {number} total */
function billed(total) {
  const bill = randomUUID();
  return {
    bill,
    events: [
      ev('BOOKING_REQUEST', { kind: 'jcb_hours' }),
      ev('BOOKING_REPLY', { answer: 'yes' }),
      ev('BILL', { totalPaise: total, evidence: [{ kind: 'meter' }] }, bill),
    ],
  };
}

test('an old ledger still replays: one claim, a corrected screenshot, the old SETTLED', () => {
  const { bill, events } = billed(732000);
  const p1 = randomUUID();
  const p2 = randomUUID();
  const v = replay([...events, ev('ACCEPT', { bill }),
    ev('PAYMENT_CLAIM', { bill, amountPaise: 700000, utr: 'U1', paidOn: '2026-10-28', screenshot: { sha256: SHA } }, p1),
    ev('PAYMENT_CLAIM', { bill, amountPaise: 732000, utr: 'U2', paidOn: '2026-10-28', screenshot: { sha256: SHA } }, p2),
    ev('SETTLED', { bill, payment: p2, amountPaise: 732000 })]);
  assert.equal(v.state, 'settled');
  assert.equal(v.paid[p2].status, 'confirmed');
  // The old form names the latest claim only.
  const w = replay([...events, ev('ACCEPT', { bill }), ev('PAYMENT_CLAIM', { bill, amountPaise: 732000 }, p1), ev('PAYMENT_CLAIM', { bill, amountPaise: 732000 }, p2)]);
  assert.equal(step(w, ev('SETTLED', { bill, payment: p1, amountPaise: 732000 })), null);
});

test('payments fit from the booking on, never before it and never after settled', () => {
  const req = step(emptyView(), ev('BOOKING_REQUEST', { kind: 'material' }));
  assert.ok(req);
  assert.equal(step(/** @type {any} */ (req), ev('PAYMENT_CLAIM', { bill: null, amountPaise: 500000 })), null, 'requested');
  assert.equal(step(/** @type {any} */ (req), ev('PAYMENT_RECEIVED', { bill: null, amountPaise: 500000 })), null, 'requested');
  const booked = /** @type {any} */ (step(/** @type {any} */ (req), ev('BOOKING_REPLY', { answer: 'yes', rates: [] })));
  // An advance names no bill; with a bill in force a payment must name it.
  const adv = step(booked, ev('PAYMENT_CLAIM', { bill: null, amountPaise: 500000 }));
  assert.equal(adv?.state, 'booked');
  assert.equal(step(booked, ev('PAYMENT_CLAIM', { bill: randomUUID(), amountPaise: 500000 })), null);
  const { bill, events } = billed(1000000);
  const settled = replay([...events, ev('ACCEPT', { bill }), ev('PAYMENT_RECEIVED', { bill, amountPaise: 1000000 })]);
  assert.equal(settled.state, 'part_paid');
  const ids = Object.keys(settled.paid);
  const done = /** @type {any} */ (step(settled, ev('SETTLED', { bill, amountPaise: 1000000, payments: ids })));
  assert.equal(done.state, 'settled');
  assert.equal(step(done, ev('PAYMENT_CLAIM', { bill, amountPaise: 1000 })), null);
  assert.equal(step(done, ev('PAYMENT_RECEIVED', { bill, amountPaise: 1000 })), null);
  assert.equal(step(/** @type {any} */ (req), ev('PAYMENT_CLAIM', { bill: null, amountPaise: 1 }, null)), null, 'a claim has an id');
});

test('states after ACCEPT follow the payments; an ACK answers one claim once, for its own amount', () => {
  const { bill, events } = billed(2065000);
  const c1 = randomUUID();
  let v = replay([...events, ev('PAYMENT_CLAIM', { bill, amountPaise: 1000000 }, c1)]);
  assert.equal(v.state, 'billed', 'nothing moves before ACCEPT');
  v = /** @type {any} */ (step(v, ev('ACCEPT', { bill })));
  assert.deepEqual([v.state, v.pending, v.billTotalPaise], ['payment_claimed', [c1], 2065000]);
  assert.equal(step(v, ev('PAYMENT_ACK', { payment: c1, received: true, amountPaise: 999999 })), null, 'not the claim\'s amount');
  assert.equal(step(v, ev('PAYMENT_ACK', { payment: randomUUID(), received: true, amountPaise: 1000000 })), null, 'no such claim');
  v = /** @type {any} */ (step(v, ev('PAYMENT_ACK', { payment: c1, received: true, amountPaise: 1000000 })));
  assert.deepEqual([v.state, v.confirmedPaise, v.pending], ['part_paid', 1000000, []]);
  assert.equal(step(v, ev('PAYMENT_ACK', { payment: c1, received: false, amountPaise: 1000000 })), null, 'answered once');
  // Not settled while short, nor while a claim waits, nor with a wrong list.
  assert.equal(step(v, ev('SETTLED', { bill, amountPaise: 1000000, payments: [c1] })), null, 'short');
  const c2 = randomUUID();
  const w = /** @type {any} */ (step(v, ev('PAYMENT_CLAIM', { bill, amountPaise: 1065000 }, c2)));
  assert.equal(w.state, 'payment_claimed');
  assert.equal(step(w, ev('SETTLED', { bill, amountPaise: 1000000, payments: [c1] })), null, 'a claim waits');
  const denied = /** @type {any} */ (step(w, ev('PAYMENT_ACK', { payment: c2, received: false, amountPaise: 1065000 })));
  assert.deepEqual([denied.state, denied.confirmedPaise], ['part_paid', 1000000]);
  const r = randomUUID();
  const full = /** @type {any} */ (step(denied, ev('PAYMENT_RECEIVED', { bill, amountPaise: 1065000 }, r)));
  assert.equal(step(full, ev('SETTLED', { bill, amountPaise: 2065000, payments: [c1] })), null, 'every confirmed payment is listed');
  assert.equal(step(full, ev('SETTLED', { bill, amountPaise: 2000000, payments: [c1, r] })), null, 'the amount is all confirmed');
  assert.equal(step(full, ev('SETTLED', { bill, amountPaise: 2065000, payments: [c1, r] }))?.state, 'settled');
  // A denied claim alone after ACCEPT leaves the bill accepted.
  const { bill: b2, events: e2 } = billed(500000);
  const c3 = randomUUID();
  const only = replay([...e2, ev('ACCEPT', { bill: b2 }), ev('PAYMENT_CLAIM', { bill: b2, amountPaise: 500000 }, c3), ev('PAYMENT_ACK', { payment: c3, received: false, amountPaise: 500000 })]);
  assert.equal(only.state, 'accepted');
});

test('advances: a correction changes the bill total, never the payments; covered at ACCEPT the seller may settle', () => {
  const booked = replay([ev('BOOKING_REQUEST', { kind: 'material' }), ev('BOOKING_REPLY', { answer: 'yes', rates: [] })]);
  const a = randomUUID();
  let v = /** @type {any} */ (step(booked, ev('PAYMENT_RECEIVED', { bill: null, amountPaise: 2000000 }, a)));
  v = step(v, ev('DELIVERY', {}));
  const bill = randomUUID();
  v = step(v, ev('BILL', { totalPaise: 2065000 }, bill));
  const fix = randomUUID();
  v = step(step(v, ev('DISPUTE', { bill })), ev('CORRECTION', { totalPaise: 1950000, replaces: bill }, fix));
  assert.deepEqual([v.billTotalPaise, v.confirmedPaise, v.state], [1950000, 2000000, 'billed']);
  v = step(v, ev('ACCEPT', { bill: fix }));
  assert.equal(v.state, 'part_paid');
  assert.equal(step(v, ev('SETTLED', { bill: fix, amountPaise: 2000000, payments: [a] }))?.state, 'settled');
});

test('message shapes: advance, cash, group shares, ACK, RECEIVED and both SETTLED forms', () => {
  const bill = randomUUID();
  const upi = { bill, amountPaise: 1000000, utr: '412300000201', paidOn: '2026-10-30', screenshot: { sha256: SHA } };
  assert.equal(bodyIsValid('PAYMENT_CLAIM', upi), true, 'the old form');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...upi, bill: null }), true, 'an advance');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...upi, method: 'upi' }), true);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...upi, utr: undefined }), false, 'UPI needs its UTR');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...upi, screenshot: undefined }), false, 'UPI needs its screenshot');
  const cash = { bill, method: 'cash', amountPaise: 1000000, paidOn: '2026-10-30' };
  assert.equal(bodyIsValid('PAYMENT_CLAIM', cash), true);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, screenshot: { sha256: SHA } }), true, 'a cash receipt photo');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, utr: 'X1' }), false, 'cash has no UTR');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, method: 'cheque' }), false);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, amountPaise: 0 }), false);
  const orders = [randomUUID(), randomUUID()];
  const group = { id: randomUUID(), totalPaise: 3965000, orders };
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, group }), true);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, amountPaise: 4000000, group }), false, 'a share is part of the total');
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { ...cash, group: { ...group, orders: [orders[0]] } }), false, 'a group has two orders or more');
  assert.equal(bodyIsValid('PAYMENT_ACK', { payment: randomUUID(), received: true, amountPaise: 1000 }), true);
  assert.equal(bodyIsValid('PAYMENT_ACK', { payment: randomUUID(), received: 'yes', amountPaise: 1000 }), false);
  assert.equal(bodyIsValid('PAYMENT_RECEIVED', { method: 'cash', amountPaise: 1000, receivedOn: '2026-10-30', bill: null }), true);
  assert.equal(bodyIsValid('PAYMENT_RECEIVED', { method: 'cash', amountPaise: 1000, receivedOn: '2026-10-30' }), false, 'bill or null, always said');
  assert.equal(bodyIsValid('SETTLED', { bill, payment: randomUUID(), amountPaise: 1000 }), true, 'the old form');
  assert.equal(bodyIsValid('SETTLED', { bill, payments: [randomUUID()], amountPaise: 1000 }), true, 'the new form');
  assert.equal(bodyIsValid('SETTLED', { bill, payments: [], amountPaise: 1000 }), false);
  const keys = generateKeys();
  const at = { type: /** @type {const} */ ('PAYMENT_CLAIM'), from: 'agent:contractor-1', to: 'agent:supplier-1', privateKey: keys.privateKey, nowMs: Date.parse('2026-10-30T05:00:00Z') };
  assert.ok(buildMessage({ ...at, orderId: orders[0], body: { ...cash, group } }));
  assert.throws(() => buildMessage({ ...at, orderId: randomUUID(), body: { ...cash, group } }), /outside its group/);
});
