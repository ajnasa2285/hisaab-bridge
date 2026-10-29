// GST on material (docs/BUILD2.md "GST on material (30 Oct)"): the supplier's yes may carry a GST rate
// per item, the tax invoice's reading may carry it too, code computes taxable + GST per line with one
// rounding rule, and the bill's total is compared with the invoice's grand total. Everything after the
// bill (UPI amount, ask-anything totals, explanations) uses the total with GST. The seller's dispute
// notice says how to send a correction, and that exact phrase is read by code. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { ratesWithGst, tokens } from '../../src/agents/replies.js';
import { billLines, gstPaise, invoiceCheck, invoiceFromReading, lineAmountPaise } from '../../src/agents/material.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { differenceFacts } from '../../src/agents/explain-facts.js';
import { numbersSupported } from '../../src/agents/explain.js';
import { bodyIsValid } from '../../src/protocol/messages.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto, SHA_A, SHA_C } from './helpers.js';

const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000041' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000042' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const photo = { mime: 'image/jpeg', bytes: new Uint8Array([4, 1, 4]) };
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 10)); };

/** An invented tax invoice reading: 50 bags, ₹380, taxable ₹19,000, GST 28%, grand total as given. @param {number | null} grand @param {number | null} [gst] */
const invoiceRead = (grand, gst = 28) => ({ ok: true, kind: 'challan', challanNo: 'INV-1', date: '2026-10-29', vehicle: null, clear: true, signed: null,
  grandTotalPaise: grand, items: [{ name: 'ACC Cement', qtyHundredths: 5000, unit: 'bag', raw: 'ACC Cement 50 bags 380.00', ratePaise: 38000, taxablePaise: 1900000, gstPercent: gst }] });

/** Supplier and contractor desks over the real agents, one cement order of 50 bags requested. */
async function desk() {
  /** @type {any} */
  let nextChallan = null;
  /** @type {any} */
  let nextUpi = null;
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  const supTalk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, reply, now: s.supCore.now,
    readChallan: async () => nextChallan, classifyPhoto: seesPhoto('challan') });
  const siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now,
    readUpi: async () => nextUpi, classifyPhoto: seesPhoto('upi') });
  await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site G', day: '2026-10-30', items: [CEMENT] } });
  await settle();
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  return {
    s, supTalk, siteTalk, said, orderId,
    challan: (/** @type {any} */ r) => { nextChallan = r; },
    upi: (/** @type {any} */ r) => { nextUpi = r; },
    keys: (/** @type {string} */ who) => said.filter(([w]) => w === who).map(([, k]) => k),
    last: (/** @type {string} */ who) => said.filter(([w]) => w === who).at(-1) ?? ['', '', ''],
    bill: () => s.siteCore.ledger.events(orderId).filter((e) => e.type === 'BILL' || e.type === 'CORRECTION').at(-1)?.body.body,
  };
}

test('rates with GST in the supplier\'s yes: "+ 28%", "28% gst", one per rate; a percent that is not a GST slab is not exact', () => {
  const after = (/** @type {string} */ s) => tokens(s).slice(1);
  assert.deepEqual(ratesWithGst(after('हाँ 380 + 28%')), { paise: [38000], gst: [28] });
  assert.deepEqual(ratesWithGst(after('हाँ 380 28% gst')), { paise: [38000], gst: [28] });
  assert.deepEqual(ratesWithGst(after('हाँ 380+28%')), { paise: [38000], gst: [28] });
  assert.deepEqual(ratesWithGst(after('हाँ 350 18%, 4000 5%')), { paise: [35000, 400000], gst: [18, 5] });
  assert.deepEqual(ratesWithGst(after('हाँ 350, 4000 5 %')), { paise: [35000, 400000], gst: [null, 5] });
  assert.deepEqual(ratesWithGst(after('हाँ 380')), { paise: [38000], gst: [null] });
  for (const s of ['हाँ 28% 380', 'हाँ 380 7%', 'हाँ 380 18% 28%', 'हाँ 380 gst सहित']) assert.equal(ratesWithGst(after(s)), null, s);
});

