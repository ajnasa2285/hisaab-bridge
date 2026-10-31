// A whole material order between the contractor's agent and the supplier's agent over real A2A
// HTTP: order, rates, delivery with a challan, the site's own count, bill = delivered qty × agreed
// rate, dispute and correction, payment claim, settled. Both ledgers must agree at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { billFollows, challanQuantities, lineAmountPaise, materialBillBody } from '../../src/agents/material.js';
import { createOffice } from '../../src/agents/office.js';
import { prepare } from '../../src/protocol/exchange.js';
import { setup, person, SHA_A, SHA_C } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const contractor = person('contractor', 'agent:contractor-1');
const supervisor = person('supervisor', 'agent:contractor-1');
const settle = () => new Promise((r) => setImmediate(r));
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const SAND = { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' };

/** Orders cement (and sand) and books it at ₹350/बोरी (and ₹4,000/ट्रॉली). @param {any} s @param {any[]} items */
async function bookedOrder(s, items) {
  const r = await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-29', items } });
  assert.deepEqual([r.ok, r.key], [true, 'site.material_requested']);
  const orderId = s.siteCore.ledger.orders()[0].order_id;
  const rates = [35000, 400000].slice(0, items.length);
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: rates } })).ok, true);
  return orderId;
}

test('the rounding rule: qty × rate / 100 to the nearest paisa, half up, integers only', () => {
  assert.equal(lineAmountPaise(5000, 35000), 1750000, '50 bags × ₹350 = ₹17,500');
  assert.equal(lineAmountPaise(250, 33333), 83333, '2.5 × ₹333.33 = ₹833.325 → ₹833.33');
  assert.equal(lineAmountPaise(150, 33), 50, '1.5 × ₹0.33 = 49.5 paise → 50');
  assert.equal(lineAmountPaise(149, 33), 49, '1.49 × ₹0.33 = 49.17 paise → 49');
  assert.equal(lineAmountPaise(0, 35000), null, 'a line has a quantity');
  assert.equal(lineAmountPaise(5000, 350.5), null, 'integers only');
  assert.equal(lineAmountPaise(Number.MAX_SAFE_INTEGER, 2), null, 'beyond safe integers is refused, not rounded');
  const body = materialBillBody([CEMENT, SAND], [{ name: 'रेत', unit: 'ट्रॉली', ratePaise: 400000 }, { name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }], { sha256: SHA_A, number: '412', sentAt: '2026-10-29T06:00:00.000Z' });
  assert.deepEqual(body?.lines.map((l) => [l.what, l.amountPaise]), [['सीमेंट', 1750000], ['रेत', 800000]]);
  assert.equal(body?.totalPaise, 2550000);
  assert.deepEqual(body?.evidence, [{ sha256: SHA_A, kind: 'challan', readValue: '412', takenAt: null, sentAt: '2026-10-29T06:00:00.000Z' }]);
  assert.equal(materialBillBody([{ ...CEMENT, unit: 'टन' }], [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }], { sha256: SHA_A, number: null, sentAt: '2026-10-29T06:00:00.000Z' }), null, 'no agreed rate, no bill');
  // The contractor's check uses the same rule.
  const rates = [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }];
  const bill = /** @type {NonNullable<typeof body>} */ (materialBillBody([CEMENT], rates, { sha256: SHA_A, number: null, sentAt: '2026-10-29T06:00:00.000Z' }));
  assert.equal(billFollows(bill, [CEMENT], rates, { sameQty: true }), true);
  assert.equal(billFollows({ ...bill, lines: [{ ...bill.lines[0], amountPaise: 1750001 }] }, [CEMENT], rates, { sameQty: true }), false);
  assert.equal(billFollows({ ...bill, lines: [{ ...bill.lines[0], qtyHundredths: 4800, amountPaise: 1680000 }] }, [CEMENT], rates, { sameQty: true }), false, 'a first bill has the delivered quantity');
  assert.equal(billFollows({ ...bill, lines: [{ ...bill.lines[0], qtyHundredths: 4800, amountPaise: 1680000 }] }, [CEMENT], rates, { sameQty: false }), true, 'a correction may change the quantity');
});

