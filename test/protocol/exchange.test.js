import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { prepare, receive, recordAnswer } from '../../src/protocol/exchange.js';
import { buildMessage } from '../../src/protocol/messages.js';

const T0 = Date.parse('2026-10-29T02:30:00Z');

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */

/**
 * Two agents that know each other's public keys and what each may send.
 */
function pair() {
  const jk = generateKeys();
  const ck = generateKeys();
  let clock = T0;
  const now = () => clock;
  /** @type {MessageType[]} */
  const toJcb = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  /** @type {MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'];
  const jcb = {
    self: { id: 'agent:jcb-1', privateKey: jk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: publicKeyFromText(publicKeyText(ck.publicKey)), mayReceiveFrom: new Set(toJcb) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const contractor = {
    self: { id: 'agent:contractor-1', privateKey: ck.privateKey },
    peers: new Map([['agent:jcb-1', { id: 'agent:jcb-1', publicKey: publicKeyFromText(publicKeyText(jk.publicKey)), mayReceiveFrom: new Set(toContractor) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  return { jcb, contractor, tick: (/** @type {number} */ ms) => { clock += ms; } };
}

/**
 * Sends a prepared message and records the receiver's answer on the sender's side.
 * @param {any} from @param {any} to @param {any} m
 */
function deliver(from, to, m) {
  const r = receive(to, m);
  const rec = recordAnswer(from, r.answer);
  assert.equal(rec.ok, true);
  return r;
}

const SHA = 'e'.repeat(64);

test('a whole JCB job between two agents: both ledgers agree at every step', () => {
  const { jcb, contractor, tick } = pair();
  const orderId = randomUUID();

  const req = prepare(contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } });
  assert.ok(req);
  assert.equal(deliver(contractor, jcb, req).applied, true);

  const reply = prepare(jcb, { type: 'BOOKING_REPLY', to: 'agent:contractor-1', orderId, body: { answer: 'yes', ratePaise: 120000 } });
  assert.ok(reply);
  deliver(jcb, contractor, reply);

  tick(9 * 3600 * 1000);
  jcb.ledger.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: null, body: { kind: 'meter', sha256: SHA, readValue: '3671.6' }, at: new Date(jcb.now()).toISOString() });
  const ev = [{ sha256: SHA, kind: 'meter', readValue: '3671.6', takenAt: null, sentAt: '2026-10-29T02:31:00Z' },
    { sha256: 'f'.repeat(64), kind: 'meter', readValue: '3677.7', takenAt: null, sentAt: '2026-10-29T11:30:00Z' }];
  const bill = prepare(jcb, { type: 'BILL', to: 'agent:contractor-1', orderId, body: { lines: [{ what: 'JCB 3DX', hoursTenths: 61, ratePaise: 120000, amountPaise: 732000 }], totalPaise: 732000, evidence: ev } });
  assert.ok(bill);
  deliver(jcb, contractor, bill);

  const dispute = prepare(contractor, { type: 'DISPUTE', to: 'agent:jcb-1', orderId, body: { bill: bill.msg_id, reason: 'supervisor noted 5.5', theirFigure: { hoursTenths: 55 } } });
  assert.ok(dispute);
  deliver(contractor, jcb, dispute);

  const correction = prepare(jcb, { type: 'CORRECTION', to: 'agent:contractor-1', orderId, body: { lines: [{ what: 'JCB 3DX', hoursTenths: 58, ratePaise: 120000, amountPaise: 696000 }], totalPaise: 696000, evidence: ev, replaces: bill.msg_id } });
  assert.ok(correction);
  deliver(jcb, contractor, correction);

  const accept = prepare(contractor, { type: 'ACCEPT', to: 'agent:jcb-1', orderId, body: { bill: correction.msg_id } });
  assert.ok(accept);
  deliver(contractor, jcb, accept);

  const pay = prepare(contractor, { type: 'PAYMENT_CLAIM', to: 'agent:jcb-1', orderId, body: { bill: correction.msg_id, amountPaise: 696000, utr: '430212345678', paidOn: '2026-10-30', screenshot: { sha256: '1'.repeat(64) } } });
  assert.ok(pay);
  deliver(contractor, jcb, pay);

  const settled = prepare(jcb, { type: 'SETTLED', to: 'agent:contractor-1', orderId, body: { bill: correction.msg_id, payment: pay.msg_id, amountPaise: 696000 } });
  assert.ok(settled);
  deliver(jcb, contractor, settled);

  for (const side of [jcb, contractor]) {
    const v = side.ledger.view(orderId);
    assert.deepEqual([v.state, v.currentBill, v.billRev, v.payment], ['settled', correction.msg_id, 2, pay.msg_id]);
    assert.equal(side.ledger.verifyChain().ok, true);
  }
  // Every business message sits in both ledgers, with the same signed content.
  const businessIds = (/** @type {any} */ side) => side.ledger.events(orderId).filter((/** @type {any} */ e) => e.msgId && !['RECEIPT', 'REFUSE'].includes(e.type)).map((/** @type {any} */ e) => e.msgId);
  assert.deepEqual(businessIds(jcb), businessIds(contractor));
});

test('delivered twice after a crash: written once, answered with the same receipt', () => {
  const { jcb, contractor } = pair();
  const orderId = randomUUID();
  const req = prepare(contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } });
  assert.ok(req);
  const first = receive(jcb, req);
  // The answer is lost on the way back; the contractor's agent sends again.
  const second = receive(jcb, req);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.answer.type, 'RECEIPT');
  assert.equal(second.answer.body.entry_hash, first.answer.body.entry_hash);
  assert.equal(jcb.ledger.events(orderId).length, 1);
  assert.deepEqual(recordAnswer(contractor, second.answer), { ok: true, kind: 'receipt' });
});

test('an outsider, a forged message and a step out of order are refused with a signed REFUSE', () => {
  const { jcb, contractor } = pair();
  const orderId = randomUUID();
  const outsider = generateKeys();
  const forged = buildMessage({ type: 'BOOKING_REQUEST', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'X', day: '2026-10-29' }, privateKey: outsider.privateKey, nowMs: T0 });
  const r1 = receive(jcb, forged);
  assert.deepEqual([r1.answer.type, r1.answer.body.code, r1.applied], ['REFUSE', 'BAD_SIGNATURE', false]);

  const early = buildMessage({ type: 'ACCEPT', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId, body: { bill: randomUUID() }, privateKey: contractor.self.privateKey, nowMs: T0 });
  const r2 = receive(jcb, early);
  assert.deepEqual([r2.answer.type, r2.answer.body.code], ['REFUSE', 'WRONG_STATE']);
  assert.equal(jcb.ledger.events(orderId).length, 0);
  assert.deepEqual(recordAnswer(contractor, r2.answer), { ok: false, reason: 'answer to nothing we sent' }, 'a refusal of a message we never sent is not recorded');
});

test('we never send what our own ledger says does not fit', () => {
  const { contractor } = pair();
  const orderId = randomUUID();
  assert.equal(prepare(contractor, { type: 'ACCEPT', to: 'agent:jcb-1', orderId, body: { bill: randomUUID() } }), null);
  assert.equal(contractor.ledger.events(orderId).length, 0);
});
