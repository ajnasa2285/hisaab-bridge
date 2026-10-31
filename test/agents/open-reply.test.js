// A free-text reply maps to the person's latest open question unless it names a reference (the owner's
// rule, live 31 Oct: "Cement 50 बोरी है 40 नहीं" on a two-line bill became a count, then a new order).
// Real agents over A2A; Muse Spark is a stand-in giving the calls a model would give, and each request
// it got is kept, to check what was offered. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { exactReply } from '../../src/agents/replies.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { parseRatePaise } from '../../src/orchestrator/units.js';
import { setup, person } from './helpers.js';

const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000061' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000062' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000063' };
const owner = { ...person('jcb_owner', 'agent:jcb-1'), phone: '919000000064' };
const settle = () => new Promise((r) => setTimeout(r, 30));
const SHA = 'e'.repeat(64);
const LIVE = 'Cement 50 बोरी है 40 नहीं';
const ITEMS = [{ name: 'सीमेंट', qtyHundredths: 4000, unit: 'बोरी' }, { name: 'बालू', qtyHundredths: 4000, unit: 'टन' }];
/** The model calling for an objection with per-item figures. @param {[string, string | null][]} items */
const disputeItems = (items) => ({ name: 'dispute_bill', args: { their_hours: null, their_quantity: null, their_total_rupees: null, their_items: items.map(([item, quantity]) => ({ item, quantity })), reason: 'model words' } });
const NOT_ANSWER = { name: 'not_an_answer', args: {} };

/** The site's and sellers' conversations, wired as the app wires notices. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any[]} */ const asked = [];
  /** @type {any[][]} */ const script = [];
  const spark = async (/** @type {any} */ req) => { asked.push(req); return { ok: /** @type {const} */ (true), toolCalls: script.shift() ?? [{ name: 'help', args: {} }] }; };
  /** @type {Record<string, any>} */ const talks = {};
  const s = await setup({ onTell: (side, role, key, params, expect) => {
    said.push([role, key, t(key, params)]);
    const who = /** @type {Record<string, any>} */ ({ contractor, supervisor, supplier, jcb_owner: owner })[role];
    if (expect && who) talks[role]?.expect(who, expect.tool, expect.args, expect.no, { key, params });
  } });
  tc.after(() => s.close());
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  /** @param {any} core @param {any} tools @param {'contractor' | 'jcb' | 'supplier'} kind */
  const talk = (core, tools, kind) => createConversation({ ledger: core.ledger, tools, spark, reply, now: core.now,
    office: createOffice({ ledger: core.ledger, tools, kind, tell: () => {}, reply, now: core.now }) });
  const site = talk(s.siteCore, s.site.tools, 'contractor');
  Object.assign(talks, { contractor: site, supervisor: site, supplier: talk(s.supCore, s.sup.tools, 'supplier'), jcb_owner: talk(s.jcbCore, s.jcb.tools, 'jcb') });
  /** @param {any} who @param {string} text @param {...any} calls one list of model calls per model request */
  const say = async (who, text, ...calls) => { script.push(...calls); await talks[who.role].onText(who, text); await settle(); };
  return { s, said, asked, say, talks,
    last: (/** @type {string} */ role) => said.filter((x) => x[0] === role).at(-1),
    keys: (/** @type {string} */ role) => said.filter((x) => x[0] === role).map((x) => x[1]),
    offered: () => asked.at(-1).tools.map((/** @type {any} */ x) => x.function.name).sort() };
}

/** A material order through to a bill, the site having counted. @param {Awaited<ReturnType<typeof desk>>} d @param {{site?: string, items?: any[], rates?: number[], gst?: (number | null)[], count?: boolean}} [o] */
async function billed(d, o = {}) {
  const items = o.items ?? ITEMS;
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: o.site ?? 'Invented Site', day: '2026-11-02', items } })).ok, true);
  await settle();
  d.s.advance(1000);
  const id = String(d.s.supCore.ledger.orders().at(-1)?.order_id);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: id, answer: 'yes', ratesPaise: o.rates ?? [38000, 80000], gstPercents: o.gst ?? [18, null] } })).ok, true);
  await settle();
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: id, items, sha256: SHA } })).ok, true);
  await settle();
  if (o.count !== false) assert.equal((await runTool(d.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: id, qtysHundredths: items.map((i) => i.qtyHundredths) } })).ok, true);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: id } })).ok, true);
  await settle();
  d.s.advance(1000);
  return id;
}
const counts = (/** @type {any} */ d, /** @type {string} */ id) => d.s.siteCore.ledger.events(id).filter((/** @type {any} */ e) => e.type === 'NOTE' && e.body.kind === 'site_count').length;
const disputes = (/** @type {any} */ d, /** @type {string} */ id) => d.s.supCore.ledger.events(id).filter((/** @type {any} */ e) => e.type === 'DISPUTE');

