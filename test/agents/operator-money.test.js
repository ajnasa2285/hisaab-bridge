// The JCB operator sees the order, site, day and state, and no money, on any route: the exact commands,
// ask-anything, what reaches the model, and the code-written answer when the model's is dropped. Muse
// Spark is a stand-in; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { runTool, seesMoney } from '../../src/agents/common.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B, SHA_C } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000031' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000032' };
const settle = () => new Promise((r) => setTimeout(r, 30));
// Every way the money of this order could be written: rate, bill, payment, balance, in rupees or paise.
const MONEY = /₹|1,200|120000|7,320|732000|2,000|200000|5,320|532000|rate|bill|balance|payment/iu;

/** J-1 at Shivpuri, 6.1 hours at ₹1,200, billed ₹7,320 and accepted, ₹2,000 reported paid. */
async function job() {
  const s = await setup();
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29', hoursTenths: 60 } });
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_A } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } })).params?.total, '₹7,320');
  await settle();
  await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } });
  await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 200000, utr: 'UTR123456789', paidOn: '2026-10-29', screenshotSha256: SHA_C } });
  await settle();
  return { s, orderId };
}

/** The JCB agent's conversation with its office; every reply as [key, text], every model request kept. @param {any} s @param {any[]} turns */
function desk(s, turns = []) {
  /** @type {[string, string][]} */
  const said = [];
  /** @type {any[]} */
  const seen = [];
  const reply = (/** @type {any} */ _p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([key, t(key, params)]); };
  const spark = async (/** @type {any} */ req) => {
    seen.push(req);
    const turn = turns.shift();
    return turn === undefined ? { ok: /** @type {const} */ (false), transient: false, reason: 'no more turns' } : { ok: /** @type {const} */ (true), toolCalls: turn };
  };
  const office = createOffice({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, kind: 'jcb', tell: () => {}, reply, now: s.jcbCore.now });
  return { conv: createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark, reply, now: s.jcbCore.now, office }), said, seen };
}

const ASK = { name: 'ask_records', args: {} };
const DETAIL = { name: 'order_detail', args: { ref: 'J-1' } };
const LIST = { name: 'list_orders', args: { site: null, kind: null, state: null, period: 'all', from: null, to: null } };

test('only the operator is kept from money', () => {
  assert.deepEqual(['operator', 'jcb_owner', 'contractor', 'supervisor', 'supplier'].map(seesMoney), [false, true, true, true, true]);
});

test('"status J-1": the operator gets the order, site, day and state; the owner still gets the money', async () => {
  const { s } = await job();
  try {
    const d = desk(s);
    await d.conv.onText(operator, 'status J-1');
    const [key, text] = /** @type {[string, string]} */ (d.said.at(-1));
    assert.equal(key, 'office.status_plain');
    assert.ok(text.includes('J-1') && text.includes('Shivpuri') && text.includes('29 अक्टूबर') && text.includes(t('state.payment_claimed')), text);
    assert.ok(!MONEY.test(text) && !text.includes('दर'), text);

    await d.conv.onText(owner, 'status J-1');
    const [ownerKey, ownerText] = /** @type {[string, string]} */ (d.said.at(-1));
    assert.equal(ownerKey, 'office.status');
    assert.ok(ownerText.includes('₹1,200') && ownerText.includes('₹7,320') && ownerText.includes('₹2,000'), ownerText);
  } finally { await s.close(); }
});

test('"pending": the operator sees no balance; the owner still does', async () => {
  const { s } = await job();
  try {
    const d = desk(s);
    await d.conv.onText(operator, 'pending');
    const [key, text] = /** @type {[string, string]} */ (d.said.at(-1));
    assert.equal(key, 'office.pending');
    assert.ok(text.includes('J-1') && text.includes('Shivpuri'), text);
    assert.ok(!MONEY.test(text), text);

    await d.conv.onText(owner, 'pending');
    assert.ok(d.said.at(-1)?.[1].includes('₹2,000'), d.said.at(-1)?.[1]);
  } finally { await s.close(); }
});

