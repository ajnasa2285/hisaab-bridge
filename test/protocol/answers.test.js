// Who may answer a message, and how (red-team review a2a1, a2a2, a2a3, a2a5): a refusal only as the
// direct answer to a message just delivered, no signature for a request that failed sender
// authentication, repeats answered before expiry, receipts that name a real message, a size cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeys, publicKeyFromText, publicKeyText, signMessage, verifyMessage } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { prepare, receive, recordAnswer } from '../../src/protocol/exchange.js';
import { buildMessage } from '../../src/protocol/messages.js';

const T0 = Date.parse('2026-10-29T02:30:00Z');
const DAY_MS = 24 * 3600 * 1000;

/** Two agents that know each other's public keys and what each may send. */
function pair() {
  const jk = generateKeys();
  const ck = generateKeys();
  let clock = T0;
  const now = () => clock;
  /** @type {import('../../src/protocol/messages.js').MessageType[]} */
  const toJcb = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST'];
  /** @type {import('../../src/protocol/messages.js').MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST'];
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
  return { jcb, contractor, jk, tick: (/** @type {number} */ ms) => { clock += ms; } };
}

/** A booked order on both ledgers, every message answered. @param {ReturnType<typeof pair>} p */
function booked(p) {
  const orderId = randomUUID();
  const req = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } }));
  assert.equal(recordAnswer(p.contractor, receive(p.jcb, req).answer).ok, true);
  const reply = /** @type {any} */ (prepare(p.jcb, { type: 'BOOKING_REPLY', to: 'agent:contractor-1', orderId, body: { answer: 'yes', ratePaise: 120000 } }));
  assert.equal(recordAnswer(p.jcb, receive(p.contractor, reply).answer).ok, true);
  return { orderId, req, reply };
}

test('a2a1: a late signed REFUSE posted in is not accepted, and the order stays as it was', () => {
  const p = pair();
  const { orderId, req } = booked(p);
  const late = buildMessage({ type: 'REFUSE', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { refers_to: req.msg_id, code: 'WRONG_STATE' }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  const r = receive(p.contractor, late);
  assert.equal(r.applied, false);
  assert.equal(r.answer.type, 'REFUSE');
  assert.equal(p.contractor.ledger.hasMessage(late.msg_id), false, 'nothing written');
  assert.equal(p.contractor.ledger.view(orderId).state, 'booked');
});

test('a2a1: the same REFUSE as an HTTP answer is ignored once the message has a RECEIPT', () => {
  const p = pair();
  const { orderId, req } = booked(p);
  const late = buildMessage({ type: 'REFUSE', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { refers_to: req.msg_id, code: 'WRONG_STATE' }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  const r = recordAnswer(p.contractor, late);
  assert.equal(r.ok, false);
  assert.equal(p.contractor.ledger.hasMessage(late.msg_id), false);
  assert.equal(p.contractor.ledger.view(orderId).state, 'booked');
});

test('a2a1: a REFUSE that later events depend on is ignored, even without a RECEIPT (the receipt was lost)', () => {
  const p = pair();
  const orderId = randomUUID();
  const req = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } }));
  assert.equal(receive(p.jcb, req).applied, true);
  const reply = /** @type {any} */ (prepare(p.jcb, { type: 'BOOKING_REPLY', to: 'agent:contractor-1', orderId, body: { answer: 'yes', ratePaise: 120000 } }));
  assert.equal(receive(p.contractor, reply).applied, true);
  const late = buildMessage({ type: 'REFUSE', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { refers_to: req.msg_id, code: 'WRONG_STATE' }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  assert.equal(recordAnswer(p.contractor, late).ok, false);
  assert.equal(p.contractor.ledger.view(orderId).state, 'booked', 'view() never throws');
});

test('a2a1: an ordinary refusal as the direct answer still counts, and the message does not', () => {
  const p = pair();
  const { orderId } = booked(p);
  const wrong = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId: randomUUID(), body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } }));
  const answer = buildMessage({ type: 'REFUSE', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId: wrong.order_id, body: { refers_to: wrong.msg_id, code: 'WRONG_STATE' }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  assert.deepEqual(recordAnswer(p.contractor, answer), { ok: true, kind: 'refuse', code: 'WRONG_STATE' });
  assert.equal(p.contractor.ledger.view(wrong.order_id).state, 'none');
  assert.equal(p.contractor.ledger.view(orderId).state, 'booked');
});

