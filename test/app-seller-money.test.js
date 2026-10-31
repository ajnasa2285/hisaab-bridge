// The sellers' side of money, through the assembled app: a notice about a reported payment told again
// after WhatsApp's 24-hour window (a plain "हाँ" right after it decides nothing; "हाँ <ref>" answers it),
// and an amount equal to money already confirmed on that order (told, with its date and method, and
// counted only on an explicit yes). Graph API and model are stand-ins; invented data only.

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
import { t } from '../src/i18n/index.js';
import { SHA_A, SHA_B } from './agents/helpers.js';

const CONTRACTOR = '919000000081';
const SUPPLIER = '919000000082';
const OWNER = '919000000083';
const OPERATOR = '919000000084';
const SITE_ID = 'agent:contractor-1';
const SHA = 'e'.repeat(64);
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** @typedef {import('../src/wa/directory.js').Person} Person */
const contractor = /** @type {Person} */ ({ line: 'line-site', phone: CONTRACTOR, agent: SITE_ID, role: 'contractor', name: 'contractor' });
const supplier = /** @type {Person} */ ({ line: 'line-site', phone: SUPPLIER, agent: 'agent:supplier-1', role: 'supplier', name: 'supplier' });
const owner = /** @type {Person} */ ({ line: 'line-site', phone: OWNER, agent: 'agent:jcb-1', role: 'jcb_owner', name: 'owner' });
const operator = /** @type {Person} */ ({ line: 'line-site', phone: OPERATOR, agent: 'agent:jcb-1', role: 'operator', name: 'operator' });

