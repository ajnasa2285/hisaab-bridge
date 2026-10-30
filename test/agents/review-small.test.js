// The smaller findings of the red-team review (whatsapp3, whatsapp4, model2 to model4) and the lead's
// list from the live test (unit from the order, estimate with GST, supervisor's bill copy, trace depth).
// Readers and Muse Spark are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { createOffice } from '../../src/agents/office.js';
import { guardViolation, numbersSupported } from '../../src/agents/explain.js';
import { answerViolation } from '../../src/agents/ask.js';
import { unitFromOrder } from '../../src/agents/material.js';
import { clean } from '../../src/trace/trace.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B, SHA_C, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000091' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000092' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000093' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000094' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const settle = () => new Promise((r) => setTimeout(r, 30));
/** @param {number} n */
const photo = (n) => ({ mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, n, n, n]) });

/** @param {Awaited<ReturnType<typeof setup>>} s */
async function jcbBooked(s) {
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Rampur', day: '2026-10-29', hoursTenths: 60 } });
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
  await settle();
  return orderId;
}

test('whatsapp3: record_meter rejects a start when the start is already recorded', async () => {
  const s = await setup();
  try {
    const orderId = await jcbBooked(s);
    assert.equal((await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 1000, sha256: SHA_A } })).ok, true);
    const r = await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 1060, sha256: SHA_B } });
    assert.deepEqual([r.ok, r.key], [false, 'jcb.meter_which_stale']);
    assert.equal(s.jcbCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE').length, 1);
  } finally {
    await s.close();
  }
});

test('whatsapp3: two photos overlapping: the slower one is re-read against the ledger before it commits', async () => {
  const s = await setup();
  try {
    const orderId = await jcbBooked(s);
    /** @type {string[]} */
    const said = [];
    /** @type {(() => void)[]} */
    const hold = [];
    const talk = createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      reply: (_p, key) => { said.push(key); }, now: s.jcbCore.now, classifyPhoto: seesPhoto('meter'),
      readMeter: async (image) => {
        await new Promise((r) => { hold.push(() => r(undefined)); });
        const value = image.bytes[2] === 1 ? 1000 : 1060;
        return { ok: true, kind: 'hour_meter', raw: String(value / 10), valueTenths: value, clear: true, displayDate: null };
      } });
    const first = talk.onImage(operator, photo(1));
    await settle();
    const second = talk.onImage(operator, photo(2));
    await settle();
    assert.equal(hold.length, 2, 'both were being read with no reading recorded');
    hold[0]();
    await first;
    hold[1]();
    await second;
    const readings = s.jcbCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE').map((e) => [e.body.which, e.body.valueTenths]);
    assert.deepEqual(readings, [['start', 1000], ['end', 1060]]);
  } finally {
    await s.close();
  }
});

test('whatsapp4: the same phone on another line cannot approve its own held step', async () => {
  const s = await setup();
  try {
    /** @type {[string, string][]} */
    const said = [];
    const office = createOffice({ ledger: s.siteCore.ledger, tools: s.site.tools, kind: 'contractor', limits: { procurementPaise: 100 },
      tell: (_r, key) => { said.push(['tell', key]); }, reply: (_p, key) => { said.push(['reply', key]); }, now: s.siteCore.now });
    const onSiteLine = { ...supervisor, line: 'site-line', phone: '919000000095' };
    const onOtherLine = { ...contractor, line: 'other-line', phone: '919000000095' };
    const held = await office.commit(onSiteLine, 'request_jcb', { site: 'Rampur', day: '2026-10-29', hoursTenths: 60 });
    assert.equal(held.key, 'office.held_step');
    const r = await office.command(onOtherLine, { cmd: 'ok', ref: String(held.params?.ref), note: null });
    assert.deepEqual([r?.ok, r?.key], [false, 'office.own_entry']);
    assert.equal(s.siteCore.ledger.orders().length, 0, 'nothing ran');
  } finally {
    await s.close();
  }
});

test('model3: romanised number words and wording do not pass the guards', () => {
  const bad = 'कुल pachaas hazaar रुपये galat hai, abhi bhej do, kyunki meter kharab hai।';
  assert.equal(numbersSupported('कुल pachaas hazaar का बिल', []), false);
  assert.notEqual(guardViolation(bad, []), null);
  assert.notEqual(answerViolation(bad, []), null);
  for (const [text, rule] of [['बिल galat है', 'verdict'], ['यह ghalat है', 'verdict'], ['अभी bhejo', 'directive'], ['आपको paise मिले', 'payment'], ['kyunki देर हुई', 'cause'], ['मीटर kharab है', 'cause']]) {
    assert.equal(guardViolation(text, []), rule, text);
  }
  for (const word of ['pachaas', 'hazaar', 'hajar', 'teen', 'bees', 'aadha', 'do sau', 'dedh', 'lakh']) assert.equal(numbersSupported(`कुल ${word}`, []), false, word);
  // Ordinary mixed words stay fine.
  assert.equal(guardViolation('JCB बिल और meter की रीडिंग अलग है।', []), null);
});

/** A contractor with a clear UPI reading that carries a payee. @param {any} s @param {any} read */
function upiTalk(s, read) {
  return createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
    reply: () => {}, now: s.siteCore.now, classifyPhoto: seesPhoto('upi'), readUpi: async () => read });
}

