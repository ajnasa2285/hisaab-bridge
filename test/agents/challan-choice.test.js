// A supplier's challan photo with two booked orders: the photo is held as the one open question, the
// orders are listed by number, reference, site and day, a number or a reference answers it, and the
// normal challan flow goes on. A reference in the caption answers it before it is asked. The reader is a
// stand-in; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const contractor = person('contractor', 'agent:contractor-1');
const settle = () => new Promise((r) => setTimeout(r, 30));
/** @param {number} n */
const photo = (n) => ({ mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, n, n]) });
/** One clear line: the reader sees 50 of the order's one item. @param {boolean} [clear] */
const reading = (clear = true) => ({ ok: true, kind: 'challan', challanNo: '412', date: null, vehicle: null, clear,
  items: [{ name: 'माल', qtyHundredths: clear ? 5000 : null, unit: 'बोरी', raw: 'माल 50' }] });

/**
 * `orders` material orders booked, one item each, and the supplier's conversation.
 * @param {import('node:test').TestContext} tc @param {number} [orders]
 */
async function desk(tc, orders = 2) {
  const s = await setup();
  tc.after(() => s.close());
  for (let i = 1; i <= orders; i += 1) {
    const items = [{ name: i === 1 ? 'सीमेंट' : 'गिट्टी', qtyHundredths: 5000, unit: 'बोरी' }];
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: `Invented Site ${i}`, day: `2026-11-0${i}`, items } })).ok, true);
    await settle();
    s.advance(1000);
  }
  const ids = s.supCore.ledger.orders().map((/** @type {any} */ x) => String(x.order_id));
  for (const orderId of ids) assert.equal((await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } })).ok, true);
  await settle();
  /** @type {[string, string][]} */ const said = [];
  /** @type {any[]} */ const reads = [];
  const f = {
    s, ids, said, reads,
    /** @type {any} */ next: reading(),
    models: 0,
    last: () => said.at(-1)?.[0],
    lastText: () => said.at(-1)?.[1] ?? '',
    deliveries: (/** @type {string} */ id) => s.supCore.ledger.events(id).filter((e) => e.type === 'DELIVERY'),
    /** @type {any} */ talk: null,
  };
  f.talk = createConversation({
    ledger: s.supCore.ledger, tools: s.sup.tools, now: s.supCore.now, classifyPhoto: seesPhoto('challan'),
    spark: async () => { f.models += 1; return { ok: true, toolCalls: [{ name: 'help', args: {} }] }; },
    readChallan: async (image) => { reads.push(image); return f.next; },
    reply: (_p, key, params) => { said.push([key, t(key, params)]); },
  });
  return f;
}

test('two booked orders: the photo is held, unread, and the orders are listed by number, reference, site and day', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(supplier, photo(1));
  assert.equal(f.last(), 'challan.which_order');
  for (const part of ['1. P-1', 'Invented Site 1', '1 नवंबर 2026', 'सीमेंट 50 बोरी', '2. P-2', 'Invented Site 2', '2 नवंबर 2026', 'गिट्टी 50 बोरी']) assert.ok(f.lastText().includes(part), `${part} in: ${f.lastText()}`);
  assert.equal(f.reads.length, 0, 'read only once the order is known');
  assert.equal(f.talk.pending(supplier)?.kind, 'challan_job');
  for (const id of f.ids) assert.equal(f.deliveries(id).length, 0);
});

test('a number answers it: that order gets the delivery, with the held photo\'s fingerprint', async (tc) => {
  const f = await desk(tc);
  const image = photo(7);
  await f.talk.onImage(supplier, image);
  await f.talk.onText(supplier, '2');
  assert.equal(f.last(), 'supplier.delivery_sent');
  assert.equal(f.deliveries(f.ids[0]).length, 0);
  const d = f.deliveries(f.ids[1]);
  assert.equal(d.length, 1);
  assert.equal(d[0].body.body.challan.sha256, createHash('sha256').update(image.bytes).digest('hex'));
  assert.deepEqual(d[0].body.body.items.map((/** @type {any} */ i) => i.name), ['गिट्टी']);
  assert.equal(f.talk.pending(supplier), null);
  assert.equal(f.models, 0, 'the model never saw the answer');
});

