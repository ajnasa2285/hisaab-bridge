// Makes web/sample/export.json: one whole JCB job run by the real agents (src/agents) over real
// A2A HTTP between two in-memory ledgers, with invented names and numbers only. The shape of the
// export is documented in web/README.md. Run: node web/sample/make-sample.js
//
// Each run makes fresh keys, so the file changes every time; the signatures inside it verify with
// the public keys it carries (test/web/sample.test.js checks that).

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { agentCardJson, createA2AHandler, sendToAgent } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { runTool } from '../../src/agents/common.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';

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
 */
/** @typedef {{v: 'hb-export/0.1', exportedAt: string, jcb: LedgerExport, contractor: LedgerExport}} Export */

// Invented photo fingerprints: the sample has no real images.
const SHA_START = '1a'.repeat(32);
const SHA_END = '2b'.repeat(32);
const SHA_UPI = '3c'.repeat(32);

/** @param {string} role @param {string} agent @param {string} phone @returns {Person} */
const person = (role, agent, phone) => ({ line: 'line', phone, agent, role: /** @type {any} */ (role), name: role });

const owner = person('jcb_owner', 'agent:jcb-1', '919000000001');
const operator = person('operator', 'agent:jcb-1', '919000000002');
const contractor = person('contractor', 'agent:contractor-1', '919000000003');
const supervisor = person('supervisor', 'agent:contractor-1', '919000000004');

/**
 * Two agents on local HTTP, each with its own keys and ledger, a clock the flow can move forward.
 */
async function setup() {
  const jk = generateKeys();
  const ck = generateKeys();
  let nowMs = Date.parse('2026-10-28T03:30:00Z'); // 09:00 IST
  const now = () => nowMs;
  /** @type {MessageType[]} */
  const toJcb = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  /** @type {MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'];
  const jcbCore = {
    self: { id: 'agent:jcb-1', privateKey: jk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: publicKeyFromText(publicKeyText(ck.publicKey)), mayReceiveFrom: new Set(toJcb) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const siteCore = {
    self: { id: 'agent:contractor-1', privateKey: ck.privateKey },
    peers: new Map([['agent:jcb-1', { id: 'agent:jcb-1', publicKey: publicKeyFromText(publicKeyText(jk.publicKey)), mayReceiveFrom: new Set(toContractor) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const peerUrls = new Map();
  const jcbLink = createLink(jcbCore, { peerUrls, transport: sendToAgent });
  const siteLink = createLink(siteCore, { peerUrls, transport: sendToAgent });
  const silent = () => {};
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: silent });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: silent, jcbAgentId: 'agent:jcb-1' });

  /** @type {import('node:http').Server[]} */
  const servers = [];
  for (const [core, a, name] of /** @type {const} */ ([[jcbCore, jcb, 'jcb'], [siteCore, site, 'site']])) {
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
    jcb, site, jcbCore, siteCore,
    advance: (/** @type {number} */ minutes) => { nowMs += minutes * 60_000; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

/** @param {import('../../src/agents/common.js').Said} r @param {string} step */
function must(r, step) {
  if (!r.ok) throw new Error(`sample: ${step} failed with ${r.key}`);
  return r;
}

/**
 * Runs the job: request → yes (₹1,200/h) → start and end meter → bill 6.1 h → dispute 5.5 h →
 * correction → accept → payment claim → settled. Returns both ledgers as the export.
 * @returns {Promise<Export>}
 */
export async function buildSample() {
  const s = await setup();
  try {
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
    await new Promise((res) => setImmediate(res));

    /** @param {typeof s.jcbCore} core @returns {LedgerExport} */
    const dump = (core) => {
      const orders = /** @type {LedgerExport['orders']} */ (core.ledger.orders());
      const events = orders.flatMap((o) => core.ledger.events(o.order_id)).sort((a, b) => a.seq - b.seq);
      return { agentId: core.self.id, publicKey: publicKeyText(core.self.privateKey), orders, events, chain: core.ledger.verifyChain() };
    };
    return { v: 'hb-export/0.1', exportedAt: new Date(s.jcbCore.now()).toISOString(), jcb: dump(s.jcbCore), contractor: dump(s.siteCore) };
  } finally {
    await s.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL('./export.json', import.meta.url);
  const sample = await buildSample();
  writeFileSync(out, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(out)}: ${sample.jcb.events.length} JCB events, ${sample.contractor.events.length} contractor events`);
}
