// Payments as they really happen (docs/CONTRACTS.md section 4.1): part, cash, advance and one payment
// for several orders, through the real agents over A2A and the WhatsApp conversations. Every receipt
// and notice shows the balance; the seller's own हाँ is the only thing that makes money count, and
// the seller's agent settles by itself. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { paymentSummary } from '../../src/ledger/payments.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_C, seesPhoto } from './helpers.js';

const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000051' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000052' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** Every text anyone was told or answered, across the tests in this file (checked at the end). @type {string[]} */
const everything = [];

/** Waits for the agents' messages to go round (real HTTP). @param {() => boolean} cond */
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'timed out waiting');
}

/** Two agents and both people's WhatsApp conversations. The supplier's notices set what his हाँ/नहीं means. */
async function desk() {
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any} */
  let supTalk = null;
  /** @type {any} */
  let nextUpi = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      const text = t(key, params);
      said.push([`${side}:${role}`, key, text]);
      everything.push(text);
      if (expect && side === 'supplier') supTalk.expect(supplier, expect.tool, expect.args, expect.no);
    },
  });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => {
    const text = t(key, params);
    said.push([p.role, key, text]);
    everything.push(text);
  };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  supTalk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, reply, now: s.supCore.now });
  const siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now,
    readUpi: async () => nextUpi, classifyPhoto: seesPhoto('upi') });
  let shots = 0;

  /** A new cement order of `bags` bags at ₹350, as far as `upTo`. @param {number} bags @param {'booked' | 'billed' | 'accepted'} upTo */
  async function order(bags, upTo) {
    s.advance(60_000);
    const before = new Set(s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id));
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site K', day: '2026-10-30', items: [{ ...CEMENT, qtyHundredths: bags * 100 }] } });
    const orderId = /** @type {string} */ (s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id).find((id) => !before.has(id)));
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    if (upTo !== 'booked') await bill(orderId, bags);
    if (upTo === 'accepted') await accept(orderId);
    return orderId;
  }
  /** @param {string} orderId @param {number} bags */
  async function bill(orderId, bags) {
    await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [{ ...CEMENT, qtyHundredths: bags * 100 }], sha256: SHA_A, challanNo: '7' } });
    assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
  }
  /** @param {string} orderId */
  async function accept(orderId) {
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } })).ok, true);
  }
  return {
    s, said, supTalk, siteTalk, order, bill, accept,
    /** A clear successful UPI screenshot from the contractor. @param {number} paise @param {string} utr */
    shot: async (paise, utr) => {
      nextUpi = { ok: true, kind: 'upi_payment', amountPaise: paise, date: '2026-10-30', time: null, clock: null, utr, status: 'success', clear: true };
      shots += 1;
      await siteTalk.onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([7, shots]) });
    },
    last: () => said.at(-1) ?? ['', '', ''],
    /** @param {string} who @param {string} key */
    toldCount: (who, key) => said.filter(([w, k]) => w === who && k === key).length,
    /** @param {string} who @param {string} key */
    told: (who, key) => said.filter(([w, k]) => w === who && k === key).at(-1)?.[2],
    /** @param {string} orderId */
    states: (orderId) => [s.siteCore.ledger.view(orderId).state, s.supCore.ledger.view(orderId).state],
    /** @param {string} orderId */
    summary: (orderId) => paymentSummary(s.siteCore.ledger.events(orderId)),
  };
}