for (const [answer, index] of /** @type {[string, number][]} */ ([['P-1', 0], ['p2', 1], ['पी 2', 1], ['१', 0]])) {
  test(`"${answer}" answers it`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(supplier, photo(1));
    await f.talk.onText(supplier, answer);
    assert.equal(f.last(), 'supplier.delivery_sent');
    assert.equal(f.deliveries(f.ids[index]).length, 1);
    assert.equal(f.deliveries(f.ids[1 - index]).length, 0);
  });
}

for (const answer of ['3', 'P-9', 'हाँ']) {
  test(`"${answer}" does not say which order: asked again, the photo still held`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(supplier, photo(1));
    await f.talk.onText(supplier, answer);
    assert.equal(f.last(), 'challan.which_order');
    assert.equal(f.talk.pending(supplier)?.kind, 'challan_job');
    await f.talk.onText(supplier, '1');
    assert.equal(f.deliveries(f.ids[0]).length, 1);
  });
}

for (const word of ['नहीं', 'रद्द']) {
  test(`"${word}" drops the photo; nothing is recorded`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(supplier, photo(1));
    await f.talk.onText(supplier, word);
    assert.equal(f.last(), 'step.cancelled');
    assert.equal(f.talk.pending(supplier), null);
    assert.equal(f.reads.length, 0);
    for (const id of f.ids) assert.equal(f.deliveries(id).length, 0);
  });
}

test('any other message lapses the question, drops the photo, and is read as a new message', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(supplier, photo(1));
  await f.talk.onText(supplier, 'गाड़ी कब निकली');
  assert.equal(f.models, 1);
  assert.equal(f.talk.pending(supplier), null);
  for (const id of f.ids) assert.equal(f.deliveries(id).length, 0);
});

test('after the choice the normal flow goes on: an unclear reading asks for the figures, for that order', async (tc) => {
  const f = await desk(tc);
  f.next = reading(false);
  await f.talk.onImage(supplier, photo(1));
  await f.talk.onText(supplier, 'P-2');
  assert.equal(f.last(), 'challan.ask_person');
  assert.equal(f.talk.pending(supplier)?.kind, 'challan_figures');
  await f.talk.onText(supplier, '48');
  assert.equal(f.last(), 'supplier.delivery_sent');
  assert.equal(f.deliveries(f.ids[1])[0].body.body.items[0].qtyHundredths, 4800);
  assert.equal(f.deliveries(f.ids[0]).length, 0);
});

test('a reference in the caption answers it before it is asked', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(supplier, { ...photo(1), caption: 'P-2 का चालान' });
  assert.equal(f.last(), 'supplier.delivery_sent');
  assert.equal(f.deliveries(f.ids[1]).length, 1);
  assert.equal(f.deliveries(f.ids[0]).length, 0);
});

test('a caption with no reference, an order not open, or two references still asks', async (tc) => {
  const f = await desk(tc);
  for (const caption of ['आज का चालान', 'P-9', 'P-1 P-2']) {
    await f.talk.onImage(supplier, { ...photo(1), caption });
    assert.equal(f.last(), 'challan.which_order', caption);
  }
  assert.equal(f.reads.length, 0);
});

test('one booked order: no question, and a caption naming another order is asked about, never put on this one', async (tc) => {
  const f = await desk(tc, 1);
  await f.talk.onImage(supplier, { ...photo(1), caption: 'P-5' });
  assert.equal(f.last(), 'challan.which_order');
  assert.equal(f.deliveries(f.ids[0]).length, 0);
  await f.talk.onImage(supplier, photo(1));
  assert.equal(f.last(), 'supplier.delivery_sent');
});

test('the order moved on while the question was open: nothing is put on another one', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(supplier, photo(1));
  assert.equal((await runTool(f.s.site.tools, contractor, { tool: 'cancel_order', args: { orderId: f.ids[0] } })).ok, true);
  await settle();
  await f.talk.onText(supplier, '1');
  assert.equal(f.last(), 'common.wrong_state');
  assert.equal(f.deliveries(f.ids[1]).length, 0);
});

test('a notice that asks something waits behind the question, and is asked after it', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(supplier, photo(1));
  f.talk.expect(supplier, 'send_bill', { orderId: f.ids[1] });
  assert.equal(f.talk.pending(supplier)?.kind, 'challan_job', 'the open question stays');
  await f.talk.onText(supplier, '2');
  assert.equal(f.said.at(-2)?.[0], 'supplier.delivery_sent');
  assert.equal(f.last(), 'step.send_material_bill');
});