test('GST rounding: CGST and SGST halves each to the nearest paisa (half up); the invoice may round off to whole rupees', () => {
  assert.equal(gstPaise(1900000, 28), 532000);
  assert.equal(gstPaise(10, 5), 0, 'each half 0.25 paisa rounds down');
  assert.equal(gstPaise(30, 5), 2, 'each half 0.75 paisa rounds up');
  assert.equal(gstPaise(83333, 18), 15000, '₹833.33 at 18%: 2 × ₹75.00');
  assert.equal(gstPaise(100, 7), null, 'not a GST slab');
  assert.deepEqual(billLines([CEMENT], [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 38000, gstPercent: 28 }]),
    [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 38000, taxablePaise: 1900000, gstPercent: 28, gstPaise: 532000, amountPaise: 2432000 }]);
  assert.equal(lineAmountPaise(5000, 38000), 1900000);
  assert.equal(invoiceCheck(2432000, 2432000), 'match');
  assert.equal(invoiceCheck(2432000, 2432040), 'match', 'printed total rounded off to the rupee');
  assert.equal(invoiceCheck(2432100, 2432060), 'match');
  assert.equal(invoiceCheck(2432000, 2432060), 'differs');
  assert.equal(invoiceCheck(2400000, 2432000), 'differs');
  assert.equal(invoiceCheck(null, 2432000), null);
});

test('GST from the yes: "हाँ 380 + 28%" is sent at once; the bill is ₹19,000 + GST 28% ₹5,320 = ₹24,320 and the contractor\'s check passes', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380 + 28%');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.reply_sent_yes');
    assert.ok(d.last('supplier')[2].includes('₹380/बोरी + GST 28%'), d.last('supplier')[2]);
    const yes = d.s.siteCore.ledger.events(d.orderId).find((e) => e.type === 'BOOKING_REPLY')?.body.body;
    assert.deepEqual(yes?.rates, [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 38000, gstPercent: 28 }]);

    // A plain challan (no invoice figures): the GST comes from the yes.
    d.challan({ ok: true, kind: 'challan', challanNo: '96', date: null, vehicle: null, clear: true, signed: null, items: [{ name: 'Cement', qtyHundredths: 5000, unit: 'bag', raw: 'Cement 50' }] });
    await d.supTalk.onImage(supplier, photo);
    await settle();
    await d.supTalk.onText(supplier, 'बिल');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.bill_sent');
    assert.ok(d.last('supplier')[2].includes('सीमेंट 50 बोरी × ₹380 = ₹19,000 + GST 28% ₹5,320 = ₹24,320'), d.last('supplier')[2]);
    const bill = d.bill();
    assert.deepEqual([bill?.totalPaise, bill?.lines[0].taxablePaise, bill?.lines[0].gstPercent, bill?.lines[0].gstPaise], [2432000, 1900000, 28, 532000]);
    assert.equal(d.last('site:contractor')[1], 'site.material_bill_received', 'the contractor\'s code finds the bill follows from delivery × rate + GST');
  } finally {
    await d.s.close();
  }
});

test('GST from the invoice reading; its grand total equals the bill: "चालान/इनवॉइस से मिलान ठीक" on both sides', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380');
    d.challan(invoiceRead(2432000));
    await d.supTalk.onImage(supplier, photo);
    await settle();
    const delivered = d.s.siteCore.ledger.events(d.orderId).find((e) => e.type === 'DELIVERY')?.body.body;
    assert.deepEqual(delivered?.items, [{ ...CEMENT, gstPercent: 28, invoiceRatePaise: 38000, taxablePaise: 1900000 }]);
    assert.equal(delivered?.grandTotalPaise, 2432000);
    await d.supTalk.onText(supplier, 'बिल');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.bill_sent_invoice_match', 'equal totals: sent at once');
    assert.ok(d.last('supplier')[2].includes('मिलान ठीक'));
    assert.equal(d.bill()?.totalPaise, 2432000);
    assert.equal(d.last('site:contractor')[1], 'site.material_bill_received_invoice_match');
  } finally {
    await d.s.close();
  }
});

