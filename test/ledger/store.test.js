import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openLedger } from '../../src/ledger/store.js';

const AT = '2026-10-29T03:30:00.000Z';
const SHA = 'c'.repeat(64);

/**
 * A received or sent message as the ledger stores it: the whole message, its body inside.
 * @param {string} type @param {Record<string, any>} body
 */
function msg(type, body) {
  return { msgId: randomUUID(), body: { type, body } };
}

/**
 * @param {ReturnType<typeof openLedger>} L
 * @param {string} orderId
 * @param {'in'|'out'} direction
 * @param {string} type
 * @param {{msgId: string, body: Record<string, any>}} m
 */
function put(L, orderId, direction, type, m) {
  return L.append({ orderId, direction, type, msgId: m.msgId, body: m.body, at: AT });
}

function newJcbOrder() {
  const L = openLedger(':memory:');
  const orderId = randomUUID();
  L.ensureOrder({ orderId, kind: 'jcb_hours', counterparty: 'agent:contractor-1', site: 'Shivpuri', at: AT });
  return { L, orderId };
}

const meterEvidence = { sha256: 'd'.repeat(64), kind: 'meter', readValue: '3677.7', takenAt: null, sentAt: AT };
const bill = { lines: [{ what: 'JCB', hoursTenths: 61, ratePaise: 120000, amountPaise: 732000 }], totalPaise: 732000, evidence: [meterEvidence] };

test('a JCB job from request to settled', () => {
  const { L, orderId } = newJcbOrder();
  assert.ok(put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' })));
  assert.equal(L.view(orderId).state, 'requested');
  assert.ok(put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' })));
  assert.equal(L.view(orderId).state, 'booked');
  assert.ok(L.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: null, body: { kind: 'meter', sha256: SHA, readValue: '3677.7' }, at: AT }));
  assert.equal(L.view(orderId).state, 'working');
  const b = msg('BILL', bill);
  assert.ok(put(L, orderId, 'out', 'BILL', b));
  assert.equal(L.view(orderId).state, 'billed');
  assert.ok(put(L, orderId, 'in', 'ACCEPT', msg('ACCEPT', { bill: b.msgId })));
  const p = msg('PAYMENT_CLAIM', { bill: b.msgId, amountPaise: 732000 });
  assert.ok(put(L, orderId, 'in', 'PAYMENT_CLAIM', p));
  assert.equal(L.view(orderId).state, 'payment_claimed');
  assert.ok(put(L, orderId, 'out', 'SETTLED', msg('SETTLED', { bill: b.msgId, payment: p.msgId, amountPaise: 732000 })));
  assert.equal(L.view(orderId).state, 'settled');
  assert.deepEqual(L.verifyChain(), { ok: true, events: 7 });
});

test('a dispute, a correction naming the bill it replaces, then acceptance of the correction', () => {
  const { L, orderId } = newJcbOrder();
  put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' }));
  L.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: null, body: {}, at: AT });
  const b1 = msg('BILL', bill);
  put(L, orderId, 'out', 'BILL', b1);
  assert.ok(put(L, orderId, 'in', 'DISPUTE', msg('DISPUTE', { bill: b1.msgId })));
  assert.equal(L.view(orderId).state, 'disputed');
  assert.equal(put(L, orderId, 'out', 'CORRECTION', msg('CORRECTION', { ...bill, replaces: randomUUID() })), null, 'must replace the bill in force');
  const b2 = msg('CORRECTION', { ...bill, replaces: b1.msgId });
  assert.ok(put(L, orderId, 'out', 'CORRECTION', b2));
  const v = L.view(orderId);
  assert.deepEqual([v.state, v.currentBill, v.billRev], ['billed', b2.msgId, 2]);
  assert.equal(put(L, orderId, 'in', 'ACCEPT', msg('ACCEPT', { bill: b1.msgId })), null, 'the old bill can no longer be accepted');
  assert.ok(put(L, orderId, 'in', 'ACCEPT', msg('ACCEPT', { bill: b2.msgId })));
  assert.equal(L.view(orderId).state, 'accepted');
  // Both bills stay in the history.
  assert.deepEqual(L.events(orderId).filter((e) => e.type === 'BILL' || e.type === 'CORRECTION').map((e) => e.msgId), [b1.msgId, b2.msgId]);
});