test('a challan is matched to the order by name, never by position, and never across units', () => {
  const order = [{ name: 'सीमेंट', unit: 'बोरी' }, { name: 'Sand', unit: 'trolley' }];
  assert.deepEqual(challanQuantities(order, [{ name: ' sand ', qtyHundredths: 200 }, { name: 'सीमेंट', qtyHundredths: 5000 }]), [5000, 200]);
  assert.deepEqual(challanQuantities(order, [{ name: 'OPC 53', qtyHundredths: 5000 }, { name: 'Sand', qtyHundredths: 200 }]), [5000, 200], 'OPC is cement');
  assert.deepEqual(challanQuantities(order, [{ name: 'OPC 53', qtyHundredths: 5000 }, { name: 'Balu', qtyHundredths: 200 }]), [5000, 200], 'balu is sand');
  assert.deepEqual(challanQuantities(order, [{ name: 'OPC 53', qtyHundredths: 5000 }, { name: 'Stone', qtyHundredths: 200 }]), [5000, null], 'the one left is not guessed');
  assert.deepEqual(challanQuantities(order, [{ name: 'OPC 53', qtyHundredths: 5000 }]), [5000, null], 'a line missing: asked');
  assert.deepEqual(challanQuantities([{ name: 'सीमेंट', unit: 'बोरी' }], [{ name: 'Gravel', qtyHundredths: 5000 }]), [null], 'one item, one line, another material: asked');
  assert.deepEqual(challanQuantities([{ name: 'sand', unit: 'ton' }], [{ name: 'Sand', qtyHundredths: 4000, unit: 'cft' }]), [null], '40 cft is not 40 tons: asked');
  assert.deepEqual(challanQuantities([{ name: 'cement', unit: 'bori' }], [{ name: 'Cement', qtyHundredths: 5000, unit: 'bag' }]), [5000], 'bori and bag are one unit');
  assert.deepEqual(challanQuantities([{ name: 'रेत', unit: 'ट्रॉली' }], [{ name: 'Sand', qtyHundredths: 200, unit: 'trip' }]), [200], 'a trolley is a trip here');
  assert.deepEqual(challanQuantities([{ name: 'sand', unit: 'dumper' }], [{ name: 'Sand', qtyHundredths: 200, unit: 'ton' }]), [200], 'a unit we do not know is not called different');
  assert.deepEqual(challanQuantities(order, [{ name: 'सीमेंट', qtyHundredths: null }, { name: 'Sand', qtyHundredths: 200 }]), [null, 200]);
});

test('a challan listing the items in another order keeps each quantity on its own item (live, 31 Oct)', () => {
  const order = [{ name: 'cement', unit: 'bori' }, { name: 'sand', unit: 'ton' }];
  const seen = [{ name: 'Sand', qtyHundredths: 4000 }, { name: 'ACC Cement (Bags)', qtyHundredths: 5000 }];
  assert.deepEqual(challanQuantities(order, seen), [5000, 4000]);
  assert.deepEqual(challanQuantities(order, [...seen].reverse()), [5000, 4000]);
  assert.deepEqual(challanQuantities([{ name: 'सीमेंट', unit: 'बोरी' }, { name: 'रेत', unit: 'टन' }], seen), [5000, 4000], 'the usual Hindi names, other order');
  assert.deepEqual(challanQuantities([{ name: 'पत्थर', unit: 'टन' }, { name: 'मिट्टी', unit: 'टन' }], [{ name: 'Stone', qtyHundredths: 100 }, { name: 'Soil', qtyHundredths: 200 }]), [null, null], 'names it does not know: asked');
  assert.deepEqual(challanQuantities(order, [{ name: 'Cement sand mix', qtyHundredths: 100 }, { name: 'Gravel', qtyHundredths: 200 }]), [null, null], 'one line fits two items: not guessed');
  assert.deepEqual(challanQuantities(order, [{ name: 'White cement', qtyHundredths: 100 }, { name: 'Grey cement', qtyHundredths: 200 }]), [null, null], 'two lines fit one item: not guessed');
});

