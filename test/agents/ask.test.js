// Ask anything about your own records: Muse Spark (a stand-in that scripts its tool calls) plans the
// lookups and phrases the answer; code runs every lookup on the agent's own ledger, checks every
// number of the answer against the lookups, and answers with its own figures otherwise. Commands and
// committing steps go where they always went. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { runTool } from '../../src/agents/common.js';
import { answerQuestion, answerViolation, lookupsFor, orderFacts, pastDay, periodRange, runLookup } from '../../src/agents/ask.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B, SHA_C } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000021' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000022' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000023' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000024' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const settle = () => new Promise((r) => setImmediate(r));

/**
 * The invented ledgers: J-1 at Shivpuri, 6.1 h at ₹1,200 billed ₹7,320, accepted, paid and settled;
 * P-1 at Shivpuri, cement 50 bags at ₹350 delivered, counted 48 at site, billed ₹17,500.
 */
async function books() {
  const s = await setup();
  let r = await runTool(s.site.tools, supervisor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } });
  assert.equal(r.ok, true);
  const jcbId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId: jcbId, answer: 'yes', ratePaise: 120000 } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId: jcbId, which: 'start', valueTenths: 12345, sha256: SHA_A } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId: jcbId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
  r = await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId: jcbId } });
  assert.equal(r.params?.total, '₹7,320');
  await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId: jcbId } });
  await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: jcbId, amountPaise: 732000, utr: 'UTR123456789', paidOn: '2026-10-29', screenshotSha256: SHA_C } });
  r = await runTool(s.jcb.tools, owner, { tool: 'confirm_payment', args: { orderId: jcbId } });
  assert.equal(r.ok, true);

  r = await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-29', items: [CEMENT] } });
  assert.equal(r.ok, true);
  const matId = /** @type {{order_id: string, kind: string}[]} */ (s.siteCore.ledger.orders()).find((o) => o.kind === 'material')?.order_id ?? '';
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: matId, answer: 'yes', ratesPaise: [35000] } });
  await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: matId, items: [CEMENT], sha256: SHA_A, challanNo: '412' } });
  await settle();
  await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: matId, qtysHundredths: [4800] } });
  r = await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: matId } });
  assert.equal(r.ok, true);
  await settle();
  return s;
}

/**
 * A stand-in Muse Spark: each call takes the next scripted turn (a list of tool calls, or a function
 * of the request). It records every request it saw.
 * @param {(({name: string, args: any}[]) | ((req: any) => any))[]} turns
 */
function script(turns) {
  /** @type {any[]} */
  const seen = [];
  /** @param {any} req */
  const spark = async (req) => {
    seen.push(req);
    const turn = turns.shift();
    if (turn === undefined) return { ok: false, transient: false, reason: 'no more turns' };
    return typeof turn === 'function' ? turn(req) : { ok: true, toolCalls: turn };
  };
  return { spark, seen };
}

/** A conversation on one agent, with its office, recording every reply as [role, key, text]. @param {any} s @param {'site' | 'jcb' | 'sup'} side @param {any} spark */
function talk(s, side, spark) {
  const core = side === 'site' ? s.siteCore : side === 'jcb' ? s.jcbCore : s.supCore;
  const agent = side === 'site' ? s.site : side === 'jcb' ? s.jcb : s.sup;
  /** @type {[string, string, string][]} */
  const said = [];
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const office = createOffice({ ledger: core.ledger, tools: agent.tools, kind: side === 'site' ? 'contractor' : side === 'jcb' ? 'jcb' : 'supplier', tell: () => {}, reply, now: core.now });
  const conv = createConversation({ ledger: core.ledger, tools: agent.tools, spark, reply, now: core.now, office });
  return { conv, said, ledger: core.ledger };
}

const ASK = { name: 'ask_records', args: {} };
const names = (/** @type {any} */ req) => req.tools.map((/** @type {any} */ x) => x.function.name);

