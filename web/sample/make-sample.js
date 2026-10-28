// Makes web/sample/export.json: one whole JCB job and one whole material job run by the real
// agents (src/agents) over real A2A HTTP between three in-memory ledgers (JCB, contractor,
// supplier), with invented names and numbers only. The shape of the export is documented in
// web/README.md. Run: node web/sample/make-sample.js
//
// Each run makes fresh keys, so the file changes every time; the signatures inside it verify with
// the public keys it carries (test/web/sample.test.js checks that).

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { openRefs } from '../../src/ledger/refs.js';
import { agentCardJson, createA2AHandler, sendToAgent } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { runTool } from '../../src/agents/common.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';
import { createSupplierAgent } from '../../src/agents/supplier.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */
/** @typedef {import('../../src/wa/directory.js').Person} Person */
/** @typedef {import('../../src/ledger/store.js').LedgerEvent} LedgerEvent */

/**
 * @typedef {object} LedgerExport
 * @property {string} agentId
 * @property {string} publicKey                 "ed25519:<base64>"
 * @property {{order_id: string, kind: string, counterparty: string, site: string, created_at: string}[]} orders
 * @property {LedgerEvent[]} events             every event of every order, in seq order
 * @property {{ok: true, events: number} | {ok: false, brokenAt: number}} chain  verifyChain() at export time
 * @property {Record<string, string>} [refs]    this side's reference (J-n / P-n) per order_id
 */
/** @typedef {{v: 'hb-export/0.1', exportedAt: string, jcb: LedgerExport, contractor: LedgerExport, supplier: LedgerExport}} Export */

// Invented photo fingerprints: the sample has no real images.
const SHA_START = '1a'.repeat(32);
const SHA_END = '2b'.repeat(32);
const SHA_UPI = '3c'.repeat(32);
const SHA_CHALLAN = '4d'.repeat(32);
const SHA_UPI_2 = '5e'.repeat(32);

/** @param {string} role @param {string} agent @param {string} phone @returns {Person} */
const person = (role, agent, phone) => ({ line: 'line', phone, agent, role: /** @type {any} */ (role), name: role });

const owner = person('jcb_owner', 'agent:jcb-1', '919000000001');
const operator = person('operator', 'agent:jcb-1', '919000000002');
const contractor = person('contractor', 'agent:contractor-1', '919000000003');
const supervisor = person('supervisor', 'agent:contractor-1', '919000000004');
const supplier = person('supplier', 'agent:supplier-1', '919000000005');

const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/**
 * Three agents on local HTTP, each with its own keys and ledger, a clock the flow can move forward.
 * The contractor's agent has two peers; the sellers never talk to each other.
 */
async function setup() {
  const jk = generateKeys();
  const ck = generateKeys();
  const sk = generateKeys();
  let nowMs = Date.parse('2026-10-28T03:30:00Z'); // 09:00 IST
  const now = () => nowMs;
  /** @type {MessageType[]} */
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  /** @type {MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'];
  const pub = (/** @type {import('node:crypto').KeyObject} */ k) => publicKeyFromText(publicKeyText(k));
  const jcbCore = {
    self: { id: 'agent:jcb-1', privateKey: jk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: pub(ck.publicKey), mayReceiveFrom: new Set(toSeller) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const supCore = {
    self: { id: 'agent:supplier-1', privateKey: sk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: pub(ck.publicKey), mayReceiveFrom: new Set(toSeller) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const siteCore = {
    self: { id: 'agent:contractor-1', privateKey: ck.privateKey },
    peers: new Map([
      ['agent:jcb-1', { id: 'agent:jcb-1', publicKey: pub(jk.publicKey), mayReceiveFrom: new Set(toContractor) }],
      ['agent:supplier-1', { id: 'agent:supplier-1', publicKey: pub(sk.publicKey), mayReceiveFrom: new Set([...toContractor, /** @type {MessageType} */ ('DELIVERY')]) }],
    ]),
    ledger: openLedger(':memory:'),
    now,
  };
  const peerUrls = new Map();
  const jcbLink = createLink(jcbCore, { peerUrls, transport: sendToAgent });
  const siteLink = createLink(siteCore, { peerUrls, transport: sendToAgent });
  const supLink = createLink(supCore, { peerUrls, transport: sendToAgent });
  const silent = () => {};
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: silent });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: silent, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1' });
  const sup = createSupplierAgent({ agent: supCore, link: supLink, tell: silent });

  /** @type {import('node:http').Server[]} */
  const servers = [];
  for (const [core, a, name] of /** @type {const} */ ([[jcbCore, jcb, 'jcb'], [siteCore, site, 'site'], [supCore, sup, 'supplier']])) {
    /** @type {any} */
    let handle = null;
    const server = createServer(async (req, res) => {
      if (!(await handle(req, res))) res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    const baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    handle = createA2AHandler(core, agentCardJson({ id: core.self.id, name, description: name, baseUrl, publicKeyText: publicKeyText(core.self.privateKey) }), { onApplied: (m) => { void a.onApplied(m); } });
    peerUrls.set(core.self.id, baseUrl);
    servers.push(server);
  }
  return {
    jcb, site, sup, jcbCore, siteCore, supCore,
    advance: (/** @type {number} */ minutes) => { nowMs += minutes * 60_000; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

/** @param {import('../../src/agents/common.js').Said} r @param {string} step */
function must(r, step) {
  if (!r.ok) throw new Error(`sample: ${step} failed with ${r.key}`);
  return r;
}

const settle = () => new Promise((res) => setImmediate(res));

/**
 * The JCB job: request → yes (₹1,200/h) → start and end meter → bill 6.1 h → dispute 5.5 h →
 * correction → accept → payment claim → settled.
 * @param {Awaited<ReturnType<typeof setup>>} s
 */
async function jcbJob(s) {
  must(await runTool(s.site.tools, supervisor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } }), 'request_jcb');
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  s.advance(25);
  must(await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } }), 'reply_booking');
  s.advance(23 * 60 + 10); // next morning, 08:05 IST
  must(await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_START, takenAt: '2026-10-29T02:33:00Z' } }), 'meter start');
  s.advance(6 * 60 + 20);
  must(await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_END, takenAt: '2026-10-29T08:52:00Z' } }), 'meter end');
  s.advance(40);
  must(await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } }), 'send_bill');
  s.advance(95);
  must(await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 55, reason: 'machine stood 36 minutes for the lunch break' } }), 'dispute_bill');
  s.advance(30);
  must(await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 55 } }), 'send_correction');
  s.advance(12);
  must(await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } }), 'accept_bill');
  s.advance(20 * 60);
  must(await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 660000, utr: '000000000001', paidOn: '2026-10-30', screenshotSha256: SHA_UPI } }), 'claim_payment');
  s.advance(50);
  must(await runTool(s.jcb.tools, owner, { tool: 'confirm_payment', args: { orderId } }), 'confirm_payment');
  await settle();
}