test('part by UPI, the rest in cash: each confirmed by the supplier; settled by itself and both ledgers agree', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    // ₹10,000 of ₹17,500: no longer a mismatch, sent at once with the balance.
    await d.shot(1000000, '412300000101');
    assert.equal(d.last()[1], 'pay.site.claimed');
    assert.equal(d.last()[2], 'P-1: सप्लायर को भुगतान बताया: ₹10,000, 30 अक्टूबर 2026, UTR 412300000101। बाक़ी ₹17,500; इसमें ₹10,000 पक्का होना बाक़ी।');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    assert.ok(d.told('supplier:supplier', 'pay.seller.claimed')?.includes('बाक़ी ₹17,500'));
    assert.deepEqual(d.states(p1), ['payment_claimed', 'payment_claimed']);

    await d.supTalk.onText(supplier, 'हाँ');
    assert.equal(d.last()[1], 'pay.seller.confirmed');
    assert.equal(d.last()[2], 'P-1: ₹10,000 मिलना पक्का किया, ठेकेदार को बताया। बाक़ी ₹7,500।');
    await until(() => d.toldCount('site:contractor', 'pay.site.acked') === 1);
    assert.equal(d.told('site:contractor', 'pay.site.acked'), 'P-1: सप्लायर ने ₹10,000, 30 अक्टूबर 2026, UTR 412300000101 मिलना पक्का किया। बाक़ी ₹7,500।');
    assert.deepEqual(d.states(p1), ['part_paid', 'part_paid']);

    // The rest in cash, typed: acts at once (an exact single-order payment).
    await d.siteTalk.onText(contractor, 'P-1 ₹7,500 नकद दिए');
    assert.equal(d.last()[1], 'pay.site.claimed');
    assert.ok(d.last()[2].includes('₹7,500 नकद, 29 अक्टूबर 2026'), d.last()[2]);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 2);
    await d.supTalk.onText(supplier, 'हाँ मिल गए');
    assert.equal(d.last()[1], 'supplier.settled_sent');
    await until(() => d.states(p1)[0] === 'settled');
    assert.deepEqual(d.states(p1), ['settled', 'settled']);
    assert.ok(d.told('site:contractor', 'site.material_settled')?.includes('₹17,500'));
    const settled = d.s.siteCore.ledger.events(p1).find((e) => e.type === 'SETTLED')?.body.body;
    assert.equal(settled.amountPaise, 1750000);
    assert.equal(settled.payments.length, 2);
    const s = d.summary(p1);
    assert.deepEqual([s.confirmedPaise, s.duePaise, s.creditPaise, s.settled], [1750000, 0, 0, true]);
    assert.deepEqual(s.payments.map((p) => [p.method, p.status]), [['upi', 'confirmed'], ['cash', 'confirmed']]);
  } finally {
    await d.s.close();
  }
});

test('a forwarded UPI screenshot or cash receipt is refused before it is read; no claim is signed', async () => {
  const s = await setup();
  try {
    /** @type {string[]} */
    const said = [];
    let reads = 0;
    /** @param {'upi' | 'cash_receipt'} kind */
    const talkFor = (kind) => createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      reply: (_p, key) => { said.push(key); }, now: s.siteCore.now, classifyPhoto: /** @type {any} */ (async () => ({ ok: true, kind, clear: true, model: 'stand-in', latencyMs: 1 })),
      readUpi: /** @type {any} */ (async () => { reads += 1; return { ok: false }; }), readCashReceipt: /** @type {any} */ (async () => { reads += 1; return { ok: false }; }) });
    await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site K', day: '2026-10-30', items: [CEMENT] } });
    const orderId = String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
    const before = s.siteCore.ledger.events(orderId).length;
    for (const kind of /** @type {const} */ (['upi', 'cash_receipt'])) {
      await talkFor(kind).onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([7, 1]), forwarded: true });
    }
    assert.deepEqual(said, ['payment.forwarded', 'payment.forwarded']);
    assert.equal(reads, 0, 'neither was read');
    assert.equal(s.siteCore.ledger.events(orderId).length, before, 'nothing written');
  } finally {
    await s.close();
  }
});

test('a denied claim: the supplier\'s नहीं counts nothing; both see the balance unchanged', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    await d.shot(1750000, '412300000102');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    await d.supTalk.onText(supplier, 'नहीं');
    assert.equal(d.last()[1], 'pay.seller.denied');
    assert.equal(d.last()[2], 'P-1: ठेकेदार को बताया कि ₹17,500 नहीं मिला। बाक़ी ₹17,500।');
    await until(() => d.toldCount('site:contractor', 'pay.site.denied') === 1);
    assert.ok(d.told('site:contractor', 'pay.site.denied')?.includes('UTR 412300000102 नहीं मिला। बाक़ी ₹17,500'));
    assert.deepEqual(d.states(p1), ['accepted', 'accepted']);
    assert.deepEqual(d.summary(p1).payments.map((p) => p.status), ['denied']);
  } finally {
    await d.s.close();
  }
});

