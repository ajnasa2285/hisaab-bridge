// A contractor or supervisor who missed a notice outside WhatsApp's 24-hour window, through the
// assembled app: when they next write they are told what still waits for them, rebuilt from the ledger,
// and it asks for "हाँ <ref>" (no expectation is set, so a plain "हाँ" decides nothing). Then their own
// message is handled. Graph API and model are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from '../src/app.js';
import { runTool, ofType } from '../src/agents/common.js';
import { missedWaiting } from '../src/agents/payment-view.js';
import { t } from '../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B } from './agents/helpers.js';

const CONTRACTOR = '919000000061';
const SUPERVISOR = '919000000062';
const SECOND = '919000000063';
const SITE_ID = 'agent:contractor-1';
const SHA = 'd'.repeat(64);
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** @typedef {import('../src/wa/directory.js').Person} Person */
const site = (/** @type {string} */ phone, /** @type {any} */ role) => /** @type {Person} */ ({ line: 'line-site', phone, agent: SITE_ID, role, name: role });
const contractor = site(CONTRACTOR, 'contractor');
const supervisor = site(SUPERVISOR, 'supervisor');
const supplier = /** @type {Person} */ ({ line: 'line-site', phone: '919000000064', agent: 'agent:supplier-1', role: 'supplier', name: 'supplier' });
const owner = /** @type {Person} */ ({ line: 'line-site', phone: '919000000065', agent: 'agent:jcb-1', role: 'jcb_owner', name: 'owner' });
const operator = /** @type {Person} */ ({ line: 'line-site', phone: '919000000066', agent: 'agent:jcb-1', role: 'operator', name: 'operator' });