/** The whole app, three agents talking over HTTP, nobody having written yet. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-seller-money-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {string[]} */
  const logs = [];
  const state = { failNext: 0, sparks: 0, nowMs: Date.parse('2026-10-29T02:30:00Z') };
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
    people: [contractor, supplier, owner, operator],
    waStoreFile: join(dir, 'wa.db'),
    spark: async () => { state.sparks += 1; return { ok: /** @type {const} */ (true), toolCalls: [] }; },
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
  /** Every event in the three ledgers: the messages between agents arrive after a step's own reply. */
  const written = () => [...['agent:jcb-1', 'agent:supplier-1', SITE_ID].map((id) => app.agent(id).core.ledger)]
    .reduce((sum, l) => sum + l.orders().reduce((/** @type {number} */ c, /** @type {any} */ x) => c + l.events(x.order_id).length, 0), 0);
  /** What the other agent's message set off has finished: logs, sends and ledgers have stopped moving, twice running. */
  const quiet = async () => {
    let seen = -1;
    let still = 0;
    for (let i = 0; i < 300 && still < 2; i += 1) {
      const now = logs.length + sent.length + written();
      still = now === seen ? still + 1 : 0;
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
  /** A material order of ₹19,000, billed and accepted unless asked otherwise. @param {{accept?: boolean}} [o] */
  const material = async (o = {}) => {
    state.nowMs += 1000; // Orders list by when they were made; on a tie, by their random id.
    const before = new Set(siteEntry.core.ledger.orders().map((/** @type {any} */ x) => x.order_id));
    await run(siteEntry, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
    const orderId = String(siteEntry.core.ledger.orders().find((/** @type {any} */ x) => !before.has(x.order_id)).order_id);
    await run(supEntry, supplier, 'reply_order', { orderId, answer: 'yes', ratesPaise: [38000] });
    await run(supEntry, supplier, 'record_delivery', { orderId, items: [CEMENT], sha256: SHA });
    await run(siteEntry, contractor, 'confirm_count', { orderId, qtysHundredths: [5000], sameAsChallan: true });
    await run(supEntry, supplier, 'send_bill', { orderId });
    if (o.accept !== false) await run(siteEntry, contractor, 'accept_bill', { orderId });
    return orderId;
  };
  /** A JCB job of ₹7,200, billed and accepted. */
  const jcbJob = async () => {
    state.nowMs += 1000;
    const before = new Set(siteEntry.core.ledger.orders().map((/** @type {any} */ x) => x.order_id));
    await run(siteEntry, contractor, 'request_jcb', { site: 'Rampur', day: '2026-10-30', hoursTenths: 60 });
    const orderId = String(siteEntry.core.ledger.orders().find((/** @type {any} */ x) => !before.has(x.order_id)).order_id);
    await run(jcbEntry, owner, 'reply_booking', { orderId, answer: 'yes', ratePaise: 120000 });
    await run(jcbEntry, operator, 'record_meter', { orderId, which: 'start', valueTenths: 100, sha256: SHA_A });
    await run(jcbEntry, operator, 'record_meter', { orderId, which: 'end', valueTenths: 160, sha256: SHA_B });
    await run(jcbEntry, owner, 'send_bill', { orderId });
    await run(siteEntry, contractor, 'accept_bill', { orderId });
    return orderId;
  };
  /** The contractor says cash was given. @param {string} orderId @param {number} amountPaise */
  const cash = (orderId, amountPaise) => run(siteEntry, contractor, 'claim_payment', { orderId, method: 'cash', amountPaise, paidOn: '2026-10-28' });
  return { app, sent, logs, state, say, run, material, jcbJob, cash, quiet, siteEntry, supEntry, jcbEntry,
    to: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).map((s) => s.text),
    /** What the supplier's ledger counts on the order. @param {string} orderId */
    money: (orderId) => { const v = supEntry.core.ledger.view(orderId); return [v.confirmedPaise, v.pending.length, v.state]; },
    /** The contractor's ledger agrees. @param {string} orderId */
    siteConfirmed: (orderId) => siteEntry.core.ledger.view(orderId).confirmedPaise };
}

// --- A plain "हाँ" right after a notice told again --------------------------------------------------

test('supplier: a first message of plain "नहीं" after a missed claim denies nothing; "नहीं P-1" answers it', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.cash(orderId, 1000000);
  await d.say(SUPPLIER, 'नहीं');
  const words = d.to(SUPPLIER);
  assert.equal(words.at(-1), t('site.no_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  assert.deepEqual(d.money(orderId), [0, 1, 'payment_claimed'], 'nothing denied');
  assert.equal(d.state.sparks, 0, 'no model reads that no');
  await d.say(SUPPLIER, 'नहीं P-1');
  assert.equal(d.money(orderId)[1], 0, 'named, it is answered');
});

test('supplier: a claim missed outside the window, then a first message of plain "हाँ": told, nothing confirmed, no model; "हाँ P-1" confirms that claim', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.cash(orderId, 1000000);
  assert.deepEqual(d.to(SUPPLIER), [], 'the window was closed');

  await d.say(SUPPLIER, 'हाँ');
  const words = d.to(SUPPLIER);
  assert.equal(words.length, 2, words.join(' | '));
  assert.ok(words[0].includes('P-1') && words[0].includes('₹10,000') && words[0].includes('28 अक्टूबर 2026'), words[0]);
  assert.ok(words[0].includes('"हाँ P-1"') && words[0].includes('"नहीं P-1"'), `it says how to answer: ${words[0]}`);
  assert.equal(words[1], t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  assert.deepEqual(d.money(orderId), [0, 1, 'payment_claimed']);
  assert.equal(d.state.sparks, 0, 'no model reads that yes');

  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId), [0, 1, 'payment_claimed'], 'nor a second plain yes');

  await d.say(SUPPLIER, 'हाँ P-1');
  assert.deepEqual(d.money(orderId).slice(0, 2), [1000000, 0]);
  assert.equal(d.siteConfirmed(orderId), 1000000);
  assert.ok(d.to(SUPPLIER).at(-1)?.includes('₹10,000'), d.to(SUPPLIER).at(-1));
});

test('JCB owner: the same, and "नहीं J-1" denies that claim', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.jcbJob();
  await d.cash(orderId, 300000);
  await d.say(OWNER, 'हाँ');
  const words = d.to(OWNER);
  assert.ok(words[0].includes('"हाँ J-1"'), words[0]);
  assert.equal(words.at(-1), t('site.yes_needs_ref', { ref: 'J-1', refs: 'J-1' }));
  const view = () => d.jcbEntry.core.ledger.view(orderId);
  assert.deepEqual([view().confirmedPaise, view().pending.length], [0, 1]);
  assert.equal(d.state.sparks, 0);
  await d.say(OWNER, 'नहीं J-1');
  assert.deepEqual([view().confirmedPaise, view().pending.length], [0, 0]);
  assert.ok(d.to(OWNER).at(-1)?.includes('नहीं मिला'), d.to(OWNER).at(-1));
});

