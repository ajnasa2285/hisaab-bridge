// Cancelling a booked order (`रद्द J-2`): read by code, read back, one "हाँ", a signed CANCEL; the other
// side records it without a yes and tells its people. Refused with the reason when there is meter
// evidence, a delivery, a site count, a bill or money. Real agents over A2A; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice, parseCommand } from '../../src/agents/office.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { orderRefs } from '../../src/orchestrator/orchestrator.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const contractor = person('contractor', 'agent:contractor-1');
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012' };
const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000002' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000031' };
const settle = () => new Promise((r) => setTimeout(r, 30));
const SHA = 'd'.repeat(64);

/** The three agents with a conversation each, on real offices. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  tc.after(() => s.close());
  let models = 0;
  const spark = async () => { models += 1; return { ok: /** @type {const} */ (true), toolCalls: [{ name: 'help', args: {} }] }; };
  /** @param {any} core @param {Record<string, any>} tools @param {'contractor' | 'jcb' | 'supplier'} kind @param {Record<string, any>} [more] */
  const talk = (core, tools, kind, more = {}) => {
    const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
    const tell = (/** @type {string} */ role, /** @type {string} */ key, /** @type {any} */ params) => { said.push([`office:${role}`, key, t(key, params)]); };
    return createConversation({ ledger: core.ledger, tools, spark, reply, now: core.now, office: createOffice({ ledger: core.ledger, tools, kind, tell, reply, now: core.now }), ...more });
  };
  const site = talk(s.siteCore, s.site.tools, 'contractor');
  const jcb = talk(s.jcbCore, s.jcb.tools, 'jcb', { classifyPhoto: seesPhoto('meter'),
    readMeter: async () => ({ ok: true, kind: 'hour_meter', raw: '2061.7', valueTenths: 20617, clear: true, displayDate: null }) });
  const sup = talk(s.supCore, s.sup.tools, 'supplier');
  return {
    s, said, site, jcb, sup, models: () => models,
    last: (/** @type {string} */ who) => said.filter((x) => x[0] === who).at(-1),
    told: (/** @type {string} */ who, /** @type {string} */ key) => said.some((x) => x[0] === who && x[1] === key),
    state: (/** @type {any} */ core, /** @type {string} */ id) => core.ledger.view(id).state,
  };
}

/** A JCB job booked on both ledgers. @param {Awaited<ReturnType<typeof desk>>} d @param {string} [where] */
async function jcbJob(d, where = 'Invented Site') {
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: where, day: '2026-11-02', hoursTenths: 60 } })).ok, true);
  await settle();
  d.s.advance(1000);
  const orderId = String(d.s.jcbCore.ledger.orders().at(-1)?.order_id);
  assert.equal((await runTool(d.s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } })).ok, true);
  await settle();
  return orderId;
}

/** A material order booked on both ledgers. @param {Awaited<ReturnType<typeof desk>>} d */
async function materialJob(d) {
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-02', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } })).ok, true);
  await settle();
  const orderId = String(d.s.supCore.ledger.orders().at(-1)?.order_id);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } })).ok, true);
  await settle();
  return orderId;
}

test('the command is read by code, in the ways a person writes it', () => {
  for (const text of ['रद्द J-2', 'रद्द j2', 'J-2 रद्द', 'रद्द करो J-2', 'J-2 रद्द कर दो', 'cancel J-2', 'radd J 2', 'रद्द जे-2.']) assert.deepEqual(parseCommand(text), { cmd: 'cancel', ref: 'J-2' }, text);
  assert.deepEqual(parseCommand('रद्द P-12'), { cmd: 'cancel', ref: 'P-12' });
  for (const text of ['रद्द', 'रद्द शिवपुरी', 'रद्द J-1 J-2', 'J-2 रद्द मत करो']) assert.equal(parseCommand(text), null, text);
});