test('a one-lookup question: totals by code, the answer with only figures from the lookup', async () => {
  const s = await books();
  try {
    const f = script([
      [ASK],
      [{ name: 'totals', args: { site: 'Shivpuri', kind: 'material', item: 'सीमेंट', period: 'this_month', from: null, to: null, group_by: 'none' } }],
      [{ name: 'answer', args: { answer: 'इस महीने शिवपुरी पर सीमेंट 50 बोरी चालान पर आया, साइट की गिनती 48 बोरी है। बिल ₹17,500 का है।' } }],
    ]);
    const d = talk(s, 'site', f.spark);
    const before = d.ledger.events(/** @type {any} */ (d.ledger.orders()[1]).order_id).length;
    await d.conv.onText(contractor, 'is mahine shivpuri pe kitna cement aaya?');
    assert.equal(d.said.at(-1)?.[1], 'records.answer');
    assert.ok(d.said.at(-1)?.[2].startsWith('इस महीने शिवपुरी पर सीमेंट 50 बोरी'));
    assert.ok(d.said.at(-1)?.[2].includes('(बही से: P-1)'));
    // The router offered the read-only route; the loop offered this role's lookups and the answer.
    assert.ok(names(f.seen[0]).includes('ask_records'));
    assert.deepEqual(names(f.seen[1]), ['list_orders', 'order_detail', 'totals', 'payments', 'stock', 'usual', 'answer']);
    assert.equal(f.seen[1].reasoningEffort, 'low');
    // The model saw the code's figures as display values ("50 बोरी"), never stored integers.
    assert.ok(f.seen[2].text.includes('"delivered_on_challan":"50 बोरी"') && f.seen[2].text.includes('"received_at_site":"48 बोरी"'));
    assert.ok(!f.seen[2].text.includes('5000'));
    // Nothing was committed or left waiting for "हाँ".
    assert.equal(d.ledger.events(/** @type {any} */ (d.ledger.orders()[1]).order_id).length, before);
    assert.equal(d.conv.pending(contractor), null);
  } finally { await s.close(); }
});

test('a two-lookup question: the list first, then one order by its reference', async () => {
  const s = await books();
  try {
    const f = script([
      [ASK],
      [{ name: 'list_orders', args: { site: null, kind: 'jcb', state: null, period: 'all', from: null, to: null } }],
      (/** @type {any} */ req) => {
        assert.ok(req.text.includes('"ref":"J-1"'));
        return { ok: true, toolCalls: [{ name: 'order_detail', args: { ref: 'J-1' } }] };
      },
      [{ name: 'answer', args: { answer: 'J-1 पर 6.1 घंटे का बिल ₹7,320 था। ₹7,320 का भुगतान बताया गया और JCB मालिक ने पुष्टि की।' } }],
    ]);
    const d = talk(s, 'site', f.spark);
    await d.conv.onText(contractor, 'JCB ka bill kitna tha aur paisa gaya?');
    assert.deepEqual(d.said.at(-1)?.slice(0, 1), ['contractor']);
    assert.equal(d.said.at(-1)?.[1], 'records.answer');
    assert.ok(f.seen[3].text.includes('1. list_orders') && f.seen[3].text.includes('2. order_detail'));
    assert.ok(f.seen[3].text.includes('"bill_hours":"6.1 घंटे"') && f.seen[3].text.includes('"settled":"₹7,320, 29 अक्टूबर 2026"'));
  } finally { await s.close(); }
});

test('a question outside the person\'s permission: the operator sees no money lookups, and one named anyway is refused', async () => {
  const s = await books();
  try {
    assert.deepEqual(lookupsFor('operator'), ['list_orders', 'order_detail']);
    const f = script([[ASK], [{ name: 'payments', args: { site: null, kind: null, period: 'all', from: null, to: null } }]]);
    const d = talk(s, 'jcb', f.spark);
    await d.conv.onText(operator, 'kitna paisa aaya?');
    assert.equal(d.said.at(-1)?.[1], 'records.not_allowed');
    assert.deepEqual(names(f.seen[1]), ['list_orders', 'order_detail', 'answer']);
    // Stock lives on the site's agent only; the supplier is not offered it.
    assert.ok(!lookupsFor('supplier').includes('stock'));
    const r = runLookup('stock', { site: null, item: null }, { ledger: s.supCore.ledger, side: 'seller', nowMs: s.supCore.now(), facts: orderFacts(s.supCore.ledger) });
    assert.ok(r.data.error);
  } finally { await s.close(); }
});

