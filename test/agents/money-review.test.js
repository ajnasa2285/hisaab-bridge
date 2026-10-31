// The money findings of the red-team review (money1 to money6), through the real agents over A2A and
// the WhatsApp conversations. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_C, seesPhoto } from './helpers.js';

const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000071' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000072' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** Waits for the agents' messages to go round (real HTTP). @param {() => boolean} cond */
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'timed out waiting');
}

async function desk() {
  /** @type {[string, string, string, any][]} [who, key, text, expect] */
  const said = [];
  /** @type {any} */
  let supTalk = null;
  /** @type {any} */
  let siteTalk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params), expect]);
      if (expect && side === 'supplier') supTalk.expect(supplier, expect.tool, expect.args, expect.no, { key, params });
      if (expect && side === 'site' && role === 'contractor') siteTalk.expect(contractor, expect.tool, expect.args, expect.no, { key, params });
    },
  });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params), undefined]); };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  supTalk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, reply, now: s.supCore.now });
  siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now, classifyPhoto: seesPhoto('upi') });

  /** A new cement order of `bags` bags at ₹350, as far as `upTo`. @param {number} bags @param {'delivered' | 'billed' | 'accepted'} upTo */
  async function order(bags, upTo) {
    s.advance(60_000);
    const before = new Set(s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id));
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site K', day: '2026-10-30', items: [{ ...CEMENT, qtyHundredths: bags * 100 }] } });
    const orderId = /** @type {string} */ (s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id).find((id) => !before.has(id)));
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [{ ...CEMENT, qtyHundredths: bags * 100 }], sha256: SHA_A, challanNo: '7' } });
    if (upTo === 'delivered') return orderId;
    await until(() => s.siteCore.ledger.view(orderId).state === 'delivered');
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [bags * 100], sameAsChallan: true } })).ok, true);
    assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
    if (upTo === 'accepted') assert.equal((await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } })).ok, true);
    return orderId;
  }
  /** @param {string} orderId @param {number} paise @param {string} utr @param {Record<string, any>} [more] */
  const upi = (orderId, paise, utr, more = {}) => runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, method: 'upi', amountPaise: paise, utr, paidOn: '2026-10-30', screenshotSha256: SHA_C, ...more } });
  /** @param {string} orderId @param {number} paise */
  const cash = (orderId, paise) => runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, method: 'cash', amountPaise: paise, paidOn: '2026-10-30' } });
  return {
    s, said, supTalk, siteTalk, order, upi, cash,
    last: () => said.at(-1) ?? ['', '', '', undefined],
    /** @param {string} who @param {string} key */
    toldCount: (who, key) => said.filter(([w, k]) => w === who && k === key).length,
    /** @param {string} who @param {string} key */
    told: (who, key) => said.filter(([w, k]) => w === who && k === key).at(-1),
    /** @param {string} orderId */
    states: (orderId) => [s.siteCore.ledger.view(orderId).state, s.supCore.ledger.view(orderId).state],
  };
}

test('money1: an acceptance is bound to the bill it was offered for; a correction in between accepts nothing', async () => {
  const d = await desk();
  try {
    // No site count here, so the correction below keeps its own offer of a one-word yes.
    const orderId = await d.order(50, 'delivered');
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
    await until(() => d.toldCount('site:contractor', 'site.material_bill_no_count') === 1);
    const billId = d.s.siteCore.ledger.view(orderId).currentBill;
    const offer = { args: { orderId, bill: billId } };

    // The seller replaces the bill before the contractor's yes is handled.
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [4800] } })).ok, true);
    await until(() => d.toldCount('site:contractor', 'site.material_correction_received') === 1);
    const stale = await runTool(d.s.site.tools, contractor, { tool: 'accept_bill', args: offer.args });
    assert.deepEqual([stale.ok, stale.key], [false, 'site.bill_changed']);
    assert.deepEqual(d.states(orderId), ['billed', 'billed'], 'nothing accepted');
    assert.equal(stale.params?.total, '₹16,800');
    // The new one, as now in force, can be accepted.
    const fresh = d.told('site:contractor', 'site.material_correction_received')?.[3];
    assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'accept_bill', args: fresh.args })).ok, true);
    assert.deepEqual(d.states(orderId), ['accepted', 'accepted']);
  } finally {
    await d.s.close();
  }
});