test('the contractor: read-back, nothing sent; हाँ sends a signed CANCEL; the JCB side records it and tells its people', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.site.onText(contractor, 'रद्द J-1');
  const asked = d.last('contractor');
  assert.equal(asked?.[1], 'step.cancel_order');
  for (const part of ['J-1', 'Invented Site', '2 नवंबर 2026', 'JCB', 'हाँ / नहीं']) assert.ok(asked?.[2].includes(part), `${part} in ${asked?.[2]}`);
  assert.equal(d.state(d.s.siteCore, id), 'booked');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  assert.equal(d.last('contractor')?.[1], 'cancel.done');
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.jcbCore, id)], ['cancelled', 'cancelled']);
  const m = d.s.jcbCore.ledger.events(id).find((e) => e.type === 'CANCEL');
  assert.equal(m?.direction, 'in');
  assert.equal(m?.body.from, 'agent:contractor-1');
  assert.match(m?.body.sig, /^ed25519:/);
  for (const role of ['jcb:jcb_owner', 'jcb:operator']) assert.ok(d.told(role, 'jcb.order_cancelled'), role);
  assert.ok(d.told('site:supervisor', 'site.order_cancelled_own'));
  assert.equal(d.models(), 0, 'the model never saw it');
  assert.equal(d.s.jcbCore.ledger.verifyChain().ok, true);
  assert.equal(d.s.siteCore.ledger.verifyChain().ok, true);
});

test('नहीं to the read-back: nothing sent, still booked', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'नहीं');
  assert.equal(d.last('contractor')?.[1], 'step.cancelled');
  assert.equal(d.state(d.s.jcbCore, id), 'booked');
  assert.equal(d.s.jcbCore.ledger.events(id).some((e) => e.type === 'CANCEL'), false);
});

test('the JCB owner: the contractor, the supervisor and the operator are told', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.jcb.onText(owner, 'रद्द J-1');
  await d.jcb.onText(owner, 'हाँ');
  await settle();
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.jcbCore, id)], ['cancelled', 'cancelled']);
  for (const role of ['site:contractor', 'site:supervisor']) assert.ok(d.told(role, 'site.order_cancelled'), role);
  assert.ok(d.said.find((x) => x[1] === 'site.order_cancelled')?.[2].includes('JCB मालिक'));
  assert.ok(d.told('jcb:operator', 'jcb.order_cancelled_own'));
});

test('the supplier: same, for a material order; the items are named', async (tc) => {
  const d = await desk(tc);
  const id = await materialJob(d);
  await d.sup.onText(supplier, 'रद्द P-1');
  assert.ok(d.last('supplier')?.[2].includes('सीमेंट 50 बोरी'));
  await d.sup.onText(supplier, 'हाँ');
  await settle();
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.supCore, id)], ['cancelled', 'cancelled']);
  for (const role of ['site:contractor', 'site:supervisor']) assert.ok(d.told(role, 'site.order_cancelled'), role);
});

test('the contractor cancels a material order: the supplier is told', async (tc) => {
  const d = await desk(tc);
  await materialJob(d);
  await d.site.onText(contractor, 'रद्द P-1');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  assert.ok(d.told('supplier:supplier', 'supplier.order_cancelled'));
});

test('an order not answered yet can be cancelled too', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02' } })).ok, true);
  await settle();
  const id = String(d.s.jcbCore.ledger.orders()[0].order_id);
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.jcbCore, id)], ['cancelled', 'cancelled']);
});

test('never the supervisor or the operator', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.site.onText(supervisor, 'रद्द J-1');
  assert.equal(d.last('supervisor')?.[1], 'cancel.not_allowed');
  await d.jcb.onText(operator, 'रद्द J-1');
  assert.equal(d.last('operator')?.[1], 'cancel.not_allowed');
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.jcbCore, id)], ['booked', 'booked']);
  assert.equal((await runTool(d.s.site.tools, supervisor, { tool: 'cancel_order', args: { orderId: id } })).ok, false);
  assert.equal((await runTool(d.s.jcb.tools, operator, { tool: 'cancel_order', args: { orderId: id } })).ok, false);
});