test('the live sequence: the reply is an objection, code works out ₹54,420, no new order, no count change', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  const orders = d.s.siteCore.ledger.orders().length;
  await d.say(contractor, LIVE, [disputeItems([['सीमेंट', '50']])]);
  assert.deepEqual(d.offered(), ['accept_bill', 'dispute_bill', 'not_an_answer'], 'only the steps that answer the question');
  assert.ok(d.asked.at(-1).system.includes('P-1'), 'the question is given');
  const back = d.last('contractor');
  assert.equal(back?.[1], 'step.dispute_bill_items');
  for (const part of ['P-1', 'सीमेंट 50 बोरी', 'बालू 40 टन', '₹54,420', LIVE, 'हाँ / नहीं']) assert.ok(back?.[2].includes(part), `${part} in: ${back?.[2]}`);
  assert.equal(disputes(d, id).length, 0, 'nothing before the yes');
  await d.say(contractor, 'हाँ');
  const sent = disputes(d, id);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.body.theirFigure, { totalPaise: 5442000 }, 'the wire format does not change');
  assert.equal(sent[0].body.body.reason, LIVE, "the person's own words");
  assert.equal(d.s.siteCore.ledger.orders().length, orders);
  assert.equal(counts(d, id), 1);
});

test('the second live message, both items named: the same total; the bill notice question is not asked again after it', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(contractor, 'Cement 50 bori, sand 40 ton', [disputeItems([['सीमेंट', '50'], ['बालू', '40']])]);
  assert.ok(d.last('contractor')?.[2].includes('₹54,420'));
  await d.say(contractor, 'हाँ');
  assert.equal(disputes(d, id).length, 1);
  assert.equal(d.talks.contractor.pending(contractor), null);
});

test('नहीं to the read-back: nothing sent, and the bill question is asked again; its हाँ accepts the bill', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(contractor, LIVE, [disputeItems([['सीमेंट', '50']])]);
  await d.say(contractor, 'नहीं');
  assert.equal(disputes(d, id).length, 0);
  assert.equal(d.last('contractor')?.[1], 'site.material_bill_received');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'accepted');
});

for (const [why, items, text] of /** @type {[string, [string, string | null][], string][]} */ ([
  ['an item not on the bill', [['ईंट', '50']], 'ईंट 50 है'],
  ['a figure with no item it can be', [['सीमेंट', null]], 'सीमेंट कम है'],
  ['the same item twice', [['सीमेंट', '50'], ['सीमेंट', '45']], 'सीमेंट 50 या 45'],
  ['a figure the person did not write', [['सीमेंट', '55']], 'सीमेंट 50 है'],
  ['part of a longer number', [['सीमेंट', '50']], 'सीमेंट 150 है'],
])) {
  test(`${why}: asked, never guessed; nothing to say yes to`, async (tc) => {
    const d = await desk(tc);
    const id = await billed(d);
    await d.say(contractor, text, [disputeItems(items)]);
    const r = d.last('contractor');
    assert.equal(r?.[1], 'site.dispute_which_item');
    assert.ok(r?.[2].includes('सीमेंट') && r?.[2].includes('बालू'), r?.[2]);
    assert.equal(d.talks.contractor.pending(contractor), null, 'a bare हाँ now cannot accept or dispute anything at once');
    assert.equal(disputes(d, id).length, 0);
  });
}

test('a figure at the end of a sentence, in Devanagari digits, is the person\'s own figure', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'सीमेंट तो ५० बोरी आई थी.', [disputeItems([['सीमेंट', '५०']])]);
  assert.ok(d.last('contractor')?.[2].includes('₹54,420'), d.last('contractor')?.[2]);
});