test('money1: through the conversation, the first हाँ answers the first bill: nothing accepted, the new bill shown and asked', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'billed');
    await until(() => d.toldCount('site:contractor', 'site.material_bill_received') === 1);
    // The delivery's count question is the supervisor's alone, so the contractor's yes is for the bill.
    assert.ok(!d.told('site:contractor', 'site.delivery_received_challan'));
    await runTool(d.s.site.tools, person('supervisor', 'agent:contractor-1'), { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000], sameAsChallan: true } });
    // A new bill replaces it (the same figures here, so it still agrees with the site's count).
    await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [5000] } });
    await until(() => d.toldCount('site:contractor', 'site.material_correction_received') === 1);
    await d.siteTalk.onText(contractor, 'हाँ');
    assert.deepEqual(d.states(orderId), ['billed', 'billed']);
    assert.ok(d.said.some(([, k, text]) => k === 'site.bill_changed' && text.includes('₹17,500')));
    await d.siteTalk.onText(contractor, 'हाँ');
    await until(() => d.states(orderId)[1] === 'accepted');
    assert.equal(d.s.supCore.ledger.events(orderId).find((e) => e.type === 'ACCEPT')?.body.body.bill, d.s.siteCore.ledger.view(orderId).currentBill);
  } finally {
    await d.s.close();
  }
});

test('money1: a read-back of the model\'s accept_bill is bound to the bill the person saw', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'billed');
    await until(() => d.toldCount('site:contractor', 'site.material_bill_received') === 1);
    const describeBound = d.s.site.tools.accept_bill.bind?.({ orderId });
    assert.deepEqual(describeBound, { orderId, bill: d.s.siteCore.ledger.view(orderId).currentBill });
  } finally {
    await d.s.close();
  }
});

test('money2: a correction above the signed delivery is told as a mismatch, with no one-word acceptance armed', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'billed');
    await until(() => d.toldCount('site:contractor', 'site.material_bill_received') === 1);
    await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [50000] } });
    await until(() => d.toldCount('site:contractor', 'site.material_bill_mismatch') === 1);
    assert.equal(d.toldCount('site:contractor', 'site.material_correction_received'), 0);
    assert.equal(d.told('site:contractor', 'site.material_bill_mismatch')?.[3], undefined, 'no "हाँ" armed');
  } finally {
    await d.s.close();
  }
});

test('money2: a correction up to the site\'s own count is still offered', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'delivered');
    // The site counted 55 bags; the bill for 50 differs, and the correction brings it to the count.
    assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5500] } })).ok, true);
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
    await until(() => d.toldCount('site:contractor', 'site.material_bill_count_differs') === 1);
    await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [5500] } });
    await until(() => d.toldCount('site:contractor', 'site.material_correction_received') === 1);
    assert.ok(d.told('site:contractor', 'site.material_correction_received')?.[3]);
  } finally {
    await d.s.close();
  }
});

test('money3: the seller\'s claim notice says when this UTR was used on another of this seller\'s orders', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(40, 'accepted');
    await d.upi(p1, 1750000, '412300000501');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    assert.equal(d.told('supplier:supplier', 'pay.seller.claimed')?.[2].includes('पहले भी'), false, 'first use: no warning');
    await d.upi(p2, 1400000, '412300000501', { sameUtrOk: true });
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 2);
    const notice = d.told('supplier:supplier', 'pay.seller.claimed')?.[2] ?? '';
    assert.ok(notice.includes('412300000501') && notice.includes('पहले भी') && notice.includes('P-1'), notice);
  } finally {
    await d.s.close();
  }
});

test('money3: the shares of one clubbed payment are not told as a reused UTR', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(40, 'accepted');
    const r = await runTool(d.s.site.tools, contractor, { tool: 'claim_group', args: { orderIds: [p1, p2], method: 'upi', totalPaise: 3150000, utr: '412300000502', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.equal(r.ok, true);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.group_claimed') === 1);
    assert.equal(d.told('supplier:supplier', 'pay.seller.group_claimed')?.[2].includes('पहले भी'), false);
  } finally {
    await d.s.close();
  }
});

test('money4: recording money with a waiting claim of the same amount sends the seller to that claim', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'accepted');
    await d.cash(orderId, 1000000);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    const r = await runTool(d.s.sup.tools, supplier, { tool: 'record_received', args: { orderId, amountPaise: 1000000, method: 'cash' } });
    assert.deepEqual([r.ok, r.key], [false, 'pay.seller.claim_waiting']);
    assert.equal(d.s.supCore.ledger.events(orderId).some((e) => e.type === 'PAYMENT_RECEIVED'), false);
    assert.equal(d.s.supCore.ledger.view(orderId).confirmedPaise, 0);
  } finally {
    await d.s.close();
  }
});

