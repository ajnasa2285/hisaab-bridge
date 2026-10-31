// Two checks that only warn. The site's count read from the very photo the supplier sent is no second
// check, whichever came first; and a tax invoice's printed line (delivered quantity × its rate against
// its taxable value) that does not add up is told in the existing delivery reply and notice. Nothing new
// is asked and no bill changes. Real agents over real A2A; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { delivery, invoiceLineMath, lineMathWarning } from '../../src/agents/material.js';
import { t } from '../../src/i18n/index.js';
import { hi } from '../../src/i18n/hi.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const supervisor = person('supervisor', 'agent:contractor-1');
const contractor = person('contractor', 'agent:contractor-1');
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const SAND = { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' };
const NOT_A_SECOND_CHECK = 'दूसरी जाँच नहीं';
/** The figures a tax invoice prints: 50 bags at ₹380, taxable ₹19,000. */
const printed = (/** @type {Partial<{qtyHundredths: number, invoiceRatePaise: number, taxablePaise: number}>} */ o = {}) => ({ ...CEMENT, invoiceRatePaise: 38000, taxablePaise: 1900000, ...o });
const WRONG_LINE = 'सीमेंट 50 बोरी × ₹380 = ₹19,000, पर इनवॉइस पर ₹18,000';

/** An order of cement booked at ₹380 a bag. @param {any[]} [items] */
async function booked(items = [CEMENT]) {
  /** @type {any[]} */
  const expects = [];
  const s = await setup({ onTell: (side, role, key, _params, expect) => { if (expect) expects.push([side, role, key, expect.tool]); } });
  await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items } });
  const orderId = String(s.siteCore.ledger.orders()[0].order_id);
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: items.map(() => 38000) } });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  /** @param {string} who */
  const toldTo = (who) => s.told.filter(([side, role, key]) => side === 'site' && role === who && /delivery|count/u.test(key)).map(([, , key, params]) => ({ key, text: t(key, params) }));
  /** @param {Record<string, any>} [more] */
  const deliver = async (more = {}) => {
    const r = await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items, sha256: SHA_A, challanNo: '412', ...more } });
    await settle();
    return r;
  };
  /** @param {any} who @param {string} sha256 @param {number[]} [qtysHundredths] */
  const sitePhoto = async (who, sha256, qtysHundredths = [5000]) => {
    const r = await runTool(s.site.tools, who, { tool: 'confirm_count', args: { orderId, qtysHundredths, challan: { sha256, number: '412' }, sameAsChallan: true } });
    await settle();
    return r;
  };
  return { s, orderId, expects, toldTo, deliver, sitePhoto, settle };
}

// --- The arithmetic, on its own ---------------------------------------------------------------------

test('invoice line: agrees, disagrees, and ₹1 either way is printed rounding', () => {
  assert.deepEqual(invoiceLineMath([printed()]), { checked: 1, differs: [] });
  assert.deepEqual(invoiceLineMath([printed({ taxablePaise: 1900100 })])?.differs, []);
  assert.deepEqual(invoiceLineMath([printed({ taxablePaise: 1899900 })])?.differs, []);
  assert.deepEqual(invoiceLineMath([printed({ taxablePaise: 1900101 })])?.differs.map((l) => l.printedPaise), [1900101]);
  assert.deepEqual(invoiceLineMath([printed({ taxablePaise: 1899899 })])?.differs, [
    { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी', ratePaise: 38000, printedPaise: 1899899, computedPaise: 1900000 },
  ]);
  // The one rounding rule of a bill line: 2.5 × ₹333.33 = ₹833.33.
  assert.deepEqual(invoiceLineMath([{ name: 'x', qtyHundredths: 250, unit: 'y', invoiceRatePaise: 33333, taxablePaise: 83333 }])?.differs, []);
});

test('invoice line: a line missing a figure is skipped silently; none checked gives no result at all', () => {
  assert.equal(invoiceLineMath([CEMENT]), null);
  assert.equal(invoiceLineMath([{ ...CEMENT, invoiceRatePaise: 38000 }]), null);
  assert.equal(invoiceLineMath([{ ...CEMENT, taxablePaise: 1900000 }]), null);
  assert.equal(invoiceLineMath([]), null);
  assert.equal(lineMathWarning([CEMENT], 'order'), null);
  const mixed = invoiceLineMath([SAND, printed({ taxablePaise: 1800000 }), { ...SAND, invoiceRatePaise: 400000 }]);
  assert.equal(mixed?.checked, 1);
  assert.deepEqual(mixed?.differs.map((l) => l.name), ['सीमेंट']);
});

test('invoice line: a typed quantity against the invoice gets the same warning, in what it comes to', () => {
  const check = invoiceLineMath([printed({ qtyHundredths: 4000 })]);
  assert.deepEqual(check?.differs.map((l) => [l.qtyHundredths, l.computedPaise, l.printedPaise]), [[4000, 1520000, 1900000]]);
  assert.equal(lineMathWarning([printed({ qtyHundredths: 4000 })], 'order'), 'सीमेंट 40 बोरी × ₹380 = ₹15,200, पर इनवॉइस पर ₹19,000');
  assert.equal(lineMathWarning([printed()], 'order'), null, 'agrees: nothing to say');
});

// --- The arithmetic, at the delivery ----------------------------------------------------------------

/** The arguments as the conversation hands them over: one invoice line per delivered item. @param {number} taxablePaise */
const invoiceArgs = (taxablePaise) => ({ invoice: { lines: [{ gstPercent: null, ratePaise: 38000, taxablePaise }], grandTotalPaise: null } });

test('a line that does not agree: one clause for the supplier and, from the signed body, the contractor; the bill stays quantity × agreed rate', async () => {
  const c = await booked();
  try {
    const r = await c.deliver(invoiceArgs(1800000));
    assert.equal(r.ok, true);
    assert.equal(r.key, 'supplier.delivery_sent_math');
    assert.ok(t(r.key, r.params).includes(WRONG_LINE), t(r.key, r.params));
    // What the contractor's side reads is the signed message as it arrived.
    const body = c.s.siteCore.ledger.events(c.orderId).find((e) => e.type === 'DELIVERY')?.body.body;
    assert.deepEqual([body.items[0].invoiceRatePaise, body.items[0].taxablePaise], [38000, 1800000]);
    const told = c.toldTo('contractor').at(-1);
    assert.equal(told?.key, 'site.delivery_info_challan_math');
    assert.ok(told?.text.includes(WRONG_LINE) && told.text.includes('चालान 412'), told?.text);
    // The supervisor is asked as ever, with the clause left out, and their one word still stands.
    assert.deepEqual(c.toldTo('supervisor').map((x) => x.key), ['site.delivery_received_challan']);
    assert.deepEqual(c.expects, [['site', 'supervisor', 'site.delivery_received_challan', 'confirm_count']]);
    assert.equal(c.s.siteCore.ledger.view(c.orderId).state, 'delivered', 'recorded as ever');

    const bill = await runTool(c.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: c.orderId } });
    assert.equal(bill.ok, true);
    const sent = c.s.supCore.ledger.events(c.orderId).find((e) => e.type === 'BILL')?.body.body;
    assert.equal(sent.totalPaise, 1900000, '50 × ₹380, not the printed ₹18,000');
  } finally { await c.s.close(); }
});

