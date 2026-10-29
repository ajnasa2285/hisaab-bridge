import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { evidenceAnswer, prepare, recordAnswer, receive } from '../../src/protocol/exchange.js';
import { openMediaStore } from '../../src/media/store.js';
import { agentCardJson, createA2AHandler, sendToAgent } from '../../src/transport/a2a.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */

/**
 * Starts one agent's HTTP server on a free port.
 * @param {any} agent
 * @param {string} name
 * @param {(m: any) => void} [onApplied]
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
async function serve(agent, name, onApplied) {
  /** @type {any} */
  let handle = null;
  const server = createServer(async (req, res) => {
    if (!(await handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  handle = createA2AHandler(agent, agentCardJson({ id: agent.self.id, name, description: name, baseUrl, publicKeyText: publicKeyText(agent.self.privateKey) }), { onApplied });
  return { baseUrl, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

function agents() {
  const jk = generateKeys();
  const ck = generateKeys();
  const now = () => Date.now();
  /** @type {MessageType[]} */
  const toJcb = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  /** @type {MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'];
  return {
    jcb: {
      self: { id: 'agent:jcb-1', privateKey: jk.privateKey },
      peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: publicKeyFromText(publicKeyText(ck.publicKey)), mayReceiveFrom: new Set(toJcb) }]]),
      ledger: openLedger(':memory:'),
      now,
    },
    contractor: {
      self: { id: 'agent:contractor-1', privateKey: ck.privateKey },
      peers: new Map([['agent:jcb-1', { id: 'agent:jcb-1', publicKey: publicKeyFromText(publicKeyText(jk.publicKey)), mayReceiveFrom: new Set(toContractor) }]]),
      ledger: openLedger(':memory:'),
      now,
    },
  };
}

test('the Agent Card names the agent and its public key', async () => {
  const { jcb } = agents();
  const s = await serve(jcb, 'JCB Hisaab');
  try {
    const card = await (await fetch(`${s.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(card.supportedInterfaces[0].url, `${s.baseUrl}/a2a`);
    assert.equal(card.capabilities.extensions[0].params.agent_id, 'agent:jcb-1');
    assert.equal(card.capabilities.extensions[0].params.public_key, publicKeyText(jcb.self.privateKey));
  } finally {
    await s.close();
  }
});

test('a booking request travels over A2A (official SDK) and comes back with a signed receipt', async () => {
  const { jcb, contractor } = agents();
  /** @type {any[]} */
  const applied = [];
  const s = await serve(jcb, 'JCB Hisaab', (m) => applied.push(m.type));
  try {
    const orderId = randomUUID();
    const req = prepare(contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } });
    assert.ok(req);
    const answer = await sendToAgent(s.baseUrl, req);
    assert.deepEqual(recordAnswer(contractor, answer), { ok: true, kind: 'receipt' });
    assert.equal(jcb.ledger.view(orderId).state, 'requested');
    assert.deepEqual(applied, ['BOOKING_REQUEST']);

    // Sent again (as after a lost answer): same receipt, written once, the owner not told twice.
    const again = await sendToAgent(s.baseUrl, req);
    assert.equal(/** @type {any} */ (again).body.entry_hash, /** @type {any} */ (answer).body.entry_hash);
    assert.equal(jcb.ledger.events(orderId).length, 1);
    assert.deepEqual(applied, ['BOOKING_REQUEST']);
  } finally {
    await s.close();
  }
});

test('a tampered message over A2A gets a signed refusal and changes nothing', async () => {
  const { jcb, contractor } = agents();
  const s = await serve(jcb, 'JCB Hisaab');
  try {
    const orderId = randomUUID();
    const req = prepare(contractor, { type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29' } });
    assert.ok(req);
    const tampered = { ...req, body: { ...req.body, site: 'Elsewhere' } };
    const answer = /** @type {any} */ (await sendToAgent(s.baseUrl, tampered));
    assert.deepEqual([answer.type, answer.body.code], ['REFUSE', 'BAD_SIGNATURE']);
    assert.equal(jcb.ledger.events(orderId).length, 0);
  } finally {
    await s.close();
  }
});

test('a signed photo larger than the old JSON cap travels over the official A2A SDK', async () => {
  const pair = agents();
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-a2a-evidence-'));
  const jcb = { ...pair.jcb, mediaStore: openMediaStore({ dataDir, agentId: pair.jcb.self.id }) };
  const contractor = { ...pair.contractor, mediaStore: openMediaStore({ dataDir, agentId: pair.contractor.self.id }) };
  for (const core of [jcb, contractor]) for (const peer of core.peers.values()) {
    peer.mayReceiveFrom.add('EVIDENCE'); peer.mayReceiveFrom.add('EVIDENCE_REQUEST');
  }
  const server = await serve(contractor, 'Contractor evidence');
  try {
    const orderId = randomUUID();
    const booking = prepare(contractor, { type: 'BOOKING_REQUEST', to: jcb.self.id, orderId, body: { kind: 'jcb_hours', site: 'Invented Site', day: '2026-10-29' } });
    assert.ok(booking); recordAnswer(contractor, receive(jcb, booking).answer);
    const yes = prepare(jcb, { type: 'BOOKING_REPLY', to: contractor.self.id, orderId, body: { answer: 'yes', ratePaise: 10000 } });
    assert.ok(yes); recordAnswer(jcb, receive(contractor, yes).answer);
    const photo = jcb.mediaStore.put({ bytes: Buffer.alloc(300 * 1024, 42), mime: 'image/png' });
    const record = randomUUID(); const at = new Date(jcb.now()).toISOString();
    jcb.ledger.append({ orderId, direction: 'local', type: 'EVIDENCE', msgId: record, at, body: { kind: 'meter', which: 'start', valueTenths: 100, sha256: photo.sha256 } });
    const bill = prepare(jcb, { type: 'BILL', to: contractor.self.id, orderId, body: {
      lines: [{ what: 'JCB', hoursTenths: 10, ratePaise: 10000, amountPaise: 10000 }], totalPaise: 10000,
      evidence: [{ record, sha256: photo.sha256, kind: 'meter', readValue: '10.0', takenAt: null, sentAt: at }] } });
    assert.ok(bill); recordAnswer(jcb, receive(contractor, bill).answer);
    const request = prepare(contractor, { type: 'EVIDENCE_REQUEST', to: jcb.self.id, orderId, body: { order: orderId, refers_to: record, reason: 'asked' } });
    assert.ok(request);
    // The request is recorded; after the owner's yes the photo leaves as its own signed message.
    const ack = receive(jcb, request).answer;
    assert.equal(ack.type, 'RECEIPT');
    assert.equal(recordAnswer(contractor, ack).ok, true);
    jcb.ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(), at, body: { kind: 'evidence_consent', request: request.msg_id, answer: 'yes', by: 'jcb_owner' } });
    const answer = evidenceAnswer(jcb, orderId, request.msg_id);
    assert.ok(answer.ok);
    const response = prepare(jcb, { type: 'EVIDENCE', to: contractor.self.id, orderId, body: answer.ok ? answer.body : {} });
    assert.ok(response);
    const receipt = await sendToAgent(server.baseUrl, response);
    assert.deepEqual(recordAnswer(jcb, receipt), { ok: true, kind: 'receipt' });
    assert.equal(contractor.mediaStore.get(photo.sha256)?.bytes.length, 300 * 1024);
    assert.equal(JSON.stringify(contractor.ledger.events(orderId)).includes('"bytes"'), false);
  } finally {
    await server.close(); jcb.ledger.close(); contractor.ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
