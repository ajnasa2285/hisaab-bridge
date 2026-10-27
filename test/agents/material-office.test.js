// Material orders through the site office: a supervisor's order above the limit (or not estimable)
// is held as P-n and runs on the contractor's "OK P-n" with that reference; exact commands answered
// while a challan or count question is open leave the question open, and typed figures never
// swallow a command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { runTool } from '../../src/agents/common.js';
import { openRefs } from '../../src/ledger/refs.js';
import { t } from '../../src/i18n/index.js';
import { setup, person } from './helpers.js';

const supplier = { ...person('supplier', 'agent:supplier-1'), name: 'Supplier' };
const contractor = { ...person('contractor', 'agent:contractor-1'), name: 'Contractor' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012', name: 'Supervisor' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const SAND = { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' };
const settle = () => new Promise((r) => setImmediate(r));

/**
 * The contractor's and the supplier's conversations with their offices over the real agents.
 * @param {import('../../src/agents/office.js').Limits} [limits]
 */
async function desks(limits) {
  /** @type {[string, string, string, any][]} [to, key, text, params] */
  const said = [];
  /** @type {any} */
  const talks = {};
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params), params]);
      if (!expect) return;
      if (side === 'site') talks.site.expect(role === 'supervisor' ? supervisor : contractor, expect.tool, expect.args);
      if (side === 'supplier') talks.sup.expect(supplier, expect.tool, expect.args);
    },
  });
  /** @type {{name: string, args: any}[]} */
  const calls = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: calls.splice(0) });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params), params]); };
  const tellSite = (/** @type {string} */ role, /** @type {string} */ key, /** @type {any} */ params) => { said.push([`all:${role}`, key, t(key, params), params]); };
  /** @type {any} */
  let nextRead = null;
  const siteOffice = createOffice({ ledger: s.siteCore.ledger, tools: s.site.tools, kind: 'contractor', limits, tell: tellSite, reply, now: s.siteCore.now });
  const supOffice = createOffice({ ledger: s.supCore.ledger, tools: s.sup.tools, kind: 'supplier', tell: tellSite, reply, now: s.supCore.now });
  talks.site = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now, office: siteOffice });
  talks.sup = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, readChallan: async () => nextRead, reply, now: s.supCore.now, office: supOffice });
  /** @param {any} who @param {string} text @param {{name: string, args: any}} [call] */
  const site = async (who, text, call) => { if (call) calls.push(call); await talks.site.onText(who, text); };
  /** @param {string} text @param {{name: string, args: any}} [call] */
  const sup = async (text, call) => { if (call) calls.push(call); await talks.sup.onText(supplier, text); };
  const last = (/** @type {string} */ to) => /** @type {[string, string, string, any]} */ (said.filter((x) => x[0] === to).at(-1));
  return { s, said, site, sup, last, talks, siteOffice, read: (/** @type {any} */ r) => { nextRead = r; } };
}

/** @param {string} site @param {{name: string, quantity: string, unit: string}[]} items */
const materialCall = (site, items) => ({ name: 'request_material', args: { site, day: '30-10', time: null, items } });

test('a supervisor\'s material order is held as P-n; the contractor\'s "OK P-n" sends it with that reference', async () => {
  const d = await desks({ procurementPaise: 100000 }); // ₹1,000
  try {
    const refs = openRefs(d.s.siteCore.ledger);
    const supOrders = () => /** @type {{order_id: string}[]} */ (d.s.supCore.ledger.orders());

    // No rate agreed with the supplier yet: cannot be estimated, so held as P-1. Nothing is signed.
    await d.site(supervisor, 'parso Shivpuri cement 50 bori', materialCall('Shivpuri', [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }]));
    assert.equal(d.last('supervisor')[1], 'step.request_material');
    await d.site(supervisor, 'हाँ');
    assert.deepEqual(d.last('supervisor').slice(0, 2), ['supervisor', 'office.held']);
    assert.equal(d.last('supervisor')[3].ref, 'P-1');
    assert.equal(d.s.siteCore.ledger.orders().length, 0);
    const asked = d.last('all:contractor');
    assert.ok(asked[2].includes('"OK P-1"') && asked[2].includes('सीमेंट 50 बोरी') && asked[2].includes('अनुमान —'));

    // The contractor approves: the stored step runs as the supervisor's, and the new order is P-1.
    await d.site(contractor, 'ok p-1');
    assert.deepEqual(d.last('contractor').slice(0, 2), ['contractor', 'site.material_requested']);
    assert.equal(d.last('contractor')[3].ref, 'P-1');
    assert.equal(supOrders().length, 1);
    const orderId = /** @type {{order_id: string}} */ (d.s.siteCore.ledger.orders()[0]).order_id;
    assert.equal(refs.refOf(orderId), 'P-1');
    assert.equal(d.s.supCore.ledger.events(orderId).find((e) => e.type === 'BOOKING_REQUEST')?.body.body.items[0].qtyHundredths, 5000);
    await settle();
    // The supplier numbers it on its own side and sees the reference too.
    assert.equal(d.last('supplier:supplier')[3].ref, 'P-1');

    // ₹350 a bag is agreed; now orders can be estimated against the limit.
    await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    await settle();
    // 10 bags = ₹3,500 > ₹1,000: held as P-2 with its estimate.
    await d.site(supervisor, 'Gwalior cement 10 bori', materialCall('Gwalior', [{ name: 'सीमेंट', quantity: '10', unit: 'बोरी' }]));
    await d.site(supervisor, 'हाँ');
    assert.equal(d.last('supervisor')[1], 'office.held');
    assert.equal(d.last('supervisor')[3].ref, 'P-2');
    assert.ok(d.last('all:contractor')[2].includes('₹3,500'));
    // 2 bags = ₹700: within the limit, sent at once; it takes the next number, P-3.
    await d.site(supervisor, 'Datia cement 2 bori', materialCall('Datia', [{ name: 'सीमेंट', quantity: '2', unit: 'बोरी' }]));
    await d.site(supervisor, 'हाँ');
    assert.deepEqual([d.last('supervisor')[1], d.last('supervisor')[3].ref], ['site.material_requested', 'P-3']);
    // P-2 approved later keeps P-2.
    await d.site(contractor, 'OK P-2');
    assert.deepEqual([d.last('contractor')[1], d.last('contractor')[3].ref], ['site.material_requested', 'P-2']);
    const gwalior = /** @type {{order_id: string, site: string}[]} */ (d.s.siteCore.ledger.orders()).find((x) => x.site === 'Gwalior');
    assert.equal(refs.refOf(/** @type {any} */ (gwalior).order_id), 'P-2');
  } finally {
    await d.s.close();
  }
});

