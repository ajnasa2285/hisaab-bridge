// Faults an outside review found (31 Oct): a seller's "दिए" taken as money received; a challan's other
// unit carried onto the order; a bill ahead of the site's count offered for one word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { paymentSummary } from '../../src/ledger/payments.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, seesPhoto } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const contractor = person('contractor', 'agent:contractor-1');
const settle = () => new Promise((r) => setTimeout(r, 30));
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const photo = { mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, 7, 7]) };

/** A booked order, with both sides' conversations. Stand-in model that does nothing. @param {any[]} [tells] */
async function booked(tells = []) {
  const s = await setup({ onTell: (side, role, key, _p, expect) => { tells.push({ side, role, key, expect }); } });
  await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-11-01', items: [CEMENT] } });
  await settle();
  const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
  await settle();
  /** @type {string[]} */ const said = [];
  /** @type {any} */ let nextRead = null;
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  const reply = (/** @type {any} */ _p, /** @type {string} */ key, /** @type {any} */ params) => { said.push(key); void t(key, params); };
  const supTalk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, reply, now: s.supCore.now, classifyPhoto: seesPhoto('challan'), readChallan: async () => nextRead });
  const siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now });
  return { s, orderId, said, supTalk, siteTalk, read: (/** @type {any} */ r) => { nextRead = r; } };
}

/** @param {any} f */
async function billed(f) {
  await runTool(f.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: f.orderId, items: [CEMENT], sha256: SHA_A, challanNo: '7' } });
  await settle();
  await runTool(f.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: f.orderId } });
  await settle();
}

test('a seller records money at once only when the words say received', async () => {
  const f = await booked();
  try {
    await billed(f);
    const got = () => paymentSummary(f.s.supCore.ledger.events(f.orderId)).confirmedPaise;
    await f.supTalk.onText(supplier, 'P-1 ₹1000 नकद दिए');
    await settle();
    assert.equal(got(), 0, '"दिए" from a seller records nothing');
    await f.supTalk.onText(supplier, 'P-1 ₹1000 नकद मिले');
    await settle();
    assert.equal(got(), 100000);
  } finally { await f.s.close(); }
});

test('a challan in another unit than the order is asked, not carried across', async () => {
  const f = await booked();
  try {
    f.read({ ok: true, kind: 'challan', challanNo: '7', date: null, vehicle: null, clear: true, signed: null, items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'ton', raw: 'सीमेंट 50 ton' }] });
    await f.supTalk.onImage(supplier, photo);
    assert.equal(f.said.at(-1), 'challan.ask_person');
    assert.equal(f.s.supCore.ledger.events(f.orderId).filter((e) => e.type === 'DELIVERY').length, 0);
  } finally { await f.s.close(); }
});

test('a first bill with no site count says so, and a plain yes does not accept it', async () => {
  /** @type {any[]} */ const tells = [];
  const f = await booked(tells);
  try {
    await billed(f);
    const notice = tells.find((x) => x.side === 'site' && x.role === 'contractor' && x.key === 'site.material_bill_no_count');
    assert.ok(notice, 'the contractor is told no count was recorded');
    assert.equal(notice.expect, undefined, 'no one-word acceptance armed');
    await f.siteTalk.onText(contractor, 'हाँ');
    await settle();
    assert.equal(f.s.siteCore.ledger.view(f.orderId).state, 'billed', 'a plain yes accepts nothing');
  } finally { await f.s.close(); }
});

test('once the site has counted, the same bill keeps its one-word yes', async () => {
  /** @type {any[]} */ const tells = [];
  const f = await booked(tells);
  try {
    await runTool(f.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: f.orderId, items: [CEMENT], sha256: SHA_A, challanNo: '7' } });
    await settle();
    assert.equal((await runTool(f.s.site.tools, contractor, { tool: 'confirm_count', args: { orderId: f.orderId, qtysHundredths: [5000], sameAsChallan: true } })).ok, true);
    await runTool(f.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: f.orderId } });
    await settle();
    const notice = tells.find((x) => x.side === 'site' && x.role === 'contractor' && x.key === 'site.material_bill_received');
    assert.equal(notice?.expect?.tool, 'accept_bill');
  } finally { await f.s.close(); }
});
