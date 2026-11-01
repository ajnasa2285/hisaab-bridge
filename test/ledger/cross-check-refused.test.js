// A message one side counts as refused or undelivered, which the other side wrote: the ledgers then see
// the order differently, with no receipt to compare. Honest refusals and evidence refusals never alarm.
// Invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { prepare, receive, recordAnswer } from '../../src/protocol/exchange.js';
import { buildMessage } from '../../src/protocol/messages.js';
import { crossCheck } from '../../src/ledger/cross-check.js';
import { checkLedgers } from '../../src/ledger/integrity.js';

const T0 = Date.parse('2026-11-01T02:30:00Z');
const JCB = 'agent:jcb-1';
const SITE = 'agent:contractor-1';

/** A booked order on both ledgers, every message answered. */
function booked() {
  const [jk, ck] = [generateKeys(), generateKeys()];
  const now = () => T0;
  /** @type {any[]} */
  const types = ['BOOKING_REQUEST', 'BOOKING_REPLY', 'CANCEL', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST'];
  /** @param {string} id @param {any} key */
  const peer = (id, key) => new Map([[id, { id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) }]]);
  const jcb = { self: { id: JCB, privateKey: jk.privateKey }, peers: peer(SITE, ck.publicKey), ledger: openLedger(':memory:'), now };
  const site = { self: { id: SITE, privateKey: ck.privateKey }, peers: peer(JCB, jk.publicKey), ledger: openLedger(':memory:'), now };
  const orderId = randomUUID();
  const req = /** @type {any} */ (prepare(site, { type: 'BOOKING_REQUEST', to: JCB, orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-11-01' } }));
  assert.equal(recordAnswer(site, receive(jcb, req).answer).ok, true);
  const reply = /** @type {any} */ (prepare(jcb, { type: 'BOOKING_REPLY', to: SITE, orderId, body: { answer: 'yes', ratePaise: 120000 } }));
  assert.equal(recordAnswer(jcb, receive(site, reply).answer).ok, true);
  return { jcb, site, orderId };
}

/** @param {any} a */
const side = (a) => ({ id: a.self.id, events: a.ledger.orders().flatMap((/** @type {any} */ o) => a.ledger.events(o.order_id)) });
/** @param {any} p */
const cancel = (p) => /** @type {any} */ (prepare(p.site, { type: 'CANCEL', to: JCB, orderId: p.orderId, body: {} }));
/** @param {any} p @param {any} m @param {string} code */
const refusal = (p, m, code) => buildMessage({ type: 'REFUSE', from: JCB, to: SITE, orderId: p.orderId, body: { refers_to: m.msg_id, code }, privateKey: p.jcb.self.privateKey, nowMs: T0 });

for (const code of ['EXPIRED', 'WRONG_STATE']) {
  test(`a peer that writes a message and answers ${code} is caught`, () => {
    const p = booked();
    const m = cancel(p);
    assert.equal(receive(p.jcb, m).applied, true);
    assert.equal(recordAnswer(p.site, refusal(p, m, code)).ok, true);
    assert.deepEqual([p.site.ledger.view(p.orderId).state, p.jcb.ledger.view(p.orderId).state], ['booked', 'cancelled']);
    const r = crossCheck(side(p.site), side(p.jcb));
    assert.deepEqual(r.mismatches.map((x) => [x.holder, x.peer, x.orderId, x.kind]), [[SITE, JCB, p.orderId, 'refused_but_written']]);
  });
}

test('the same is caught for our own "undelivered" note', () => {
  const p = booked();
  const m = cancel(p);
  receive(p.jcb, m);
  p.site.ledger.append({ orderId: p.orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(), at: new Date(T0).toISOString(), body: { kind: 'undelivered', msg_id: m.msg_id, type: m.type } });
  assert.deepEqual(crossCheck(side(p.site), side(p.jcb)).mismatches.map((x) => x.kind), ['refused_but_written']);
});

test('an honest refusal, with nothing written on the other side, does not alarm', () => {
  const p = booked();
  const m = cancel(p);
  assert.equal(recordAnswer(p.site, refusal(p, m, 'WRONG_STATE')).ok, true);
  assert.deepEqual(crossCheck(side(p.site), side(p.jcb)).mismatches, []);
});

test('a message simply not answered yet does not alarm', () => {
  const p = booked();
  receive(p.jcb, cancel(p));
  assert.deepEqual(crossCheck(side(p.site), side(p.jcb)).mismatches, []);
});

test('the server check reports it, naming the message and no contents', async () => {
  const p = booked();
  const m = cancel(p);
  receive(p.jcb, m);
  recordAnswer(p.site, refusal(p, m, 'EXPIRED'));
  const r = await checkLedgers([{ name: 'site', id: SITE, ledger: p.site.ledger, peers: p.site.peers }, { name: 'jcb', id: JCB, ledger: p.jcb.ledger, peers: p.jcb.peers }]);
  const found = r.failures.filter((f) => f.kind === 'refused_but_written');
  assert.equal(found.length, 1);
  assert.match(found[0].text, /^site seq \d+, message to jcb: refused_but_written$/);
});