test('a material order needs a delivery before a bill; a JCB bill must carry meter evidence', () => {
  const L = openLedger(':memory:');
  const orderId = randomUUID();
  L.ensureOrder({ orderId, kind: 'material', counterparty: 'agent:supplier-1', site: 'Shivpuri', at: AT });
  put(L, orderId, 'out', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'material' }));
  assert.equal(put(L, orderId, 'in', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' })), null, 'a material yes needs its rates');
  put(L, orderId, 'in', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }] }));
  assert.equal(put(L, orderId, 'in', 'BILL', msg('BILL', bill)), null, 'no bill before delivery');
  assert.ok(put(L, orderId, 'in', 'DELIVERY', msg('DELIVERY', {})));
  assert.ok(put(L, orderId, 'in', 'BILL', msg('BILL', bill)));

  const j = newJcbOrder();
  put(j.L, j.orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  assert.equal(put(j.L, j.orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'JCB', unit: 'घंटा', ratePaise: 1 }] })), null, 'a JCB yes has no item rates');
  put(j.L, j.orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' }));
  assert.equal(put(j.L, j.orderId, 'out', 'BILL', msg('BILL', { ...bill, evidence: [] })), null, 'no bill without meter evidence');
  assert.ok(put(j.L, j.orderId, 'out', 'BILL', msg('BILL', bill)), 'the buyer side never sees local photos, only the evidence in the bill');
});

test('steps out of order are refused and write nothing', () => {
  const { L, orderId } = newJcbOrder();
  assert.equal(put(L, orderId, 'in', 'ACCEPT', msg('ACCEPT', { bill: randomUUID() })), null);
  assert.equal(put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' })), null);
  put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'no' }));
  assert.equal(L.view(orderId).state, 'declined');
  assert.equal(L.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: null, body: {}, at: AT }), null, 'no work on a declined order');
  assert.equal(L.events(orderId).length, 2);
});

test('another time sends the request back to the buyer, who may ask again', () => {
  const { L, orderId } = newJcbOrder();
  put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'other_time', day: '2026-10-30' }));
  assert.equal(L.view(orderId).state, 'offered');
  assert.ok(put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' })));
  assert.equal(L.view(orderId).state, 'requested');
});

test('settlement only for the payment in force on the bill in force', () => {
  const { L, orderId } = newJcbOrder();
  put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' }));
  L.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: null, body: {}, at: AT });
  const b = msg('BILL', bill);
  put(L, orderId, 'out', 'BILL', b);
  // A part payment may come before acceptance (CONTRACTS 4.1); it never moves the state before ACCEPT.
  const early = msg('PAYMENT_CLAIM', { bill: b.msgId, amountPaise: 100000 });
  assert.ok(put(L, orderId, 'in', 'PAYMENT_CLAIM', early));
  assert.equal(L.view(orderId).state, 'billed');
  put(L, orderId, 'in', 'ACCEPT', msg('ACCEPT', { bill: b.msgId }));
  assert.equal(L.view(orderId).state, 'payment_claimed');
  const p1 = msg('PAYMENT_CLAIM', { bill: b.msgId });
  put(L, orderId, 'in', 'PAYMENT_CLAIM', p1);
  const p2 = msg('PAYMENT_CLAIM', { bill: b.msgId });
  assert.ok(put(L, orderId, 'in', 'PAYMENT_CLAIM', p2), 'a corrected screenshot replaces the first claim');
  assert.equal(put(L, orderId, 'out', 'SETTLED', msg('SETTLED', { bill: b.msgId, payment: p1.msgId })), null, 'old claim');
  assert.ok(put(L, orderId, 'out', 'SETTLED', msg('SETTLED', { bill: b.msgId, payment: p2.msgId })));
});

test('history cannot be changed or deleted, and a forced edit is detected by the chain', () => {
  const { L, orderId } = newJcbOrder();
  put(L, orderId, 'in', 'BOOKING_REQUEST', msg('BOOKING_REQUEST', { kind: 'jcb_hours' }));
  put(L, orderId, 'out', 'BOOKING_REPLY', msg('BOOKING_REPLY', { answer: 'yes' }));
  assert.throws(() => L.db.exec(`UPDATE events SET type = 'X' WHERE seq = 1`), /append-only/);
  assert.throws(() => L.db.exec('DELETE FROM events WHERE seq = 1'), /append-only/);
  assert.throws(() => L.db.exec(`UPDATE orders SET site = 'X'`), /never changed/);
  // Someone with file access drops the trigger and edits a row: the chain shows it.
  L.db.exec('DROP TRIGGER events_no_update');
  L.db.exec(`UPDATE events SET body_json = '{"type":"BOOKING_REQUEST","body":{"kind":"material"}}' WHERE seq = 1`);
  assert.deepEqual(L.verifyChain(), { ok: false, brokenAt: 1 });
});

test('a message id is stored once', () => {
  const { L, orderId } = newJcbOrder();
  const m = msg('BOOKING_REQUEST', { kind: 'jcb_hours' });
  put(L, orderId, 'in', 'BOOKING_REQUEST', m);
  assert.equal(L.hasMessage(m.msgId), true);
  assert.throws(() => L.append({ orderId, direction: 'in', type: 'RECEIPT', msgId: m.msgId, body: { type: 'RECEIPT', body: {} }, at: AT }), /UNIQUE/);
});
