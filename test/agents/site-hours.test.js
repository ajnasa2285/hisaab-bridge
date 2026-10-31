// The site's own hours on a JCB job: optional, kept on the contractor's ledger only, once, closed with a
// bill in force, set beside the bill when it comes. Real agents over A2A, the conversation route with a
// stand-in model; the waiting notices through the agent itself. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { exactReply } from '../../src/agents/replies.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { runTool } from '../../src/agents/common.js';
import { differenceFacts } from '../../src/agents/explain-facts.js';
import { siteHours } from '../../src/agents/material.js';
import { orderRefs, proposeStep } from '../../src/orchestrator/orchestrator.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000081' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000082' };
const owner = { ...person('jcb_owner', 'agent:jcb-1'), phone: '919000000083' };
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000084' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000085' };
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A JCB job booked at ₹1,200 an hour, with the conversations wired as the app wires notices. @param {import('node:test').TestContext} tc */
async function booked(tc) {
  /** @type {[string, string, string, any][]} */ const said = [];
  /** @type {any[][]} */ const script = [];
  /** @type {any[]} */ const asked = [];
  const spark = async (/** @type {any} */ req) => { asked.push(req); return { ok: /** @type {const} */ (true), toolCalls: script.shift() ?? [{ name: 'help', args: {} }] }; };
  /** @type {Record<string, any>} */ const talks = {};
  const s = await setup({ onTell: (_side, role, key, params, expect) => {
    said.push([role, key, t(key, params), expect]);
    const who = /** @type {Record<string, any>} */ ({ contractor, supervisor, jcb_owner: owner })[role];
    if (expect && who) talks[role]?.expect(who, expect.tool, expect.args, expect.no, { key, params });
  } });
  tc.after(() => s.close());
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params), undefined]); };
  /** @param {any} core @param {any} tools @param {'contractor' | 'jcb'} kind */
  const talk = (core, tools, kind) => createConversation({ ledger: core.ledger, tools, spark, reply, now: core.now,
    office: createOffice({ ledger: core.ledger, tools, kind, tell: () => {}, reply, now: core.now }) });
  const site = talk(s.siteCore, s.site.tools, 'contractor');
  Object.assign(talks, { contractor: site, supervisor: site, jcb_owner: talk(s.jcbCore, s.jcb.tools, 'jcb') });
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02', hoursTenths: 60 } })).ok, true);
  const orderId = String(s.siteCore.ledger.orders()[0].order_id);
  await settle();
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } })).ok, true);
  await settle();
  /** @param {any} who @param {string} text @param {...any} calls */
  const say = async (who, text, ...calls) => { script.push(...calls); await talks[who.role].onText(who, text); await settle(); };
  /** The meter photos and the bill: 6.0 hours. */
  const bill = async () => {
    assert.equal((await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 1000, sha256: SHA_A } })).ok, true);
    assert.equal((await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 1060, sha256: SHA_B } })).ok, true);
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } })).ok, true);
    await settle();
  };
  const notes = () => s.siteCore.ledger.events(orderId).filter((/** @type {any} */ e) => e.type === 'NOTE' && e.body.kind === 'site_hours');
  /** @param {string} role */
  const last = (role) => said.filter((x) => x[0] === role).at(-1);
  /** Both ledgers on the same bill and state, and the JCB side without a word of the note. */
  const agree = () => {
    const [a, b] = [s.siteCore.ledger.view(orderId), s.jcbCore.ledger.view(orderId)];
    assert.deepEqual([a.state, a.currentBill, a.billTotalPaise], [b.state, b.currentBill, b.billTotalPaise]);
    assert.equal(JSON.stringify(s.jcbCore.ledger.events(orderId)).includes('site_hours'), false, 'the JCB side never sees the note');
    return a;
  };
  return { s, orderId, say, said, asked, bill, notes, last, agree };
}

test('the exact form: recorded at once, no read-back, who entered it kept, the JCB side unaware', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  assert.equal(d.last('supervisor')?.[1], 'site.hours_saved');
  assert.ok(d.last('supervisor')?.[2].includes('5.5'));
  assert.deepEqual(d.notes().map((/** @type {any} */ e) => e.body), [{ kind: 'site_hours', hoursTenths: 55, by: 'supervisor' }]);
  assert.equal(d.asked.length, 0, 'no model');
  d.agree();
});