test('money4: the seller can still say it is a separate payment; another amount is not stopped', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'accepted');
    await d.cash(orderId, 1000000);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    // Their own message goes through the conversation: "नहीं" here means "a separate payment".
    await d.supTalk.onText(supplier, 'नहीं'); // the claim's own "नहीं" is answered first
    await until(() => d.s.siteCore.ledger.view(orderId).pending.length === 0);
    await d.cash(orderId, 500000);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 2);
    await d.supTalk.onText(supplier, 'P-1 ₹5,000 नकद मिले');
    assert.equal(d.last()[1], 'pay.seller.claim_waiting');
    await d.supTalk.onText(supplier, 'नहीं');
    // Recorded; the claim, set aside by the typed money, is then asked again.
    assert.deepEqual(d.said.slice(-2).map((/** @type {any} */ x) => x[1]), ['pay.seller.received', 'pay.seller.claimed']);
    assert.equal(d.s.supCore.ledger.view(orderId).confirmedPaise, 500000);
    assert.equal(d.s.supCore.ledger.view(orderId).pending.length, 1, 'the claim still waits');
    const other = await runTool(d.s.sup.tools, supplier, { tool: 'record_received', args: { orderId, amountPaise: 700000, method: 'cash' } });
    assert.equal(other.ok, true);
  } finally {
    await d.s.close();
  }
});

test('money4: its "हाँ" answers the waiting claim, and nothing is counted twice', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'accepted');
    await d.cash(orderId, 1000000);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    await d.supTalk.onText(supplier, 'P-1 ₹10,000 नकद मिले');
    assert.equal(d.last()[1], 'pay.seller.claim_waiting');
    await d.supTalk.onText(supplier, 'हाँ');
    assert.equal(d.s.supCore.ledger.view(orderId).confirmedPaise, 1000000);
    assert.equal(d.s.supCore.ledger.events(orderId).some((e) => e.type === 'PAYMENT_RECEIVED'), false);
  } finally {
    await d.s.close();
  }
});

test('money5: denying the last waiting claim settles an order already fully paid', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'accepted');
    await d.upi(orderId, 1750000, '412300000503');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    await d.cash(orderId, 100);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 2);
    const pending = d.s.supCore.ledger.view(orderId).pending;
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId, payment: pending[0] } })).ok, true);
    assert.deepEqual(d.states(orderId), ['payment_claimed', 'payment_claimed'], 'the ₹1 claim still blocks');
    const r = await runTool(d.s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId, payment: pending[1], received: false } });
    assert.equal(r.ok, true);
    assert.deepEqual(d.states(orderId), ['settled', 'settled']);
    assert.equal(d.s.siteCore.ledger.events(orderId).find((e) => e.type === 'SETTLED')?.body.body.amountPaise, 1750000);
  } finally {
    await d.s.close();
  }
});

test('money5: a denial that leaves the bill unpaid does not settle', async () => {
  const d = await desk();
  try {
    const orderId = await d.order(50, 'accepted');
    await d.cash(orderId, 100);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    const r = await runTool(d.s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId, received: false } });
    assert.equal(r.key, 'pay.seller.denied');
    assert.deepEqual(d.states(orderId), ['accepted', 'accepted']);
  } finally {
    await d.s.close();
  }
});

test('money6: a clubbed payment with an undelivered share is recorded whole; the seller is told once when all arrive', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(40, 'accepted');
    d.s.net.up = false;
    const r = await runTool(d.s.site.tools, contractor, { tool: 'claim_group', args: { orderIds: [p1, p2], method: 'upi', totalPaise: 3150000, utr: '412300000504', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.equal(r.key, 'common.pending');
    const shares = [p1, p2].map((id) => d.s.siteCore.ledger.events(id).find((e) => e.type === 'PAYMENT_CLAIM')?.body.body);
    assert.deepEqual(shares.map((b) => b?.amountPaise), [1750000, 1400000], 'both shares recorded');
    assert.equal(shares[0]?.group.id, shares[1]?.group.id);
    assert.equal(d.toldCount('supplier:supplier', 'pay.seller.group_claimed'), 0);
    d.s.net.up = true;
    await d.s.siteLink.retryPending();
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.group_claimed') === 1);
    assert.deepEqual(d.s.siteLink.pending(), []);
    await d.s.siteLink.retryPending();
    assert.equal(d.toldCount('supplier:supplier', 'pay.seller.group_claimed'), 1);
  } finally {
    await d.s.close();
  }
});

test('money6: an order still waiting on an earlier message stops the group before anything is recorded', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(40, 'accepted');
    d.s.net.up = false;
    await d.cash(p2, 100);
    d.s.net.up = true;
    const r = await runTool(d.s.site.tools, contractor, { tool: 'claim_group', args: { orderIds: [p1, p2], method: 'upi', totalPaise: 3150000, utr: '412300000505', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.equal(r.key, 'common.busy');
    assert.equal(d.s.siteCore.ledger.events(p1).some((e) => e.type === 'PAYMENT_CLAIM'), false);
  } finally {
    await d.s.close();
  }
});
