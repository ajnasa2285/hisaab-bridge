// A correction can take one item to zero (it never came), the contractor can object the same way, and
// every item at zero is refused: a ₹0 bill has no clean end. Real agents over A2A, both ledgers compared;
// the conversation route with a stand-in model. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { runTool } from '../../src/agents/common.js';
import { billFollows, linesText, materialBillBody, sameItems } from '../../src/agents/material.js';
import { bodyIsValid } from '../../src/protocol/messages.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A } from './helpers.js';

const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000071' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000072' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000073' };
const settle = () => new Promise((r) => setTimeout(r, 30));
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const SAND = { name: 'बालू', qtyHundredths: 200, unit: 'ट्रॉली' };
const RATES = [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000, gstPercent: 28 }, { name: 'बालू', unit: 'ट्रॉली', ratePaise: 400000 }];
const CHALLAN = { sha256: SHA_A, number: '7', sentAt: '2026-10-29T08:00:00.000Z' };

/** Agents and conversations, wired as the app wires notices. @param {import('node:test').TestContext} tc @param {any[]} [items] */
async function billedOrder(tc, items = [CEMENT, SAND]) {
  /** @type {[string, string, string][]} */ const said = [];
  /** @type {any[][]} */ const script = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: script.shift() ?? [{ name: 'help', args: {} }] });
  /** @type {Record<string, any>} */ const talks = {};
  const s = await setup({ onTell: (_side, role, key, params, expect) => {
    said.push([role, key, t(key, params)]);
    const who = /** @type {Record<string, any>} */ ({ contractor, supervisor, supplier })[role];
    if (expect && who) talks[role]?.expect(who, expect.tool, expect.args, expect.no, { key, params });
  } });
  tc.after(() => s.close());
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  /** @param {any} core @param {any} tools @param {'contractor' | 'supplier'} kind */
  const talk = (core, tools, kind) => createConversation({ ledger: core.ledger, tools, spark, reply, now: core.now,
    office: createOffice({ ledger: core.ledger, tools, kind, tell: () => {}, reply, now: core.now }) });
  const site = talk(s.siteCore, s.site.tools, 'contractor');
  Object.assign(talks, { contractor: site, supervisor: site, supplier: talk(s.supCore, s.sup.tools, 'supplier') });
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-02', items } })).ok, true);
  await settle();
  const orderId = String(s.supCore.ledger.orders()[0].order_id);
  const rates = items.length === 2 ? { ratesPaise: [35000, 400000], gstPercents: [28, null] } : { ratesPaise: [35000] };
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ...rates } })).ok, true);
  await settle();
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items, sha256: SHA_A, challanNo: '7' } })).ok, true);
  await settle();
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
  await settle();
  /** @param {any} who @param {string} text @param {...any} calls */
  const say = async (who, text, ...calls) => { script.push(...calls); await talks[who.role].onText(who, text); await settle(); };
  /** Both ledgers name the same bill in force, for the same total, in the same state. */
  const agree = () => {
    const [a, b] = [s.siteCore.ledger.view(orderId), s.supCore.ledger.view(orderId)];
    assert.deepEqual([a.state, a.currentBill, a.billTotalPaise], [b.state, b.currentBill, b.billTotalPaise]);
    return a;
  };
  return { s, orderId, say, said, agree, talks, last: (/** @type {string} */ role) => said.filter((x) => x[0] === role).at(-1) };
}