test('one quantity on a multi-line bill, not tied to an item: asked', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, '50 बोरी ही आई', [{ name: 'dispute_bill', args: { their_hours: null, their_quantity: '50', their_total_rupees: null, their_items: null, reason: 'x' } }]);
  assert.equal(d.last('contractor')?.[1], 'site.dispute_which_item');
});

test('figures that come to the bill itself: told so, nothing to object to', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'सीमेंट 40 है', [disputeItems([['सीमेंट', '40']])]);
  assert.equal(d.last('contractor')?.[1], 'site.dispute_same');
});

test('an objection with no figure: the exact format is shown with a real example', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'बिल ग़लत है', [{ name: 'dispute_bill', args: { their_hours: null, their_quantity: null, their_total_rupees: null, their_items: null, reason: 'x' } }]);
  const r = d.last('contractor');
  assert.equal(r?.[1], 'site.dispute_format');
  assert.ok(r?.[2].includes('नहीं ₹49936'), r?.[2]);
});

test('a new order sent during an open bill question stays a new order; the bill question comes back', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  const orders = d.s.siteCore.ledger.orders().length;
  await d.say(contractor, 'कल Invented Site पर सीमेंट 50 बोरी भेजो', [NOT_ANSWER], [{ name: 'request_material', args: { site: 'Invented Site', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } }]);
  assert.equal(d.last('contractor')?.[1], 'step.request_material');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.orders().length, orders + 1, 'the yes went to the read-back it followed');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed');
  assert.equal(d.last('contractor')?.[1], 'site.material_bill_received', 'asked again, in its own words');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'accepted');
});

test('a question sent during it is answered; the bill question comes back, so a bare हाँ means what was last asked', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(contractor, 'इस बिल में कितना बाक़ी है', [NOT_ANSWER], [{ name: 'ask_records', args: {} }], [{ name: 'answer', args: { answer: 'कोई भुगतान दर्ज नहीं।' } }]);
  const keys = d.keys('contractor');
  assert.ok(keys.includes('records.answer') || keys.some((k) => k.startsWith('records.')), keys.join());
  assert.equal(keys.at(-1), 'site.material_bill_received');
  assert.equal(d.talks.contractor.pending(contractor)?.tool, 'accept_bill');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed');
});

test('asked again only once: a second unrelated message does not repeat it, and a bare हाँ then needs a read-back', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(contractor, 'पहली बात', [NOT_ANSWER], [{ name: 'help', args: {} }]);
  const before = d.keys('contractor').filter((k) => k === 'site.material_bill_received').length;
  await d.say(contractor, 'दूसरी बात', [NOT_ANSWER], [{ name: 'help', args: {} }]);
  assert.equal(d.keys('contractor').filter((k) => k === 'site.material_bill_received').length, before);
  await d.say(contractor, 'हाँ', [{ name: 'accept_bill', args: {} }]);
  assert.equal(d.last('contractor')?.[1], 'step.accept_bill');
  assert.ok(d.last('contractor')?.[2].includes('P-1'), 'the read-back names the order');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed', 'not at once');
});

test('a reference to another order goes there', async (tc) => {
  const d = await desk(tc);
  const first = await billed(d);
  const second = await billed(d, { site: 'Second Site' });
  await d.say(contractor, 'P-1 में सीमेंट 50 बोरी है', [disputeItems([['सीमेंट', '50']])]);
  assert.ok(d.asked.at(-1).system.includes('P-1') && !d.asked.at(-1).system.includes('P-2'), 'only that order');
  await d.say(contractor, 'हाँ');
  assert.equal(disputes(d, first).length, 1);
  assert.equal(disputes(d, second).length, 0);
});

test('two open questions: no reference uses the latest', async (tc) => {
  const d = await desk(tc);
  const first = await billed(d);
  const second = await billed(d, { site: 'Second Site' });
  await d.say(contractor, LIVE, [disputeItems([['सीमेंट', '50']])]);
  assert.ok(d.asked.at(-1).system.includes('P-2') && !d.asked.at(-1).system.includes('P-1'));
  assert.ok(d.last('contractor')?.[2].includes('P-2'), 'the read-back names it');
  await d.say(contractor, 'हाँ');
  assert.equal(disputes(d, second).length, 1);
  assert.equal(disputes(d, first).length, 0);
});