test('JCB owner: "हाँ J-1" confirms the claim', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.jcbJob();
  await d.cash(orderId, 300000);
  await d.say(OWNER, 'मदद');
  assert.ok(d.to(OWNER)[0].includes('"हाँ J-1"'), d.to(OWNER)[0]);
  await d.say(OWNER, 'हाँ');
  assert.equal(d.jcbEntry.core.ledger.view(orderId).confirmedPaise, 0, 'a later plain yes in the while after too');
  await d.say(OWNER, 'हाँ J-1');
  assert.equal(d.jcbEntry.core.ledger.view(orderId).confirmedPaise, 300000);
});

test('two claims on two orders: both told; a plain "हाँ" names both and confirms neither; "हाँ P-2" reaches only P-2', async (tc) => {
  const d = await desk(tc);
  const first = await d.material();
  const second = await d.material();
  await d.cash(first, 1000000);
  await d.cash(second, 500000);
  await d.say(SUPPLIER, 'हाँ');
  const words = d.to(SUPPLIER);
  assert.equal(words.length, 3, words.join(' | '));
  assert.equal(words[2], t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1, P-2' }));
  await d.say(SUPPLIER, 'हाँ P-2');
  assert.deepEqual([d.money(first)[0], d.money(second)[0]], [0, 500000]);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.to(SUPPLIER).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }), 'P-2 is no longer open');
  assert.equal(d.money(first)[0], 0);
});

test('a clubbed payment missed outside the window comes back; a plain "हाँ" decides nothing; "हाँ P-2" answers it whole', async (tc) => {
  const d = await desk(tc);
  const first = await d.material();
  const second = await d.material();
  await d.run(d.siteEntry, contractor, 'claim_group', { orderIds: [first, second], method: 'cash', totalPaise: 3800000, paidOn: '2026-10-28' });
  await d.say(SUPPLIER, 'हाँ');
  const words = d.to(SUPPLIER);
  assert.equal(words.length, 2, words.join(' | '));
  assert.ok(words[0].includes('P-1, P-2') && words[0].includes('₹38,000') && words[0].includes('"हाँ P-1"'), words[0]);
  assert.equal(words[1], t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1, P-2' }));
  assert.deepEqual([d.money(first)[0], d.money(second)[0]], [0, 0]);
  await d.say(SUPPLIER, 'हाँ P-2');
  assert.deepEqual([d.money(first)[0], d.money(second)[0]], [1900000, 1900000]);
  assert.equal(d.siteConfirmed(first) + d.siteConfirmed(second), 3800000);
});

test('two claims on one order: "हाँ P-1" reads back the oldest with its amount, and its "हाँ" confirms only that one; "नहीं P-1" reads the next back as a denial', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.cash(orderId, 1000000);
  await d.cash(orderId, 200000);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.to(SUPPLIER).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }), 'the reference once');
  assert.equal(d.to(SUPPLIER).filter((x) => x.includes('"हाँ P-1"')).length, 3, 'both told, each saying how');

  await d.say(SUPPLIER, 'हाँ P-1');
  assert.equal(d.to(SUPPLIER).at(-1), t('step.confirm_payment', { site: 'Rampur', amount: '₹10,000' }));
  assert.deepEqual(d.money(orderId).slice(0, 2), [0, 2], 'a read-back still');
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId).slice(0, 2), [1000000, 1]);

  await d.cash(orderId, 300000);
  await d.say(SUPPLIER, 'नहीं P-1');
  assert.equal(d.to(SUPPLIER).at(-1), t('step.deny_payment', { site: 'Rampur', amount: '₹2,000' }));
  assert.deepEqual(d.money(orderId).slice(0, 2), [1000000, 2], 'nothing denied yet');
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId).slice(0, 2), [1000000, 1], 'the ₹3,000 still waits');
  assert.equal(d.siteConfirmed(orderId), 1000000);
});

test('a notice whose send fails is still not confirmed by a plain "हाँ"; it is told at the next message', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.cash(orderId, 1000000);
  d.state.failNext = 1;
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId).slice(0, 2), [0, 1], 'a claim never seen is never confirmed');
  assert.equal(d.to(SUPPLIER).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  await d.say(SUPPLIER, 'मदद');
  assert.ok(d.to(SUPPLIER).some((x) => x.includes('₹10,000') && x.includes('"हाँ P-1"')), d.to(SUPPLIER).join(' | '));
  assert.deepEqual(d.money(orderId).slice(0, 2), [0, 1]);
});

