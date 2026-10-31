// The same-photo and printed-arithmetic warnings through the assembled app: photos and words arrive at
// the webhook, three agents talk over HTTP, the challan reader and the Graph API are stand-ins. Nothing
// new is asked: no open question appears for the warning, and the existing one-word offers still work.
// Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from '../src/app.js';
import { runTool } from '../src/agents/common.js';
import { t } from '../src/i18n/index.js';

const CONTRACTOR = '919000000091';
const SUPERVISOR = '919000000092';
const SUPPLIER = '919000000093';
const SITE_ID = 'agent:contractor-1';
const SUPPLIER_ID = 'agent:supplier-1';
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const MEDIA = { 'media-a': new Uint8Array([7, 1, 1]), 'media-b': new Uint8Array([7, 2, 2]) };

/** @typedef {import('../src/wa/directory.js').Person} Person */
const contractor = /** @type {Person} */ ({ line: 'line-site', phone: CONTRACTOR, agent: SITE_ID, role: 'contractor', name: 'contractor' });
const supervisor = /** @type {Person} */ ({ line: 'line-site', phone: SUPERVISOR, agent: SITE_ID, role: 'supervisor', name: 'supervisor' });
const supplier = /** @type {Person} */ ({ line: 'line-site', phone: SUPPLIER, agent: SUPPLIER_ID, role: 'supplier', name: 'supplier' });