test('model4: the payee the UPI reader saw is shown in the seller\'s claim notice', async () => {
  /** @type {string[]} */
  const notices = [];
  const s = await setup({ onTell: (side, _role, key, params) => { if (side === 'supplier' && key.startsWith('pay.seller.')) notices.push(t(key, params)); } });
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [CEMENT] } });
    const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    const read = { ok: true, kind: 'upi_payment', amountPaise: 500000, date: '2026-10-29', utr: '412300000901', status: 'success', clear: true, payeeName: 'Invented Traders', payeeVpa: null, payerName: null };
    await upiTalk(s, read).onImage(contractor, photo(3));
    await settle();
    const claim = s.supCore.ledger.events(orderId).find((e) => e.type === 'PAYMENT_CLAIM');
    assert.equal(claim?.body.body.payeeName, 'Invented Traders');
    assert.ok(notices.at(-1)?.includes('Invented Traders'), notices.at(-1));
    // Without one: as before.
    await upiTalk(s, { ...read, utr: '412300000902', payeeName: null }).onImage(contractor, photo(4));
    await settle();
    assert.equal(s.supCore.ledger.events(orderId).filter((e) => e.type === 'PAYMENT_CLAIM').at(-1)?.body.body.payeeName, undefined);
  } finally {
    await s.close();
  }
});

test('item 19: a reading whose only gap is the unit takes the order\'s unit, only when item and quantity match', () => {
  const order = [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }];
  const read = { clear: false, onlyUnitMissing: true, items: [{ name: ' सीमेंट ', qtyHundredths: 5000, unit: null, raw: 'सीमेंट 50' }] };
  assert.equal(unitFromOrder(order, read), true);
  assert.equal(unitFromOrder(order, { ...read, items: [{ ...read.items[0], qtyHundredths: 4000 }] }), false, 'quantity differs');
  assert.equal(unitFromOrder(order, { ...read, items: [{ ...read.items[0], name: 'बालू' }] }), false, 'item differs');
  assert.equal(unitFromOrder(order, { ...read, onlyUnitMissing: false }), false, 'something else is unclear too');
  assert.equal(unitFromOrder([...order, { name: 'रेत', qtyHundredths: 100, unit: 'ट्रॉली' }], read), false, 'more than one item');
});

test('item 19: the supplier\'s cash memo without a unit column is recorded at once; with another quantity it asks', async () => {
  const s = await setup();
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [CEMENT] } });
    const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    /** @type {string[]} */
    const said = [];
    let qty = 4000;
    const talk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      reply: (_p, key) => { said.push(key); }, now: s.supCore.now, classifyPhoto: seesPhoto('challan'),
      readChallan: async () => ({ ok: true, kind: 'challan', challanNo: '9', date: null, clear: false, onlyUnitMissing: true, signed: null, items: [{ name: 'सीमेंट', qtyHundredths: qty, unit: null, raw: 'सीमेंट 40' }] }) });
    await talk.onImage(supplier, photo(5));
    assert.equal(said.at(-1), 'challan.ask_person', 'another quantity: asked as now');
    qty = 5000;
    await talk.onImage(supplier, photo(6));
    assert.equal(said.at(-1), 'supplier.delivery_sent');
    assert.equal(s.supCore.ledger.view(orderId).state, 'delivered');
  } finally {
    await s.close();
  }
});

test('item 20: the estimate for the ₹25,000 check adds the last GST percent for that party and item', async () => {
  const s = await setup();
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [CEMENT] } });
    const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
    const estimate = s.site.tools.request_material.hold?.estimatePaise;
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000], gstPercents: [28] } });
    // 50 bags × ₹350 = ₹17,500, + 28% = ₹22,400.
    assert.equal(estimate?.({ items: [CEMENT] }), 2240000);
    // An item with no GST known: as before.
    assert.equal(estimate?.({ items: [{ ...CEMENT, name: 'सीमेंट', unit: 'टन' }] }), null);
  } finally {
    await s.close();
  }
});

test('item 21: the supervisor\'s copy of a bill does not ask for हाँ; their हाँ is told who accepts', async () => {
  /** @type {[string, string, string][]} */
  const told = [];
  const s = await setup({ onTell: (side, role, key, params) => { told.push([`${side}:${role}`, key, t(key, params)]); } });
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [CEMENT] } });
    const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_C, challanNo: '7' } });
    await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } });
    await settle();
    const copy = told.find(([w, k]) => w === 'site:supervisor' && k === 'site.bill_copy');
    assert.ok(copy, 'the supervisor gets the copy');
    assert.equal(copy?.[2].includes('हाँ'), false, copy?.[2]);
    assert.ok(copy?.[2].includes('₹17,500'));
    assert.ok(told.some(([w, k, x]) => w === 'site:contractor' && k.startsWith('site.material_bill_received') && x.includes('हाँ')));
    /** @type {string[]} */
    const said = [];
    const talk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      reply: (_p, key) => { said.push(key); }, now: s.siteCore.now });
    await talk.onText(supervisor, 'हाँ');
    assert.deepEqual(said, ['site.bill_contractor_accepts']);
  } finally {
    await s.close();
  }
});

test('item 22: the trace shows request items at their real depth, not [null]', () => {
  const detail = { job: 'understand', calls: [{ tool: 'request_material', args: { site: 'Rampur', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } }] };
  assert.deepEqual(clean(detail), detail);
  // Depth stays bounded.
  /** @type {any} */
  let deep = { x: 1 };
  for (let i = 0; i < 20; i++) deep = { deep };
  assert.ok(JSON.stringify(clean(deep)).length < 200);
});