test('an advance blocks it, with the reason and the amount; no question is asked', async (tc) => {
  const d = await desk(tc);
  await jcbJob(d);
  await d.site.onText(contractor, 'J-1 अग्रिम ₹5,000 नकद दिए');
  await settle();
  await d.site.onText(contractor, 'रद्द J-1');
  const r = d.last('contractor');
  assert.equal(r?.[1], 'cancel.has_payment');
  assert.ok(r?.[2].includes('₹5,000') && r?.[2].includes('J-1'), r?.[2]);
  assert.equal(d.site.pending(contractor), null);
  await d.jcb.onText(owner, 'रद्द J-1');
  assert.equal(d.last('jcb_owner')?.[1], 'cancel.has_payment');
});

test('meter evidence: the owner is told why; the contractor, who cannot see it, is refused by the JCB side and stays booked', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.jcb.onImage(operator, { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 1]) });
  assert.equal(d.last('operator')?.[1], 'jcb.meter_start_saved');
  await d.jcb.onText(owner, 'रद्द J-1');
  assert.equal(d.last('jcb_owner')?.[1], 'cancel.has_meter');
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'हाँ');
  assert.equal(d.last('contractor')?.[1], 'cancel.refused');
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.jcbCore, id)], ['booked', 'working']);
  assert.equal(d.s.siteCore.ledger.verifyChain().ok, true);
});

test('a delivery or a bill blocks it, each with its reason', async (tc) => {
  const d = await desk(tc);
  const id = await materialJob(d);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: id, items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }], sha256: SHA } })).ok, true);
  await settle();
  await d.site.onText(contractor, 'रद्द P-1');
  assert.equal(d.last('contractor')?.[1], 'cancel.has_delivery');
  await d.sup.onText(supplier, 'रद्द P-1');
  assert.equal(d.last('supplier')?.[1], 'cancel.has_delivery');
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: id } })).ok, true);
  await settle();
  await d.sup.onText(supplier, 'रद्द P-1');
  assert.equal(d.last('supplier')?.[1], 'cancel.has_bill');
  assert.equal(d.state(d.s.supCore, id), 'billed');
});

test('a site count before the delivery: the contractor is told why, and the supplier\'s CANCEL is refused', async (tc) => {
  const d = await desk(tc);
  const id = await materialJob(d);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'confirm_count', args: { orderId: id, qtysHundredths: [5000], challan: { sha256: SHA, number: '12' } } })).ok, true);
  await d.site.onText(contractor, 'रद्द P-1');
  assert.equal(d.last('contractor')?.[1], 'cancel.has_count');
  await d.sup.onText(supplier, 'रद्द P-1');
  await d.sup.onText(supplier, 'हाँ');
  assert.equal(d.last('supplier')?.[1], 'cancel.refused');
  assert.deepEqual([d.state(d.s.siteCore, id), d.state(d.s.supCore, id)], ['booked', 'booked']);
});

test('no such reference, a held step, and cancelling twice each get their own answer', async (tc) => {
  const d = await desk(tc);
  await d.site.onText(contractor, 'रद्द J-7');
  assert.equal(d.last('contractor')?.[1], 'office.no_such_ref');
  await jcbJob(d);
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  await d.site.onText(contractor, 'रद्द J-1');
  assert.equal(d.last('contractor')?.[1], 'cancel.already');
  // A supervisor's request held for approval has a reference and no order yet.
  await runToolHeld(d);
  await d.site.onText(contractor, 'रद्द J-2');
  assert.equal(d.last('contractor')?.[1], 'cancel.held');
});

/** Holds a supervisor's request on the contractor's office. @param {Awaited<ReturnType<typeof desk>>} d */
async function runToolHeld(d) {
  const office = createOffice({ ledger: d.s.siteCore.ledger, tools: d.s.site.tools, kind: 'contractor', tell: () => {}, reply: () => {}, now: d.s.siteCore.now });
  assert.equal((await office.commit(supervisor, 'request_jcb', { site: 'Invented Site', day: '2026-11-03' })).ok, true);
}

test('the other side cannot be reached: recorded here, sent again later', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.site.onText(contractor, 'रद्द J-1');
  d.s.net.up = false;
  await d.site.onText(contractor, 'हाँ');
  assert.equal(d.last('contractor')?.[1], 'common.pending');
  assert.equal(d.state(d.s.siteCore, id), 'cancelled');
  d.s.net.up = true;
  await d.s.siteLink.retryPending();
  await settle();
  assert.equal(d.state(d.s.jcbCore, id), 'cancelled');
});

