// The site's signed copy goes back to the supplier: when the site's count is recorded from a photo of
// its own copy of the challan, the contractor's agent sends a signed SITE_RECEIPT; the supplier's
// code checks the challan number and the items against its own DELIVERY and tells the supplier.
// Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { createOffice } from '../../src/agents/office.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { bodyIsValid } from '../../src/protocol/messages.js';
import { step, emptyView } from '../../src/ledger/states.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A } from './helpers.js';

const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000021' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000022' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const photo = { mime: 'image/jpeg', bytes: new Uint8Array([4, 8, 4, 8]) };
const SHA = createHash('sha256').update(photo.bytes).digest('hex');

/** A clear reading of the site's copy. @param {string | null} no @param {number} qty @param {boolean | null | undefined} signed */
const read = (no, qty, signed) => ({
  ok: true, kind: 'challan', challanNo: no, date: '2026-10-29', vehicle: null, clear: true,
  items: [{ name: 'सीमेंट', qtyHundredths: qty, unit: 'bag', raw: `सीमेंट ${qty / 100} बोरी` }],
  ...(signed === undefined ? {} : { signed }),
});

/** One cement order, booked at ₹350/बोरी; the site's conversation reads challans with a stand-in. */
async function start() {
  /** @type {any} */
  let nextRead = null;
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any} */
  let talk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params)]);
      if (expect && side === 'site' && role === 'supervisor') talk.expect(supervisor, expect.tool, expect.args);
    },
  });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  talk = createConversation({
    ledger: s.siteCore.ledger, tools: s.site.tools, reply, now: s.siteCore.now,
    spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
    readChallan: async () => nextRead,
    classifyPhoto: async () => ({ ok: true, kind: 'challan', clear: true, model: 'stand-in', latencyMs: 1 }),
  });
  await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Site B', day: '2026-10-29', items: [CEMENT] } });
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  /** Waits (at most 2 s) for something an agent does after answering over HTTP. @param {() => boolean} ok */
  const until = async (ok) => { for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10)); };
  return {
    s, said, talk, orderId, settle, until,
    next: (/** @type {any} */ r) => { nextRead = r; },
    /** The supplier's DELIVERY of 50 bags on its own challan. @param {string} no */
    deliver: async (no) => {
      const r = await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A, challanNo: no } });
      assert.equal(r.key, 'supplier.delivery_sent');
      await settle();
    },
    /** The site photographs its copy: recorded at once when it agrees, else read back and "हाँ". */
    photograph: async () => {
      await talk.onImage(supervisor, photo);
      if (String(said.at(-1)?.[1]).startsWith('step.site_challan')) await talk.onText(supervisor, 'हाँ');
      else assert.match(String(said.at(-1)?.[1]), /^site\.challan_count/);
      await settle();
    },
    receipts: () => s.supCore.ledger.events(orderId).filter((e) => e.type === 'SITE_RECEIPT'),
    toSupplier: () => said.filter(([w, k]) => w === 'supplier:supplier' && k.startsWith('supplier.site_receipt')),
  };
}

test('a count from the site\'s challan photo, after the DELIVERY: a signed SITE_RECEIPT reaches the supplier, who sees the match', async () => {
  const c = await start();
  try {
    await c.deliver('96');
    c.next(read('96', 5000, true));
    await c.photograph();
    const [r] = c.receipts();
    assert.ok(r, 'the supplier ledger has the receipt');
    assert.equal(r.direction, 'in');
    const delivery = c.s.supCore.ledger.events(c.orderId).find((e) => e.type === 'DELIVERY');
    assert.deepEqual(r.body.body, { delivery: delivery?.msgId, challan: { sha256: SHA, number: '96' }, items: [CEMENT], signed: true });
    assert.equal(r.body.from, 'agent:contractor-1');
    assert.equal(c.s.siteCore.ledger.events(c.orderId).filter((e) => e.type === 'SITE_RECEIPT' && e.direction === 'out').length, 1);
    const [told] = c.toSupplier();
    assert.equal(told[1], 'supplier.site_receipt_matches');
    assert.equal(told[2], 'P-1: साइट ने चालान 96 पर सीमेंट 50 बोरी प्राप्त लिखी, मिलान ठीक। साइट की प्रति पर दस्तख़त दिख रहे हैं।');
    // The order's state does not move.
    assert.equal(c.s.supCore.ledger.view(c.orderId).state, 'delivered');
  } finally {
    await c.s.close();
  }
});

test('the site wrote fewer bags: the supplier sees both figures, no verdict; an unsigned copy is said so', async () => {
  const c = await start();
  try {
    await c.deliver('96');
    c.next(read('096', 4800, false));
    await c.photograph();
    const [told] = c.toSupplier();
    assert.equal(told[1], 'supplier.site_receipt_differs', 'leading zeros name the same challan');
    assert.equal(told[2], 'P-1: साइट ने चालान 96 पर सीमेंट 48 बोरी प्राप्त लिखी (आपके चालान पर सीमेंट 50 बोरी)। साइट की प्रति पर दस्तख़त नहीं दिखे।');
    assert.equal(c.receipts()[0].body.body.signed, false);
  } finally {
    await c.s.close();
  }
});