test('an advance before the delivery that covers the bill: settled at ACCEPT by the supplier\'s agent', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'booked');
    await d.siteTalk.onText(contractor, 'P-1 अग्रिम ₹17,500 नकद');
    assert.equal(d.last()[1], 'pay.site.claimed_advance');
    assert.equal(d.last()[2], 'P-1: सप्लायर को एडवांस बताया: ₹17,500 नकद, 29 अक्टूबर 2026। अभी बिल नहीं बना; एडवांस ₹17,500 पक्का होना बाक़ी।');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed_advance') === 1);
    await d.supTalk.onText(supplier, 'हाँ');
    assert.equal(d.last()[1], 'pay.seller.confirmed');
    assert.ok(d.last()[2].includes('अभी बिल नहीं बना; एडवांस ₹17,500 पक्का'), d.last()[2]);
    // Payments never move the state before ACCEPT.
    assert.deepEqual(d.states(p1), ['booked', 'booked']);
    await d.bill(p1, 50);
    await d.accept(p1);
    await until(() => d.states(p1)[0] === 'settled');
    assert.deepEqual(d.states(p1), ['settled', 'settled']);
    // The notice goes after SETTLED has made its round trip, later than the state changes.
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.settled_at_accept') === 1);
    await until(() => d.told('site:contractor', 'site.material_settled') !== undefined);
    assert.ok(d.told('supplier:supplier', 'pay.seller.settled_at_accept')?.includes('₹17,500'));
    assert.ok(d.told('site:contractor', 'site.material_settled'));
  } finally {
    await d.s.close();
  }
});

test('an advance smaller than the bill ("P-1 अग्रिम ₹5,000" then the screenshot): part_paid at ACCEPT', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'booked');
    await d.siteTalk.onText(contractor, 'P-1 अग्रिम ₹5,000');
    assert.equal(d.last()[1], 'pay.await_shot');
    assert.equal(d.last()[2], 'P-1 ₹5,000: UPI की फ़ोटो भेजें, या नकद दिया हो तो "नकद" लिखें।');
    await d.shot(500000, '412300000103');
    assert.equal(d.last()[1], 'pay.site.claimed_advance');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed_advance') === 1);
    await d.supTalk.onText(supplier, 'हाँ');
    await d.bill(p1, 50);
    await d.accept(p1);
    await until(() => d.s.supCore.ledger.view(p1).state === 'part_paid');
    assert.deepEqual(d.states(p1), ['part_paid', 'part_paid']);
    const v = d.s.siteCore.ledger.view(p1);
    assert.deepEqual([v.billTotalPaise, v.confirmedPaise, v.pending], [1750000, 500000, []]);
    assert.equal(d.summary(p1).duePaise, 1250000);
  } finally {
    await d.s.close();
  }
});

test('the supplier records cash he received himself: counts at once, and settles when it completes the bill', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    await d.supTalk.onText(supplier, '₹5,000 नकद मिले');
    assert.equal(d.last()[1], 'pay.seller.received');
    assert.equal(d.last()[2], 'P-1: ₹5,000 नकद, 29 अक्टूबर 2026 मिलना दर्ज किया, ठेकेदार को बताया। बाक़ी ₹12,500।');
    await until(() => d.toldCount('site:contractor', 'pay.site.received') === 1);
    assert.equal(d.told('site:contractor', 'pay.site.received'), 'P-1: सप्लायर ने ₹5,000 नकद, 29 अक्टूबर 2026 मिलना दर्ज किया। बाक़ी ₹12,500।');
    assert.deepEqual(d.states(p1), ['part_paid', 'part_paid']);
    await d.supTalk.onText(supplier, 'P-1 ₹12,500 नकद मिले');
    assert.equal(d.last()[1], 'supplier.settled_sent');
    await until(() => d.states(p1)[0] === 'settled');
    assert.deepEqual(d.summary(p1).payments.map((p) => [p.kind, p.method, p.status]), [['received', 'cash', 'confirmed'], ['received', 'cash', 'confirmed']]);
  } finally {
    await d.s.close();
  }
});