test('a cancelled order leaves every open list and blocks nothing: the meter photo goes to the other job, no bill, no payment', async (tc) => {
  const d = await desk(tc);
  const first = await jcbJob(d, 'Invented One');
  const second = await jcbJob(d, 'Invented Two');
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  for (const core of [d.s.siteCore, d.s.jcbCore]) assert.deepEqual(orderRefs(core.ledger).map((r) => r.ref), ['J-2']);
  await d.jcb.onText(owner, 'बाक़ी');
  assert.ok(!d.last('jcb_owner')?.[2].includes('J-1'));
  await d.jcb.onImage(operator, { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 2]) });
  assert.equal(d.last('operator')?.[1], 'jcb.meter_start_saved');
  assert.equal(d.s.jcbCore.ledger.events(second).some((e) => e.type === 'EVIDENCE'), true);
  assert.equal(d.s.jcbCore.ledger.events(first).some((e) => e.type === 'EVIDENCE'), false);
  // Named directly, it cannot be billed, read or paid.
  assert.equal((await runTool(d.s.jcb.tools, owner, { tool: 'send_bill', args: { orderId: first } })).ok, false);
  assert.equal((await runTool(d.s.jcb.tools, operator, { tool: 'record_meter', args: { orderId: first, which: 'start', valueTenths: 1, sha256: SHA } })).ok, false);
  assert.equal((await runTool(d.s.jcb.tools, owner, { tool: 'record_received', args: { orderId: first, amountPaise: 1000, method: 'cash', receivedOn: '2026-11-02' } })).ok, false);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: first, amountPaise: 1000, method: 'cash', paidOn: '2026-11-02' } })).ok, false);
  await d.site.onText(contractor, 'J-1 ₹1,000 नकद दिए');
  assert.equal(d.s.siteCore.ledger.events(first).some((e) => e.type === 'PAYMENT_CLAIM'), false);
});

test('status and ask-anything show it as cancelled, and it counts in no total', async (tc) => {
  const d = await desk(tc);
  const id = await jcbJob(d);
  await d.site.onText(contractor, 'रद्द J-1');
  await d.site.onText(contractor, 'हाँ');
  await settle();
  await d.site.onText(contractor, 'स्थिति J-1');
  assert.ok(d.last('contractor')?.[2].includes(t('state.cancelled')), d.last('contractor')?.[2]);
  const facts = orderFacts(d.s.siteCore.ledger);
  assert.equal(facts.find((f) => f.orderId === id)?.state, 'cancelled');
  const ctx = { facts, side: /** @type {const} */ ('buyer'), nowMs: d.s.siteCore.now(), ledger: d.s.siteCore.ledger };
  const all = runLookup('list_orders', { site: null, kind: null, period: 'all', from: null, to: null, state: null }, /** @type {any} */ (ctx));
  assert.ok(JSON.stringify(all).includes(t('state.cancelled')));
  const open = runLookup('list_orders', { site: null, kind: null, period: 'all', from: null, to: null, state: 'open' }, /** @type {any} */ (ctx));
  assert.ok(!JSON.stringify(open).includes('J-1'));
  const cancelled = runLookup('list_orders', { site: null, kind: null, period: 'all', from: null, to: null, state: 'cancelled' }, /** @type {any} */ (ctx));
  assert.ok(JSON.stringify(cancelled).includes('J-1'));
  const totals = runLookup('totals', { site: null, kind: null, period: 'all', from: null, to: null, item: null, group_by: 'none' }, /** @type {any} */ (ctx));
  assert.ok(!JSON.stringify(totals).includes('J-1'));
});

test('the role\'s help names the command; the supervisor\'s and operator\'s do not', () => {
  for (const role of ['contractor', 'jcb_owner', 'supplier']) assert.ok(t(`help.${role}`).includes('रद्द'), role);
  for (const role of ['supervisor', 'operator']) assert.ok(!t(`help.${role}`).includes('रद्द'), role);
});