test('a different challan number is shown with both numbers, never accepted silently', async () => {
  const c = await start();
  try {
    await c.deliver('96');
    c.next(read('97', 5000, true));
    await c.photograph();
    const [told] = c.toSupplier();
    assert.equal(told[1], 'supplier.site_receipt_number_differs');
    assert.ok(told[2].includes('97') && told[2].includes('96') && !told[2].includes('मिलान ठीक'), told[2]);
  } finally {
    await c.s.close();
  }
});

test('counted before the DELIVERY: nothing goes until the DELIVERY arrives, then the receipt goes; unsure mark is null', async () => {
  const c = await start();
  try {
    c.next(read('96', 5000, null));
    await c.photograph();
    assert.equal(c.receipts().length, 0, 'no delivery to refer to yet');
    assert.equal(c.s.siteCore.ledger.events(c.orderId).filter((e) => e.type === 'SITE_RECEIPT').length, 0);
    await c.deliver('96');
    await c.until(() => c.toSupplier().length > 0);
    assert.equal(c.receipts().length, 1);
    assert.equal(c.receipts()[0].body.body.signed, null);
    const [told] = c.toSupplier();
    assert.equal(told[1], 'supplier.site_receipt_matches');
    assert.ok(told[2].endsWith('दस्तख़त साफ़ नहीं दिखे।'), told[2]);
  } finally {
    await c.s.close();
  }
});

test('a reader that does not report the mark sends signed null; a typed count without a photo sends nothing', async () => {
  const c = await start();
  try {
    await c.deliver('96');
    await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: [5000] } });
    await c.settle();
    assert.equal(c.receipts().length, 0, 'a typed count is not the signed copy');
    c.next(read('96', 5000, undefined));
    await c.talk.onImage(supervisor, photo);
    // The order is already counted: the photo is not for an open order any more.
    assert.equal(c.said.at(-1)?.[1], 'site.challan_no_order');
    await runTool(c.s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId: c.orderId, qtysHundredths: [5000], challan: { sha256: SHA, number: '96' } } });
    await c.settle();
    assert.equal(c.receipts().length, 1);
    assert.equal(c.receipts()[0].body.body.signed, null);
  } finally {
    await c.s.close();
  }
});

test('the supplier\'s status and ask-anything facts include the receipt', async () => {
  const c = await start();
  try {
    await c.deliver('96');
    c.next(read('96', 4800, true));
    await c.photograph();
    const office = createOffice({ ledger: c.s.supCore.ledger, tools: c.s.sup.tools, kind: 'supplier', tell: () => {}, reply: () => {}, now: c.s.supCore.now });
    const st = /** @type {any} */ (await office.command(supplier, { cmd: 'status', ref: 'P-1' }));
    assert.equal(st.key, 'office.status_with_receipt');
    const text = t(st.key, st.params);
    assert.ok(text.includes('साइट की प्रति: चालान 96 पर सीमेंट 48 बोरी प्राप्त लिखी, दस्तख़त हैं'), text);

    // The contractor's own status stays as it was.
    const siteOffice = createOffice({ ledger: c.s.siteCore.ledger, tools: c.s.site.tools, kind: 'contractor', tell: () => {}, reply: () => {}, now: c.s.siteCore.now });
    assert.equal(/** @type {any} */ (await siteOffice.command(supervisor, { cmd: 'status', ref: 'P-1' })).key, 'office.status');

    const facts = orderFacts(c.s.supCore.ledger);
    assert.deepEqual(facts[0].siteReceipt, { items: [{ name: 'सीमेंट', qtyHundredths: 4800, unit: 'बोरी' }], number: '96', signed: true });
    const r = runLookup('order_detail', { ref: 'P-1' }, { ledger: c.s.supCore.ledger, side: 'seller', nowMs: c.s.supCore.now(), facts });
    assert.deepEqual(r.data.site_signed_copy, { received: 'सीमेंट 48 बोरी', challan_no: '96', signed: 'दस्तख़त हैं' });
    assert.ok(r.allowed.some((a) => a.value === '96' && a.kind === 'identifier'));
  } finally {
    await c.s.close();
  }
});

test('SITE_RECEIPT: its body is checked, and it fits only after a delivery, never moving the state', () => {
  const body = { delivery: '00000000-0000-4000-8000-000000000001', challan: { sha256: SHA, number: '96' }, items: [CEMENT], signed: true };
  assert.equal(bodyIsValid('SITE_RECEIPT', body), true);
  assert.equal(bodyIsValid('SITE_RECEIPT', { ...body, signed: null, challan: { sha256: SHA, number: null } }), true);
  assert.equal(bodyIsValid('SITE_RECEIPT', { ...body, signed: 'yes' }), false);
  assert.equal(bodyIsValid('SITE_RECEIPT', { ...body, signed: undefined }), false);
  assert.equal(bodyIsValid('SITE_RECEIPT', { ...body, delivery: 'x' }), false);
  assert.equal(bodyIsValid('SITE_RECEIPT', { ...body, items: [] }), false);
  const e = { type: 'SITE_RECEIPT', msg_id: null, body };
  const booked = { ...emptyView(), state: /** @type {const} */ ('booked'), kind: /** @type {const} */ ('material') };
  assert.equal(step(booked, e), null);
  for (const state of /** @type {const} */ (['delivered', 'billed', 'accepted', 'settled'])) {
    const v = { ...booked, state };
    assert.deepEqual(step(v, e), v, state);
  }
  assert.equal(step({ ...booked, state: 'delivered', kind: 'jcb_hours' }, e), null);
});