test('each agent answers from its own ledger: the supplier sees its own order with the contractor', async () => {
  const s = await books();
  try {
    const facts = orderFacts(s.supCore.ledger);
    assert.deepEqual(facts.map((o) => [o.ref, o.kind, o.state]), [['P-1', 'material', 'billed']]);
    // The site's own count is the contractor's local note: not on the supplier's ledger.
    assert.equal(facts[0].counted, null);
    const r = runLookup('totals', { site: null, kind: null, item: null, period: 'all', from: null, to: null, group_by: 'none' }, { ledger: s.supCore.ledger, side: 'seller', nowMs: s.supCore.now(), facts });
    assert.equal(r.data.groups[0].money.billed, '₹17,500');
    assert.ok(!('received_at_site' in r.data.groups[0].material[0]));
  } finally { await s.close(); }
});

test('a number in the answer that no lookup gave: the code-written figures are sent instead', async () => {
  const s = await books();
  try {
    const f = script([
      [ASK],
      [{ name: 'payments', args: { site: null, kind: null, period: 'this_week', from: null, to: null } }],
      // ₹7,000 is in no lookup (the model rounded): the whole answer is dropped.
      [{ name: 'answer', args: { answer: 'इस हफ़्ते लगभग ₹7,000 का भुगतान JCB मालिक को बताया गया।' } }],
    ]);
    const d = talk(s, 'site', f.spark);
    await d.conv.onText(contractor, 'pichhle hafte kisko kitna payment kiya?');
    const [, key, text] = /** @type {[string, string, string]} */ (d.said.at(-1));
    assert.equal(key, 'records.unavailable');
    assert.ok(text.startsWith('पूरा जवाब नहीं बन पाया'));
    assert.ok(text.includes('J-1 (JCB मालिक, Shivpuri): रक़म ₹7,320 · UPI भुगतान · बिल के लिए · पक्का · 29 अक्टूबर 2026'));
    assert.ok(!text.includes('₹7,000'));
  } finally { await s.close(); }
});

test('the model times out: figures from the last lookup, or a plain "could not answer"', async () => {
  const s = await books();
  try {
    const facts = { ledger: s.siteCore.ledger, person: contractor, nowMs: s.siteCore.now() };
    const hang = () => new Promise(() => {});
    let f = script([[{ name: 'totals', args: { site: null, kind: 'jcb', item: null, period: 'all', from: null, to: null, group_by: 'none' } }], hang]);
    let r = await answerQuestion({ ...facts, spark: f.spark, question: 'JCB के कितने घंटे का बिल बाक़ी है?', limitMs: 300 });
    assert.equal(r.key, 'records.unavailable');
    assert.ok(String(r.params?.figures).includes('JCB घंटे: माँगे 6 घंटे, बिल में 6.1 घंटे, जिनका हिसाब पूरा नहीं 0 घंटे'));
    f = script([hang]);
    r = await answerQuestion({ ...facts, spark: f.spark, question: 'कितना सीमेंट आया?', limitMs: 300 });
    assert.equal(r.key, 'records.no_answer');
    // An outage, and an answer with no lookup behind it, are no answer either.
    f = script([() => ({ ok: false, transient: true, reason: 'timeout' })]);
    assert.equal((await answerQuestion({ ...facts, spark: f.spark, question: 'कितना सीमेंट आया?' })).key, 'records.no_answer');
    f = script([[{ name: 'answer', args: { answer: 'कोई सीमेंट नहीं आया।' } }]]);
    assert.equal((await answerQuestion({ ...facts, spark: f.spark, question: 'कितना सीमेंट आया?' })).key, 'records.no_answer');
  } finally { await s.close(); }
});

test('at most 4 lookups: the fifth round offers only the answer', async () => {
  const s = await books();
  try {
    const look = { name: 'order_detail', args: { ref: 'P-1' } };
    const f = script([[look, look], [look], [look, look], (/** @type {any} */ req) => {
      assert.deepEqual(names(req), ['answer']);
      return { ok: true, toolCalls: [{ name: 'answer', args: { answer: 'P-1 पर सीमेंट 50 बोरी आया।' } }] };
    }]);
    const r = await answerQuestion({ spark: f.spark, ledger: s.siteCore.ledger, person: contractor, question: 'P-1?', nowMs: s.siteCore.now() });
    assert.equal(r.key, 'records.answer');
    assert.equal(f.seen.length, 4);
  } finally { await s.close(); }
});