test('an item at 0: the line stays and comes to nothing, GST included, and the other side finds it follows', () => {
  const delivered = [CEMENT, SAND];
  const body = /** @type {NonNullable<ReturnType<typeof materialBillBody>>} */ (materialBillBody([{ ...CEMENT, qtyHundredths: 0 }, SAND], RATES, CHALLAN));
  assert.deepEqual(body.lines[0], { what: 'सीमेंट', qtyHundredths: 0, ratePaise: 35000, taxablePaise: 0, gstPercent: 28, gstPaise: 0, amountPaise: 0 });
  assert.equal(body.totalPaise, 800000);
  assert.ok(billFollows(body, delivered, RATES, { sameQty: false }));
  assert.equal(billFollows(body, delivered, RATES, { sameQty: true }), false, 'a first bill carries what was delivered');
  assert.match(linesText(body.lines, delivered), /सीमेंट 0 बोरी × ₹350/u);
  const none = /** @type {NonNullable<ReturnType<typeof materialBillBody>>} */ (materialBillBody([{ ...CEMENT, qtyHundredths: 0 }, { ...SAND, qtyHundredths: 0 }], RATES, CHALLAN));
  assert.equal(billFollows(none, delivered, RATES, { sameQty: false }), false, 'every item at 0 never follows');
  assert.ok(sameItems([SAND], [{ ...CEMENT, qtyHundredths: 0 }, SAND]), 'left out and at 0 are the same');
  assert.equal(sameItems([CEMENT], [CEMENT, SAND]), false);
});

test('the protocol: 0 only on a correction, never on every line', () => {
  const zero = { what: 'सीमेंट', qtyHundredths: 0, ratePaise: 35000, amountPaise: 0 };
  const some = { what: 'बालू', qtyHundredths: 200, ratePaise: 400000, amountPaise: 800000 };
  const base = { evidence: [], replaces: '11111111-1111-4111-8111-111111111111' };
  assert.equal(bodyIsValid('CORRECTION', { ...base, lines: [zero, some], totalPaise: 800000 }), true);
  assert.equal(bodyIsValid('CORRECTION', { ...base, lines: [zero], totalPaise: 0 }), false);
  assert.equal(bodyIsValid('BILL', { lines: [zero, some], totalPaise: 800000, evidence: [] }), false);
  assert.equal(bodyIsValid('BILL', { lines: [some], totalPaise: 800000, evidence: [] }), true);
});

test('"सुधार 0 2": read back, sent, both ledgers agree; a count that says the same keeps the one-word yes', async (tc) => {
  const d = await billedOrder(tc);
  await runTool(d.s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId: d.orderId, totalPaise: 800000, reason: 'सीमेंट नहीं आई' } });
  await settle();
  assert.equal(d.agree().state, 'disputed');
  await d.say(supplier, 'सुधार 0 2');
  const back = d.last('supplier');
  assert.equal(back?.[1], 'step.send_material_correction');
  assert.ok(back?.[2].includes('सीमेंट 0 बोरी'), back?.[2]);
  assert.ok(back?.[2].includes('₹8,000'), back?.[2]);
  await d.say(supplier, 'हाँ');
  const v = d.agree();
  assert.deepEqual([v.state, v.billTotalPaise], ['billed', 800000]);
  const notice = d.said.filter((x) => x[0] === 'contractor').map((x) => x[1]);
  assert.ok(notice.includes('site.material_correction_received'), notice.join());
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'accepted');
  // The balance is what the correction says, on both sides; it settles like any other bill.
  assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_received', args: { orderId: d.orderId, amountPaise: 800000, method: 'cash', receivedOn: '2026-11-03' } })).ok, true);
  await settle();
  assert.equal(d.agree().state, 'settled');
});

test('the other item at 0: the total is the one left, GST included', async (tc) => {
  const d = await billedOrder(tc);
  await runTool(d.s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId: d.orderId, totalPaise: 800000, reason: 'सीमेंट नहीं आई' } });
  await settle();
  const r = await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId: d.orderId, qtysHundredths: [2500, 0] } });
  assert.equal(r.ok, true);
  await settle();
  assert.equal(d.agree().billTotalPaise, 1120000, '25 bags × ₹350 + 28% GST; the sand at nothing');
});