test('commands leave an open challan or count question open; typed figures never swallow "ok P-n" or "status P-n"', async () => {
  const d = await desks({ procurementPaise: 100000 });
  try {
    // The contractor orders (never held), the supplier agrees.
    await d.site(contractor, 'x', materialCall('Shivpuri', [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }, { name: 'रेत', quantity: '2', unit: 'ट्रॉली' }]));
    await d.site(contractor, 'हाँ');
    const orderId = /** @type {{order_id: string}} */ (d.s.siteCore.ledger.orders()[0]).order_id;
    await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000, 400000] } });
    await settle();

    // Supplier: an unclear challan opens a question; "status P-1" is answered and the question stays.
    d.read({ ok: true, kind: 'challan', challanNo: '9', date: null, vehicle: null, clear: false, items: [{ name: 'सीमेंट', qtyHundredths: null, unit: 'bag', raw: 'सीमेंट ?? bag' }] });
    await d.talks.sup.onImage(supplier, { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
    assert.equal(d.last('supplier')[1], 'challan.ask_person');
    await d.sup('status P-1');
    assert.equal(d.last('supplier')[1], 'office.status');
    assert.ok(d.last('supplier')[2].includes('सीमेंट ₹350') && d.last('supplier')[2].includes('Shivpuri'));
    await d.sup('50, 2');
    assert.equal(d.last('supplier')[1], 'step.record_delivery');
    assert.ok(d.last('supplier')[2].includes('सीमेंट 50 बोरी, रेत 2 ट्रॉली'));
    await d.sup('हाँ');
    assert.equal(d.last('supplier')[1], 'supplier.delivery_sent');
    await settle();

    // Site: the count question is open for the supervisor and the contractor.
    assert.equal(d.last('site:supervisor')[1], 'site.delivery_received');
    assert.equal(d.last('site:supervisor')[3].ref, 'P-1');
    // The contractor's "बाक़ी" shows the delivery waiting for the site's count.
    await d.site(contractor, 'बाक़ी');
    assert.equal(d.last('contractor')[1], 'office.pending');
    assert.ok(d.last('contractor')[2].includes('P-1') && d.last('contractor')[2].includes(t('office.await.buyer.delivered')));
    // The supervisor checks status mid-question, then types the count: the question was still open.
    await d.site(supervisor, 'स्थिति P-1');
    assert.equal(d.last('supervisor')[1], 'office.status');
    await d.site(supervisor, '48 2');
    assert.equal(d.last('supervisor')[1], 'step.confirm_count');
    assert.ok(d.last('supervisor')[2].includes('सीमेंट 48 बोरी'));
    await d.site(supervisor, 'हाँ');
    assert.equal(d.last('supervisor')[1], 'site.count_saved_differs');
    assert.ok(d.said.some(([to, key, , p]) => to === 'site:contractor' && key === 'site.count_differs' && p.ref === 'P-1'));

    // The contractor's own count question is open too; "ok P-2" decides the held step and the
    // contractor's "हाँ" afterwards still answers the count question.
    await d.site(supervisor, 'Gwalior cement 10 bori', materialCall('Gwalior', [{ name: 'सीमेंट', quantity: '10', unit: 'बोरी' }]));
    await d.site(supervisor, 'हाँ');
    assert.deepEqual([d.last('supervisor')[1], d.last('supervisor')[3].ref], ['office.held', 'P-2']);
    await d.site(contractor, 'ok P-2');
    assert.equal(d.last('contractor')[1], 'site.material_requested');
    await d.site(contractor, 'हाँ');
    assert.equal(d.last('contractor')[1], 'site.count_matches', 'the open count question (same as the challan) was answered');
    // After the count, the delivered order no longer waits for the contractor.
    await d.site(contractor, 'बाक़ी');
    assert.ok(!d.last('contractor')[2].includes('P-1'));
  } finally {
    await d.s.close();
  }
});