test('a whole material order, from request to settled, leaves both ledgers in agreement', async () => {
  /** @type {[string, string, string, any][]} */
  const expects = [];
  const s = await setup({ onTell: (side, role, key, _p, expect) => { if (expect) expects.push([side, role, key, expect]); } });
  try {
    let r = await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-29', time: '09:00', items: [CEMENT, SAND] } });
    assert.deepEqual([r.ok, r.key], [true, 'site.material_requested']);
    const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
    const order = /** @type {{kind: string, counterparty: string}} */ (s.siteCore.ledger.order(orderId));
    assert.deepEqual([order.kind, order.counterparty], ['material', 'agent:supplier-1']);
    assert.equal(s.supCore.ledger.view(orderId).state, 'requested');
    await settle();
    assert.ok(s.told.some(([a, role, key, p]) => a === 'supplier' && role === 'supplier' && key === 'supplier.order_request_time' && p.items === 'सीमेंट 50 बोरी, रेत 2 ट्रॉली'));

    // "Yes" needs one rate per item; the rates are what the bill will use.
    r = await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes' } });
    assert.deepEqual([r.ok, r.key], [false, 'supplier.rates_needed']);
    r = await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    assert.equal(r.key, 'supplier.rates_needed');
    r = await runTool(s.sup.tools, contractor, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000, 400000] } });
    assert.equal(r.key, 'common.not_allowed');
    r = await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000, 400000] } });
    assert.deepEqual([r.ok, r.key], [true, 'supplier.reply_sent_yes']);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'booked');
    await settle();
    assert.ok(s.told.some(([a, role, key, p]) => a === 'site' && role === 'supervisor' && key === 'site.material_booking_yes_time' && p.rates === 'सीमेंट ₹350/बोरी, रेत ₹4,000/ट्रॉली'));

    // No bill before the delivery; only agreed items can be delivered.
    assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).key, 'supplier.delivery_missing');
    r = await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [{ name: 'सरिया', qtyHundredths: 100, unit: 'टन' }], sha256: SHA_A } });
    assert.equal(r.key, 'supplier.item_not_agreed');
    r = await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT, SAND], sha256: SHA_A, challanNo: '412' } });
    assert.deepEqual([r.ok, r.key], [true, 'supplier.delivery_sent']);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'delivered');
    await settle();
    // The site is asked for its own count; a plain "हाँ" means "the same as the challan".
    assert.ok(s.told.some(([a, role, key, p]) => a === 'site' && role === 'supervisor' && key === 'site.delivery_received_challan' && p.challan === '412'));
    const ask = expects.find(([a, role, key]) => a === 'site' && role === 'supervisor' && key === 'site.delivery_received_challan');
    assert.deepEqual(ask?.[3], { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000, 200], sameAsChallan: true } });
    r = await runTool(s.site.tools, supervisor, ask?.[3]);
    assert.deepEqual([r.ok, r.key], [true, 'site.count_matches']);
    assert.equal(s.supCore.ledger.events(orderId).filter((e) => e.type === 'NOTE').length, 0, 'the site count stays on the site side');
    // A count equal to the challan is still told to the contractor, with how it was entered; nothing is asked.
    assert.ok(s.told.some(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.count_told_yes'));
    assert.ok(!expects.some(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.count_told_yes'), 'told only');
    const entry = s.siteCore.ledger.events(orderId).find((e) => e.type === 'NOTE' && e.body.kind === 'site_count');
    assert.deepEqual([entry?.body.by, entry?.body.how], ['supervisor', 'yes']);

    // The bill is built by code: 50 × ₹350 + 2 × ₹4,000 = ₹25,500, the challan as evidence.
    r = await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } });
    assert.deepEqual([r.ok, r.params?.total], [true, '₹25,500']);
    const bill = s.siteCore.ledger.events(orderId).find((e) => e.type === 'BILL');
    assert.deepEqual(bill?.body.body.lines, [
      { what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 },
      { what: 'रेत', qtyHundredths: 200, ratePaise: 400000, amountPaise: 800000 },
    ]);
    assert.deepEqual(bill?.body.body.evidence.map((/** @type {any} */ e) => [e.kind, e.sha256, e.readValue]), [['challan', SHA_A, '412']]);
    await settle();
    assert.ok(expects.some(([a, role, key, e]) => a === 'site' && role === 'contractor' && key === 'site.material_bill_received' && e.tool === 'accept_bill'));

    // A quantity names one item: on this two-line bill only a total can be disputed.
    r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, reason: 'site count' } });
    assert.deepEqual([r.ok, r.key], [false, 'site.material_total_only']);
    assert.equal(s.supCore.ledger.view(orderId).state, 'billed', 'nothing was sent');
    r = await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } });
    assert.deepEqual([r.ok, r.key], [true, 'site.material_bill_accepted']);
    await settle();
    assert.ok(s.told.some(([a, , key]) => a === 'supplier' && key === 'supplier.bill_accepted'));

    // The payment claim is a claim; only the supplier settles.
    r = await runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 2550000, utr: 'UTR123456789', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.deepEqual([r.ok, r.key], [true, 'pay.site.claimed']);
    await settle();
    assert.ok(expects.some(([a, , key, e]) => a === 'supplier' && key === 'pay.seller.claimed' && e.tool === 'confirm_payment'));
    r = await runTool(s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId } });
    assert.deepEqual([r.ok, r.params?.amount], [true, '₹25,500']);

    for (const core of [s.supCore, s.siteCore]) {
      const v = core.ledger.view(orderId);
      assert.deepEqual([v.state, v.billRev], ['settled', 1]);
      assert.equal(core.ledger.verifyChain().ok, true);
    }
    const signed = (/** @type {any} */ core) => core.ledger.events(orderId).filter((/** @type {any} */ e) => e.direction !== 'local' && e.type !== 'RECEIPT').map((/** @type {any} */ e) => e.msgId).sort();
    assert.deepEqual(signed(s.supCore), signed(s.siteCore));
    await settle();
    assert.ok(s.told.some(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.material_settled'));
    assert.equal(s.jcbCore.ledger.orders().length, 0, 'the JCB agent never saw the material order');
  } finally {
    await s.close();
  }
});