test('the exact forms by role', async (tc) => {
  const d = await booked(tc);
  const reply = (/** @type {any} */ who, /** @type {string} */ text) => exactReply({ ledger: d.s.siteCore.ledger, person: who, text, nowMs: d.s.siteCore.now() });
  for (const text of ['J-1 6 घंटे', 'j1 6 ghante', 'J 1 6 घंटा', 'जे-1 ६ घंटे', '6 घंटे J-1', 'J-1 6घंटे', 'J-1 6 hrs', 'J-1, 6 घंटे।']) {
    assert.deepEqual(reply(supervisor, text), { kind: 'step', tool: 'record_site_hours', args: { orderId: d.orderId, hoursTenths: 60 } }, text);
  }
  assert.deepEqual(reply(contractor, 'J-1 6.5 घंटे'), { kind: 'step', tool: 'record_site_hours', args: { orderId: d.orderId, hoursTenths: 65 } });
  for (const text of ['J-1 6', 'J-1 6 बोरी', '6 घंटे', 'J-1 में 6 घंटे काम हुआ', 'J-1 5.25 घंटे']) assert.equal(reply(supervisor, text), null, text);
  assert.deepEqual(reply(supervisor, 'J-9 6 घंटे'), { kind: 'ask', key: 'common.no_such_order' });
  assert.equal(reply(operator, 'J-1 6 घंटे'), null, 'not on the JCB side');
});

test('free words go through the model and a read-back; offered only while a JCB job waits', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'आज मशीन ने ढाई घंटे काम किया', [{ name: 'record_site_hours', args: { order: 'J-1', hours: 'ढाई' } }]);
  assert.equal(d.last('supervisor')?.[1], 'step.record_site_hours');
  assert.ok(d.last('supervisor')?.[2].includes('2.5'));
  assert.equal(d.notes().length, 0, 'nothing before the yes');
  await d.say(supervisor, 'हाँ');
  assert.deepEqual(d.notes().map((/** @type {any} */ e) => e.body.hoursTenths), [25]);
  const orders = orderRefs(d.s.siteCore.ledger);
  /** @type {string[]} */ let offered = [];
  const spark = async (/** @type {any} */ req) => { offered = req.tools.map((/** @type {any} */ x) => x.function.name); return { ok: /** @type {const} */ (true), toolCalls: [{ name: 'help', args: {} }] }; };
  await proposeStep({ spark, person: supervisor, text: 'कुछ', orders, nowMs: d.s.siteCore.now() });
  assert.equal(offered.includes('record_site_hours'), false, 'recorded: not offered again');
  await proposeStep({ spark, person: supervisor, text: 'कुछ', orders: [{ ...orders[0], hoursNoted: false }], nowMs: d.s.siteCore.now() });
  assert.ok(offered.includes('record_site_hours'));
  await proposeStep({ spark, person: supervisor, text: 'कुछ', orders: [], nowMs: d.s.siteCore.now() });
  assert.equal(offered.includes('record_site_hours'), false, 'no JCB job: not offered');
});

test('a second entry is refused, whoever enters it; the first stands', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  await d.say(contractor, 'J-1 7 घंटे');
  assert.equal(d.last('contractor')?.[1], 'site.hours_already');
  assert.ok(d.last('contractor')?.[2].includes('5.5'));
  assert.equal(d.notes().length, 1);
});

test('closed once a bill is in force; the refusal says to object', async (tc) => {
  const d = await booked(tc);
  await d.bill();
  await d.say(supervisor, 'J-1 5.5 घंटे');
  assert.equal(d.last('supervisor')?.[1], 'site.hours_closed');
  assert.equal(d.notes().length, 0);
});

test('other refusals: a material order, hours out of range, a job not booked', async (tc) => {
  const d = await booked(tc);
  for (const hoursTenths of [0, 241, 1.5]) {
    const r = await runTool(d.s.site.tools, supervisor, { tool: 'record_site_hours', args: { orderId: d.orderId, hoursTenths } });
    assert.deepEqual([r.ok, r.key], [false, 'site.hours_figure']);
  }
  await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-02', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } });
  await settle();
  await d.say(supervisor, 'P-1 6 घंटे');
  assert.equal(d.last('supervisor')?.[1], 'site.hours_jcb_only');
  await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-03' } });
  await settle();
  await d.say(supervisor, 'J-2 6 घंटे');
  assert.equal(d.last('supervisor')?.[1], 'site.hours_not_open', 'no yes from the owner yet');
});