test('no open question: as today, every step of the role offered', async (tc) => {
  const d = await desk(tc);
  await d.say(contractor, 'कल सीमेंट', [{ name: 'help', args: {} }]);
  assert.equal(d.asked.length, 1);
  for (const name of ['request_jcb', 'request_material', 'ask_records']) assert.ok(d.offered().includes(name), name);
  assert.ok(!d.offered().includes('not_an_answer'));
});

test("the supervisor cannot answer the contractor's bill question", async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(supervisor, LIVE, [disputeItems([['सीमेंट', '50']])]);
  assert.ok(!d.offered().includes('dispute_bill') && !d.offered().includes('not_an_answer'));
  assert.equal(d.last('supervisor')?.[1], 'common.not_allowed');
  assert.equal(disputes(d, id).length, 0);
  assert.equal(d.talks.contractor.pending(contractor)?.tool, 'accept_bill', "the contractor's question stands");
});

test('an exact reply is read as before, without the model', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(contractor, 'नहीं ₹54420 दर ज़्यादा');
  assert.equal(d.asked.length, 0);
  assert.equal(disputes(d, id)[0].body.body.theirFigure.totalPaise, 5442000);
});

test('a JCB bill too: the notice shows the exact format, and it parses as an objection', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02', hoursTenths: 60 } })).ok, true);
  await settle();
  const id = String(d.s.jcbCore.ledger.orders()[0].order_id);
  await runTool(d.s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId: id, answer: 'yes', ratePaise: 120000 } });
  await settle();
  await runTool(d.s.jcb.tools, owner, { tool: 'record_meter', args: { orderId: id, which: 'start', valueTenths: 100, sha256: SHA } });
  await runTool(d.s.jcb.tools, owner, { tool: 'record_meter', args: { orderId: id, which: 'end', valueTenths: 161, sha256: SHA } });
  await runTool(d.s.jcb.tools, owner, { tool: 'send_bill', args: { orderId: id } });
  await settle();
  const notice = d.last('contractor');
  assert.equal(notice?.[1], 'site.bill_received');
  const example = /नहीं ₹\d+ कारण/u.exec(notice?.[2] ?? '')?.[0];
  assert.equal(example, 'नहीं ₹7320 कारण');
  assert.equal(exactReply({ ledger: d.s.siteCore.ledger, person: contractor, text: example ?? '', nowMs: d.s.siteCore.now() })?.kind, 'step');
  await d.say(contractor, 'घंटे 5 ही चली', [{ name: 'dispute_bill', args: { their_hours: '5', their_quantity: null, their_total_rupees: null, their_items: null, reason: 'x' } }]);
  assert.equal(d.last('contractor')?.[1], 'step.dispute_bill');
  assert.ok(d.last('contractor')?.[2].includes('घंटे 5 ही चली'), 'own words');
});

test('the material bill notice shows the format with its own total, and it parses', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  const example = /नहीं ₹\d+ कारण/u.exec(d.last('contractor')?.[2] ?? '')?.[0];
  assert.equal(example, 'नहीं ₹49936 कारण');
  assert.equal(exactReply({ ledger: d.s.siteCore.ledger, person: contractor, text: example ?? '', nowMs: d.s.siteCore.now() })?.kind, 'step');
});

test('order replies, corrections and payment confirmations are answers too, read back first', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02' } })).ok, true);
  await settle();
  const id = String(d.s.jcbCore.ledger.orders()[0].order_id);
  await d.say(owner, 'कर देंगे, बारह सौ लगेगा घंटे का', [{ name: 'reply_booking', args: { answer: 'yes', rate_rupees_per_hour: '1200', day: null, time: null } }]);
  assert.deepEqual(d.offered(), ['not_an_answer', 'reply_booking']);
  assert.equal(d.last('jcb_owner')?.[1], 'step.reply_booking_yes');
  assert.equal(d.s.jcbCore.ledger.view(id).state, 'requested', 'not before the yes');
  await d.say(owner, 'हाँ');
  await d.say(contractor, 'J-1 ₹5,000 नकद दिए');
  await d.say(owner, 'पैसा पहुँच गया खाते में', [{ name: 'confirm_payment', args: {} }]);
  assert.deepEqual(d.offered(), ['confirm_payment', 'not_an_answer']);
  assert.equal(d.last('jcb_owner')?.[1], 'step.confirm_payment');

  const m = await billed(d, { site: 'Second Site' });
  await d.say(contractor, 'नहीं ₹40000 कम आया');
  await d.say(supplier, 'ठीक है 38 और 40 कर देता हूँ', [{ name: 'send_correction', args: { quantities: ['38', '40'] } }]);
  assert.deepEqual(d.offered(), ['not_an_answer', 'send_correction']);
  assert.equal(d.last('supplier')?.[1], 'step.send_material_correction');
  assert.equal(d.s.supCore.ledger.view(m).state, 'disputed', 'not before the yes');
});