test('the site counts less than the challan: the contractor sees both figures, disputes the quantity, the supplier corrects', async () => {
  /** @type {[string, string, string, any][]} */
  const expects = [];
  const s = await setup({ onTell: (side, role, key, _p, expect) => expects.push([side, role, key, expect]) });
  try {
    const orderId = await bookedOrder(s, [CEMENT]);
    await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A, challanNo: '77' } });
    await settle();

    // The supervisor counts 48 bags: saved, and the contractor is told both figures.
    let r = await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [4800, 1] } });
    assert.equal(r.key, 'site.count_figures', 'one figure per delivered item');
    r = await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [4800] } });
    assert.deepEqual([r.ok, r.key], [true, 'site.count_saved_differs']);
    assert.ok(s.told.some(([a, role, key, p]) => a === 'site' && role === 'contractor' && key === 'site.count_differs' && p.challan === 'सीमेंट 50 बोरी' && p.count === 'सीमेंट 48 बोरी'));

    // The bill follows the challan; the contractor is shown the site's count and what it comes to,
    // and is not offered a one-word acceptance.
    await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } });
    await settle();
    const notice = s.told.find(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.material_bill_count_differs');
    assert.deepEqual([notice?.[3].total, notice?.[3].siteTotal, notice?.[3].count], ['₹17,500', '₹16,800', 'सीमेंट 48 बोरी']);
    assert.ok(!expects.some(([a, , key, e]) => a === 'site' && key === 'site.material_bill_count_differs' && e), 'no "हाँ" to accept on a differing count');

    // The dispute carries the site's quantity; hours make no sense for material.
    r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 48, reason: 'site count' } });
    assert.equal(r.key, 'site.material_figure_needed');
    r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, totalPaise: 1680000, reason: 'site count' } });
    assert.equal(r.key, 'site.material_figure_needed', 'exactly one figure');
    const dispute = s.site.tools.dispute_bill.describe?.({ orderId, qtyHundredths: 4800, reason: 'साइट पर 48 बोरी गिनी' });
    assert.equal(dispute?.params?.their, '48 बोरी');
    r = await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, reason: 'साइट पर 48 बोरी गिनी' } });
    assert.deepEqual([r.ok, r.key], [true, 'site.material_bill_disputed']);
    assert.equal(s.supCore.ledger.view(orderId).state, 'disputed');
    await settle();
    assert.ok(s.told.some(([a, , key, p]) => a === 'supplier' && key === 'supplier.bill_disputed' && p.their === '48 बोरी'));

    // The supplier corrects to 48 bags; the correction now matches the site's count and can be accepted with "हाँ".
    r = await runTool(s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [4800, 100] } });
    assert.equal(r.key, 'common.bad_args');
    r = await runTool(s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [4800] } });
    assert.deepEqual([r.ok, r.params?.total], [true, '₹16,800']);
    await settle();
    const offer = expects.find(([a, role, key, e]) => a === 'site' && role === 'contractor' && key === 'site.material_correction_received' && e);
    assert.deepEqual(offer?.[3], { tool: 'accept_bill', args: { orderId, bill: s.siteCore.ledger.view(orderId).currentBill } });
    r = await runTool(s.site.tools, contractor, offer?.[3]);
    assert.equal(r.ok, true);
    for (const core of [s.supCore, s.siteCore]) {
      const v = core.ledger.view(orderId);
      assert.deepEqual([v.state, v.billRev], ['accepted', 2]);
      assert.equal(core.ledger.verifyChain().ok, true);
    }
  } finally {
    await s.close();
  }
});

