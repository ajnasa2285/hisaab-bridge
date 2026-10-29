import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../../src/ledger/store.js';
import { openMediaStore } from '../../src/media/store.js';
import { generateKeys, signMessage, verifyMessage } from '../../src/protocol/keys.js';
import { buildMessage, TYPES } from '../../src/protocol/messages.js';
import { receive, prepare, recordAnswer } from '../../src/protocol/exchange.js';
import { evidenceRecords, MAX_EVIDENCE_BYTES } from '../../src/protocol/evidence.js';
import { createLink } from '../../src/agents/link.js';

const NOW = Date.parse('2026-10-29T06:00:00Z');
/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-evidence-protocol-'));
  const keys = [generateKeys(), generateKeys(), generateKeys()];
  const ids = ['agent:contractor-1', 'agent:supplier-1', 'agent:outsider-1'];
  const cores = ids.map((id, i) => ({ self: { id, privateKey: keys[i].privateKey }, now: () => NOW,
    ledger: openLedger(':memory:'), mediaStore: openMediaStore({ dataDir: dir, agentId: id }),
    peers: new Map(ids.filter((x) => x !== id).map((other) => [other, { id: other, publicKey: keys[ids.indexOf(other)].publicKey, mayReceiveFrom: new Set(TYPES) }])) }));
  t.after(() => { for (const core of cores) core.ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const [buyer, seller, outsider] = cores;
  /** @param {typeof buyer} from @param {typeof buyer} to @param {Parameters<typeof prepare>[1]} msg */
  function exchange(from, to, msg) {
    const m = prepare(from, msg); assert.ok(m);
    const r = receive(to, m); assert.equal(r.applied, true);
    assert.equal(recordAnswer(from, r.answer).ok, true);
    return m;
  }
  /** @param {string} [orderId] */
  function order(orderId = randomUUID()) {
    exchange(buyer, seller, { type: 'BOOKING_REQUEST', to: seller.self.id, orderId,
      body: { kind: 'material', site: 'Invented Yard', day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } });
    exchange(seller, buyer, { type: 'BOOKING_REPLY', to: buyer.self.id, orderId,
      body: { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }] } });
    const photo = seller.mediaStore.put({ bytes: Buffer.from(`invented-photo-${orderId}`), mime: 'image/png' });
    const delivery = exchange(seller, buyer, { type: 'DELIVERY', to: buyer.self.id, orderId,
      body: { items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी', ratePaise: 35000 }], challan: { sha256: photo.sha256, number: '701' }, deliveredAt: new Date(NOW).toISOString() } });
    return { orderId, delivery, photo };
  }
  /** @param {string} orderId @param {string} record */
  function request(orderId, record) {
    const req = prepare(buyer, { type: 'EVIDENCE_REQUEST', to: seller.self.id, orderId, body: { order: orderId, refers_to: record, reason: 'asked' } });
    assert.ok(req); return req;
  }
  return { buyer, seller, outsider, order, request, keys };
}

test('real signed request/reply stores private bytes and separately verifiable metadata only', (t) => {
  const f = fixture(t); const { orderId, delivery, photo } = f.order();
  const request = f.request(orderId, delivery.msg_id);
  const response = receive(f.seller, request);
  assert.equal(response.answer.type, 'EVIDENCE');
  assert.equal(verifyMessage(response.answer, f.keys[1].publicKey), true);
  assert.deepEqual(recordAnswer(f.buyer, response.answer).ok, true);
  assert.deepEqual(f.buyer.mediaStore.get(photo.sha256)?.bytes, f.seller.mediaStore.get(photo.sha256)?.bytes);
  for (const core of [f.buyer, f.seller]) {
    const metadata = core.ledger.eventOfMessage(response.answer.msg_id)?.body;
    assert.ok(metadata);
    assert.equal(verifyMessage(metadata, f.keys[1].publicKey), true, 'stored metadata has its own genuine signature');
    assert.equal(JSON.stringify(core.ledger.events(orderId)).includes('"bytes"'), false);
    assert.equal(core.ledger.verifyChain().ok, true);
  }
  const repeat = receive(f.seller, request);
  assert.equal(repeat.applied, false);
  assert.equal(repeat.answer.msg_id, response.answer.msg_id);
  assert.equal(verifyMessage(repeat.answer, f.keys[1].publicKey), true);
  const accepted = recordAnswer(f.buyer, repeat.answer);
  assert.equal(accepted.ok && accepted.applied, false);
  const tamperedRepeat = signMessage({ ...repeat.answer, body: { ...repeat.answer.body,
    items: [{ ...repeat.answer.body.items[0], bytes: Buffer.from('tampered repeat').toString('base64') }] } }, f.seller.self.privateKey);
  const rejectedRepeat = recordAnswer(f.buyer, tamperedRepeat);
  assert.equal(!rejectedRepeat.ok && rejectedRepeat.answer?.body.code, 'BAD_BODY', 'repeat still checks every byte');
});

test('remote photo provenance uses the signed recording time, not this agent arrival time', (t) => {
  const f = fixture(t);
  f.buyer.now = () => NOW + 60_000;
  const { orderId, delivery } = f.order();
  const received = f.buyer.ledger.eventOfMessage(delivery.msg_id);
  assert.notEqual(received?.at, delivery.created_at);
  assert.equal(evidenceRecords(f.buyer.ledger, orderId).find((r) => r.record === delivery.msg_id)?.at, delivery.created_at);
});

test('signed byte tampering, unsigned tampering, unsolicited evidence and extra items are refused without storing bytes', (t) => {
  const f = fixture(t); const { orderId, delivery, photo } = f.order();
  const request = f.request(orderId, delivery.msg_id);
  const response = receive(f.seller, request).answer;
  const bad = buildMessage({ type: 'EVIDENCE', from: f.seller.self.id, to: f.buyer.self.id, orderId,
    body: { refers_to: request.msg_id, items: [{ ...response.body.items[0], bytes: Buffer.from('tampered').toString('base64') }] }, privateKey: f.seller.self.privateKey, nowMs: NOW });
  const rejected = recordAnswer(f.buyer, bad);
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.answer?.body.code, 'BAD_BODY');
  assert.equal(!rejected.ok && verifyMessage(/** @type {any} */ (rejected.answer), f.keys[0].publicKey), true);
  const forged = structuredClone(response); forged.body.items[0].bytes = Buffer.from('tampered').toString('base64');
  const unsigned = recordAnswer(f.buyer, forged);
  assert.equal(!unsigned.ok && unsigned.answer?.body.code, 'BAD_SIGNATURE');
  const unsolicited = buildMessage({ type: 'EVIDENCE', from: f.seller.self.id, to: f.buyer.self.id, orderId,
    body: { refers_to: randomUUID(), items: response.body.items }, privateKey: f.seller.self.privateKey, nowMs: NOW });
  assert.equal(receive(f.buyer, unsolicited).answer.body.code, 'BAD_BODY');
  const extra = signMessage({ ...response, body: { ...response.body, items: [response.body.items[0], response.body.items[0]] } }, f.seller.self.privateKey);
  assert.equal(receive(f.buyer, extra).answer.body.code, 'BAD_BODY');
  assert.equal(f.buyer.mediaStore.get(photo.sha256), null);
  assert.equal(f.buyer.ledger.events(orderId).some((e) => e.type === 'EVIDENCE'), false);
});

test('different order, third party, and third-party replay of a real request receive signed refusals', (t) => {
  const f = fixture(t); const one = f.order(); const two = f.order();
  const wrong = receive(f.seller, f.request(one.orderId, two.delivery.msg_id));
  assert.equal(wrong.answer.body.code, 'no_such_record');
  const original = f.request(one.orderId, one.delivery.msg_id);
  assert.equal(receive(f.seller, original).answer.type, 'EVIDENCE');
  const stranger = buildMessage({ type: 'EVIDENCE_REQUEST', from: f.outsider.self.id, to: f.seller.self.id, orderId: one.orderId,
    body: original.body, privateKey: f.outsider.self.privateKey, nowMs: NOW });
  const denied = receive(f.seller, stranger);
  assert.equal(denied.answer.body.code, 'not_party');
  assert.equal(verifyMessage(denied.answer, f.keys[1].publicKey), true);
  const replay = signMessage({ ...stranger, msg_id: original.msg_id }, f.outsider.self.privateKey);
  const rejected = receive(f.seller, replay);
  assert.equal(rejected.answer.type, 'REFUSE');
  assert.equal(rejected.answer.body.code, 'BAD_BODY');
  assert.equal(JSON.stringify(rejected.answer).includes('"bytes"'), false);
  const mismatch = signMessage({ ...original, msg_id: randomUUID(), body: { ...original.body, order: two.orderId } }, f.buyer.self.privateKey);
  assert.equal(receive(f.seller, mismatch).answer.body.code, 'BAD_BODY');
});

test('signed evidence requests cannot smuggle top-level photo bytes into ledger metadata', (t) => {
  const f = fixture(t); const { orderId, delivery } = f.order();
  const request = buildMessage({ type: 'EVIDENCE_REQUEST', from: f.buyer.self.id, to: f.seller.self.id, orderId,
    body: { order: orderId, refers_to: delivery.msg_id, reason: 'asked' }, privateKey: f.buyer.self.privateKey, nowMs: NOW });
  const malicious = signMessage({ ...request, bytes: Buffer.from('smuggled photo').toString('base64') }, f.buyer.self.privateKey);
  const before = f.seller.ledger.events(orderId).length;
  const rejected = receive(f.seller, malicious);
  assert.equal(rejected.answer.type, 'REFUSE');
  assert.equal(rejected.answer.body.code, 'BAD_BODY');
  assert.equal(rejected.applied, false);
  assert.equal(f.seller.ledger.events(orderId).length, before);
  assert.equal(f.seller.ledger.hasMessage(request.msg_id), false);
});

test('missing or corrupt private photo is signed not_kept, and oversized bytes never decode', (t) => {
  const f = fixture(t); const { orderId, delivery } = f.order();
  const request = f.request(orderId, delivery.msg_id);
  const noStore = { ...f.seller, mediaStore: undefined };
  const missing = receive(noStore, request);
  assert.equal(missing.answer.body.code, 'not_kept');
  assert.equal(verifyMessage(missing.answer, f.keys[1].publicKey), true);
  const corrupt = { ...f.seller, mediaStore: { ...f.seller.mediaStore, get: () => ({ sha256: delivery.body.challan.sha256, mime: 'image/png', bytes: Buffer.from('corrupt') }) } };
  assert.equal(receive(corrupt, request).answer.body.code, 'not_kept');
  assert.throws(() => buildMessage({ type: 'EVIDENCE', from: f.seller.self.id, to: f.buyer.self.id, orderId,
    body: { refers_to: request.msg_id, items: [{ record: delivery.msg_id, sha256: delivery.body.challan.sha256, mime: 'image/png', bytes: Buffer.alloc(MAX_EVIDENCE_BYTES + 1).toString('base64') }] }, privateKey: f.seller.self.privateKey, nowMs: NOW }));
});

test('signed BILL and DISPUTE commitments make local record ids discoverable without leaking another order', (t) => {
  const f = fixture(t); const { orderId, delivery } = f.order();
  const id = randomUUID(); const photo = f.buyer.mediaStore.put({ bytes: Buffer.from('invented-site-copy'), mime: 'image/jpeg' });
  const at = new Date(NOW).toISOString();
  f.buyer.ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: id, at,
    body: { kind: 'site_count', items: [{ name: 'सीमेंट', qtyHundredths: 4800, unit: 'बोरी' }], challan: { sha256: photo.sha256, number: '701' } } });
  assert.equal(evidenceRecords(f.seller.ledger, orderId).some((r) => r.record === id), false);
  const bill = prepare(f.seller, { type: 'BILL', to: f.buyer.self.id, orderId, body: {
    lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 }], totalPaise: 1750000,
    evidence: [{ kind: 'challan', sha256: delivery.body.challan.sha256, readValue: '701', takenAt: null, sentAt: at }] } });
  assert.ok(bill); recordAnswer(f.seller, receive(f.buyer, bill).answer);
  const dispute = prepare(f.buyer, { type: 'DISPUTE', to: f.seller.self.id, orderId, body: { bill: bill.msg_id, theirFigure: { qtyHundredths: 4800 }, reason: 'साइट की गिनती',
    siteCount: { record: id, sha256: photo.sha256, number: '701', at, items: [{ name: 'सीमेंट', qtyHundredths: 4800, unit: 'बोरी' }] } } });
  assert.ok(dispute); recordAnswer(f.buyer, receive(f.seller, dispute).answer);
  assert.equal(evidenceRecords(f.seller.ledger, orderId, f.buyer.self.id).find((r) => r.record === id)?.sha256, photo.sha256);
  const req = prepare(f.seller, { type: 'EVIDENCE_REQUEST', to: f.buyer.self.id, orderId, body: { order: orderId, refers_to: id, reason: 'bill_disputed' } });
  assert.ok(req); assert.equal(recordAnswer(f.seller, receive(f.buyer, req).answer).ok, true);
});