test('a2a1: an evidence decline tied to our own request is the one standalone REFUSE accepted', () => {
  const p = pair();
  const { orderId, reply } = booked(p);
  const request = /** @type {any} */ (prepare(p.jcb, { type: 'EVIDENCE_REQUEST', to: 'agent:contractor-1', orderId, body: { order: orderId, refers_to: reply.msg_id, reason: 'asked' } }));
  const declined = buildMessage({ type: 'REFUSE', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId, body: { refers_to: request.msg_id, code: 'declined_by_owner' }, privateKey: p.contractor.self.privateKey, nowMs: T0 });
  const r = receive(p.jcb, declined);
  assert.deepEqual([r.answer.type, r.applied], ['RECEIPT', true]);
  // The same code about something that is not an evidence request of ours is refused.
  const other = buildMessage({ type: 'REFUSE', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId, body: { refers_to: reply.msg_id, code: 'declined_by_owner' }, privateKey: p.contractor.self.privateKey, nowMs: T0 });
  assert.equal(receive(p.jcb, other).applied, false);
  assert.equal(p.jcb.ledger.view(orderId).state, 'booked');
});

test('a2a1: a REFUSE already stored in an old ledger stays as it was: the repeat gets its receipt', () => {
  const p = pair();
  const { orderId } = booked(p);
  const wrong = /** @type {any} */ (prepare(p.jcb, { type: 'BILL', to: 'agent:contractor-1', orderId, body: { lines: [{ what: 'JCB', hoursTenths: 10, ratePaise: 100, amountPaise: 100 }], totalPaise: 100, evidence: [{ sha256: 'a'.repeat(64), kind: 'meter', readValue: '1', takenAt: null, sentAt: new Date(T0).toISOString() }] } }));
  const stored = buildMessage({ type: 'REFUSE', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId, body: { refers_to: wrong.msg_id, code: 'WRONG_STATE' }, privateKey: p.contractor.self.privateKey, nowMs: T0 });
  p.jcb.ledger.append({ orderId, direction: 'in', type: 'REFUSE', msgId: stored.msg_id, body: stored, at: new Date(T0).toISOString() });
  assert.equal(p.jcb.ledger.view(orderId).state, 'booked', 'the old meaning: the refused bill does not count');
  assert.equal(receive(p.jcb, stored).answer.type, 'RECEIPT');
});

test('a2a3: a request failing sender authentication gets no signature at all', () => {
  const p = pair();
  const { orderId, req } = booked(p);
  const bad = { ...req, sig: 'ed25519:' + 'A'.repeat(86) + '==' };
  for (const [raw, code] of /** @type {[any, string][]} */ ([
    [bad, 'BAD_SIGNATURE'],
    [{ ...req, from: 'agent:nobody' }, 'NOT_CONNECTED'],
    [{ ...req, v: 'hb/9' }, 'UNSUPPORTED'],
  ])) {
    const r = receive(p.jcb, raw);
    assert.deepEqual([/** @type {any} */ (r.answer).code, r.applied], [code, false]);
    assert.equal(/** @type {any} */ (r.answer).type, 'ERROR');
    assert.equal(/** @type {any} */ (r.answer).sig, undefined, 'nothing signed');
    assert.equal(JSON.stringify(r.answer).includes(orderId), false, 'nothing echoed');
  }
});

test('a2a3: such an answer is unusable to the sender: nothing is recorded', () => {
  const p = pair();
  const { reply } = booked(p);
  const r = receive(p.contractor, { ...reply, sig: 'ed25519:' + 'A'.repeat(86) + '==' });
  assert.equal(recordAnswer(p.jcb, r.answer).ok, false);
});

test('a sender who is authenticated still gets a signed refusal', () => {
  const p = pair();
  const early = buildMessage({ type: 'ACCEPT', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId: randomUUID(), body: { bill: randomUUID() }, privateKey: p.contractor.self.privateKey, nowMs: T0 });
  const r = receive(p.jcb, early);
  assert.deepEqual([r.answer.type, /** @type {any} */ (r.answer).body.code], ['REFUSE', 'WRONG_STATE']);
  assert.equal(verifyMessage(/** @type {any} */ (r.answer), p.jk.publicKey), true);
});

