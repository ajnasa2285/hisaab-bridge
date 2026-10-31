// The site's own copy of the challan: the supervisor (or the contractor) photographs it, the reader
// (a stand-in here) reads it, code matches it to the open material order, and it becomes the site's
// count with the photo as evidence: at once when every item was read clearly and agrees with the
// supplier's signed DELIVERY (if it has come), read back first when it differs, typed by the person when
// unclear. Code compares it with the DELIVERY, whichever comes first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { siteCount } from '../../src/agents/material.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, seesPhoto } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000013' };
const SAND = { name: 'बालू', qtyHundredths: 30000, unit: 'cft' };
const GITTI = { name: 'गिट्टी', qtyHundredths: 200, unit: 'brass' };
const photo = { mime: 'image/jpeg', bytes: new Uint8Array([9, 6, 9, 6]) };
const SHA = createHash('sha256').update(photo.bytes).digest('hex');

/** A clear reading of a challan. @param {string | null} no @param {{name: string, qtyHundredths: number | null, unit?: string | null}[]} items */
const clearRead = (no, items) => ({ ok: true, kind: 'challan', challanNo: no, date: '2026-10-29', vehicle: null, clear: true,
  items: items.map((i) => ({ name: i.name, qtyHundredths: i.qtyHundredths, unit: i.unit ?? null, raw: `${i.name} ${i.qtyHundredths ?? '?'}` })) });

/**
 * Real agents; the site's conversation reads challans with a stand-in. `orders` material orders are
 * placed and booked by the supplier (₹50/cft, ₹4,000/brass).
 * @param {{orders?: {name: string, qtyHundredths: number, unit: string}[][], withUpi?: boolean}} [opts]
 */
async function start(opts = {}) {
  /** @type {any} */
  let nextRead = null;
  let reads = 0;
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any} */
  let siteTalk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params)]);
      if (expect && side === 'site' && role === 'supervisor') siteTalk.expect(supervisor, expect.tool, expect.args);
      if (expect && side === 'site' && role === 'contractor') siteTalk.expect(contractor, expect.tool, expect.args);
    },
  });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  const readChallan = async () => { reads += 1; return nextRead; };
  /** @type {any} */
  let nextUpi = { ok: true, kind: 'not_upi' };
  let upiReads = 0;
  const readUpi = opts.withUpi ? async () => { upiReads += 1; return nextUpi; } : undefined;
  /** @type {'meter' | 'upi' | 'challan' | 'other'} */
  let kind = 'challan';
  /** @type {import('../../src/agents/conversation.js').PhotoClassifier} */
  const classifyPhoto = async () => ({ ok: true, kind, clear: true, model: 'stand-in', latencyMs: 1 });
  siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, readChallan, readUpi, classifyPhoto, reply, now: s.siteCore.now });
  /** @type {string[]} */
  const orderIds = [];
  for (const items of opts.orders ?? [[SAND]]) {
    await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Site A', day: '2026-10-29', items } });
    // The clock stands still, so the new order is the one not seen before (not the last by time).
    const orderId = /** @type {{order_id: string}[]} */ (s.siteCore.ledger.orders()).map((r) => r.order_id).find((id) => !orderIds.includes(id));
    assert.ok(orderId);
    await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: items.map((i) => (i.unit === 'cft' ? 5000 : 400000)) } });
    orderIds.push(orderId);
  }
  return {
    s, siteTalk, said, orderIds, orderId: orderIds[0],
    read: (/** @type {any} */ r) => { nextRead = r; },
    reads: () => reads,
    upi: (/** @type {any} */ r) => { nextUpi = r; },
    upiReads: () => upiReads,
    sees: (/** @type {'meter' | 'upi' | 'challan' | 'other'} */ k) => { kind = k; },
    last: () => said.at(-1),
    count: (/** @type {string} */ id) => siteCount(s.siteCore.ledger.events(id)),
    note: (/** @type {string} */ id) => s.siteCore.ledger.events(id).filter((e) => e.type === 'NOTE' && e.body.kind === 'site_count').at(-1),
    /** The supplier's signed delivery of an order. @param {string} id @param {any[]} items @param {string | null} no */
    deliver: async (id, items, no) => {
      const r = await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId: id, items, sha256: SHA_A, challanNo: no ?? undefined } });
      assert.equal(r.key, 'supplier.delivery_sent');
      await new Promise((res) => setImmediate(res));
    },
  };
}

