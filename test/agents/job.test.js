// A whole JCB job between the two agents over real A2A HTTP: booking, meter readings, bill,
// dispute, correction, acceptance, payment claim, settlement. Both ledgers must agree at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { openLedger } from '../../src/ledger/store.js';
import { agentCardJson, createA2AHandler } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { runTool } from '../../src/agents/common.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */
/** @typedef {import('../../src/wa/directory.js').Person} Person */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

/** @param {string} role @param {string} agent @returns {Person} */
const person = (role, agent) => ({ line: 'line', phone: '919000000001', agent, role: /** @type {any} */ (role), name: role });

async function setup() {
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
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: (role, key, params) => { told.push(['jcb', role, key, params]); } });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: (role, key, params) => { told.push(['site', role, key, params]); }, jcbAgentId: 'agent:jcb-1' });

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
    jcb, site, jcbCore, siteCore, told, net, siteLink,
    advance: (/** @type {number} */ ms) => { nowMs += ms; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = person('operator', 'agent:jcb-1');
const contractor = person('contractor', 'agent:contractor-1');
const supervisor = person('supervisor', 'agent:contractor-1');

test('a whole JCB job, from booking to settled, leaves both ledgers in agreement', async () => {
  const s = await setup();
  try {
    let r = await runTool(s.site.tools, supervisor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } });
    assert.deepEqual([r.ok, r.key], [true, 'site.jcb_requested']);
    const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'requested');
    await new Promise((res) => setImmediate(res));
    assert.ok(s.told.some(([a, role, key, p]) => a === 'jcb' && role === 'jcb_owner' && key === 'jcb.booking_request' && p.site === 'Shivpuri' && p.hours === '6.0'));

    // "Yes" needs a rate; the rate is what the bill will use.
    r = await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes' } });
    assert.deepEqual([r.ok, r.key], [false, 'jcb.rate_needed']);
    r = await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
    assert.equal(r.ok, true);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'booked');

    // Meter readings, confirmed by the operator. The end must be after the start.
    r = await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
    assert.deepEqual([r.ok, r.key], [false, 'jcb.start_first']);
    r = await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_A, takenAt: '2026-10-29T02:35:00Z' } });
    assert.equal(r.ok, true);
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'working');
    r = await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12300, sha256: SHA_B } });
    assert.equal(r.key, 'jcb.end_not_after_start');
    r = await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
    assert.deepEqual([r.ok, r.params?.hours], [true, '6.1']);

    // Only the owner sends the bill: 6.1 h × ₹1,200 = ₹7,320, both photos as evidence.
    r = await runTool(s.jcb.tools, operator, { tool: 'send_bill', args: { orderId } });
    assert.deepEqual([r.ok, r.key], [false, 'common.not_allowed']);
    r = await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    assert.deepEqual([r.ok, r.params?.total], [true, '₹7,320']);
    const bill = s.siteCore.ledger.events(orderId).find((e) => e.type === 'BILL');
    assert.ok(bill);
    assert.deepEqual(bill.body.body.evidence.map((/** @type {any} */ e) => [e.sha256, e.readValue]), [[SHA_A, '1234.5'], [SHA_B, '1240.6']]);
    await new Promise((res) => setImmediate(res));
    assert.ok(s.told.some(([a, role, key, p]) => a === 'site' && role === 'supervisor' && key === 'site.bill_received' && p.total === '₹7,320' && p.photos === 2));

    // The supervisor cannot accept or dispute; the contractor disputes with the site's figure.
    r = await runTool(s.site.tools, supervisor, { tool: 'accept_bill', args: { orderId } });
    assert.equal(r.key, 'common.not_allowed');
    r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 55, reason: 'lunch break of 36 minutes' } });
    assert.equal(r.ok, true);
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'disputed');

    // The owner corrects; the first bill stays in both histories.
    r = await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 55 } });
    assert.deepEqual([r.ok, r.params?.total], [true, '₹6,600']);
    r = await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } });
    assert.equal(r.ok, true);

    // The payment claim is a claim; settling needs the owner.
    r = await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 660000, utr: 'UTR123456789', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.equal(r.ok, true);
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'payment_claimed');
    r = await runTool(s.jcb.tools, operator, { tool: 'confirm_payment', args: { orderId } });
    assert.equal(r.key, 'common.not_allowed');
    r = await runTool(s.jcb.tools, owner, { tool: 'confirm_payment', args: { orderId } });
    assert.deepEqual([r.ok, r.params?.amount], [true, '₹6,600']);

    for (const core of [s.jcbCore, s.siteCore]) {
      const v = core.ledger.view(orderId);
      assert.deepEqual([v.state, v.billRev], ['settled', 2]);
      assert.equal(core.ledger.verifyChain().ok, true);
    }
    // Both sides hold the same signed messages (the JCB side also has its local meter evidence).
    const signed = (/** @type {any} */ core) => core.ledger.events(orderId).filter((/** @type {any} */ e) => e.direction !== 'local' && e.type !== 'RECEIPT').map((/** @type {any} */ e) => e.msgId).sort();
    assert.deepEqual(signed(s.jcbCore), signed(s.siteCore));
    await new Promise((res) => setImmediate(res));
    assert.ok(s.told.some(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.settled'));
  } finally {
    await s.close();
  }
});

test('when the other agent cannot be reached, the message waits and is delivered unchanged later', async () => {
  const s = await setup();
  try {
    s.net.up = false;
    const r = await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29' } });
    assert.deepEqual([r.ok, r.key], [false, 'common.pending']);
    assert.equal(s.siteLink.pending().length, 1);
    assert.equal(s.jcbCore.ledger.orders().length, 0);
    s.net.up = true;
    const again = await s.siteLink.retryPending();
    assert.equal(again[0].ok, true);
    assert.equal(s.siteLink.pending().length, 0);
    assert.equal(s.jcbCore.ledger.orders().length, 1);
  } finally {
    await s.close();
  }
});

test('steps that do not fit are refused before anything is signed', async () => {
  const s = await setup();
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29' } });
    const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
    const before = s.jcbCore.ledger.events(orderId).length;
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } })).key, 'jcb.readings_missing');
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'confirm_payment', args: { orderId } })).key, 'common.wrong_state');
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId: '00000000-0000-4000-8000-000000000000', answer: 'no' } })).key, 'common.no_such_order');
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'drop_tables', args: {} })).key, 'common.unknown_step');
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, reason: 'x' } })).key, 'site.figure_needed');
    assert.equal(s.jcbCore.ledger.events(orderId).length, before);
  } finally {
    await s.close();
  }
});