test('after the while the plain yes goes the seller\'s usual way, and a claim told in the open window keeps its one-word "हाँ"', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.cash(orderId, 1000000);
  await d.say(SUPPLIER, 'मदद');
  d.state.nowMs += 31 * 60 * 1000;
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.money(orderId)[0], 1000000);

  // Window open now: the notice itself asks for "हाँ", and that yes means this claim, even inside the while.
  await d.cash(orderId, 200000);
  const notice = d.to(SUPPLIER).at(-1) ?? '';
  assert.ok(notice.includes('₹2,000') && notice.includes('"हाँ" लिखें'), notice);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.money(orderId)[0], 1200000);
});

test('a missed request: the plain yes names the order and "हाँ P-1" asks for the rate; nothing is booked', async (tc) => {
  const d = await desk(tc);
  await d.run(d.siteEntry, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
  const orderId = String(d.supEntry.core.ledger.orders()[0].order_id);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.to(SUPPLIER).at(-1), t('site.yes_needs_ref', { ref: 'P-1', refs: 'P-1' }));
  await d.say(SUPPLIER, 'हाँ P-1');
  assert.equal(d.to(SUPPLIER).at(-1), t('supplier.rates_needed', { items: 'सीमेंट 50 बोरी' }));
  await d.say(SUPPLIER, 'हाँ 380');
  assert.equal(d.supEntry.core.ledger.view(orderId).state, 'booked');
});

test('the operator, with nothing to answer by a yes, is not told to name an order', async (tc) => {
  const d = await desk(tc);
  await d.run(d.siteEntry, contractor, 'request_jcb', { site: 'Rampur', day: '2026-10-30', hoursTenths: 60 });
  const orderId = String(d.jcbEntry.core.ledger.orders()[0].order_id);
  await d.run(d.jcbEntry, owner, 'reply_booking', { orderId, answer: 'yes', ratePaise: 120000 });
  await d.say(OPERATOR, 'हाँ');
  assert.ok(!d.to(OPERATOR).includes(t('site.yes_needs_ref', { ref: 'J-1', refs: 'J-1' })), d.to(OPERATOR).join(' | '));
});

// --- The same money counted twice --------------------------------------------------------------------

test('recording an amount already recorded: told with its date and method, not counted, no early settlement; "हाँ" counts it and settles', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(SUPPLIER, 'P-1 ₹9,500 नकद मिले');
  assert.equal(d.money(orderId)[0], 950000);

  d.state.nowMs += 24 * 3600 * 1000;
  await d.say(SUPPLIER, 'P-1 ₹9,500 UPI से मिले');
  const warning = d.to(SUPPLIER).at(-1) ?? '';
  assert.equal(warning, t('pay.seller.same_recorded', { ref: 'P-1', amount: '₹9,500', before: `₹9,500 ${t('payment.cash')}, 29 अक्टूबर 2026` }));
  assert.deepEqual(d.money(orderId), [950000, 0, 'part_paid'], 'not counted, not settled');
  assert.equal(ofType(d.supEntry.core.ledger.events(orderId), 'PAYMENT_RECEIVED', 'out').length, 1);

  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId), [1900000, 0, 'settled']);
  const second = ofType(d.supEntry.core.ledger.events(orderId), 'PAYMENT_RECEIVED', 'out')[1].body.body;
  assert.deepEqual([second.method, second.receivedOn], ['upi', '2026-10-30'], 'as the seller first wrote it');
  assert.equal(d.siteConfirmed(orderId), 1900000);
});

test('recording an amount already recorded: "नहीं" records nothing; another amount is not stopped', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(SUPPLIER, 'P-1 ₹5,000 नकद मिले');
  await d.say(SUPPLIER, 'P-1 ₹5,000 नकद मिले');
  await d.say(SUPPLIER, 'नहीं');
  assert.equal(d.to(SUPPLIER).at(-1), t('step.cancelled'));
  assert.equal(d.money(orderId)[0], 500000);
  // And it does not stand: another plain yes has nothing to count.
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.money(orderId)[0], 500000);
  await d.say(SUPPLIER, 'P-1 ₹6,000 नकद मिले');
  assert.equal(d.money(orderId)[0], 1100000);
});