test('roles: the JCB side and the supplier cannot record it', async (tc) => {
  const d = await booked(tc);
  for (const who of [owner, operator, supplier]) {
    const r = await runTool(d.s.site.tools, who, { tool: 'record_site_hours', args: { orderId: d.orderId, hoursTenths: 60 } });
    assert.deepEqual([r.ok, r.key], [false, 'common.not_allowed']);
  }
});

test('hours differ: both figures and what they come to, no one-word yes; "हाँ J-1" reads back', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  await d.bill();
  const n = d.said.find((x) => x[0] === 'contractor' && x[1] === 'site.bill_hours_differs');
  assert.ok(n, d.said.map((x) => x[1]).join());
  for (const part of ['6.0', '₹7,200', '5.5', '₹6,600', 'हाँ J-1', 'नहीं 5.5 घंटे']) assert.ok(n?.[2].includes(part), `${part} in ${n?.[2]}`);
  assert.equal(n?.[3], undefined, 'no expectation: a bare yes accepts nothing');
  assert.ok(d.said.some((x) => x[0] === 'supervisor' && x[1] === 'site.bill_copy'));
  assert.ok(d.said.some((x) => x[0] === 'contractor' && String(x[1]).startsWith('explain.')), 'the difference is explained');
  await d.say(contractor, 'हाँ', [{ name: 'not_an_answer', args: {} }], [{ name: 'help', args: {} }]);
  assert.equal(d.agree().state, 'billed', 'a bare yes did not accept');
  await d.say(contractor, 'हाँ J-1');
  assert.equal(d.last('contractor')?.[1], 'step.accept_bill');
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'accepted');
});

test('the objection the notice offers goes through in hours', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  await d.bill();
  await d.say(contractor, 'नहीं 5.5 घंटे साइट पर इतना ही चली');
  assert.equal(d.agree().state, 'disputed');
  const sent = d.s.jcbCore.ledger.events(d.orderId).find((/** @type {any} */ e) => e.type === 'DISPUTE');
  assert.deepEqual(sent?.body.body.theirFigure, { hoursTenths: 55 });
  // The correction to the site's hours now agrees; another figure would differ.
  assert.equal((await runTool(d.s.jcb.tools, owner, { tool: 'send_correction', args: { orderId: d.orderId, hoursTenths: 55 } })).ok, true);
  await settle();
  const n = d.last('contractor');
  assert.equal(n?.[1], 'site.correction_received_hours_match');
  assert.ok(n?.[3], 'one-word yes');
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'accepted');
});

test('a correction that still differs is shown with both figures', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5 घंटे');
  await d.bill();
  await d.say(contractor, 'नहीं 5 घंटे साइट पर इतना ही चली');
  await runTool(d.s.jcb.tools, owner, { tool: 'send_correction', args: { orderId: d.orderId, hoursTenths: 55 } });
  await settle();
  const n = d.said.find((x) => x[1] === 'site.correction_hours_differs');
  assert.ok(n);
  for (const part of ['5.5', '5.0', '₹6,000']) assert.ok(n?.[2].includes(part), `${part} in ${n?.[2]}`);
  assert.equal(n?.[3], undefined);
});

test('hours match: said in the notice, the one-word yes stays', async (tc) => {
  const d = await booked(tc);
  await d.say(contractor, 'J-1 6 घंटे');
  await d.bill();
  const n = d.said.find((x) => x[1] === 'site.bill_received_hours_match');
  assert.ok(n?.[2].includes('साइट पर दर्ज घंटे भी यही'));
  assert.ok(n?.[3], 'one-word yes');
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'accepted');
});

test('none recorded: the notice is exactly as before', async (tc) => {
  const d = await booked(tc);
  await d.bill();
  const n = d.said.find((x) => x[0] === 'contractor' && x[1] === 'site.bill_received');
  assert.ok(n, d.said.map((x) => x[1]).join());
  assert.equal(n?.[2].includes('साइट'), false);
  assert.ok(n?.[3], 'one-word yes');
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'accepted');
});

