// Two real agents over real A2A HTTP with in-memory ledgers, for the agent tests.

import { createServer } from 'node:http';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { agentCardJson, createA2AHandler } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */
/** @typedef {import('../../src/wa/directory.js').Person} Person */

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const SHA_C = 'c'.repeat(64);

/** @param {string} role @param {string} agent @returns {Person} */
export const person = (role, agent) => ({ line: 'line', phone: '919000000001', agent, role: /** @type {any} */ (role), name: role });

/** @param {{onTell?: (side: string, role: string, key: string, params: any, expect: any) => void}} [o] */
export async function setup(o = {}) {
  const jk = generateKeys();
  const ck = generateKeys();
  let nowMs = Date.parse('2026-10-29T02:30:00Z');
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
  const jcbLink = createLink(jcbCore, { peerUrls, transport });
  const siteLink = createLink(siteCore, { peerUrls, transport });
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: (role, key, params, expect) => { told.push(['jcb', role, key, params]); o.onTell?.('jcb', role, key, params, expect); } });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: (role, key, params, expect) => { told.push(['site', role, key, params]); o.onTell?.('site', role, key, params, expect); }, jcbAgentId: 'agent:jcb-1' });

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
    jcb, site, jcbCore, siteCore, told, net, siteLink, jcbLink,
    advance: (/** @type {number} */ ms) => { nowMs += ms; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