test('no GST anywhere: the bill is rate × quantity as before, with no GST fields', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380');
    d.challan({ ...invoiceRead(null, null), items: [{ name: 'Cement', qtyHundredths: 5000, unit: 'bag', raw: 'Cement 50' }] });
    await d.supTalk.onImage(supplier, photo);
    await settle();
    const delivered = d.s.siteCore.ledger.events(d.orderId).find((e) => e.type === 'DELIVERY')?.body.body;
    assert.deepEqual([delivered?.items, 'grandTotalPaise' in (delivered ?? {})], [[CEMENT], false]);
    await d.supTalk.onText(supplier, 'बिल');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.bill_sent');
    assert.deepEqual(d.bill()?.lines, [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 38000, amountPaise: 1900000 }]);
    assert.equal(d.bill()?.totalPaise, 1900000);
    assert.equal(d.last('site:contractor')[1], 'site.material_bill_received');
  } finally {
    await d.s.close();
  }
});

test('the invoice\'s grand total differs: the supplier sees both figures before the bill leaves; the contractor sees both with the bill', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380');
    d.challan(invoiceRead(2400000));
    await d.supTalk.onImage(supplier, photo);
    await settle();
    await d.supTalk.onText(supplier, 'बिल');
    assert.equal(d.last('supplier')[1], 'step.send_material_bill_invoice_differs');
    assert.ok(d.last('supplier')[2].includes('₹24,320') && d.last('supplier')[2].includes('₹24,000'), d.last('supplier')[2]);
    assert.equal(d.bill(), undefined, 'nothing sent before the supplier\'s yes');
    await d.supTalk.onText(supplier, 'हाँ');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.bill_sent_invoice_differs');
    assert.equal(d.bill()?.totalPaise, 2432000, 'the bill is what code computed, never the printed total');
    const [, key, text] = d.last('site:contractor');
    assert.equal(key, 'site.material_bill_received_invoice_differs');
    assert.ok(text.includes('₹24,320') && text.includes('₹24,000'), text);
  } finally {
    await d.s.close();
  }
});

test('after the bill: the UPI amount, ask-anything totals and explanation figures all use the total with GST', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380 + 28%');
    d.challan(invoiceRead(2432000));
    await d.supTalk.onImage(supplier, photo);
    await settle();
    await d.supTalk.onText(supplier, 'बिल');
    await settle();

    // Ask anything: the bill in force and the totals include GST; the GST is its own figure.
    const facts = orderFacts(d.s.siteCore.ledger);
    const ctx = { ledger: d.s.siteCore.ledger, side: /** @type {const} */ ('buyer'), nowMs: d.s.siteCore.now(), facts };
    const detail = runLookup('order_detail', { ref: 'P-1' }, ctx);
    assert.deepEqual([detail.data.bill_in_force, detail.data.bill_gst_included], ['₹24,320', '₹5,320']);
    const totals = runLookup('totals', { site: null, kind: null, item: null, period: 'all', from: null, to: null, group_by: 'none' }, ctx);
    assert.ok(JSON.stringify(totals.data).includes('₹24,320'), JSON.stringify(totals.data));

    // An explanation may cite the taxable value, the GST and the total; a percent is never a figure.
    const ef = differenceFacts(d.s.siteCore.ledger, d.orderId, 'P-1');
    assert.ok(ef.figures.includes('₹19,000') && ef.figures.includes('GST ₹5,320') && ef.figures.includes('₹24,320'), ef.figures);
    assert.equal(numbersSupported('बिल ₹19,000 और GST ₹5,320 मिलाकर ₹24,320 है।', ef.allowedNumbers), true);
    assert.equal(numbersSupported('बिल ₹19,000 पर 28% GST है।', ef.allowedNumbers), false);

    // A UPI screenshot of any amount is claimed at once (a part payment is no mismatch since 30 Oct); the
    // balance it shows is worked out on the total with GST.
    await runTool(d.s.site.tools, contractor, { tool: 'accept_bill', args: { orderId: d.orderId } });
    await settle();
    d.upi({ ok: true, kind: 'upi_payment', amountPaise: 1900000, date: '2026-10-30', time: null, clock: null, utr: '412300000041', status: 'success', clear: true });
    await d.siteTalk.onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([9, 1]) });
    assert.equal(d.last('contractor')[1], 'pay.site.claimed');
    assert.ok(d.last('contractor')[2].includes('बाक़ी ₹24,320; इसमें ₹19,000 पुष्टि के इंतज़ार में'), d.last('contractor')[2]);
    d.upi({ ok: true, kind: 'upi_payment', amountPaise: 532000, date: '2026-10-30', time: null, clock: null, utr: '412300000042', status: 'success', clear: true });
    await d.siteTalk.onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([9, 2]) });
    assert.equal(d.last('contractor')[1], 'pay.site.claimed');
    assert.ok(d.last('contractor')[2].includes('इसमें ₹24,320 पुष्टि के इंतज़ार में'), d.last('contractor')[2]);
  } finally {
    await d.s.close();
  }
});

