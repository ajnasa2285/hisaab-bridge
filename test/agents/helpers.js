// Three real agents (JCB, contractor, supplier) over real A2A HTTP with in-memory ledgers, for the
// agent tests. The contractor's agent has two peers; the JCB and supplier agents have one each.

import { createServer } from 'node:http';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { agentCardJson, createA2AHandler } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';
import { createSupplierAgent } from '../../src/agents/supplier.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */
/** @typedef {import('../../src/wa/directory.js').Person} Person */

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const SHA_C = 'c'.repeat(64);

/** @param {string} role @param {string} agent @returns {Person} */
export const person = (role, agent) => ({ line: 'line', phone: '919000000001', agent, role: /** @type {any} */ (role), name: role });

/** @param {{onTell?: (side: string, role: string, key: string, params: any, expect: any) => void, siteLedgerFile?: string, spark?: (req: any) => Promise<any>}} [o] */
export async function setup(o = {}) {
  const jk = generateKeys();
  const ck = generateKeys();
  const sk = generateKeys();
  let nowMs = Date.parse('2026-10-29T02:30:00Z');
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
    ledger: openLedger(o.siteLedgerFile ?? ':memory:'),
    now,
  };

  /** @type {[string, string, string, any][]} who was told what: [agent, role, key, params] */
  const told = [];
  const peerUrls = new Map();
  /** @type {{up: boolean}} */
  const net = { up: true };
  /** @type {(u: string, m: any) => Promise<unknown>} */
  const transport = async (u, m) => {
    if (!net.up) throw new Error('down');
    const { sendToAgent } = await import('../../src/transport/a2a.js');
    return sendToAgent(u, m);
  };
  /** @param {string} side @returns {import('../../src/agents/common.js').Tell} */
  const tellFor = (side) => (role, key, params, expect) => { told.push([side, role, key, params]); o.onTell?.(side, role, key, params, expect); };
  const jcbLink = createLink(jcbCore, { peerUrls, transport });
  const siteLink = createLink(siteCore, { peerUrls, transport });
  const supLink = createLink(supCore, { peerUrls, transport });
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: tellFor('jcb'), spark: o.spark });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: tellFor('site'), spark: o.spark, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1' });
  const sup = createSupplierAgent({ agent: supCore, link: supLink, tell: tellFor('supplier'), spark: o.spark });

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
    jcb, site, sup, jcbCore, siteCore, supCore, told, net, siteLink, jcbLink, supLink,
    advance: (/** @type {number} */ ms) => { nowMs += ms; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

/**
 * A stand-in for classifyPhoto that always sees one kind.
 * @param {'meter' | 'upi' | 'challan' | 'other'} kind @param {boolean} [clear]
 * @returns {import('../../src/agents/conversation.js').PhotoClassifier}
 */
export const seesPhoto = (kind, clear = true) => async () => ({ ok: true, kind, clear, model: 'stand-in', latencyMs: 1 });