test('the answer guard: no reminder, no verdict, no directive, numbers only from the lookups', () => {
  const allowed = [{ value: '₹7,320', kind: /** @type {const} */ ('money') }, { value: 'J-1', kind: /** @type {const} */ ('identifier') }];
  assert.equal(answerViolation('J-1 का बिल ₹7,320 है।', allowed), null);
  assert.equal(answerViolation('J-1 का ₹7,320 का भुगतान बताया गया है।', allowed), null);
  assert.equal(answerViolation('J-1 का ₹7,320 कृपया भेजें।', allowed), 'directive');
  assert.equal(answerViolation('J-1 का ₹7,320 बाक़ी है, याद दिला दें।', allowed), 'reminder');
  assert.equal(answerViolation('J-1 का बिल ₹7,320 सही है।', allowed), 'verdict');
  assert.equal(answerViolation('J-1 का बिल ₹7,300 है।', allowed), 'numbers');
  assert.equal(answerViolation('J-1 का बिल दो हज़ार है।', allowed), 'numbers');
  assert.equal(answerViolation('The bill is ₹7,320.', allowed), 'shape');
});

test('periods are days computed by code; dates are read for the past', () => {
  const now = Date.parse('2026-10-29T02:30:00Z'); // Thursday 29 Oct, IST
  assert.deepEqual(periodRange({ period: 'this_week' }, now), { from: '2026-10-26', to: '2026-10-29' });
  assert.deepEqual(periodRange({ period: 'last_week' }, now), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(periodRange({ period: 'this_month' }, now), { from: '2026-10-01', to: '2026-10-29' });
  assert.deepEqual(periodRange({ period: 'last_month' }, now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange({ period: 'yesterday' }, now), { from: '2026-10-28', to: '2026-10-28' });
  assert.deepEqual(periodRange({ period: 'all' }, now), { from: null, to: null });
  assert.deepEqual(periodRange({ period: 'all', from: '1-10', to: '15-10' }, now), { from: '2026-10-01', to: '2026-10-15' });
  assert.equal(periodRange({ period: 'all', from: 'kal' }, now), null);
  assert.equal(pastDay('5-12', '2026-10-29'), '2025-12-05');
  assert.equal(pastDay('31-2', '2026-10-29'), null);
});

test('a question that is really a command still goes to the command, without the model', async () => {
  const s = await books();
  try {
    const f = script([]);
    const d = talk(s, 'site', f.spark);
    await d.conv.onText(contractor, 'स्थिति J-1');
    assert.equal(d.said.at(-1)?.[1], 'office.status');
    await d.conv.onText(supervisor, 'stock सीमेंट');
    assert.equal(d.said.at(-1)?.[1], 'office.stock');
    assert.equal(f.seen.length, 0);
  } finally { await s.close(); }
});

test('a committing request still goes to the normal step with its read-back', async () => {
  const s = await books();
  try {
    const f = script([[{ name: 'request_material', args: { site: 'Shivpuri', day: '30-10', time: null, items: [{ name: 'सीमेंट', quantity: '20', unit: 'बोरी' }] } }]]);
    const d = talk(s, 'site', f.spark);
    await d.conv.onText(contractor, 'शिवपुरी सीमेंट 20 बोरी 30-10');
    assert.equal(d.said.at(-1)?.[1], 'step.request_material');
    assert.equal(d.conv.pending(contractor)?.kind, 'confirm');
    assert.equal(f.seen.length, 1);
  } finally { await s.close(); }
});

test('the model\'s "null" words are null, a made-up choice is an error it sees, and an answer after only errors is not sent', async () => {
  const s = await books();
  try {
    const ctx = { ledger: s.siteCore.ledger, side: /** @type {const} */ ('buyer'), nowMs: s.siteCore.now(), facts: orderFacts(s.siteCore.ledger) };
    const r = runLookup('totals', { site: 'null', kind: 'jcb', item: 'None', period: 'null', from: 'null', to: '', group_by: 'null' }, ctx);
    assert.equal(r.data.groups[0].jcb.hours_billed, '6.1 घंटे');
    assert.match(runLookup('list_orders', { site: null, kind: 'truck', state: null, period: 'all', from: null, to: null }, ctx).data.error, /kind must be one of/);
    const f = script([
      [{ name: 'list_orders', args: { site: null, kind: null, state: 'pending', period: 'all', from: null, to: null } }],
      [{ name: 'answer', args: { answer: 'कोई काम दर्ज नहीं मिला।' } }],
    ]);
    assert.equal((await answerQuestion({ spark: f.spark, ledger: s.siteCore.ledger, person: contractor, question: 'कौन से काम बाक़ी हैं?', nowMs: s.siteCore.now() })).key, 'records.no_answer');
  } finally { await s.close(); }
});