test('a line that agrees, within ₹1, or with figures missing changes nothing in the words', async () => {
  for (const more of [invoiceArgs(1900000), invoiceArgs(1900100), { invoice: { lines: [{ gstPercent: 28, ratePaise: null, taxablePaise: 1800000 }], grandTotalPaise: null } }, {}]) {
    const c = await booked();
    try {
      const r = await c.deliver(more);
      assert.equal(r.key, 'supplier.delivery_sent');
      assert.deepEqual(Object.keys(r.params ?? {}).sort(), ['items', 'ref', 'site']);
      assert.equal(c.toldTo('contractor').at(-1)?.key, 'site.delivery_info_challan');
      assert.ok(!c.toldTo('contractor').at(-1)?.text.includes('इनवॉइस'));
    } finally { await c.s.close(); }
  }
});

test('a typed quantity through the tool: the delivery goes as typed and the warning says what it comes to', async () => {
  const c = await booked();
  try {
    const typed = { ...CEMENT, qtyHundredths: 4000 };
    const r = await runTool(c.s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: c.orderId, items: [typed], sha256: SHA_A, ...invoiceArgs(1900000) } });
    await c.settle();
    const line = 'सीमेंट 40 बोरी × ₹380 = ₹15,200, पर इनवॉइस पर ₹19,000';
    assert.equal(r.key, 'supplier.delivery_sent_math');
    assert.ok(t(r.key, r.params).includes(line), t(r.key, r.params));
    assert.equal(c.toldTo('contractor').at(-1)?.key, 'site.delivery_info_math');
    assert.ok(c.toldTo('contractor').at(-1)?.text.includes(line));
    assert.equal(delivery(c.s.siteCore.ledger.events(c.orderId))?.items[0].qtyHundredths, 4000);
  } finally { await c.s.close(); }
});

test('the site counted first: the clause goes in the notice the contractor gets instead, and the supervisor gets none', async () => {
  const c = await booked();
  try {
    await c.sitePhoto(supervisor, SHA_B);
    await c.deliver(invoiceArgs(1800000));
    const told = c.toldTo('contractor').at(-1);
    assert.equal(told?.key, 'site.delivery_matches_count_math');
    assert.ok(told?.text.includes(WRONG_LINE) && !told.text.includes(NOT_A_SECOND_CHECK), told?.text);
    assert.equal(c.toldTo('supervisor').at(-1)?.key, 'site.delivery_matches_count');
  } finally { await c.s.close(); }
});

// --- The same photo, either way round ---------------------------------------------------------------