test('a bill whose lines do not follow from the delivery and the agreed rates is told to the contractor, not offered for "हाँ"', async () => {
  /** @type {[string, string, string, any][]} */
  const expects = [];
  const s = await setup({ onTell: (side, role, key, _p, expect) => expects.push([side, role, key, expect]) });
  try {
    const orderId = await bookedOrder(s, [CEMENT]);
    await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A } });
    // A supplier's agent that bills ₹360 a bag instead of the agreed ₹350 (well formed, totals add up).
    const body = { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 36000, amountPaise: 1800000 }], totalPaise: 1800000, evidence: [] };
    const m = prepare(s.supCore, { type: 'BILL', to: 'agent:contractor-1', orderId, body });
    assert.ok(m);
    assert.equal((await s.supLink.deliver(m)).ok, true, 'the protocol accepts it: the check is the contractor agent\'s');
    await settle();
    const told = s.told.find(([a, role, key]) => a === 'site' && role === 'contractor' && key === 'site.material_bill_mismatch');
    assert.equal(told?.[3].total, '₹18,000');
    assert.deepEqual([told?.[3].expected, told?.[3].expectedTotal], ['सीमेंट 50 बोरी × ₹350 = ₹17,500', '₹17,500']);
    assert.ok(!expects.some(([a, , , e]) => a === 'site' && e && e.tool === 'accept_bill'), 'nothing offers acceptance');
  } finally {
    await s.close();
  }
});

test('every tool that declares a limit can really be held: a gated role may call it', async () => {
  const s = await setup();
  try {
    const supervisor = person('supervisor', 'agent:contractor-1');
    const office = createOffice({ ledger: s.siteCore.ledger, tools: s.site.tools, kind: 'contractor', limits: {}, tell: () => {}, reply: () => {}, now: s.siteCore.now });
    const held = Object.entries(s.site.tools).filter(([, tool]) => tool.hold);
    assert.deepEqual(held.map(([name]) => name).sort(), ['request_jcb', 'request_material']);
    for (const [name, tool] of held) {
      assert.ok(tool.roles.includes('supervisor'), `${name}: the gate only holds a supervisor`);
      assert.equal(office.holds(supervisor, name, {}), true, `${name}: no limit set, so it waits`);
    }
    for (const tools of [s.jcb.tools, s.sup.tools]) assert.deepEqual(Object.values(tools).filter((tool) => tool.hold), [], 'the gate is the contractor\'s');
  } finally {
    await s.close();
  }
});

test('the estimates an approval limit reads: last agreed rates from the ledger, null when unknown', async () => {
  const s = await setup();
  try {
    const req = s.site.tools.request_material.hold;
    const jcb = s.site.tools.request_jcb.hold;
    assert.deepEqual([req?.limit, jcb?.limit], ['procurement', 'procurement']);
    assert.equal(req?.estimatePaise({ site: 'S', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 1000, unit: 'बोरी' }] }), null, 'no rate agreed yet');
    assert.equal(jcb?.estimatePaise({ site: 'S', day: '2026-10-30', hoursTenths: 60 }), null);
    assert.equal(s.site.tools.accept_bill.hold, undefined, 'accepting a bill is not held');
    assert.equal(s.site.tools.claim_payment.hold, undefined, 'payments are the contractor\'s own step');
    assert.equal(s.site.tools.claim_group.hold, undefined);

    await bookedOrder(s, [CEMENT, SAND]);
    assert.equal(req?.estimatePaise({ site: 'S', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 1000, unit: 'बोरी' }] }), 350000, '10 bags × ₹350');
    assert.equal(req?.estimatePaise({ site: 'S', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 1000, unit: 'बोरी' }, { name: 'गिट्टी', qtyHundredths: 100, unit: 'ट्रॉली' }] }), null, 'one unknown item: cannot estimate');
    assert.equal(req?.estimatePaise({ site: 'S', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 1000, unit: 'टन' }] }), null, 'same item, other unit: unknown');

    await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'S', day: '2026-10-30' } });
    const jcbOrder = /** @type {any} */ (s.siteCore.ledger.orders().find((/** @type {any} */ o) => o.kind === 'jcb_hours')).order_id;
    await runTool(s.jcb.tools, person('jcb_owner', 'agent:jcb-1'), { tool: 'reply_booking', args: { orderId: jcbOrder, answer: 'yes', ratePaise: 120000 } });
    assert.equal(jcb?.estimatePaise({ site: 'S', day: '2026-10-31', hoursTenths: 61 }), 732000, '6.1 h × ₹1,200');
    assert.equal(jcb?.estimatePaise({ site: 'S', day: '2026-10-31' }), null, 'no hours: cannot estimate');
  } finally {
    await s.close();
  }
});