test('every item at 0 is refused at each door, with what to do; the bill stays as it was', async (tc) => {
  const d = await billedOrder(tc);
  const before = d.agree();
  await d.say(supplier, 'सुधार 0 0');
  assert.equal(d.last('supplier')?.[1], 'supplier.correction_nothing');
  assert.ok(d.last('supplier')?.[2].includes('P-1'));
  await d.say(supplier, 'कुछ नहीं आया सब शून्य कर दो', [{ name: 'send_correction', args: { order: 'P-1', quantities: ['0', '0'] } }]);
  assert.equal(d.last('supplier')?.[1], 'supplier.correction_nothing', 'the model reading it the same way');
  const r = await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId: d.orderId, qtysHundredths: [0, 0] } });
  assert.deepEqual([r.ok, r.key], [false, 'supplier.correction_nothing']);
  assert.deepEqual(d.agree(), before);
  assert.equal(d.s.supCore.ledger.events(d.orderId).filter((/** @type {any} */ e) => e.type === 'CORRECTION').length, 0);
});

test('the contractor objects that the one item never came: "नहीं 0 बोरी नहीं आई"', async (tc) => {
  const d = await billedOrder(tc, [CEMENT]);
  await d.say(contractor, 'नहीं 0 बोरी नहीं आई');
  const v = d.agree();
  assert.equal(v.state, 'disputed');
  const sent = d.s.supCore.ledger.events(d.orderId).find((/** @type {any} */ e) => e.type === 'DISPUTE');
  assert.deepEqual(sent?.body.body.theirFigure, { qtyHundredths: 0 });
  const told = d.said.find((x) => x[0] === 'supplier' && x[1] === 'supplier.bill_disputed');
  assert.ok(told?.[2].includes('0 बोरी'), told?.[2]);
  // Nothing came: no ₹0 bill can answer it.
  await d.say(supplier, 'सुधार 0 बोरी');
  assert.equal(d.last('supplier')?.[1], 'supplier.correction_nothing');
});

test('an item named at 0 on a longer bill: the read-back shows it, code works out the total', async (tc) => {
  const d = await billedOrder(tc);
  const text = 'सीमेंट 0 बोरी आई, बिल्कुल नहीं आई';
  await d.say(contractor, text, [{ name: 'dispute_bill', args: { their_hours: null, their_quantity: null, their_total_rupees: null, their_items: [{ item: 'सीमेंट', quantity: '0' }], reason: 'x' } }]);
  const back = d.last('contractor');
  assert.equal(back?.[1], 'step.dispute_bill_items');
  assert.ok(back?.[2].includes('सीमेंट 0 बोरी'), back?.[2]);
  assert.ok(back?.[2].includes('₹8,000'), back?.[2]);
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'disputed');
  const sent = d.s.supCore.ledger.events(d.orderId).find((/** @type {any} */ e) => e.type === 'DISPUTE');
  assert.deepEqual(sent?.body.body.theirFigure, { totalPaise: 800000 });
});

test('the contractor names every item at 0: a signed claim of ₹0, no bill; the seller sees it', async (tc) => {
  const d = await billedOrder(tc);
  const text = 'सीमेंट 0 बालू 0 कुछ नहीं आया';
  await d.say(contractor, text, [{ name: 'dispute_bill', args: { their_hours: null, their_quantity: null, their_total_rupees: null, their_items: [{ item: 'सीमेंट', quantity: '0' }, { item: 'बालू', quantity: '0' }], reason: 'x' } }]);
  assert.ok(d.last('contractor')?.[2].includes('₹0'), d.last('contractor')?.[2]);
  await d.say(contractor, 'हाँ');
  assert.equal(d.agree().state, 'disputed');
  const told = d.said.find((x) => x[0] === 'supplier' && x[1] === 'supplier.bill_disputed');
  assert.ok(told?.[2].includes('₹0'), told?.[2]);
});

test('a JCB objection still needs hours above 0', async (tc) => {
  const s = await setup({});
  tc.after(() => s.close());
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-02' } });
  const orderId = String(s.siteCore.ledger.orders()[0].order_id);
  const r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 0, reason: 'x' } });
  assert.deepEqual([r.ok, r.key], [false, 'site.figure_needed']);
});