test('the same photo after the DELIVERY: recorded, and the sender and the contractor are told in the notices they already get', async () => {
  const c = await booked();
  try {
    await c.deliver();
    const r = await c.sitePhoto(supervisor, SHA_A);
    assert.equal(r.ok, true);
    assert.equal(r.key, 'site.challan_count_matches_challan_same_photo');
    assert.ok(t(r.key, r.params).includes('सप्लायर ने भी यही फ़ोटो भेजी') && t(r.key, r.params).includes(NOT_A_SECOND_CHECK), t(r.key, r.params));
    const told = c.toldTo('contractor').at(-1);
    assert.equal(told?.key, 'site.count_told_photo_same_photo');
    assert.ok(told?.text.includes(NOT_A_SECOND_CHECK));
    const notes = c.s.siteCore.ledger.events(c.orderId).filter((e) => e.type === 'NOTE');
    assert.deepEqual(notes.map((e) => [e.body.how, e.body.challan.sha256]), [['photo', SHA_A]], 'recorded as today');
  } finally { await c.s.close(); }
});

test('the contractor sends the same photo: their own reply says so, and no extra message', async () => {
  const c = await booked();
  try {
    await c.deliver();
    const before = c.s.told.length;
    const r = await c.sitePhoto(contractor, SHA_A);
    assert.equal(r.key, 'site.challan_count_matches_challan_same_photo');
    assert.deepEqual(c.s.told.slice(before).filter(([side]) => side === 'site'), []);
  } finally { await c.s.close(); }
});

test('the same photo before the DELIVERY: the notice that compares them says so, to contractor and supervisor', async () => {
  const c = await booked();
  try {
    assert.equal((await c.sitePhoto(supervisor, SHA_A)).key, 'site.challan_count_saved_challan', 'nothing to compare yet');
    await c.deliver();
    for (const who of ['contractor', 'supervisor']) {
      const told = c.toldTo(who).at(-1);
      assert.equal(told?.key, 'site.delivery_matches_count_same_photo', who);
      assert.ok(told?.text.includes(NOT_A_SECOND_CHECK) && told.text.includes('चालान 412'), told?.text);
    }
  } finally { await c.s.close(); }
});

test('the same photo with figures that differ: both figures as ever, and it says the same photo', async () => {
  const c = await booked();
  try {
    await c.deliver();
    const r = await c.sitePhoto(supervisor, SHA_A, [4000]);
    assert.equal(r.key, 'site.challan_count_differs_same_photo');
    assert.equal(c.toldTo('contractor').at(-1)?.key, 'site.challan_count_differs_same_photo');
    const text = t(r.key, r.params);
    assert.ok(text.includes('सीमेंट 40 बोरी') && text.includes('सीमेंट 50 बोरी') && text.includes(NOT_A_SECOND_CHECK), text);
  } finally { await c.s.close(); }

  const first = await booked();
  try {
    await first.sitePhoto(supervisor, SHA_A, [4000]);
    await first.deliver(invoiceArgs(1800000));
    assert.equal(first.toldTo('contractor').at(-1)?.key, 'site.challan_count_differs_same_photo_math');
    assert.equal(first.toldTo('supervisor').at(-1)?.key, 'site.challan_count_differs_same_photo');
  } finally { await first.s.close(); }
});

test('different photos say nothing new, either way round', async () => {
  const after = await booked();
  try {
    await after.deliver();
    const r = await after.sitePhoto(supervisor, SHA_B);
    assert.equal(r.key, 'site.challan_count_matches_challan');
    assert.equal(after.toldTo('contractor').at(-1)?.key, 'site.count_told_photo');
    const differs = await booked();
    try {
      await differs.deliver();
      assert.equal((await differs.sitePhoto(supervisor, SHA_B, [4000])).key, 'site.challan_count_differs');
    } finally { await differs.s.close(); }
  } finally { await after.s.close(); }

  const before = await booked();
  try {
    await before.sitePhoto(supervisor, SHA_B);
    await before.deliver();
    assert.equal(before.toldTo('contractor').at(-1)?.key, 'site.delivery_matches_count');
    assert.equal(before.toldTo('supervisor').at(-1)?.key, 'site.delivery_matches_count');
    assert.ok(!before.toldTo('contractor').at(-1)?.text.includes(NOT_A_SECOND_CHECK));
  } finally { await before.s.close(); }
});

test('a typed count has no photo: nothing about photos', async () => {
  const c = await booked();
  try {
    await c.deliver();
    const r = await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: [5000] } });
    assert.equal(r.key, 'site.count_matches');
  } finally { await c.s.close(); }
});

test('the bill after an identical photo: the same notice as ever, claiming no second check, and its one word stays armed', async () => {
  const c = await booked();
  try {
    await c.deliver();
    await c.sitePhoto(contractor, SHA_A);
    await runTool(c.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: c.orderId } });
    await c.settle();
    const told = c.s.told.filter(([side, role]) => side === 'site' && role === 'contractor').at(-1);
    assert.equal(told?.[2], 'site.material_bill_received');
    assert.doesNotMatch(hi['site.material_bill_received'], /गिनती|जाँच|मिलान/u, 'the notice claims nothing about the count');
    assert.deepEqual(c.expects.at(-1), ['site', 'contractor', 'site.material_bill_received', 'accept_bill']);
  } finally { await c.s.close(); }
});