test('the seller\'s dispute notice says how to correct; "सुधार 48 बोरी" is read back once, then the correction (with GST) goes', async () => {
  const d = await desk();
  try {
    await d.supTalk.onText(supplier, 'हाँ 380 + 28%');
    d.challan(invoiceRead(null));
    await d.supTalk.onImage(supplier, photo);
    await settle();
    await d.supTalk.onText(supplier, 'बिल');
    await settle();
    await runTool(d.s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId: d.orderId, qtyHundredths: 4800, reason: '2 बोरी कम आई' } });
    await settle();
    const notice = d.said.find(([w, k]) => w === 'supplier:supplier' && k === 'supplier.bill_disputed');
    assert.ok(notice?.[2].includes("सुधार भेजना हो तो लिखें: 'सुधार 48 बोरी'"), notice?.[2]);

    await d.supTalk.onText(supplier, 'सुधार 48 बोरी');
    assert.equal(d.last('supplier')[1], 'step.send_material_correction', 'read back once');
    assert.ok(d.last('supplier')[2].includes('सीमेंट 48 बोरी × ₹380 = ₹18,240 + GST 28% ₹5,107.20 = ₹23,347.20'), d.last('supplier')[2]);
    await d.supTalk.onText(supplier, 'हाँ');
    await settle();
    assert.equal(d.last('supplier')[1], 'supplier.correction_sent');
    const c = d.bill();
    assert.deepEqual([c?.lines[0].qtyHundredths, c?.totalPaise, typeof c?.replaces], [4800, 2334720, 'string']);
    assert.equal(d.last('site:contractor')[1], 'site.material_correction_received');
  } finally {
    await d.s.close();
  }
});

test('the JCB owner\'s dispute notice says "सुधार 5.5 घंटे"; that phrase is read back, then sent', async () => {
  /** @type {[string, string, string][]} */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  const owner = { ...person('jcb_owner', 'agent:jcb-1'), phone: '919000000043' };
  const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000044' };
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const talk = createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }), reply, now: s.jcbCore.now });
  try {
    await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site G', day: '2026-10-29' } });
    const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
    await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
    await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 10000, sha256: SHA_A } });
    await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 10060, sha256: SHA_C } });
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 55, reason: 'मशीन देर से आई' } });
    await settle();
    const notice = said.find(([w, k]) => w === 'jcb:jcb_owner' && k === 'jcb.bill_disputed');
    assert.ok(notice?.[2].includes("'सुधार 5.5 घंटे'"), notice?.[2]);
    await talk.onText(owner, 'सुधार 5.5 घंटे');
    assert.equal(said.at(-1)?.[1], 'step.send_correction');
    await talk.onText(owner, 'हाँ');
    await settle();
    assert.equal(said.at(-1)?.[1], 'jcb.correction_sent');
    const c = s.siteCore.ledger.events(orderId).find((e) => e.type === 'CORRECTION')?.body.body;
    assert.equal(c?.lines[0].hoursTenths, 55);
  } finally {
    await s.close();
  }
});