/** The whole app, three agents talking over HTTP, nobody having written yet. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-missed-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {{failNext: number, sparks: number, nowMs: number, calls: {name: string, args: any}[]}} */
  const state = { failNext: 0, sparks: 0, nowMs: Date.parse('2026-10-29T02:30:00Z'), calls: [] };
  /** @type {typeof globalThis.fetch} */
  const fetch = async (_input, init) => {
    if (state.failNext > 0) { state.failNext -= 1; return new Response('{}', { status: 500 }); }
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ to: body.to, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** @type {any} */
  let app = null;
  const server = createServer(async (req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const [jk, ck, sk] = [generateKeys(), generateKeys(), generateKeys()];
  const peer = (/** @type {string} */ id, /** @type {any} */ key, /** @type {any[]} */ types) => ({ id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) });
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'CANCEL', 'RECEIPT', 'REFUSE', 'SITE_RECEIPT'];
  const toSite = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'CANCEL', 'RECEIPT', 'REFUSE', 'DELIVERY'];
  app = createApp({
    baseUrl: base,
    agents: [
      { name: 'jcb', kind: 'jcb', id: 'agent:jcb-1', title: 'JCB', privateKey: jk.privateKey, ledgerFile: join(dir, 'jcb.db'),
        peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
      { name: 'supplier', kind: 'supplier', id: 'agent:supplier-1', title: 'Supplier', privateKey: sk.privateKey, ledgerFile: join(dir, 'supplier.db'),
        peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: SITE_ID, title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer('agent:jcb-1', jk.publicKey, toSite), peer('agent:supplier-1', sk.publicKey, toSite)],
        peerUrls: { 'agent:jcb-1': `${base}/agents/jcb`, 'agent:supplier-1': `${base}/agents/supplier` }, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1' },
    ],
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v', accessToken: 'tok' }],
    people: [contractor, supervisor, site(SECOND, 'contractor')],
    waStoreFile: join(dir, 'wa.db'),
    spark: async () => { state.sparks += 1; const toolCalls = state.calls; state.calls = []; return { ok: /** @type {const} */ (true), toolCalls }; },
    fetch,
    now: () => state.nowMs,
    log: (/** @type {string} */ l) => { logs.push(l); },
  });
  tc.after(async () => {
    tc.mock.timers.reset();
    await new Promise((r) => server.close(() => r(undefined)));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** What the other agent's message set off has finished: the logs and sends have stopped moving. */
  const quiet = async () => {
    let seen = -1;
    for (let i = 0; i < 200; i += 1) {
      const now = logs.length + sent.length;
      if (now === seen) return;
      seen = now;
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  let n = 0;
  const siteEntry = app.agent(SITE_ID);
  const supEntry = app.agent('agent:supplier-1');
  const jcbEntry = app.agent('agent:jcb-1');
  /** @param {string} phone @param {string} text */
  const say = async (phone, text) => {
    n += 1;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
      messages: [{ from: phone, id: `wamid.in${n}`, timestamp: String(Math.floor(state.nowMs / 1000)), type: 'text', text: { body: text } }] } }] }] });
    const r = await globalThis.fetch(`${base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret-site').update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
    await quiet();
  };
  /** @param {any} entry @param {Person} who @param {string} tool @param {Record<string, any>} args */
  const run = async (entry, who, tool, args) => {
    const r = await runTool(entry.agent.tools, who, { tool, args });
    assert.equal(r.ok, true, `${tool}: ${r.key}`);
    await quiet();
    return r;
  };
  /** A material order up to where the contractor is asked about its bill. @param {{count?: boolean, bill?: boolean}} [o] */
  const material = async (o = {}) => {
    state.nowMs += 1000; // Orders list by when they were made; on a tie, by their random id.
    const before = new Set(siteEntry.core.ledger.orders().map((/** @type {any} */ x) => x.order_id));
    await run(siteEntry, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
    const orderId = String(siteEntry.core.ledger.orders().find((/** @type {any} */ x) => !before.has(x.order_id)).order_id);
    await run(supEntry, supplier, 'reply_order', { orderId, answer: 'yes', ratesPaise: [38000] });
    await run(supEntry, supplier, 'record_delivery', { orderId, items: [CEMENT], sha256: SHA });
    if (o.count !== false) await run(siteEntry, contractor, 'confirm_count', { orderId, qtysHundredths: [5000] });
    if (o.bill !== false) await run(supEntry, supplier, 'send_bill', { orderId });
    return orderId;
  };
  return { app, sent, logs, state, say, run, material, quiet, siteEntry, supEntry, jcbEntry,
    to: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).map((s) => s.text),
    stateOf: (/** @type {string} */ orderId) => siteEntry.core.ledger.view(orderId).state,
    accepts: (/** @type {string} */ orderId) => ofType(siteEntry.core.ledger.events(orderId), 'ACCEPT', 'out').length };
}

test('a missed bill is told when the contractor next writes, once, and their message is still handled', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  assert.deepEqual(d.to(CONTRACTOR), [], 'the window was closed');
  await d.say(CONTRACTOR, 'मदद');
  const [bill, help, ...rest] = d.to(CONTRACTOR);
  assert.deepEqual(rest, []);
  assert.ok(bill.includes('P-1') && bill.includes('Rampur') && bill.includes('₹19,000'), bill);
  assert.ok(bill.includes('"हाँ P-1"'), bill);
  assert.ok(!bill.includes('"हाँ" लिखें'), 'never the one-word form');
  assert.equal(help, t('help.contractor'), 'then their own message is handled');
  assert.equal(d.stateOf(orderId), 'billed', 'telling decides nothing');
  await d.say(CONTRACTOR, 'मदद');
  assert.equal(d.to(CONTRACTOR).filter((x) => x.includes('₹19,000')).length, 1, 'never twice');
});

test('a plain "हाँ", even as the message that opened the window, accepts nothing; "हाँ P-1" reads the bill back, then "हाँ" accepts only that bill', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(CONTRACTOR, 'हाँ');
  const words = d.to(CONTRACTOR);
  assert.equal(words.length, 2, words.join(' | '));
  assert.ok(words[0].includes('"हाँ P-1"'), words[0]);
  assert.equal(words[1], t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  assert.equal(d.state.sparks, 0, 'no model reads that yes');
  await d.say(CONTRACTOR, 'हाँ');
  assert.equal(d.to(CONTRACTOR).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  assert.deepEqual([d.stateOf(orderId), d.accepts(orderId)], ['billed', 0]);

  await d.say(CONTRACTOR, 'हाँ P-1');
  assert.equal(d.to(CONTRACTOR).at(-1), t('step.accept_bill', { ref: 'P-1', site: 'Rampur', total: '₹19,000' }));
  assert.deepEqual([d.stateOf(orderId), d.accepts(orderId)], ['billed', 0], 'a read-back still');
  await d.say(CONTRACTOR, 'हाँ');
  assert.deepEqual([d.stateOf(orderId), d.accepts(orderId)], ['accepted', 1]);
  const accept = ofType(d.siteEntry.core.ledger.events(orderId), 'ACCEPT', 'out')[0];
  const view = d.siteEntry.core.ledger.view(orderId);
  assert.equal(accept.body.body.bill, view.currentBill);
});

test('with two missed bills both are told; "हाँ" names neither; "हाँ P-2" reaches P-2 and leaves P-1 open', async (tc) => {
  const d = await desk(tc);
  const first = await d.material();
  const second = await d.material();
  await d.say(CONTRACTOR, 'हाँ');
  const words = d.to(CONTRACTOR);
  assert.equal(words.length, 3, words.join(' | '));
  assert.ok(words[0].includes('"हाँ P-1"') && words[1].includes('"हाँ P-2"'));
  assert.equal(words[2], t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1, P-2' }));
  await d.say(CONTRACTOR, 'हाँ P-2');
  await d.say(CONTRACTOR, 'हाँ');
  assert.deepEqual([d.stateOf(first), d.stateOf(second)], ['billed', 'accepted']);
  // P-1 is still open, so a bare yes still names it, and P-2 no longer.
  await d.say(CONTRACTOR, 'हाँ');
  assert.equal(d.to(CONTRACTOR).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  assert.equal(d.stateOf(first), 'billed');
});

test('a bare yes is back to the usual path once the while after the replay has passed: never at once on the bill', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(CONTRACTOR, 'मदद');
  d.state.nowMs += 31 * 60 * 1000;
  await d.say(CONTRACTOR, 'हाँ');
  assert.ok(d.state.sparks > 0, 'read against the open question, as any free text');
  assert.equal(d.stateOf(orderId), 'billed');
});

test('a missed bill since replaced shows the bill in force, once', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material({ count: false });
  await d.run(d.supEntry, supplier, 'send_correction', { orderId, qtysHundredths: [4800] });
  await d.say(CONTRACTOR, 'मदद');
  const [bill, help, ...rest] = d.to(CONTRACTOR);
  assert.deepEqual(rest, []);
  assert.equal(help, t('help.contractor'));
  assert.ok(bill.includes('₹18,240'), bill);
  assert.ok(!bill.includes('₹19,000'), 'never the replaced figure');
  assert.ok(bill.includes('"हाँ P-1"'), bill);
  await d.say(CONTRACTOR, 'हाँ P-1');
  await d.say(CONTRACTOR, 'हाँ');
  const events = d.siteEntry.core.ledger.events(orderId);
  assert.equal(ofType(events, 'ACCEPT', 'out')[0].body.body.bill, ofType(events, 'CORRECTION', 'in')[0].msgId);
});

test('a missed bill since settled, or objected to, stays silent', async (tc) => {
  const d = await desk(tc);
  const settled = await d.material();
  const disputed = await d.material();
  await d.run(d.siteEntry, contractor, 'accept_bill', { orderId: settled });
  await d.run(d.supEntry, supplier, 'record_received', { orderId: settled, amountPaise: 1900000, method: 'cash', receivedOn: '2026-10-29' });
  assert.equal(d.stateOf(settled), 'settled');
  await d.run(d.siteEntry, contractor, 'dispute_bill', { orderId: disputed, totalPaise: 1800000, reason: 'कम आया' });
  assert.equal(d.stateOf(disputed), 'disputed');
  await d.say(CONTRACTOR, 'मदद');
  assert.deepEqual(d.to(CONTRACTOR), [t('help.contractor')]);
});

test('a missed count question reaches the supervisor; a plain "हाँ" records nothing; "हाँ P-1" is the count; told-only notices do not come back', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material({ count: false, bill: false });
  await d.say(SUPERVISOR, 'हाँ');
  const words = d.to(SUPERVISOR);
  assert.ok(words.some((x) => x.includes('सीमेंट 50 बोरी') && x.includes('"हाँ P-1"')), words.join(' | '));
  assert.equal(words.at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  const counts = () => ofType(d.siteEntry.core.ledger.events(orderId), 'NOTE', 'local').filter((e) => e.body.kind === 'site_count');
  assert.equal(counts().length, 0);

  await d.say(SUPERVISOR, 'हाँ P-1');
  assert.deepEqual(counts().map((e) => [e.body.by, e.body.how]), [['supervisor', 'yes']]);
  assert.ok(d.to(SUPERVISOR).at(-1)?.includes('चालान जितनी'), d.to(SUPERVISOR).at(-1));
  // A later bare yes has nothing left to say about P-1.
  const before = d.state.sparks;
  await d.say(SUPERVISOR, 'हाँ');
  assert.ok(d.state.sparks > before);

  await d.say(CONTRACTOR, 'मदद');
  assert.deepEqual(d.to(CONTRACTOR), [t('help.contractor')], 'delivery info and the count told are told only');
});

test('a count question since answered stays silent for the supervisor', async (tc) => {
  const d = await desk(tc);
  await d.material({ bill: false });
  await d.say(SUPERVISOR, 'मदद');
  assert.deepEqual(d.to(SUPERVISOR), [t('help.supervisor')]);
});

test('a supervisor\'s "हाँ <ref>" on anything but an uncounted delivery stays what it was', async (tc) => {
  const d = await desk(tc);
  await d.material();
  await d.say(SUPERVISOR, 'हाँ P-1');
  assert.equal(d.to(SUPERVISOR).at(-1), t('office.only_contractor'));
});

test('a missed approval request is told; a plain "हाँ" decides nothing; another contractor\'s decision silences it', async (tc) => {
  const d = await desk(tc);
  d.state.calls = [{ name: 'request_material', args: { site: 'Rampur', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } }];
  await d.say(SUPERVISOR, 'कल Rampur सीमेंट 50 बोरी');
  assert.ok(d.logs.some((l) => l.includes('not sent: outside 24h window')));
  const [held] = d.app.agent(SITE_ID).office.held();
  assert.equal(held.decision, null);

  await d.say(CONTRACTOR, 'हाँ');
  const words = d.to(CONTRACTOR);
  assert.ok(words[0].includes(`"OK ${held.ref}"`), words[0]);
  assert.equal(words[1], t('site.yes_needs_ref', { ref: held.ref, refs: held.ref }));
  assert.equal(d.app.agent(SITE_ID).office.held()[0].decision, null);

  await d.say(CONTRACTOR, `OK ${held.ref}`);
  assert.equal(d.app.agent(SITE_ID).office.held()[0].decision.decision, 'ok');
  assert.equal(d.supEntry.core.ledger.orders().length, 1, 'the order went out');

  await d.say(SECOND, 'मदद');
  assert.deepEqual(d.to(SECOND), [t('help.contractor')]);
});

test('a JCB bill comes back the same way', async (tc) => {
  const d = await desk(tc);
  await d.run(d.siteEntry, contractor, 'request_jcb', { site: 'Rampur', day: '2026-10-30', hoursTenths: 60 });
  const orderId = String(d.siteEntry.core.ledger.orders()[0].order_id);
  await d.run(d.jcbEntry, owner, 'reply_booking', { orderId, answer: 'yes', ratePaise: 120000 });
  await d.run(d.jcbEntry, operator, 'record_meter', { orderId, which: 'start', valueTenths: 100, sha256: SHA_A });
  await d.run(d.jcbEntry, operator, 'record_meter', { orderId, which: 'end', valueTenths: 160, sha256: SHA_B });
  await d.run(d.jcbEntry, owner, 'send_bill', { orderId });
  await d.say(CONTRACTOR, 'हाँ');
  const [bill, nudge] = d.to(CONTRACTOR);
  assert.ok(bill.includes('J-1') && bill.includes('₹7,200') && bill.includes('"हाँ J-1"'), bill);
  assert.equal(nudge, t('site.yes_needs_ref', { ref: 'J-1', refs: 'J-1' }));
  assert.equal(d.stateOf(orderId), 'billed');
});

test('another day a seller offered comes back to both, and not once it was asked for again', async (tc) => {
  const d = await desk(tc);
  await d.run(d.siteEntry, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
  const orderId = String(d.siteEntry.core.ledger.orders()[0].order_id);
  await d.run(d.supEntry, supplier, 'reply_order', { orderId, answer: 'other_time', day: '2026-10-31' });
  assert.equal(d.stateOf(orderId), 'offered');
  await d.say(SUPERVISOR, 'मदद');
  assert.ok(d.to(SUPERVISOR)[0].includes('P-1') && d.to(SUPERVISOR)[0].includes('31'), d.to(SUPERVISOR)[0]);
  await d.run(d.siteEntry, contractor, 'request_material', { orderId, site: 'Rampur', day: '2026-10-31', items: [CEMENT] });
  await d.say(CONTRACTOR, 'मदद');
  assert.deepEqual(d.to(CONTRACTOR), [t('help.contractor')]);
});

test('a notice whose send fails is kept and told at the next message; the message itself is still handled', async (tc) => {
  const d = await desk(tc);
  await d.material();
  d.state.failNext = 1;
  await d.say(CONTRACTOR, 'मदद');
  assert.deepEqual(d.to(CONTRACTOR), [t('help.contractor')]);
  await d.say(CONTRACTOR, 'मदद');
  const words = d.to(CONTRACTOR);
  assert.equal(words.length, 3, words.join(' | '));
  assert.ok(words[1].includes('"हाँ P-1"'), words[1]);
  await d.say(CONTRACTOR, 'मदद');
  assert.equal(d.to(CONTRACTOR).filter((x) => x.includes('₹19,000')).length, 1);
});

// The key recorded as missed can be "usual.notice" (withUsual), and it can change after it was missed.
test('a bill first told with the "usual" line is found under that key, and under any key of a bill on that reference', async () => {
  const contractorP = person('contractor', SITE_ID);
  const supplierP = person('supplier', 'agent:supplier-1');
  const s = await setup();
  const pause = () => new Promise((r) => setImmediate(r));
  /** @param {number} rate @param {boolean} accept */
  const order = async (rate, accept) => {
    const before = new Set(s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id));
    await runTool(s.site.tools, contractorP, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [CEMENT] } });
    const orderId = String(s.siteCore.ledger.orders().find((/** @type {any} */ o) => !before.has(o.order_id))?.order_id);
    await runTool(s.sup.tools, supplierP, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [rate] } });
    await runTool(s.sup.tools, supplierP, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A } });
    await pause();
    await runTool(s.site.tools, contractorP, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000], sameAsChallan: true } });
    await runTool(s.sup.tools, supplierP, { tool: 'send_bill', args: { orderId } });
    await pause();
    if (accept) await runTool(s.site.tools, contractorP, { tool: 'accept_bill', args: { orderId } });
    return orderId;
  };
  try {
    for (let i = 0; i < 3; i += 1) await order(38000, true);
    await order(90000, false);
    const told = s.told.filter(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'usual.notice').at(-1);
    assert.ok(told, 'the bill was first told with the usual line');
    const open = s.site.waiting('contractor');
    assert.equal(open.length, 1);
    assert.equal(open[0].key, 'usual.notice');
    const text = t(open[0].key, open[0].params);
    assert.ok(text.includes('"हाँ P-4"') && text.includes('सामान्य से अलग'), text);
    assert.ok(!text.includes('"हाँ" लिखें'));
    for (const key of ['usual.notice', 'site.material_bill_received', 'site.material_bill_received_invoice_differs', 'site.material_correction_received', 'site.material_bill_mismatch', 'site.material_bill_no_count']) {
      assert.deepEqual(missedWaiting([{ ref: 'P-4', key }], open), open, key);
    }
    // The wrong reference, and a told-only notice, do not bring it.
    assert.deepEqual(missedWaiting([{ ref: 'P-3', key: 'usual.notice' }], open), []);
    assert.deepEqual(missedWaiting([{ ref: 'P-4', key: 'site.delivery_info' }], open), []);
    assert.deepEqual(missedWaiting([{ ref: 'P-4', key: 'site.count_told_yes' }], open), []);
    assert.deepEqual(s.site.waiting('supervisor'), [], 'a bill is not the supervisor\'s');
  } finally { await s.close(); }
});