test('the count: the supervisor\'s free words answer it; once counted, or with a bill, it is neither offered nor accepted', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d, { count: false });
  // A bill in force: the count is closed, on the model path and at the tool.
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed');
  await d.say(contractor, 'P-1 में 50 और 40 आया', [NOT_ANSWER], [{ name: 'confirm_count', args: { order: 'P-1', quantities: ['50', '40'] } }]);
  assert.ok(!d.offered().includes('confirm_count'), 'no delivery waits for a count: not offered');
  assert.equal(counts(d, id), 0);
  const atTool = await runTool(d.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: id, qtysHundredths: [5000, 4000] } });
  assert.deepEqual([atTool.ok, atTool.key], [false, 'site.count_closed']);
  assert.equal(counts(d, id), 0);

  // Delivered, not counted: the supervisor's free words are the answer, read back.
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Second Site', day: '2026-11-03', items: ITEMS } })).ok, true);
  await settle();
  const second = String(d.s.supCore.ledger.orders().at(-1)?.order_id);
  await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: second, answer: 'yes', ratesPaise: [38000, 80000] } });
  await settle();
  await runTool(d.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: second, items: ITEMS, sha256: SHA } });
  await settle();
  // Offered now for that delivery, but a reference to the billed order is refused.
  await d.say(supervisor, 'P-1 में 50 और 40 आया', [{ name: 'confirm_count', args: { order: 'P-1', quantities: ['50', '40'] } }]);
  assert.ok(d.offered().includes('ask_records'), 'it names no open question of theirs: read as today');
  assert.ok(d.keys('supervisor').includes('site.count_closed'));
  assert.equal(d.last('supervisor')?.[1], 'site.delivery_received', 'their own question comes back');
  await d.say(supervisor, 'गिनती की, 38 सीमेंट और 40 बालू', [{ name: 'confirm_count', args: { quantities: ['38', '40'] } }]);
  assert.deepEqual(d.offered(), ['confirm_count', 'not_an_answer']);
  assert.equal(d.last('supervisor')?.[1], 'step.confirm_count');
  await d.say(supervisor, 'हाँ');
  assert.equal(counts(d, second), 1);

  // Counted: not offered any more, refused by reference, refused at the tool.
  await d.say(supervisor, 'फिर से गिना, 39', [{ name: 'help', args: {} }]);
  assert.ok(!d.offered().includes('confirm_count'));
  const again = await runTool(d.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: second, qtysHundredths: [3900, 4000] } });
  assert.deepEqual([again.ok, again.key], [false, 'site.count_already']);
  assert.equal(counts(d, second), 1);
});

/** A supervisor's request held and approved, then through to a bill: its approval is already decided. @param {Awaited<ReturnType<typeof desk>>} d */
async function billedAfterApproval(d) {
  const office = createOffice({ ledger: d.s.siteCore.ledger, tools: d.s.site.tools, kind: 'contractor', tell: () => {}, reply: () => {}, now: d.s.siteCore.now });
  assert.equal((await office.commit(supervisor, 'request_material', { site: 'Invented Site', day: '2026-11-02', items: ITEMS })).key, 'office.held_step');
  await d.say(contractor, 'ok P-1');
  assert.equal(d.last('contractor')?.[1], 'site.material_requested');
  const id = String(d.s.supCore.ledger.orders().at(-1)?.order_id);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: id, answer: 'yes', ratesPaise: [38000, 80000], gstPercents: [18, null] } })).ok, true);
  await settle();
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: id, items: ITEMS, sha256: SHA } })).ok, true);
  await settle();
  assert.equal((await runTool(d.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: id, qtysHundredths: [4000, 4000] } })).ok, true);
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: id } })).ok, true);
  await settle();
  return { id, office };
}