test('old messages without GST stay valid; GST fields are checked when present', () => {
  const rates = [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 38000 }];
  assert.equal(bodyIsValid('BOOKING_REPLY', { answer: 'yes', rates }), true);
  assert.equal(bodyIsValid('BOOKING_REPLY', { answer: 'yes', rates: [{ ...rates[0], gstPercent: 28 }] }), true);
  assert.equal(bodyIsValid('BOOKING_REPLY', { answer: 'yes', rates: [{ ...rates[0], gstPercent: 7 }] }), false);
  const delivery = { items: [CEMENT], challan: { sha256: SHA_A, number: '96' }, deliveredAt: '2026-10-29T05:00:00.000Z' };
  assert.equal(bodyIsValid('DELIVERY', delivery), true);
  assert.equal(bodyIsValid('DELIVERY', { ...delivery, items: [{ ...CEMENT, gstPercent: 28, invoiceRatePaise: 38000, taxablePaise: 1900000 }], grandTotalPaise: 2432000 }), true);
  assert.equal(bodyIsValid('DELIVERY', { ...delivery, grandTotalPaise: 0 }), false);
  assert.equal(bodyIsValid('DELIVERY', { ...delivery, items: [{ ...CEMENT, gstPercent: 3 }] }), false);
  const evidence = [{ sha256: SHA_A, kind: 'challan', readValue: '96', takenAt: null, sentAt: '2026-10-29T05:00:00.000Z' }];
  const plain = { what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 38000, amountPaise: 1900000 };
  assert.equal(bodyIsValid('BILL', { lines: [plain], totalPaise: 1900000, evidence }), true);
  const withGst = { ...plain, taxablePaise: 1900000, gstPercent: 28, gstPaise: 532000, amountPaise: 2432000 };
  assert.equal(bodyIsValid('BILL', { lines: [withGst], totalPaise: 2432000, evidence }), true);
  assert.equal(bodyIsValid('BILL', { lines: [{ ...withGst, amountPaise: 1900000 }], totalPaise: 1900000, evidence }), false, 'amount must be taxable + GST');
  assert.equal(bodyIsValid('BILL', { lines: [{ ...plain, gstPercent: 28 }], totalPaise: 1900000, evidence }), false, 'GST rate without its figures');
});

test('invoice figures map onto the order\'s items by name or position; none printed gives null', () => {
  assert.deepEqual(invoiceFromReading([CEMENT], /** @type {any} */ (invoiceRead(2432000))),
    { lines: [{ gstPercent: 28, ratePaise: 38000, taxablePaise: 1900000 }], grandTotalPaise: 2432000 });
  assert.equal(invoiceFromReading([CEMENT], { items: [{ name: 'Cement' }] }), null);
});

test('the supplier\'s waiting notices are rebuilt from the ledger and end when the order moves on', async () => {
  const d = await desk();
  try {
    const waiting = d.s.sup.waiting('supplier');
    assert.deepEqual(waiting.map((n) => [n.key, n.params.ref]), [['supplier.order_request', 'P-1']]);
    assert.ok(t(waiting[0].key, waiting[0].params).includes('सीमेंट 50 बोरी'));
    assert.deepEqual(d.s.sup.waiting('contractor'), []);
    await d.supTalk.onText(supplier, 'हाँ 380');
    assert.deepEqual(d.s.sup.waiting('supplier'), []);
  } finally {
    await d.s.close();
  }
});