/**
 * The material job with the supplier: 50 bags of cement → yes at ₹350/बोरी → delivery with challan
 * 412 → the site counts 48 → bill 50 × ₹350 → dispute 48 → correction → accept → payment claim →
 * settled. The site's count is a local NOTE on the contractor's ledger only.
 * @param {Awaited<ReturnType<typeof setup>>} s
 */
async function materialJob(s) {
  s.advance(30);
  must(await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-31', time: '09:00', items: [CEMENT] } }), 'request_material');
  const order = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders().find((/** @type {any} */ o) => o.kind === 'material'));
  const orderId = order.order_id;
  s.advance(40);
  must(await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } }), 'reply_order');
  s.advance(22 * 60 + 15); // 31 Oct, 09:10 IST
  must(await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_CHALLAN, challanNo: '412' } }), 'record_delivery');
  await settle();
  s.advance(35);
  must(await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [4800] } }), 'confirm_count');
  s.advance(50);
  must(await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } }), 'send_bill (material)');
  s.advance(70);
  must(await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, reason: 'साइट पर 48 बोरी गिनी' } }), 'dispute_bill (material)');
  s.advance(45);
  must(await runTool(s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [4800] } }), 'send_correction (material)');
  s.advance(15);
  must(await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } }), 'accept_bill (material)');
  s.advance(26 * 60);
  must(await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 1680000, utr: '000000000002', paidOn: '2026-11-01', screenshotSha256: SHA_UPI_2 } }), 'claim_payment (material)');
  s.advance(40);
  must(await runTool(s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId } }), 'confirm_payment (material)');
  await settle();
}

/**
 * Runs both jobs and returns the three ledgers as the export.
 * @returns {Promise<Export>}
 */
export async function buildSample() {
  const s = await setup();
  try {
    await jcbJob(s);
    await materialJob(s);

    /** @param {typeof s.jcbCore} core @returns {LedgerExport} */
    const dump = (core) => {
      const orders = /** @type {LedgerExport['orders']} */ (core.ledger.orders());
      const events = orders.flatMap((o) => core.ledger.events(o.order_id)).sort((a, b) => a.seq - b.seq);
      const refs = openRefs(core.ledger);
      /** @type {Record<string, string>} */
      const refByOrder = {};
      for (const o of orders) {
        const ref = refs.refOf(o.order_id);
        if (ref !== null) refByOrder[o.order_id] = ref;
      }
      return { agentId: core.self.id, publicKey: publicKeyText(core.self.privateKey), orders, events, chain: core.ledger.verifyChain(), refs: refByOrder };
    };
    return { v: 'hb-export/0.1', exportedAt: new Date(s.jcbCore.now()).toISOString(), jcb: dump(s.jcbCore), contractor: dump(s.siteCore), supplier: dump(s.supCore) };
  } finally {
    await s.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL('./export.json', import.meta.url);
  const sample = await buildSample();
  writeFileSync(out, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(out)}: ${sample.jcb.events.length} JCB events, ${sample.contractor.events.length} contractor events, ${sample.supplier.events.length} supplier events`);
}