test('"हाँ P1" with the approval decided and a bill: read back, one हाँ accepts the bill in force', async (tc) => {
  const d = await desk(tc);
  const { id } = await billedAfterApproval(d);
  await d.say(contractor, 'हाँ P1');
  assert.equal(d.last('contractor')?.[1], 'step.accept_bill');
  assert.ok(d.last('contractor')?.[2].includes('P-1') && d.last('contractor')?.[2].includes('₹49,936'));
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed', 'not before the yes');
  assert.equal(d.talks.contractor.pending(contractor)?.args.bill, d.s.siteCore.ledger.view(id).currentBill, 'bound to the bill in force');
  assert.equal(d.asked.length, 0, 'read by code');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'accepted');
});

test('"नहीं P-1 ₹54420 कारण" with the approval decided goes to the dispute path', async (tc) => {
  const d = await desk(tc);
  const { id } = await billedAfterApproval(d);
  await d.say(contractor, 'नहीं P-1 ₹54420 दर ज़्यादा');
  const sent = disputes(d, id);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.body.theirFigure, { totalPaise: 5442000 });
  assert.equal(sent[0].body.body.reason, 'दर ज़्यादा');
  assert.equal(d.asked.length, 0);
  assert.equal(d.talks.contractor.pending(contractor), null, 'the bill question ended with it');
});

test('"नहीं P-1" in other words: free figures are read as the objection; no figure shows the format', async (tc) => {
  const d = await desk(tc);
  const { id } = await billedAfterApproval(d);
  await d.say(contractor, 'नहीं P-1');
  assert.equal(d.last('contractor')?.[1], 'site.dispute_format');
  await d.say(contractor, 'नहीं P-1 सीमेंट 50 बोरी है', [disputeItems([['सीमेंट', '50']])]);
  assert.equal(d.last('contractor')?.[1], 'step.dispute_bill_items');
  assert.ok(d.last('contractor')?.[2].includes('₹54,420'));
  assert.equal(disputes(d, id).length, 0, 'not before the yes');
});

test('in the disputed state: हाँ can still accept after a read-back; नहीं says the objection is in', async (tc) => {
  const d = await desk(tc);
  const { id } = await billedAfterApproval(d);
  await d.say(contractor, 'नहीं P-1 ₹54420 दर ज़्यादा');
  await d.say(contractor, 'नहीं P-1 फिर से देखो');
  assert.equal(d.last('contractor')?.[1], 'site.dispute_already');
  assert.equal(disputes(d, id).length, 1);
  await d.say(contractor, 'हाँ P-1');
  assert.equal(d.last('contractor')?.[1], 'step.accept_bill');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'accepted');
});

test('a step still undecided keeps its approval behaviour, on its own reference', async (tc) => {
  const d = await desk(tc);
  const { office, id } = await billedAfterApproval(d);
  const held = await office.commit(supervisor, 'request_material', { site: 'Second Site', day: '2026-11-03', items: ITEMS });
  const ref = String(held.params?.ref);
  const before = d.s.siteCore.ledger.orders().length;
  await d.say(contractor, `हाँ ${ref}`);
  assert.equal(d.s.siteCore.ledger.orders().length, before + 1, 'the approval ran the held step');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed', 'the bill is untouched');
  assert.ok(!d.keys('contractor').includes('step.accept_bill'));
});

test('an undecided step on an order with a bill stays an approval', async (tc) => {
  const d = await desk(tc);
  const { office, id } = await billedAfterApproval(d);
  const held = /** @type {any} */ (await office.commit(supervisor, 'request_material', { orderId: id, site: 'Invented Site', day: '2026-11-04', items: ITEMS }));
  assert.equal(held.params?.ref, 'P-1');
  await d.say(contractor, 'हाँ P-1');
  assert.ok(!d.keys('contractor').slice(-3).includes('step.accept_bill'), d.keys('contractor').join());
  assert.equal(office.held().filter((h) => h.ref === 'P-1' && h.decision === null).length, 0, 'decided as an approval');
});

test('the supervisor gets the normal refusal', async (tc) => {
  const d = await desk(tc);
  const { id } = await billedAfterApproval(d);
  await d.say(supervisor, 'हाँ P-1');
  assert.equal(d.last('supervisor')?.[1], 'office.only_contractor');
  await d.say(supervisor, 'नहीं P-1 ₹54420 दर ज़्यादा');
  assert.equal(d.last('supervisor')?.[1], 'office.only_contractor');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'billed');
  assert.equal(disputes(d, id).length, 0);
});