test('link shows only accepted evidence once and records a signed refusal for a tampered response', async (t) => {
  const f = fixture(t); const { orderId, delivery } = f.order();
  let shown = 0;
  const link = createLink(f.buyer, { peerUrls: new Map([[f.seller.self.id, 'memory:seller']]), onEvidence: async () => { shown += 1; },
    transport: async (_url, m) => receive(f.seller, m).answer });
  const result = await link.send({ type: 'EVIDENCE_REQUEST', to: f.seller.self.id, orderId, body: { order: orderId, refers_to: delivery.msg_id, reason: 'asked' } });
  assert.equal(result.ok, true); assert.equal(shown, 1); assert.equal(link.pending().length, 0);
  if (result.ok) await link.deliver(result.message);
  assert.equal(shown, 1);
  const evil = createLink(f.buyer, { peerUrls: new Map([[f.seller.self.id, 'memory:seller']]), onEvidence: async () => { shown += 1; },
    transport: async (_url, m) => {
      const answer = receive(f.seller, m).answer;
      if (m.type === 'EVIDENCE_REQUEST') answer.body.items[0].bytes = Buffer.from('tampered').toString('base64');
      return answer;
    } });
  const rejected = await evil.send({ type: 'EVIDENCE_REQUEST', to: f.seller.self.id, orderId, body: { order: orderId, refers_to: delivery.msg_id, reason: 'asked' } });
  assert.equal(rejected.ok, false); assert.equal(shown, 1);
  assert.equal(f.seller.ledger.events(orderId).some((e) => e.type === 'REFUSE' && e.direction === 'in' && e.body.body.code === 'BAD_SIGNATURE'), true);
});

test('a signed reply to an older request never completes or displays evidence for a new request', async (t) => {
  const f = fixture(t); const { orderId, delivery } = f.order();
  const first = f.request(orderId, delivery.msg_id);
  const stale = receive(f.seller, first).answer;
  assert.equal(recordAnswer(f.buyer, stale).ok, true);
  let shown = 0;
  const link = createLink(f.buyer, { peerUrls: new Map([[f.seller.self.id, 'memory:seller']]),
    onEvidence: async () => { shown += 1; }, transport: async () => stale });
  const result = await link.send({ type: 'EVIDENCE_REQUEST', to: f.seller.self.id, orderId,
    body: { order: orderId, refers_to: delivery.msg_id, reason: 'asked' } });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'bad_answer');
  assert.equal(shown, 0);
  assert.equal(link.pending().length, 1, 'the new request remains unanswered');
});