test('one payment for P-1 and P-2, exact: the split read back once; one हाँ from the supplier settles both', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(30, 'accepted');
    await d.siteTalk.onText(contractor, 'P-1 और P-2 एक साथ ₹28,000 नकद');
    assert.equal(d.last()[1], 'step.claim_group_cash');
    assert.equal(d.last()[2], '₹28,000 नकद, एक साथ सप्लायर को, ऐसे बँटेगा:\nP-1 में ₹17,500\nP-2 में ₹10,500\nभेजें? हाँ / नहीं');
    await d.siteTalk.onText(contractor, 'हाँ');
    assert.equal(d.last()[1], 'pay.site.group_claimed');
    const claims = [p1, p2].map((id) => d.s.supCore.ledger.events(id).find((e) => e.type === 'PAYMENT_CLAIM')?.body.body);
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.group_claimed') === 1);
    assert.equal(claims[0].group.id, claims[1].group.id);
    assert.deepEqual(claims[0].group, { id: claims[0].group.id, totalPaise: 2800000, orders: [p1, p2] });
    assert.deepEqual(claims.map((c) => c.amountPaise), [1750000, 1050000]);
    assert.equal(d.toldCount('supplier:supplier', 'pay.seller.claimed'), 0, 'the group is told once, whole');
    assert.ok(d.told('supplier:supplier', 'pay.seller.group_claimed')?.includes('P-2 में ₹10,500; बाक़ी ₹10,500'));

    await d.supTalk.onText(supplier, 'हाँ');
    assert.equal(d.last()[1], 'pay.seller.group_confirmed');
    assert.equal(d.last()[2], '₹28,000 मिलना पक्का किया, ठेकेदार को बताया।\nP-1 में ₹17,500; हिसाब पूरा\nP-2 में ₹10,500; हिसाब पूरा');
    await until(() => d.states(p1)[0] === 'settled' && d.states(p2)[0] === 'settled');
    assert.deepEqual([...d.states(p1), ...d.states(p2)], ['settled', 'settled', 'settled', 'settled']);
    await until(() => d.toldCount('site:contractor', 'pay.site.group_acked') === 1);
  } finally {
    await d.s.close();
  }
});

test('one payment for two orders, short: the oldest bill is paid first, the second is part paid', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(30, 'accepted');
    // No order named: every order with something due, oldest bill first (CONTRACTS 4.1).
    await d.shot(2000000, '412300000104');
    assert.equal(d.last()[1], 'pay.split_choose');
    assert.ok(d.last()[2].includes('P-1 में ₹17,500\nP-2 में ₹2,500'), d.last()[2]);
    await d.siteTalk.onText(contractor, 'हाँ');
    assert.equal(d.last()[1], 'pay.site.group_claimed');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.group_claimed') === 1);
    await d.supTalk.onText(supplier, 'हाँ');
    await until(() => d.states(p1)[0] === 'settled' && d.states(p2)[0] === 'part_paid');
    assert.deepEqual([...d.states(p1), ...d.states(p2)], ['settled', 'settled', 'part_paid', 'part_paid']);
    assert.equal(d.summary(p2).duePaise, 800000);
  } finally {
    await d.s.close();
  }
});

test('one payment for two orders, over: a credit on the last billed order, or an advance when it has no bill', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    const p2 = await d.order(30, 'accepted');
    await d.siteTalk.onText(contractor, 'P-1 P-2 ₹30,000 नकद');
    assert.ok(d.last()[2].includes('P-1 में ₹17,500\nP-2 में ₹12,500'), d.last()[2]);
    await d.siteTalk.onText(contractor, 'हाँ');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.group_claimed') === 1);
    await d.supTalk.onText(supplier, 'हाँ');
    await until(() => d.states(p2)[0] === 'settled');
    assert.equal(d.summary(p2).creditPaise, 200000);
    assert.equal(d.told('site:contractor', 'site.material_settled_credit'), 'P-2: सप्लायर ने ₹12,500 मिलना पक्का किया। Site K का यह हिसाब पूरा; ₹2,000 ज़्यादा दिया गया है।');
  } finally {
    await d.s.close();
  }
  const e = await desk();
  try {
    const p1 = await e.order(50, 'accepted');
    const p2 = await e.order(30, 'booked');
    await e.siteTalk.onText(contractor, 'P-1 P-2 ₹20,000 नकद');
    assert.ok(e.last()[2].includes('P-1 में ₹17,500\nP-2 में ₹2,500 (एडवांस)'), e.last()[2]);
    await e.siteTalk.onText(contractor, 'हाँ');
    const share = e.s.siteCore.ledger.events(p2).find((x) => x.type === 'PAYMENT_CLAIM')?.body.body;
    assert.deepEqual([share.bill, share.amountPaise], [null, 250000]);
    assert.equal(e.summary(p2).payments[0].advance, true);
    assert.equal(e.states(p1)[0], 'payment_claimed');
  } finally {
    await e.s.close();
  }
});