test('a bill with no question open (the site counted differently): the notice says how to accept, and that works', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-02', items: ITEMS } })).ok, true);
  await settle();
  const id = String(d.s.supCore.ledger.orders().at(-1)?.order_id);
  await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: id, answer: 'yes', ratesPaise: [38000, 80000] } });
  await settle();
  await runTool(d.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: id, items: ITEMS, sha256: SHA } });
  await settle();
  await runTool(d.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: id, qtysHundredths: [3000, 4000] } });
  await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: id } });
  await settle();
  const notice = d.said.find((x) => x[0] === 'contractor' && x[1] === 'site.material_bill_count_differs');
  assert.ok(notice?.[2].includes('"हाँ P-1"'), notice?.[2]);
  assert.equal(d.talks.contractor.pending(contractor), null);
  await d.say(contractor, 'हाँ P-1');
  assert.equal(d.last('contractor')?.[1], 'step.accept_bill');
  await d.say(contractor, 'हाँ');
  assert.equal(d.s.siteCore.ledger.view(id).state, 'accepted');
  const mismatch = t('site.material_bill_mismatch', { ref: 'P-4', site: 'x', lines: 'x', total: 'x', expected: 'x', expectedTotal: 'x', example: '1' });
  assert.ok(mismatch.includes('मंज़ूर हो तो "हाँ P-4" लिखें'), mismatch);
});

/** What Muse did live, twice, on 4babf3c: not an answer, then a new order with no site and no day. @param {[string, string | null][]} items @param {{site?: string | null, day?: string | null, time?: string | null}} [o] */
const newOrderCalls = (items, o = {}) => [[NOT_ANSWER], [{ name: 'request_material', args: { site: o.site ?? null, day: o.day ?? null, time: o.time ?? null, items: items.map(([name, quantity]) => ({ name, quantity, unit: 'बोरी' })) } }]];

test('live again: item names of the bill with figures, no site, no day: code makes it the objection, whatever the model said', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  const orders = d.s.siteCore.ledger.orders().length;
  await d.say(contractor, 'Cement 50 bori, sand 40 ton', ...newOrderCalls([['Cement', '50'], ['sand', '40']]));
  const back = d.last('contractor');
  assert.equal(back?.[1], 'step.dispute_bill_items');
  assert.ok(back?.[2].includes('₹54,420'), back?.[2]);
  await d.say(contractor, 'हाँ');
  assert.deepEqual(disputes(d, id)[0].body.body.theirFigure, { totalPaise: 5442000 });
  assert.equal(disputes(d, id)[0].body.body.reason, 'Cement 50 bori, sand 40 ton');
  assert.equal(d.s.siteCore.ledger.orders().length, orders, 'no new order');
});

test('the same rule: every figure equal to the bill is told so', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'Cement 40 bori', ...newOrderCalls([['Cement', '40']]));
  assert.equal(d.last('contractor')?.[1], 'site.dispute_same');
});

test('the same rule: a figure not in the person\'s words is asked about', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'Cement 50 bori', ...newOrderCalls([['Cement', '55']]));
  assert.equal(d.last('contractor')?.[1], 'site.dispute_which_item');
});

for (const [why, calls, text] of /** @type {[string, any[], string][]} */ ([
  ['a site', newOrderCalls([['Cement', '50']], { site: 'Shivpuri' }), 'Shivpuri par cement 50 bori'],
  ['a day', newOrderCalls([['Cement', '50']], { day: 'tomorrow' }), 'kal cement 50 bori'],
  ['a time', newOrderCalls([['Cement', '50']], { time: '8' }), '8 baje cement 50 bori'],
  ['an item not on the bill', newOrderCalls([['Cement', '50'], ['गिट्टी', '40']]), 'cement 50 गिट्टी 40'],
  ['an item with no figure', newOrderCalls([['Cement', null]]), 'cement bhejo'],
])) {
  test(`with ${why} it stays a new order`, async (tc) => {
    const d = await desk(tc);
    const id = await billed(d);
    await d.say(contractor, text, ...calls);
    assert.ok(['ask.missing', 'step.request_material', 'site.which_site'].includes(/** @type {string} */ (d.said.filter((x) => x[0] === 'contractor').at(-2)?.[1])) || ['ask.missing', 'step.request_material'].includes(/** @type {string} */ (d.last('contractor')?.[1])), d.keys('contractor').join());
    assert.ok(!d.keys('contractor').some((k) => k.startsWith('step.dispute') || k.startsWith('site.dispute')));
    assert.equal(disputes(d, id).length, 0);
  });
}