test('an amount equal to a claim that was confirmed warns; one equal to a denied claim, or to money on another order, does not', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  const other = await d.material();
  await d.say(SUPPLIER, 'मदद');
  await d.cash(orderId, 700000);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.money(orderId)[0], 700000);
  await d.cash(orderId, 100000);
  await d.say(SUPPLIER, 'नहीं');
  assert.deepEqual(d.money(orderId).slice(0, 2), [700000, 0]);

  await d.say(SUPPLIER, 'P-1 ₹7,000 नकद मिले');
  assert.equal(d.to(SUPPLIER).at(-1), t('pay.seller.same_recorded', { ref: 'P-1', amount: '₹7,000', before: `₹7,000 ${t('payment.cash')}, 28 अक्टूबर 2026` }));
  await d.say(SUPPLIER, 'नहीं');
  await d.say(SUPPLIER, 'P-1 ₹1,000 नकद मिले');
  assert.equal(d.money(orderId)[0], 800000, 'a denied claim is no money');
  await d.say(SUPPLIER, 'P-2 ₹7,000 नकद मिले');
  assert.equal(d.money(other)[0], 700000, 'one order at a time');
});

test('an amount equal to both a waiting claim and confirmed money: each is asked, and it counts only after both', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(SUPPLIER, 'P-1 ₹5,000 नकद मिले');
  await d.cash(orderId, 500000);
  await d.say(SUPPLIER, 'P-1 ₹5,000 नकद मिले');
  assert.ok(d.to(SUPPLIER).at(-1)?.startsWith('P-1: ठेकेदार का बताया'), d.to(SUPPLIER).at(-1));
  await d.say(SUPPLIER, 'नहीं');
  assert.ok(d.to(SUPPLIER).some((x) => x.includes('पहले से दर्ज')), d.to(SUPPLIER).join(' | '));
  assert.equal(d.money(orderId)[0], 500000);
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId).slice(0, 2), [1000000, 1], 'the claim still waits');
});

test('a claim equal to money already confirmed: its "हाँ" warns and counts nothing; a second "हाँ" confirms; "नहीं" tells the contractor it did not come', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.say(SUPPLIER, 'P-1 ₹9,500 नकद मिले');
  await d.cash(orderId, 950000);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.to(SUPPLIER).at(-1), t('pay.seller.claim_same_confirmed', { ref: 'P-1', amount: '₹9,500', before: `P-1: ₹9,500 ${t('payment.cash')}, 29 अक्टूबर 2026` }));
  assert.deepEqual(d.money(orderId), [950000, 1, 'payment_claimed'], 'not counted, not settled');
  await d.say(SUPPLIER, 'नहीं');
  assert.deepEqual(d.money(orderId).slice(0, 2), [950000, 0]);
  assert.equal(d.siteConfirmed(orderId), 950000);
  assert.ok(ofType(d.siteEntry.core.ledger.events(orderId), 'PAYMENT_ACK', 'in').some((e) => e.body.body.received === false));

  await d.cash(orderId, 950000);
  await d.say(SUPPLIER, 'हाँ');
  assert.equal(d.money(orderId)[0], 950000);
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId), [1900000, 0, 'settled']);
});

test('the same claim question, reached by "हाँ P-1" after a replay', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material();
  await d.run(d.supEntry, supplier, 'record_received', { orderId, amountPaise: 950000, method: 'cash', receivedOn: '2026-10-27' });
  await d.cash(orderId, 950000);
  await d.say(SUPPLIER, 'हाँ P-1');
  assert.ok(d.to(SUPPLIER).at(-1)?.includes('27 अक्टूबर 2026'), d.to(SUPPLIER).at(-1));
  assert.equal(d.money(orderId)[0], 950000);
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual(d.money(orderId), [1900000, 0, 'settled']);
});

test('a clubbed payment whose share equals money confirmed on that order: warned, and "हाँ" confirms the whole; "नहीं" denies the whole', async (tc) => {
  const d = await desk(tc);
  const first = await d.material();
  const second = await d.material();
  await d.say(SUPPLIER, 'P-2 ₹9,500 नकद मिले');
  // ₹19,000 for P-1 and the ₹9,500 still due on P-2.
  await d.run(d.siteEntry, contractor, 'claim_group', { orderIds: [first, second], method: 'cash', totalPaise: 2850000, paidOn: '2026-10-28' });
  await d.say(SUPPLIER, 'हाँ');
  const warning = d.to(SUPPLIER).at(-1) ?? '';
  assert.ok(warning.includes('पहले से पक्की') && warning.includes('P-2: ₹9,500'), warning);
  assert.deepEqual([d.money(first)[0], d.money(second)[0]], [0, 950000]);
  await d.say(SUPPLIER, 'हाँ');
  assert.deepEqual([d.money(first)[0], d.money(second)[0]], [1900000, 1900000]);
});