test('one open order: a clear photo is recorded at once with its reference; a later delivery that differs is told, with the dispute offered', async () => {
  const c = await start();
  try {
    c.read(clearRead('96', [{ name: 'I', qtyHundredths: 28000, unit: 'cft' }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    assert.ok(c.last()?.[2].includes('P-1') && c.last()?.[2].includes('96') && c.last()?.[2].includes('बालू 280 cft'), c.last()?.[2]);
    assert.equal(c.siteTalk.pending(supervisor), null, 'no "हाँ / नहीं" question left');
    const note = c.note(c.orderId);
    assert.deepEqual([note?.direction, note?.body.items, note?.body.challan], ['local', [{ name: 'बालू', qtyHundredths: 28000, unit: 'cft' }], { sha256: SHA, number: '96' }]);
    assert.equal(c.s.supCore.ledger.events(c.orderId).filter((e) => e.type === 'NOTE').length, 0, 'the count stays on the contractor ledger');

    // The supplier's signed delivery says 300 cft on challan 96: code compares, both are told, nobody is asked again.
    await c.deliver(c.orderId, [SAND], '96');
    const told = c.said.filter(([w]) => w.startsWith('site:'));
    assert.ok(!told.some(([, k]) => k === 'site.delivery_received'));
    for (const who of ['site:contractor', 'site:supervisor']) {
      const m = told.find(([w, k]) => w === who && k === 'site.challan_count_differs');
      assert.ok(m && m[2].includes('बालू 280 cft') && m[2].includes('बालू 300 cft') && m[2].includes('P-1') && m[2].includes('आपत्ति'), who);
    }

    // A later "हाँ" from the supervisor is not a count: nothing is overwritten.
    await c.siteTalk.onText(supervisor, 'हाँ');
    assert.deepEqual(c.count(c.orderId), [{ name: 'बालू', qtyHundredths: 28000, unit: 'cft' }]);

    // The bill follows the challan; the contractor sees the site's figure priced at the agreed rate.
    await runTool(c.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: c.orderId } });
    await new Promise((res) => setImmediate(res));
    const bill = c.said.find(([w, k]) => w === 'site:contractor' && k === 'site.material_bill_count_differs');
    assert.ok(bill && bill[2].includes('₹15,000') && bill[2].includes('₹14,000'), bill?.[2]);

    // Counted: no order waits for a challan photo any more, and the reader is not asked.
    const before = c.reads();
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_no_order');
    assert.equal(c.reads(), before);
  } finally {
    await c.s.close();
  }
});

test('different challan numbers are told even when the quantities agree', async () => {
  const c = await start();
  try {
    c.read(clearRead('96', [{ name: 'बालू', qtyHundredths: 30000, unit: 'cft' }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    await c.deliver(c.orderId, [SAND], '97');
    const m = c.said.find(([w, k]) => w === 'site:contractor' && k === 'site.challan_count_differs');
    assert.ok(m && m[2].includes('96') && m[2].includes('97'));
  } finally {
    await c.s.close();
  }
});

test('several open orders: the reference is asked with the exact reply forms, then the count is recorded for that order', async () => {
  const c = await start({ orders: [[SAND], [SAND, GITTI]] });
  try {
    c.read(clearRead('412', [{ name: 'बालू', qtyHundredths: 30000 }, { name: 'गिट्टी', qtyHundredths: 150 }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_which_order');
    assert.ok(c.last()?.[2].includes('"P-1"') && c.last()?.[2].includes('"P-2"') && c.last()?.[2].includes('गिट्टी 2 brass'), c.last()?.[2]);

    // A reference that is not one of them is asked again.
    await c.siteTalk.onText(supervisor, 'P-7');
    assert.equal(c.last()?.[1], 'site.challan_which_order');
    await c.siteTalk.onText(supervisor, 'p-2');
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    assert.ok(c.last()?.[2].includes('P-2') && c.last()?.[2].includes('बालू 300 cft, गिट्टी 1.5 brass'), c.last()?.[2]);
    assert.equal(c.reads(), 1, 'the photo is read once');
    assert.equal(c.count(c.orderIds[0]), null);
    assert.deepEqual(c.count(c.orderIds[1]), [{ name: 'बालू', qtyHundredths: 30000, unit: 'cft' }, { name: 'गिट्टी', qtyHundredths: 150, unit: 'brass' }]);

    // Now only P-1 is open: the next photo goes straight to it.
    c.read(clearRead('413', [{ name: 'बालू', qtyHundredths: 30000 }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    assert.ok(c.last()?.[2].includes('P-1'));
    assert.deepEqual(c.count(c.orderIds[0]), [{ name: 'बालू', qtyHundredths: 30000, unit: 'cft' }]);
  } finally {
    await c.s.close();
  }
});

test('no open material order: the person is told how to make one and nothing is read or recorded', async () => {
  const c = await start({ orders: [] });
  try {
    c.read(clearRead('96', [{ name: 'बालू', qtyHundredths: 30000 }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_no_order');
    assert.equal(c.reads(), 0);
    assert.equal(c.s.siteCore.ledger.orders().length, 0);
  } finally {
    await c.s.close();
  }
});

test('an unclear read asks for the figures; a bare "हाँ" records nothing; typed figures are recorded at once', async () => {
  const c = await start({ orders: [[SAND, GITTI]] });
  try {
    // Like a real handwritten challan: number read, the item code and quantity seen, unit not, not clear.
    c.read({ ok: true, kind: 'challan', challanNo: '96', date: null, vehicle: null, clear: false, items: [{ name: 'I', qtyHundredths: 30000, unit: null, raw: 'I 300' }] });
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_ask_person');
    assert.ok(c.last()?.[2].includes('P-1') && c.last()?.[2].includes('I 300') && c.last()?.[2].includes('बालू (cft), गिट्टी (brass)'), c.last()?.[2]);
    await c.siteTalk.onText(supervisor, 'हाँ');
    assert.equal(c.count(c.orderId), null);

    await c.siteTalk.onImage(supervisor, photo);
    // One figure for two items is asked again; 0 means that item did not come.
    await c.siteTalk.onText(supervisor, '300');
    assert.equal(c.last()?.[1], 'site.challan_ask_person_blank');
    assert.doesNotMatch(c.last()?.[2] ?? '', /—/);
    // The person's own figures are their count: recorded at once.
    await c.siteTalk.onText(supervisor, '290, 0');
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    assert.ok(c.last()?.[2].includes('बालू 290 cft') && !c.last()?.[2].includes('गिट्टी 0'));
    assert.deepEqual(c.note(c.orderId)?.body.challan, { sha256: SHA, number: '96' });
    assert.deepEqual(c.count(c.orderId), [{ name: 'बालू', qtyHundredths: 29000, unit: 'cft' }]);

    // Counted: the next photo finds no order waiting for the site's count.
    c.read({ ok: true, kind: 'not_challan' });
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_no_order');
  } finally {
    await c.s.close();
  }
});

test('a delivery already present that matches: the photo count is recorded and agrees', async () => {
  const c = await start({ orders: [[SAND, GITTI]] });
  try {
    await c.deliver(c.orderId, [SAND, GITTI], '0412');
    assert.ok(c.said.some(([w, k]) => w === 'site:supervisor' && k === 'site.delivery_received_challan'));
    c.read(clearRead('412', [{ name: 'Sand', qtyHundredths: 30000 }, { name: 'Gitti 20mm', qtyHundredths: 200 }]));
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_count_matches_challan');
    assert.ok(c.last()?.[2].includes('P-1') && c.last()?.[2].includes('0412'));
    assert.ok(!c.said.some(([, k]) => k === 'site.challan_count_differs'));
    assert.deepEqual(c.note(c.orderId)?.body.challan, { sha256: SHA, number: '412' });
  } finally {
    await c.s.close();
  }
});

test('a delivery already present that differs: the reading is read back first; on "हाँ" the contractor is told both figures', async () => {
  const c = await start({ orders: [[SAND, GITTI]] });
  try {
    await c.deliver(c.orderId, [SAND, GITTI], '412');
    c.read(clearRead('412', [{ name: 'बालू', qtyHundredths: 30000 }, { name: 'गिट्टी', qtyHundredths: 150 }]));
    await c.siteTalk.onImage(supervisor, photo);
    // Code found a mismatch with the supplier's delivery: a misread is possible, so it is read back.
    assert.equal(c.last()?.[1], 'step.site_challan_challan');
    assert.ok(c.last()?.[2].includes('गिट्टी 1.5 brass') && c.last()?.[2].includes('अलग'));
    assert.equal(c.count(c.orderId), null, 'nothing recorded before "हाँ"');
    await c.siteTalk.onText(supervisor, 'हाँ जी');
    assert.equal(c.last()?.[1], 'site.challan_count_differs');
    const m = c.said.find(([w, k]) => w === 'site:contractor' && k === 'site.challan_count_differs');
    assert.ok(m && m[2].includes('गिट्टी 1.5 brass') && m[2].includes('गिट्टी 2 brass'));
  } finally {
    await c.s.close();
  }
});

test('a bare "हाँ" never overwrites a site count already recorded; typed figures change it and the contractor is told', async () => {
  const c = await start();
  try {
    await c.deliver(c.orderId, [SAND], '96');
    // The supervisor answers the delivery notice first: the count is the challan's.
    await c.siteTalk.onText(supervisor, 'हाँ');
    assert.equal(c.last()?.[1], 'site.count_matches');
    // A read-back from a photo that was still open elsewhere (another phone) is refused on a bare "हाँ".
    const args = { orderId: c.orderId, qtysHundredths: [28000], challan: { sha256: SHA, number: '96' }, sameAsChallan: true };
    const r = await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args });
    assert.equal(r.key, 'site.count_already');
    assert.deepEqual(c.count(c.orderId), [SAND]);
    // Counted: a new photo finds no order waiting.
    await c.siteTalk.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'site.challan_no_order');
    // Typed figures (no sameAsChallan) do change it, and the contractor sees old and new.
    const typed = await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { ...args, sameAsChallan: undefined } });
    assert.equal(typed.key, 'site.challan_count_differs');
    assert.ok(c.said.some(([w, k]) => w === 'site:contractor' && k === 'site.count_changed'));
    assert.deepEqual(c.count(c.orderId), [{ name: 'बालू', qtyHundredths: 28000, unit: 'cft' }]);
  } finally {
    await c.s.close();
  }
});

test('roles: the contractor may send the site challan; other roles and other agents may not', async () => {
  const c = await start({ withUpi: true });
  try {
    // The contractor's challan photo is the site challan.
    c.read(clearRead('96', [{ name: 'बालू', qtyHundredths: 30000 }]));
    await c.siteTalk.onImage(contractor, photo);
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');

    // The tool itself: only supervisor and contractor.
    for (const role of ['jcb_owner', 'operator', 'supplier']) {
      const r = await runTool(c.s.site.tools, /** @type {any} */ (person(role, 'agent:contractor-1')), { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: [100], challan: { sha256: SHA, number: null } } });
      assert.equal(r.key, 'common.not_allowed', role);
    }
    // An operator sends no photos on the site agent; nothing is read.
    const before = c.reads();
    await c.siteTalk.onImage(/** @type {any} */ (person('operator', 'agent:contractor-1')), photo);
    assert.equal(c.last()?.[1], 'photo.none');
    assert.equal(c.reads(), before);

    // A supervisor on the supplier's agent (no site count there) gets no site challan flow.
    const said = /** @type {string[]} */ ([]);
    const supTalk = createConversation({
      ledger: c.s.supCore.ledger, tools: c.s.sup.tools, spark: async () => ({ ok: true, toolCalls: [] }),
      readChallan: async () => /** @type {any} */ (clearRead('1', [{ name: 'बालू', qtyHundredths: 100 }])), classifyPhoto: seesPhoto('challan'), reply: (_p, key) => { said.push(key); }, now: c.s.supCore.now,
    });
    await supTalk.onImage(supervisor, photo);
    assert.deepEqual(said, ['photo.none']);
  } finally {
    await c.s.close();
  }
});

/**
 * The contractor has bills to pay and an order to count: the first `payable` orders are delivered,
 * billed and accepted; the last order is booked and waits for the site's count.
 * @param {number} payable
 */
async function mixed(payable) {
  const c = await start({ withUpi: true, orders: [...Array.from({ length: payable }, () => [SAND]), [GITTI]] });
  for (const id of c.orderIds.slice(0, payable)) {
    await c.deliver(id, [SAND], '50');
    await runTool(c.s.sup.tools, supplier, { tool: 'send_bill', args: { orderId: id } });
    await new Promise((res) => setImmediate(res));
    assert.equal((await runTool(c.s.site.tools, contractor, { tool: 'accept_bill', args: { orderId: id } })).key, 'site.material_bill_accepted');
    assert.equal(c.s.siteCore.ledger.view(id).state, 'accepted');
  }
  return c;
}
const UPI = { ok: true, kind: 'upi_payment', amountPaise: 1500000, date: '2026-10-29', utr: '123456789012', status: 'success', clear: true };

test('mixed, two bills to pay: a challan photo goes to the site challan flow; the UPI reader is never tried', async () => {
  const c = await mixed(2);
  try {
    c.read(clearRead('96', [{ name: 'गिट्टी', qtyHundredths: 200 }]));
    await c.siteTalk.onImage(contractor, photo);
    assert.equal(c.upiReads(), 0);
    assert.equal(c.reads(), 1);
    const saved = c.said.find(([, k]) => k === 'site.challan_count_saved_challan');
    assert.ok(saved?.[2].includes('P-3') && saved?.[2].includes('गिट्टी 2 brass'), saved?.[2]);
    // The deliveries' count questions are the supervisor's: nothing further is asked of the contractor.
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
  } finally {
    await c.s.close();
  }
});

test('mixed, two bills to pay: a UPI screenshot offers the split or one order (CONTRACTS 4.1); the challan reader is not used', async () => {
  const c = await mixed(2);
  try {
    c.sees('upi');
    c.upi(UPI);
    await c.siteTalk.onImage(contractor, photo);
    assert.equal(c.last()?.[1], 'pay.split_choose');
    assert.equal(c.reads(), 0);
    assert.equal(c.upiReads(), 1);
  } finally {
    await c.s.close();
  }
});

test('mixed, one bill to pay: a challan photo is the site count; a clear UPI screenshot for the bill is claimed', async () => {
  const c = await mixed(1);
  try {
    c.read(clearRead('96', [{ name: 'गिट्टी', qtyHundredths: 200 }]));
    await c.siteTalk.onImage(contractor, photo);
    assert.equal(c.upiReads(), 0);
    assert.equal(c.last()?.[1], 'site.challan_count_saved_challan');
    assert.ok(c.last()?.[2].includes('P-2'));

    c.sees('upi');
    c.upi(UPI);
    await c.siteTalk.onImage(contractor, photo);
    assert.equal(c.reads(), 1);
    assert.equal(c.upiReads(), 1);
    assert.equal(c.last()?.[1], 'pay.site.claimed');
  } finally {
    await c.s.close();
  }
});

test('bad figures in the tool are refused with the order\'s items named', async () => {
  const c = await start({ orders: [[SAND, GITTI]] });
  try {
    for (const qtys of [[100], [0, 0], [-1, 5], [1.5, 2]]) {
      const r = await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: qtys, challan: { sha256: SHA, number: '9' } } });
      assert.equal(r.key, 'site.challan_figures', String(qtys));
    }
    const r = await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: [100, 0], challan: { sha256: 'x', number: '9' } } });
    assert.equal(r.key, 'common.bad_args');
    assert.equal(c.count(c.orderId), null);
  } finally {
    await c.s.close();
  }
});