test('a UTR already told for another payment is shown with both and asked; हाँ sends it anyway', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'accepted');
    await d.shot(1000000, '412300000105');
    assert.equal(d.last()[1], 'pay.site.claimed');
    await d.shot(500000, '412300000105');
    assert.equal(d.last()[1], 'pay.utr_used');
    assert.equal(d.last()[2], 'यह UTR 412300000105 पहले भी बताया जा चुका है: P-1: ₹10,000, 30 अक्टूबर 2026, UTR 412300000105।\nअब: ₹5,000, 30 अक्टूबर 2026, UTR 412300000105।\nफिर भी भेजें? हाँ / नहीं');
    const claims = () => d.s.siteCore.ledger.events(p1).filter((e) => e.type === 'PAYMENT_CLAIM').length;
    assert.equal(claims(), 1, 'nothing sent before the answer');
    // The tool itself never sends a used UTR silently either.
    const r = await runTool(d.s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: p1, amountPaise: 500000, utr: '412300000105', paidOn: '2026-10-30', screenshotSha256: SHA_C } });
    assert.equal(r.key, 'pay.utr_used');
    await d.siteTalk.onText(contractor, 'हाँ');
    assert.equal(d.last()[1], 'pay.site.claimed');
    assert.equal(claims(), 2);
  } finally {
    await d.s.close();
  }
});

test('a correction after a part payment changes what is due, never the payments', async () => {
  const d = await desk();
  try {
    const p1 = await d.order(50, 'billed');
    await d.siteTalk.onText(contractor, 'P-1 ₹5,000 नकद दिए');
    assert.equal(d.last()[1], 'pay.site.claimed');
    await until(() => d.toldCount('supplier:supplier', 'pay.seller.claimed') === 1);
    await d.supTalk.onText(supplier, 'हाँ');
    assert.deepEqual(d.states(p1), ['billed', 'billed'], 'no state change before ACCEPT');
    const r = await runTool(d.s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId: p1, qtyHundredths: 4800, reason: 'site count' } });
    assert.equal(r.ok, true);
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'send_correction', args: { orderId: p1, qtysHundredths: [4800] } })).ok, true);
    const s = d.summary(p1);
    assert.deepEqual([s.billTotalPaise, s.confirmedPaise, s.duePaise], [1680000, 500000, 1180000]);
    assert.deepEqual(s.payments.map((p) => p.amountPaise), [500000]);
    await d.accept(p1);
    await until(() => d.s.supCore.ledger.view(p1).state === 'part_paid');
    assert.deepEqual(d.states(p1), ['part_paid', 'part_paid']);
  } finally {
    await d.s.close();
  }
});

test('payments are refused before the booking and after the order is settled', async () => {
  const d = await desk();
  try {
    await runTool(d.s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site K', day: '2026-10-30', items: [CEMENT] } });
    const p1 = /** @type {string} */ (d.s.siteCore.ledger.orders()[0].order_id);
    const cash = { orderId: p1, method: 'cash', amountPaise: 500000, paidOn: '2026-10-30' };
    assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'claim_payment', args: cash })).key, 'common.wrong_state');
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_received', args: { orderId: p1, method: 'cash', amountPaise: 500000 } })).key, 'common.wrong_state');
    assert.equal(d.s.siteCore.ledger.events(p1).filter((e) => e.type.startsWith('PAYMENT')).length, 0);

    await runTool(d.s.sup.tools, supplier, { tool: 'reply_order', args: { orderId: p1, answer: 'yes', ratesPaise: [35000] } });
    await d.bill(p1, 50);
    await d.accept(p1);
    await d.supTalk.onText(supplier, 'P-1 ₹17,500 नकद मिले');
    await until(() => d.states(p1)[0] === 'settled');
    assert.equal((await runTool(d.s.site.tools, contractor, { tool: 'claim_payment', args: cash })).key, 'common.wrong_state');
    assert.equal((await runTool(d.s.sup.tools, supplier, { tool: 'record_received', args: { orderId: p1, method: 'cash', amountPaise: 500000 } })).key, 'common.wrong_state');
    // A settled order is not open: its reference is not one to pay.
    await d.siteTalk.onText(contractor, 'P-1 ₹5,000 नकद दिए');
    assert.equal(d.last()[1], 'common.no_such_order');
  } finally {
    await d.s.close();
  }
});

test('no message in these flows shows "—" or asks anyone to pay', () => {
  assert.ok(everything.length > 40, `only ${everything.length} texts`);
  const chasing = ['जल्दी', 'तुरंत', 'याद दिला', 'चुकाएँ', 'भुगतान करें', 'भुगतान कीजिए', 'पैसे दो', 'पैसे दें', 'reminder', 'overdue'];
  for (const text of everything) {
    assert.ok(!text.includes('—'), text);
    for (const c of chasing) assert.ok(!text.includes(c), `${c}: ${text}`);
  }
});