test('a reference named: the rule does not apply', async (tc) => {
  const d = await desk(tc);
  await billed(d);
  await d.say(contractor, 'P-1 cement 50 bori', ...newOrderCalls([['Cement', '50']]));
  assert.ok(!d.keys('contractor').some((k) => k.startsWith('step.dispute')), d.keys('contractor').join());
});

test('no bill question open: as today, a new order', async (tc) => {
  const d = await desk(tc);
  await d.say(contractor, 'Cement 50 bori', [{ name: 'request_material', args: { site: null, day: null, time: null, items: [{ name: 'Cement', quantity: '50', unit: 'bori' }] } }]);
  assert.equal(d.last('contractor')?.[1], 'ask.missing');
});

test('the supervisor, with a bill open: a new order, never the objection', async (tc) => {
  const d = await desk(tc);
  const id = await billed(d);
  await d.say(supervisor, 'Cement 50 bori', [{ name: 'request_material', args: { site: null, day: null, time: null, items: [{ name: 'Cement', quantity: '50', unit: 'bori' }] } }]);
  assert.ok(!d.keys('supervisor').some((k) => k.startsWith('step.dispute')));
  assert.equal(disputes(d, id).length, 0);
});

test('a JCB yes with no rate asks for the rate, never a read-back with a dash', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02' } })).ok, true);
  await settle();
  await d.say(owner, 'कर देंगे, बारह सौ घंटा लगेगा', [{ name: 'reply_booking', args: { answer: 'yes', rate_rupees_per_hour: null, day: null, time: null } }]);
  assert.equal(d.last('jcb_owner')?.[1], 'jcb.rate_needed');
  assert.equal(d.talks.jcb_owner.pending(owner), null, 'nothing to say हाँ to');
  await d.say(owner, 'हाँ 1200');
  assert.equal(d.last('jcb_owner')?.[1], 'jcb.reply_sent_yes');
});

test('a JCB rate in words the model copied is read back in figures', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02' } })).ok, true);
  await settle();
  await d.say(owner, 'कर देंगे, बारह सौ घंटा लगेगा', [{ name: 'reply_booking', args: { answer: 'yes', rate_rupees_per_hour: 'बारह सौ', day: null, time: null } }]);
  assert.equal(d.last('jcb_owner')?.[1], 'step.reply_booking_yes');
  assert.ok(d.last('jcb_owner')?.[2].includes('₹1,200'), d.last('jcb_owner')?.[2]);
});

test('a supplier yes with a rate missing, or too few, asks for the rates naming the items', async (tc) => {
  const d = await desk(tc);
  assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-02', items: ITEMS } })).ok, true);
  await settle();
  for (const rates of [null, ['380']]) {
    await d.say(supplier, 'दे देंगे', [{ name: 'reply_order', args: { answer: 'yes', rates_rupees: rates, gst_percents: null, day: null, time: null } }]);
    const r = d.last('supplier');
    assert.equal(r?.[1], 'supplier.rates_needed');
    assert.ok(r?.[2].includes('सीमेंट') && !r?.[2].includes('—'), r?.[2]);
    assert.equal(d.talks.supplier.pending(supplier), null);
  }
  await d.say(supplier, 'दे देंगे', [{ name: 'reply_order', args: { answer: 'yes', rates_rupees: ['तीन सौ अस्सी', '800'], gst_percents: null, day: null, time: null } }]);
  assert.equal(d.last('supplier')?.[1], 'step.reply_order_yes');
  assert.ok(d.last('supplier')?.[2].includes('₹380'), d.last('supplier')?.[2]);
});

test('a rate in words: only whole rupees; digits as before', () => {
  assert.equal(parseRatePaise('बारह सौ'), 120000);
  assert.equal(parseRatePaise('डेढ़ हज़ार'), 150000);
  assert.equal(parseRatePaise('1,200'), 120000);
  assert.equal(parseRatePaise('350.50'), 35050);
  assert.equal(parseRatePaise('साढ़े चार'), null, 'could be ₹4.50 or ₹4,500');
  assert.equal(parseRatePaise('कुछ'), null);
});
