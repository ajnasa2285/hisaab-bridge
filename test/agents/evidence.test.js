import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys } from '../../src/protocol/keys.js';
import { TYPES } from '../../src/protocol/messages.js';
import { receive } from '../../src/protocol/exchange.js';
import { openLedger } from '../../src/ledger/store.js';
import { openMediaStore } from '../../src/media/store.js';
import { createLink } from '../../src/agents/link.js';
import { createContractorAgent } from '../../src/agents/contractor.js';
import { createSupplierAgent } from '../../src/agents/supplier.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createEvidenceService, forwardEvidence } from '../../src/agents/evidence.js';
import { createOffice, parseCommand } from '../../src/agents/office.js';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';

const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
/** @param {string} role @param {string} agent */
const person = (role, agent) => ({ role, agent, phone: '919000000001', line: 'test', name: 'Invented' });

/** Real signing/exchange/ledgers; only transport, model and human delivery are stand-ins.
 * @param {import('node:test').TestContext} t @param {'material'|'jcb'} [kind] */
function fixture(t, kind = 'material') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-evidence-flow-'));
  const now = () => Date.parse('2026-10-29T03:00:00Z');
  const keys = [generateKeys(), generateKeys()];
  const ids = ['agent:contractor-1', kind === 'material' ? 'agent:supplier-1' : 'agent:jcb-1'];
  const cores = ids.map((id, i) => ({ self: { id, privateKey: keys[i].privateKey }, now,
    ledger: openLedger(':memory:'), mediaStore: openMediaStore({ dataDir: dir, agentId: id }),
    peers: new Map([[ids[1-i], { id: ids[1-i], publicKey: keys[1-i].publicKey, mayReceiveFrom: new Set(TYPES) }]]) }));
  /** @type {any[]} */ const services = [];
  /** @type {any[]} */ const agents = [];
  /** @type {any[]} */ const work = [];
  /** @type {any[]} */ const shown = [];
  /** @type {any[]} */ const told = [];
  /** @type {any[]} */ const reads = [];
  /** @type {any[]} */ const links = [];
  const peerUrls = new Map(ids.map((id) => [id, id]));
  cores.forEach((core, i) => {
    links[i] = createLink(core, { peerUrls, transport: async (url, m) => {
      const to = ids.indexOf(url);
      const result = receive(cores[to], m);
      if (result.applied) work.push(async () => { await agents[to].onApplied(m); await services[to].onApplied(m); });
      return result.answer;
    }, onEvidence: (m) => services[i].onEvidence(m) });
    const tell = (/** @type {any} */ ...args) => { told.push([i, ...args]); };
    services[i] = createEvidenceService({ agent: core, link: links[i], kind: i === 0 ? 'contractor' : kind === 'material' ? 'supplier' : 'jcb', tell,
      show: async (image, caption) => { shown.push({ side: i, image, caption }); },
      spark: async () => ({ ok: true, json: { explanation: 'सप्लायर के चालान पर 50 बोरी, साइट की गिनती 48 बोरी है।' }, toolCalls: [] }),
      readChallan: async (image) => {
        reads.push(image);
        return { ok: true, kind: 'challan', challanNo: '701', date: '2026-10-29', vehicle: null, clear: true,
          items: [{ name: 'सीमेंट', qtyHundredths: Buffer.from(image.bytes).toString().includes('48') ? 4800 : 5000, unit: 'बोरी', raw: 'invented' }] };
      },
      readMeter: async (image) => { reads.push(image); return { ok: true, kind: 'hour_meter', valueTenths: 1000, raw: '100.0', clear: true }; },
    });
    agents[i] = i === 0 ? createContractorAgent({ agent: core, link: links[i], tell, evidence: services[i], jcbAgentId: ids[1], supplierAgentId: ids[1] })
      : kind === 'material' ? createSupplierAgent({ agent: core, link: links[i], tell }) : createJcbAgent({ agent: core, link: links[i], tell });
  });
  t.after(() => { for (const c of cores) c.ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { cores, agents, links, services, shown, told, reads, now,
    flush: async () => { while (work.length) await work.shift()(); },
    /** @param {number} side @param {string} tool @param {any} args @param {string} [role] */
    run: (side, tool, args, role = side === 0 ? 'contractor' : kind === 'material' ? 'supplier' : 'jcb_owner') =>
      runTool(agents[side].tools, /** @type {any} */ (person(role, ids[side])), { tool, args }),
  };
}

/** @param {ReturnType<typeof fixture>} f */
async function material(f) {
  assert.equal((await f.run(0, 'request_material', { site: 'Invented Site', day: '2026-10-29', items: [CEMENT] })).ok, true);
  const orderId = String(f.cores[0].ledger.orders()[0].order_id);
  assert.equal((await f.run(1, 'reply_order', { orderId, answer: 'yes', ratesPaise: [35000] })).ok, true);
  const photo = f.cores[1].mediaStore.put({ bytes: Buffer.from('invented challan 50'), mime: 'image/png' });
  assert.equal((await f.run(1, 'record_delivery', { orderId, items: [CEMENT], sha256: photo.sha256, challanNo: '701' })).ok, true);
  return orderId;
}

test('count difference requests supplier photo once; dispute exchanges the signed site photo commitment', async (t) => {
  const f = fixture(t);
  const orderId = await material(f);
  const photo = f.cores[0].mediaStore.put({ bytes: Buffer.from('invented site count 48'), mime: 'image/png' });
  assert.equal((await f.run(0, 'confirm_count', { orderId, qtysHundredths: [4800], challan: { sha256: photo.sha256, number: '701' } })).ok, true);
  assert.equal(f.shown.length, 1);
  assert.match(f.shown[0].caption, /फ़ोटो वही है जो दर्ज हुई थी/);
  await f.services[0].countDifference(orderId);
  assert.equal(f.cores[0].ledger.events(orderId).filter((e) => e.type === 'EVIDENCE_REQUEST').length, 1);
  assert.equal((await f.run(1, 'send_bill', { orderId })).ok, true);
  assert.equal((await f.run(0, 'dispute_bill', { orderId, qtyHundredths: 4800, reason: 'साइट की गिनती' })).ok, true);
  await f.flush();
  assert.equal(f.shown.length, 2, 'buyer and seller each received the other photo once');
  assert.equal(f.reads.length, 2);
  assert.equal(f.cores[1].ledger.events(orderId).filter((e) => e.type === 'EVIDENCE_REQUEST' && e.direction === 'out').length, 1);
  assert.equal(f.cores[0].ledger.view(orderId).state, 'disputed');
  assert.equal(f.cores[1].ledger.view(orderId).state, 'disputed');
  for (const core of f.cores) assert.equal(core.ledger.verifyChain().ok, true);
});

test('delivery arriving after the site count asks for the differing challan; restart does not ask again', async (t) => {
  const f = fixture(t);
  await f.run(0, 'request_material', { site: 'Invented Site', day: '2026-10-29', items: [CEMENT] });
  const orderId = String(f.cores[0].ledger.orders()[0].order_id);
  await f.run(1, 'reply_order', { orderId, answer: 'yes', ratesPaise: [35000] });
  const site = f.cores[0].mediaStore.put({ bytes: Buffer.from('invented count 48'), mime: 'image/png' });
  await f.run(0, 'confirm_count', { orderId, qtysHundredths: [4800], challan: { sha256: site.sha256, number: '701' } });
  assert.equal(f.shown.length, 0);
  const supplier = f.cores[1].mediaStore.put({ bytes: Buffer.from('invented delivery 50'), mime: 'image/png' });
  await f.run(1, 'record_delivery', { orderId, items: [CEMENT], sha256: supplier.sha256, challanNo: '701' });
  await f.flush();
  assert.equal(f.shown.length, 1);
  const restarted = createEvidenceService({ agent: f.cores[0], link: f.links[0], kind: 'contractor', tell: () => {}, show: async () => {} });
  await restarted.countDifference(orderId);
  assert.equal(f.cores[0].ledger.events(orderId).filter((e) => e.type === 'EVIDENCE_REQUEST').length, 1);
});

test('सबूत P-1 and saboot J-1 are code commands; operators cannot trigger evidence', async (t) => {
  assert.deepEqual(parseCommand('सबूत P-1'), { cmd: 'evidence', ref: 'P-1' });
  assert.deepEqual(parseCommand('saboot J-1'), { cmd: 'evidence', ref: 'J-1' });
  const f = fixture(t);
  const orderId = await material(f);
  const office = createOffice({ ledger: f.cores[0].ledger, tools: f.agents[0].tools, kind: 'contractor', now: f.now,
    reply: () => {}, tell: () => {}, evidence: f.services[0] });
  assert.equal((await office.command(/** @type {any} */ (person('operator', f.cores[0].self.id)), { cmd: 'evidence', ref: 'P-1' }))?.key, 'common.not_allowed');
  assert.equal(f.shown.length, 0);
  /** @type {string[]} */ const replies = [];
  const talk = createConversation({ ledger: f.cores[0].ledger, tools: f.agents[0].tools, office, now: f.now,
    spark: async () => { throw new Error('exact command must not call router'); }, reply: (_p, key) => { replies.push(key); } });
  await talk.onText(/** @type {any} */ (person('contractor', f.cores[0].self.id)), 'सबूत P-1');
  assert.equal(replies.at(-1), 'evidence.received');
  assert.equal(f.shown.length, 1);
  assert.equal(f.cores[0].ledger.events(orderId).filter((e) => e.type === 'EVIDENCE_REQUEST')[0].body.body.reason, 'asked');
});

test('JCB dispute automatically requests both meter photos committed in the bill', async (t) => {
  const f = fixture(t, 'jcb');
  await f.run(0, 'request_jcb', { site: 'Invented Site', day: '2026-10-29', hoursTenths: 20 });
  const orderId = String(f.cores[0].ledger.orders()[0].order_id);
  await f.run(1, 'reply_booking', { orderId, answer: 'yes', ratePaise: 100000 });
  for (const [which, valueTenths] of /** @type {const} */ ([['start', 1000], ['end', 1020]])) {
    const photo = f.cores[1].mediaStore.put({ bytes: Buffer.from(`invented ${which} meter`), mime: 'image/png' });
    await f.run(1, 'record_meter', { orderId, which, valueTenths, sha256: photo.sha256 });
  }
  assert.equal((await f.run(1, 'send_bill', { orderId })).ok, true);
  assert.equal((await f.run(0, 'dispute_bill', { orderId, hoursTenths: 15, reason: 'साइट के घंटे' })).ok, true);
  assert.equal(f.shown.length, 2);
  assert.equal(f.cores[0].ledger.events(orderId).filter((e) => e.type === 'EVIDENCE_REQUEST').length, 2);
});

test('image upload/message failure falls back to code caption text', async () => {
  /** @type {string[]} */ const sent = [];
  for (const fails of [false, true]) await forwardEvidence({ image: { mime: 'image/png', bytes: Buffer.from('invented') }, caption: 'फ़ोटो वही है जो दर्ज हुई थी।',
    sendImage: async () => { if (fails) throw new Error('offline'); return { ok: false }; }, sendText: async (text) => { sent.push(text); } });
  assert.deepEqual(sent, ['फ़ोटो वही है जो दर्ज हुई थी।', 'फ़ोटो वही है जो दर्ज हुई थी।']);
});

test('a confirmed challan keeps its original bytes privately before the DELIVERY leaves', async (t) => {
  const f = fixture(t);
  await f.run(0, 'request_material', { site: 'Invented Site', day: '2026-10-29', items: [CEMENT] });
  const orderId = String(f.cores[0].ledger.orders()[0].order_id);
  await f.run(1, 'reply_order', { orderId, answer: 'yes', ratesPaise: [35000] });
  const core = f.cores[1];
  const image = { mime: 'image/png', bytes: Buffer.from('invented photo for confirmation') };
  /** @type {string[]} */ const replies = [];
  const talk = createConversation({ ledger: core.ledger, tools: f.agents[1].tools, now: f.now, mediaStore: core.mediaStore,
    spark: async () => ({ ok: true, toolCalls: [] }), reply: (_p, key) => { replies.push(key); },
    classifyPhoto: async () => ({ ok: true, kind: 'challan', clear: true, model: 'stand-in', latencyMs: 0 }),
    readChallan: async () => ({ ok: true, kind: 'challan', challanNo: '701', date: '2026-10-29', clear: true,
      items: [{ ...CEMENT, raw: '50' }] }),
  });
  const supplier = /** @type {any} */ (person('supplier', core.self.id));
  const sha256 = createHash('sha256').update(image.bytes).digest('hex');
  // A clear challan is recorded at once (fewer steps); its bytes are kept before the DELIVERY leaves.
  await talk.onImage(supplier, image);
  assert.equal(replies.at(-1), 'supplier.delivery_sent');
  assert.deepEqual(Buffer.from(core.mediaStore.get(sha256)?.bytes ?? []), image.bytes);
  assert.doesNotMatch(JSON.stringify(core.ledger.events(orderId)), /invented photo for confirmation|"bytes"/);
});