test('asked anything: order_detail and list_orders give the model no money, and the answer has none', async () => {
  const { s } = await job();
  try {
    const answer = { name: 'answer', args: { answer: 'J-1 Shivpuri पर है, हालत भुगतान बताया।' } };
    const d = desk(s, [[ASK], [DETAIL, LIST], [answer]]);
    await d.conv.onText(operator, 'J-1 ka bill kitna hai?');
    assert.equal(d.said.at(-1)?.[0], 'records.answer');
    const last = d.seen.at(-1);
    assert.ok(last.text.includes('Shivpuri') && last.text.includes(t('state.payment_claimed')), last.text);
    const results = last.text.slice(last.text.indexOf('Lookups so far:'));
    assert.ok(!MONEY.test(results.replace(/"with":"[^"]*"/gu, '').replace(/"state":"[^"]*"/gu, '')), results);
    // What the model is told the lookups can do, and that money is not missing but not theirs.
    const offered = d.seen[1].tools.filter((/** @type {any} */ x) => x.function.name !== 'answer');
    assert.deepEqual(offered.map((/** @type {any} */ x) => x.function.name), ['list_orders', 'order_detail']);
    for (const tool of offered) assert.ok(!/rate|bill|payment/iu.test(tool.function.description), tool.function.description);
    assert.ok(d.seen[1].system.includes('order, site, day and state only'));
  } finally { await s.close(); }
});

test('a model naming the money anyway is dropped, and the code-written answer has none', async () => {
  const { s } = await job();
  try {
    const d = desk(s, [[ASK], [DETAIL], [{ name: 'answer', args: { answer: 'J-1 का बिल ₹7,320 है।' } }]]);
    await d.conv.onText(operator, 'J-1 ka bill kitna hai?');
    const [key, text] = /** @type {[string, string]} */ (d.said.at(-1));
    assert.equal(key, 'records.unavailable');
    assert.ok(text.includes('J-1') && text.includes('Shivpuri'), text);
    assert.ok(!MONEY.test(text), text);

    const e = desk(s, [[ASK], [LIST], [{ name: 'answer', args: { answer: 'दर ₹1,200 है।' } }]]);
    await e.conv.onText(operator, 'orders?');
    assert.equal(e.said.at(-1)?.[0], 'records.unavailable');
    assert.ok(!MONEY.test(e.said.at(-1)?.[1] ?? ''), e.said.at(-1)?.[1]);
  } finally { await s.close(); }
});

test('the lookups themselves: plain leaves out every money field; others keep them', async () => {
  const { s } = await job();
  try {
    const ctx = { ledger: s.jcbCore.ledger, side: /** @type {const} */ ('seller'), nowMs: s.jcbCore.now(), facts: orderFacts(s.jcbCore.ledger) };
    const detail = runLookup('order_detail', { ref: 'J-1' }, { ...ctx, plain: true });
    assert.deepEqual(Object.keys(detail.data).sort(), ['day', 'ref', 'site', 'state', 'what', 'with']);
    assert.ok(!detail.allowed.some((a) => a.kind === 'money'));
    const list = runLookup('list_orders', {}, { ...ctx, plain: true });
    assert.deepEqual(Object.keys(list.data.list[0]).sort(), ['day', 'ref', 'site', 'state', 'what', 'with']);
    assert.ok(!list.allowed.some((a) => a.kind === 'money'));

    const full = runLookup('order_detail', { ref: 'J-1' }, ctx);
    assert.equal(full.data.rate_per_hour, '₹1,200');
    assert.equal(full.data.bill_in_force, '₹7,320');
    assert.equal(runLookup('list_orders', {}, ctx).data.list[0].bill, '₹7,320');
  } finally { await s.close(); }
});

test('"रद्द J-1" from the operator is refused before any reason that could name money', async () => {
  const { s } = await job();
  try {
    const d = desk(s);
    await d.conv.onText(operator, 'रद्द J-1');
    assert.equal(d.said.at(-1)?.[0], 'cancel.not_allowed');
  } finally { await s.close(); }
});
