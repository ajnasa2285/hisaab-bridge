// The supplier's challan photo by conversation: the reader (a stand-in here) reads it, code matches
// what it read to the order's items, the supplier confirms with "हाँ" or types the quantities, and
// only then is the DELIVERY signed and sent, with the photo's fingerprint. The site is then asked
// for its own count, and one "हाँ" means "the same as the challan".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012' };
const ITEMS = [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }, { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' }];
const photo = { mime: 'image/jpeg', bytes: new Uint8Array([7, 7, 7]) };
const SHA = createHash('sha256').update(photo.bytes).digest('hex');

/** Two conversations over the real agents, an order booked at ₹350/बोरी and ₹4,000/ट्रॉली. */
async function start() {
  /** @type {any} */
  let nextRead = null;
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any} */
  let siteTalk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params)]);
      if (expect && side === 'site' && role === 'supervisor') siteTalk.expect(supervisor, expect.tool, expect.args);
    },
  });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  const supTalk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, readChallan: async () => nextRead, classifyPhoto: seesPhoto('challan'), reply, now: s.supCore.now });
  siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now });
  await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-29', items: ITEMS } });
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000, 400000] } });
  return {
    s, supTalk, siteTalk, said, orderId,
    read: (/** @type {any} */ r) => { nextRead = r; },
    last: () => said.at(-1),
  };
}

test('a clear challan is read back; the supplier corrects a figure, says "हाँ"; the site\'s "हाँ" matches it', async () => {
  const c = await start();
  try {
    // The challan names the items its own way and lists them in the order's order: matched by position.
    c.read({ ok: true, kind: 'challan', challanNo: ' 412 ', date: '2026-10-29', vehicle: null, clear: true, items: [
      { name: 'OPC 53 Cement', qtyHundredths: 5000, unit: 'bags', raw: 'OPC 53 Cement 50 bags' },
      { name: 'Sand', qtyHundredths: 200, unit: 'trolley', raw: 'Sand 2 trolley' },
    ] });
    await c.supTalk.onImage(supplier, photo);
    assert.equal(c.last()?.[1], 'step.record_delivery');
    assert.ok(c.last()?.[2].includes('सीमेंट 50 बोरी, रेत 2 ट्रॉली') && c.last()?.[2].includes('412'));
    assert.equal(c.s.siteCore.ledger.view(c.orderId).state, 'booked', 'nothing sent before "हाँ"');

    // The supplier sees one bag less on the challan and types the quantities in order.
    await c.supTalk.onText(supplier, '49, 2');
    assert.equal(c.last()?.[1], 'step.record_delivery');
    assert.ok(c.last()?.[2].includes('सीमेंट 49 बोरी'));
    await c.supTalk.onText(supplier, 'हाँ');
    assert.equal(c.last()?.[1], 'supplier.delivery_sent');
    const d = c.s.siteCore.ledger.events(c.orderId).find((e) => e.type === 'DELIVERY')?.body.body;
    assert.deepEqual(d?.items, [{ name: 'सीमेंट', qtyHundredths: 4900, unit: 'बोरी' }, { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' }]);
    assert.deepEqual(d?.challan, { sha256: SHA, number: '412' });

    // The supervisor is asked for the site's count; a plain "हाँ" records the challan's figures.
    await new Promise((r) => setImmediate(r));
    assert.ok(c.said.some(([w, k, text]) => w === 'site:supervisor' && k === 'site.delivery_received' && text.includes('सीमेंट 49 बोरी')));
    await c.siteTalk.onText(supervisor, 'हाँ');
    assert.equal(c.last()?.[1], 'site.count_matches');
    const note = c.s.siteCore.ledger.events(c.orderId).find((e) => e.type === 'NOTE');
    assert.deepEqual([note?.direction, note?.body.kind, note?.body.items[0].qtyHundredths], ['local', 'site_count', 4900]);

    // A second photo: no order is waiting for its delivery any more.
    await c.supTalk.onImage(supplier, photo);
    assert.equal(c.last()?.[1], 'challan.no_order_for_photo');
  } finally {
    await c.s.close();
  }
});

test('an unclear challan: the supplier types the quantities; the site counts differently and says so', async () => {
  const c = await start();
  try {
    c.read({ ok: true, kind: 'not_challan' });
    await c.supTalk.onImage(supplier, photo);
    assert.equal(c.last()?.[1], 'challan.not_challan');
    await c.supTalk.onImage(supplier, { mime: 'application/pdf', bytes: new Uint8Array([1]) });
    assert.equal(c.last()?.[1], 'photo.other');

    c.read({ ok: true, kind: 'challan', challanNo: null, date: null, vehicle: null, clear: false, items: [
      { name: 'सीमेंट', qtyHundredths: null, unit: 'बोरी', raw: 'सीमेंट 5? बोरी' },
    ] });
    await c.supTalk.onImage(supplier, photo);
    assert.equal(c.last()?.[1], 'challan.ask_person');
    assert.ok(c.last()?.[2].includes('सीमेंट (बोरी), रेत (ट्रॉली)') && c.last()?.[2].includes('सीमेंट 5? बोरी'));

    // One figure for two items is asked again; "0" means that item did not come.
    await c.supTalk.onText(supplier, '50');
    assert.equal(c.last()?.[1], 'challan.ask_person');
    await c.supTalk.onText(supplier, '50 0');
    assert.equal(c.last()?.[1], 'step.record_delivery');
    assert.ok(c.last()?.[2].includes('सीमेंट 50 बोरी') && !c.last()?.[2].includes('रेत'));
    await c.supTalk.onText(supplier, 'haan');
    assert.equal(c.last()?.[1], 'supplier.delivery_sent');
    assert.equal(c.s.siteCore.ledger.view(c.orderId).state, 'delivered');

    // The supervisor answers the count question with a different figure: read back, then saved, and
    // the contractor is told both figures.
    await new Promise((r) => setImmediate(r));
    await c.siteTalk.onText(supervisor, '48');
    assert.equal(c.last()?.[1], 'step.confirm_count');
    assert.ok(c.last()?.[2].includes('सीमेंट 48 बोरी'));
    await c.siteTalk.onText(supervisor, 'हाँ');
    assert.ok(c.said.some(([w, k, text]) => w === 'site:contractor' && k === 'site.count_differs' && text.includes('सीमेंट 50 बोरी') && text.includes('सीमेंट 48 बोरी')));
    assert.equal(c.last()?.[1], 'site.count_saved_differs');
  } finally {
    await c.s.close();
  }
});