/** The whole app with an order of 50 bags booked at ₹380 and everyone having written. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-photo-math-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** A tax invoice as the reader saw it: 50 bags at ₹380, taxable as given. */
  const reading = { clear: true, taxablePaise: 1900000 };
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    const url = String(input);
    for (const [id, bytes] of Object.entries(MEDIA)) {
      if (url.endsWith(`/${id}`)) return Response.json({ url: `https://lookaside.example/${id}.bin`, mime_type: 'image/jpeg', file_size: bytes.length });
      if (url.endsWith(`/${id}.bin`)) return new Response(bytes);
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ to: body.to, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** @type {any} */
  let app = null;
  const server = createServer(async (req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const [ck, sk] = [generateKeys(), generateKeys()];
  const peer = (/** @type {string} */ id, /** @type {any} */ key, /** @type {any[]} */ types) => ({ id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) });
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'CANCEL', 'RECEIPT', 'REFUSE', 'SITE_RECEIPT'];
  const toSite = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'CANCEL', 'RECEIPT', 'REFUSE', 'DELIVERY'];
  app = createApp({
    baseUrl: base,
    agents: [
      { name: 'supplier', kind: 'supplier', id: SUPPLIER_ID, title: 'Supplier', privateKey: sk.privateKey, ledgerFile: join(dir, 'supplier.db'),
        peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: SITE_ID, title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer(SUPPLIER_ID, sk.publicKey, toSite)], peerUrls: { [SUPPLIER_ID]: `${base}/agents/supplier` }, jcbAgentId: 'agent:jcb-1', supplierAgentId: SUPPLIER_ID },
    ],
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v', accessToken: 'tok' }],
    people: [contractor, supervisor, supplier],
    waStoreFile: join(dir, 'wa.db'),
    spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
    readChallan: async () => ({ ok: true, kind: 'challan', challanNo: '412', date: null, vehicle: null, clear: reading.clear, signed: null,
      items: [{ name: 'Cement', qtyHundredths: reading.clear ? 5000 : null, unit: 'bags', raw: 'Cement', ratePaise: 38000, taxablePaise: reading.taxablePaise, gstPercent: null }] }),
    classifyPhoto: async () => ({ ok: true, kind: 'challan', clear: true, model: 'stand-in', latencyMs: 1 }),
    fetch,
    log: () => {},
  });
  tc.after(async () => {
    tc.mock.timers.reset();
    await new Promise((r) => server.close(() => r(undefined)));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const siteEntry = app.agent(SITE_ID);
  const supEntry = app.agent(SUPPLIER_ID);
  const written = () => [siteEntry, supEntry].reduce((sum, e) => sum + e.core.ledger.orders().reduce((/** @type {number} */ c, /** @type {any} */ x) => c + e.core.ledger.events(x.order_id).length, 0), 0);
  /** What the other agent's message set off has finished. */
  const quiet = async () => {
    let seen = -1;
    let still = 0;
    for (let i = 0; i < 300 && still < 2; i += 1) {
      const now = sent.length + written();
      still = now === seen ? still + 1 : 0;
      seen = now;
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  let n = 0;
  /** @param {string} phone @param {any} message */
  const post = async (phone, message) => {
    n += 1;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
      messages: [{ from: phone, id: `wamid.in${n}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] });
    const r = await globalThis.fetch(`${base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret-site').update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
    await quiet();
  };
  const say = (/** @type {string} */ phone, /** @type {string} */ text) => post(phone, { type: 'text', text: { body: text } });
  const photo = (/** @type {string} */ phone, /** @type {keyof typeof MEDIA} */ id) => post(phone, { type: 'image', image: { id, mime_type: 'image/jpeg' } });

  for (const phone of [CONTRACTOR, SUPERVISOR, SUPPLIER]) await say(phone, 'मदद');
  await runTool(siteEntry.agent.tools, contractor, { tool: 'request_material', args: { site: 'Rampur', day: '2026-10-30', items: [CEMENT] } });
  await quiet();
  const orderId = String(siteEntry.core.ledger.orders()[0].order_id);
  await runTool(supEntry.agent.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [38000] } });
  await quiet();
  return { sent, reading, say, photo, quiet, siteEntry, supEntry, orderId,
    last: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).at(-1)?.text ?? '',
    all: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).map((s) => s.text),
    /** What each person's next word would answer: nothing here may change it. */
    open: () => [contractor, supervisor, supplier].map((p) => (p.agent === SITE_ID ? siteEntry : supEntry).talk.pending(p)?.tool ?? null),
    /** @param {any} entry @param {string} name */
    check: (entry, name) => entry.trace.list({ orderId }).filter((/** @type {any} */ e) => e.detail?.name === name) };
}

const SAME = 'साइट और सप्लायर ने एक ही फ़ोटो भेजी है, इसलिए यह दूसरी जाँच नहीं है।';
const WRONG_LINE = 'सीमेंट 50 बोरी × ₹380 = ₹19,000, पर इनवॉइस पर ₹18,000';

test('app: the supplier and then the site send the same photo: both told it is no second check, no question opened, and the one-word yes on the bill still accepts', async (tc) => {
  const d = await desk(tc);
  await d.photo(SUPPLIER, 'media-a');
  assert.ok(d.last(SUPPLIER).includes('सीमेंट 50 बोरी') && !d.last(SUPPLIER).includes('इनवॉइस'), 'agreeing figures: the receipt as ever');
  assert.deepEqual(d.check(d.supEntry, 'invoice_line_math').map((/** @type {any} */ e) => e.detail.pass), [true]);
  assert.deepEqual(d.open(), [null, 'confirm_count', null], 'the supervisor is asked to count, as ever');

  const toContractor = d.all(CONTRACTOR).length;
  await d.photo(SUPERVISOR, 'media-a');
  const sender = d.last(SUPERVISOR);
  assert.ok(sender.includes('सप्लायर ने भी यही फ़ोटो भेजी है') && sender.includes('सीमेंट 50 बोरी'), sender);
  assert.equal(d.all(CONTRACTOR).length, toContractor + 1, 'one notice, not an extra message');
  assert.ok(d.last(CONTRACTOR).includes(SAME) && d.last(CONTRACTOR).includes('सुपरवाइज़र ने Rampur की गिनती चालान की फ़ोटो से दर्ज की'), d.last(CONTRACTOR));
  assert.deepEqual(d.open(), [null, null, null], 'the count closes the question; nothing new is open');

  const check = d.check(d.siteEntry, 'site_photo_independent');
  assert.deepEqual(check.map((/** @type {any} */ e) => e.detail.pass), [false]);
  const sha = createHash('sha256').update(MEDIA['media-a']).digest('hex');
  assert.deepEqual([check[0].detail.site.sha256, check[0].detail.delivery.sha256], [sha, sha]);
  assert.equal(d.check(d.siteEntry, 'count_vs_delivery').at(-1).detail.pass, true, 'the count is still compared and recorded');

  await d.say(SUPPLIER, 'बिल');
  const bill = d.last(CONTRACTOR);
  assert.ok(bill.includes('₹19,000') && bill.includes('"हाँ"'), bill);
  assert.ok(!bill.includes('जाँच') && !bill.includes('गिनती'), 'the bill notice claims no second check');
  assert.deepEqual(d.open(), ['accept_bill', null, null], 'the one word is armed');
  await d.say(CONTRACTOR, 'हाँ');
  assert.equal(d.siteEntry.core.ledger.view(d.orderId).state, 'accepted');
});

test('app: the site\'s photo first, then the same photo with a printed line that does not add up: one notice carries both, the bill is untouched', async (tc) => {
  const d = await desk(tc);
  d.reading.taxablePaise = 1800000;
  await d.photo(SUPERVISOR, 'media-a');
  assert.ok(!d.last(SUPERVISOR).includes(SAME), 'nothing to compare yet');
  const before = [d.all(CONTRACTOR).length, d.all(SUPERVISOR).length];
  assert.deepEqual(d.open(), [null, null, null]);

  await d.photo(SUPPLIER, 'media-a');
  // The site's signed copy comes back to the supplier right after, so the receipt may not be the last word.
  const receipt = d.all(SUPPLIER).find((text) => text.includes('डिलीवरी दर्ज')) ?? '';
  assert.ok(receipt.includes(WRONG_LINE) && receipt.includes('"बिल" लिखें'), receipt);
  assert.deepEqual([d.all(CONTRACTOR).length, d.all(SUPERVISOR).length], [before[0] + 1, before[1] + 1], 'one notice each');
  const notice = d.last(CONTRACTOR);
  assert.ok(notice.includes(SAME) && notice.includes(WRONG_LINE), notice);
  assert.ok(d.last(SUPERVISOR).includes(SAME) && !d.last(SUPERVISOR).includes('इनवॉइस'), d.last(SUPERVISOR));
  assert.deepEqual(d.open(), [null, null, null], 'nothing is asked');
  assert.deepEqual(d.check(d.supEntry, 'invoice_line_math').map((/** @type {any} */ e) => e.detail.pass), [false]);
  const math = d.check(d.siteEntry, 'invoice_line_math');
  assert.deepEqual(math.map((/** @type {any} */ e) => [e.detail.pass, e.detail.differs[0].computedPaise, e.detail.differs[0].printedPaise]), [[false, 1900000, 1800000]]);

  await d.say(SUPPLIER, 'बिल');
  const sent = d.supEntry.core.ledger.events(d.orderId).find((/** @type {any} */ e) => e.type === 'BILL')?.body.body;
  assert.equal(sent.totalPaise, 1900000, 'the bill stays quantity × agreed rate');
  assert.deepEqual(d.open(), ['accept_bill', null, null]);
});

test('app: different photos say nothing new, and the supervisor\'s one word to the delivery notice stands', async (tc) => {
  const d = await desk(tc);
  await d.photo(SUPPLIER, 'media-a');
  await d.photo(SUPERVISOR, 'media-b');
  assert.ok(d.last(SUPERVISOR).includes('मेल खाता है') && !d.last(SUPERVISOR).includes('यही फ़ोटो'), d.last(SUPERVISOR));
  assert.equal(d.last(CONTRACTOR), t('site.count_told_photo', { ref: 'P-1', site: 'Rampur', items: 'सीमेंट 50 बोरी' }));
  assert.deepEqual(d.check(d.siteEntry, 'site_photo_independent').map((/** @type {any} */ e) => e.detail.pass), [true]);
});

test('app: the supplier types the quantity for an unclear photo: the same warning, in what the typed figure comes to; the supervisor\'s "हाँ" still counts', async (tc) => {
  const d = await desk(tc);
  d.reading.clear = false;
  await d.photo(SUPPLIER, 'media-a');
  await d.say(SUPPLIER, '40');
  const line = 'सीमेंट 40 बोरी × ₹380 = ₹15,200, पर इनवॉइस पर ₹19,000';
  assert.ok(d.last(SUPPLIER).includes(line), d.last(SUPPLIER));
  assert.ok(d.last(CONTRACTOR).includes(line) && d.last(CONTRACTOR).includes('चालान 412'), d.last(CONTRACTOR));
  assert.ok(!d.last(SUPERVISOR).includes('इनवॉइस'), d.last(SUPERVISOR));
  assert.deepEqual(d.open(), [null, 'confirm_count', null], 'nothing new is asked; the count question is the old one');
  await d.say(SUPERVISOR, 'हाँ');
  const count = d.siteEntry.core.ledger.events(d.orderId).filter((/** @type {any} */ e) => e.type === 'NOTE' && e.body.kind === 'site_count').at(-1);
  assert.equal(count.body.items[0].qtyHundredths, 4000);
  assert.deepEqual(d.open(), [null, null, null]);
});