test('told again after a missed window: the same notice, and it names the reference', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  await d.bill();
  const w = d.s.site.waiting('contractor');
  assert.equal(w.length, 1);
  assert.equal(w[0].key, 'site.bill_hours_differs');
  assert.ok(w[0].also?.test('site.bill_hours_differs'));
  assert.ok(w[0].also?.test('site.correction_received_hours_match'));
  assert.ok(w[0].also?.test('site.bill_received'), 'the earlier forms still match');
  const text = t(w[0].key, w[0].params);
  for (const part of ['5.5', '₹6,600', 'हाँ J-1']) assert.ok(text.includes(part), `${part} in ${text}`);
});

test('the supervisor is told once it can be noted, the contractor is not; nothing is asked', async (tc) => {
  const d = await booked(tc);
  const sup = d.said.find((x) => x[0] === 'supervisor' && String(x[1]).startsWith('site.booking_yes'));
  const con = d.said.find((x) => x[0] === 'contractor' && String(x[1]).startsWith('site.booking_yes'));
  assert.equal(sup?.[1], 'site.booking_yes_hours');
  assert.equal(con?.[1], 'site.booking_yes');
  assert.ok(sup?.[2].includes('J-1 6 घंटे'));
  assert.equal(sup?.[3], undefined, 'no question');
  assert.ok(t('help.supervisor').includes('6 घंटे'));
  assert.ok(t('help.contractor').includes('6 घंटे'));
});

test('the order lookup shows the hours and who entered them; the JCB side has neither', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  const ledger = d.s.siteCore.ledger;
  const ctx = { ledger, facts: orderFacts(ledger), side: /** @type {const} */ ('buyer'), nowMs: d.s.siteCore.now() };
  const r = /** @type {any} */ (runLookup('order_detail', { ref: 'J-1' }, ctx));
  assert.ok(r.data.hours_at_site.includes('5.5'), r.data.hours_at_site);
  assert.ok(r.data.hours_entered.includes('सुपरवाइज़र'));
  const theirs = d.s.jcbCore.ledger;
  const c2 = { ledger: theirs, facts: orderFacts(theirs), side: /** @type {const} */ ('seller'), nowMs: d.s.jcbCore.now() };
  const r2 = /** @type {any} */ (runLookup('order_detail', { ref: 'J-1' }, c2));
  assert.equal(r2.data.hours_at_site, undefined);
});

test('the facts for an explanation carry the hours on this side only', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  await d.bill();
  const f = differenceFacts(d.s.siteCore.ledger, d.orderId, 'J-1');
  assert.deepEqual(/** @type {any} */ (f.context).localSiteHours, { hours: '5.5', totalAtAgreedRate: '₹6,600' });
  assert.ok(f.figures.includes('5.5'));
  assert.ok(f.allowedNumbers.some((n) => n.value === '₹6,600'));
  const theirs = differenceFacts(d.s.jcbCore.ledger, d.orderId, 'J-1');
  assert.equal(/** @type {any} */ (theirs.context).localSiteHours, null);
});

test('the hours do not stop a cancel: by the contractor, and by the JCB owner, both ledgers agree', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'cancel_order', args: { orderId: d.orderId } })).ok, true);
  await settle();
  assert.equal(d.agree().state, 'cancelled');
  assert.equal(d.notes().length, 1, 'the note stays in history');
  assert.equal(siteHours(d.s.siteCore.ledger.events(d.orderId))?.hoursTenths, 55);
  await d.say(contractor, 'J-1 7 घंटे');
  assert.equal(d.last('contractor')?.[1], 'site.hours_already');
});

test('the JCB owner cancels a job with hours noted; nothing is refused and the side learns nothing', async (tc) => {
  const d = await booked(tc);
  await d.say(supervisor, 'J-1 5.5 घंटे');
  assert.equal((await runTool(d.s.jcb.tools, owner, { tool: 'cancel_order', args: { orderId: d.orderId } })).ok, true);
  await settle();
  assert.equal(d.agree().state, 'cancelled');
});

test('after a cancel, hours not yet recorded cannot be', async (tc) => {
  const d = await booked(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'cancel_order', args: { orderId: d.orderId } })).ok, true);
  await settle();
  await d.say(supervisor, 'J-1 6 घंटे');
  assert.equal(d.last('supervisor')?.[1], 'site.hours_not_open');
});