test('a2a2: a message already applied gets a receipt for the same entry after its expiry', () => {
  const p = pair();
  const orderId = randomUUID();
  const req = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } }));
  const first = receive(p.jcb, req);
  assert.equal(first.applied, true);
  p.tick(DAY_MS + 60_000);
  const again = receive(p.jcb, req);
  assert.deepEqual([again.answer.type, again.applied], ['RECEIPT', false]);
  assert.equal(/** @type {any} */ (again.answer).body.entry_hash, /** @type {any} */ (first.answer).body.entry_hash);
  assert.deepEqual(recordAnswer(p.contractor, again.answer), { ok: true, kind: 'receipt' });
  assert.equal(p.contractor.ledger.view(orderId).state, 'requested');
});

test('a2a2: expiry still gates the first application, and a repeat must match exactly', () => {
  const p = pair();
  const orderId = randomUUID();
  const req = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } }));
  const never = /** @type {any} */ (prepare(p.contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId: randomUUID(), body: { kind: 'jcb_hours', site: 'Rampur', day: '2026-10-29' } }));
  assert.equal(receive(p.jcb, req).applied, true);
  p.tick(DAY_MS + 60_000);
  const expired = receive(p.jcb, never);
  assert.deepEqual([expired.answer.type, /** @type {any} */ (expired.answer).body.code], ['REFUSE', 'EXPIRED']);
  // The same msg_id with other content, properly signed: not the message we applied.
  const changed = signMessage({ ...req, body: { ...req.body, site: 'Elsewhere' } }, p.contractor.self.privateKey);
  assert.equal(/** @type {any} */ (receive(p.jcb, changed).answer).body.code, 'BAD_BODY');
  // A forged repeat still fails the signature before anything else.
  assert.equal(/** @type {any} */ (receive(p.jcb, { ...req, sig: 'ed25519:' + 'A'.repeat(86) + '==' }).answer).code, 'BAD_SIGNATURE');
});

test('a2a5: a message over 64 KiB is refused, unless it is EVIDENCE', () => {
  const p = pair();
  const { orderId, req } = booked(p);
  const padded = signMessage({ ...buildMessage({ type: 'RECEIPT', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { receipt_for: req.msg_id, entry_hash: '0'.repeat(64), chain_head: '0'.repeat(64) }, privateKey: p.jcb.self.privateKey, nowMs: T0 }), pad: 'x'.repeat(70 * 1024) }, p.jcb.self.privateKey);
  const r = receive(p.contractor, padded);
  assert.deepEqual([/** @type {any} */ (r.answer).body.code, r.applied], ['BAD_BODY', false]);
  assert.equal(p.contractor.ledger.hasMessage(padded.msg_id), false);
  const bigBody = buildMessage({ type: 'BOOKING_REPLY', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { answer: 'no', pad: 'x'.repeat(70 * 1024) }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  assert.equal(/** @type {any} */ (receive(p.contractor, bigBody).answer).body.code, 'BAD_BODY');
  assert.equal(/** @type {any} */ (recordAnswer(p.contractor, padded)).ok, false);
});

test('a2a5: a RECEIPT must name a message we actually sent or received', () => {
  const p = pair();
  const { orderId, req } = booked(p);
  const random = buildMessage({ type: 'RECEIPT', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { receipt_for: randomUUID(), entry_hash: '0'.repeat(64), chain_head: '0'.repeat(64) }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  const before = p.contractor.ledger.events(orderId).length;
  const r = receive(p.contractor, random);
  assert.equal(r.applied, false);
  assert.equal(p.contractor.ledger.events(orderId).length, before);
  // One that names a real message of this order is still written, as before.
  const real = buildMessage({ type: 'RECEIPT', from: 'agent:jcb-1', to: 'agent:contractor-1', orderId, body: { receipt_for: req.msg_id, entry_hash: '0'.repeat(64), chain_head: '0'.repeat(64) }, privateKey: p.jcb.self.privateKey, nowMs: T0 });
  assert.equal(receive(p.contractor, real).applied, true);
});
