// An owner's records as an Excel file, through the assembled app: three agents over HTTP, a stand-in
// Graph API and model. What was uploaded is read back as a workbook and compared with what the app's
// own helpers say. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from '../src/app.js';
import { runTool, ofType } from '../src/agents/common.js';
import { parseCommand } from '../src/agents/office.js';
import { orderFacts } from '../src/agents/ask.js';
import { paymentEvents } from '../src/agents/payment-view.js';
import { openLedger } from '../src/ledger/store.js';
import { paymentSummary } from '../src/ledger/payments.js';
import { recordsWorkbook, sendRecords } from '../src/export/records.js';
import { XLSX_MIME } from '../src/export/xlsx.js';
import { t } from '../src/i18n/index.js';
import { readWorkbook, rowsOf } from './export/read-xlsx.js';
import { SHA_A, SHA_B } from './agents/helpers.js';
import { sentText } from './wa/sent-text.js';

const CONTRACTOR = '919000000091';
const SUPERVISOR = '919000000092';
const SUPPLIER = '919000000093';
const OWNER = '919000000094';
const OPERATOR = '919000000095';
const PHONES = [CONTRACTOR, SUPERVISOR, SUPPLIER, OWNER, OPERATOR];
const SITE_ID = 'agent:contractor-1';
const SHA = 'f'.repeat(64);
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** @typedef {import('../src/wa/directory.js').Person} Person */
const who = (/** @type {string} */ phone, /** @type {string} */ agent, /** @type {any} */ role) => /** @type {Person} */ ({ line: 'line-site', phone, agent, role, name: role });
const contractor = who(CONTRACTOR, SITE_ID, 'contractor');
const supervisor = who(SUPERVISOR, SITE_ID, 'supervisor');
const supplier = who(SUPPLIER, 'agent:supplier-1', 'supplier');
const owner = who(OWNER, 'agent:jcb-1', 'jcb_owner');
const operator = who(OPERATOR, 'agent:jcb-1', 'operator');

/** The whole app, with what it sends to the Graph API kept. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-excel-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {{mime: string, type: string, fileName: string, bytes: Buffer}[]} */
  const uploads = [];
  /** @type {{to: string, document: {id: string, filename: string, caption: string}}[]} */
  const documents = [];
  /** @type {string[]} */
  const logs = [];
  const state = { sparks: 0, failMedia: false, failDocument: false, nowMs: Date.parse('2026-10-29T02:30:00Z') };
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    if (String(input).endsWith('/media')) {
      if (state.failMedia) return new Response('{}', { status: 500 });
      const form = /** @type {FormData} */ (init?.body);
      const file = /** @type {File} */ (form.get('file'));
      uploads.push({ mime: file.type, type: String(form.get('type')), fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      return Response.json({ id: `media-${uploads.length}` });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.type === 'document') {
      if (state.failDocument) return new Response('{}', { status: 500 });
      documents.push({ to: body.to, document: body.document });
    } else sent.push({ to: body.to, text: sentText(body) });
    return Response.json({ messages: [{ id: `wamid.out${sent.length + documents.length}` }] });
  };
  /** @type {any} */
  let app = null;
  const server = createServer(async (req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const [jk, ck, sk] = [generateKeys(), generateKeys(), generateKeys()];
  const peer = (/** @type {string} */ id, /** @type {any} */ key, /** @type {any[]} */ types) => ({ id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) });
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'CANCEL', 'RECEIPT', 'REFUSE', 'SITE_RECEIPT'];
  const toSite = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'CANCEL', 'RECEIPT', 'REFUSE', 'DELIVERY'];
  app = createApp({
    baseUrl: base,
    agents: [
      { name: 'jcb', kind: 'jcb', id: 'agent:jcb-1', title: 'JCB', privateKey: jk.privateKey, ledgerFile: join(dir, 'jcb.db'),
        peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
      { name: 'supplier', kind: 'supplier', id: 'agent:supplier-1', title: 'Supplier', privateKey: sk.privateKey, ledgerFile: join(dir, 'supplier.db'),
        peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: SITE_ID, title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer('agent:jcb-1', jk.publicKey, toSite), peer('agent:supplier-1', sk.publicKey, toSite)],
        peerUrls: { 'agent:jcb-1': `${base}/agents/jcb`, 'agent:supplier-1': `${base}/agents/supplier` }, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1' },
    ],
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v', accessToken: 'tok' }],
    people: [contractor, supervisor, supplier, owner, operator],
    waStoreFile: join(dir, 'wa.db'),
    spark: async () => { state.sparks += 1; return { ok: /** @type {const} */ (true), toolCalls: [] }; },
    fetch,
    now: () => state.nowMs,
    log: (/** @type {string} */ l) => { logs.push(l); },
  });
  tc.after(async () => {
    tc.mock.timers.reset();
    await new Promise((r) => server.close(() => r(undefined)));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const written = () => ['agent:jcb-1', 'agent:supplier-1', SITE_ID].map((id) => app.agent(id).core.ledger)
    .reduce((sum, l) => sum + l.orders().reduce((/** @type {number} */ c, /** @type {any} */ x) => c + l.events(x.order_id).length, 0), 0);
  /** What the other agent's message set off has finished. */
  const quiet = async () => {
    let seen = -1;
    let still = 0;
    for (let i = 0; i < 300 && still < 2; i += 1) {
      const now = logs.length + sent.length + written();
      still = now === seen ? still + 1 : 0;
      seen = now;
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  let n = 0;
  const siteEntry = app.agent(SITE_ID);
  const supEntry = app.agent('agent:supplier-1');
  const jcbEntry = app.agent('agent:jcb-1');
  /** @param {string} phone @param {string} text */
  const say = async (phone, text) => {
    n += 1;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
      messages: [{ from: phone, id: `wamid.in${n}`, timestamp: String(Math.floor(state.nowMs / 1000)), type: 'text', text: { body: text } }] } }] }] });
    const r = await globalThis.fetch(`${base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret-site').update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
    await quiet();
  };
  /** @param {any} entry @param {Person} person @param {string} tool @param {Record<string, any>} args */
  const run = async (entry, person, tool, args) => {
    const r = await runTool(entry.agent.tools, person, { tool, args });
    assert.equal(r.ok, true, `${tool}: ${r.key}`);
    await quiet();
    return r;
  };
  /** A material order of ₹19,000. @param {{day?: string, count?: number | null, accept?: boolean, bill?: boolean}} [o] */
  const material = async (o = {}) => {
    state.nowMs += 1000;
    const before = new Set(siteEntry.core.ledger.orders().map((/** @type {any} */ x) => x.order_id));
    await run(siteEntry, contractor, 'request_material', { site: 'शिवपुरी', day: o.day ?? '2026-10-30', items: [CEMENT] });
    const orderId = String(siteEntry.core.ledger.orders().find((/** @type {any} */ x) => !before.has(x.order_id)).order_id);
    await run(supEntry, supplier, 'reply_order', { orderId, answer: 'yes', ratesPaise: [38000] });
    await run(supEntry, supplier, 'record_delivery', { orderId, items: [CEMENT], sha256: SHA, challanNo: '412' });
    if (o.count !== null) await run(siteEntry, supervisor, 'confirm_count', { orderId, qtysHundredths: [o.count ?? 5000], ...(o.count === undefined ? { sameAsChallan: true } : {}) });
    if (o.bill !== false) await run(supEntry, supplier, 'send_bill', { orderId });
    if (o.accept !== false && o.bill !== false) await run(siteEntry, contractor, 'accept_bill', { orderId });
    return orderId;
  };
  /** A JCB job of ₹7,200, billed and accepted, with the site's own hours. */
  const jcbJob = async () => {
    state.nowMs += 1000;
    const before = new Set(siteEntry.core.ledger.orders().map((/** @type {any} */ x) => x.order_id));
    await run(siteEntry, contractor, 'request_jcb', { site: 'रामपुर', day: '2026-10-30', hoursTenths: 60 });
    const orderId = String(siteEntry.core.ledger.orders().find((/** @type {any} */ x) => !before.has(x.order_id)).order_id);
    await run(jcbEntry, owner, 'reply_booking', { orderId, answer: 'yes', ratePaise: 120000 });
    await run(jcbEntry, operator, 'record_meter', { orderId, which: 'start', valueTenths: 100, sha256: SHA_A });
    await run(siteEntry, supervisor, 'record_site_hours', { orderId, hoursTenths: 55 });
    await run(jcbEntry, operator, 'record_meter', { orderId, which: 'end', valueTenths: 160, sha256: SHA_B });
    await run(jcbEntry, owner, 'send_bill', { orderId });
    await run(siteEntry, contractor, 'accept_bill', { orderId });
    return orderId;
  };
  return { app, sent, uploads, documents, logs, state, say, run, material, jcbJob, quiet, siteEntry, supEntry, jcbEntry, base,
    to: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).map((s) => s.text),
    /** The last file sent, read back. */
    lastBook: () => readWorkbook(/** @type {{bytes: Buffer}} */ (uploads.at(-1)).bytes) };
}

/** The refs of a sheet's rows. @param {ReturnType<typeof readWorkbook>} book @param {string} sheet */
const refsIn = (book, sheet) => rowsOf(book, sheet).map((r) => r.A);

// --- The command ------------------------------------------------------------------------------

test('the command is read by code, with or without a month', () => {
  for (const text of ['एक्सेल', 'excel', 'EXCEL', 'Excel.', ' एक्सेल ', 'एक्सल', 'एक्सेल फ़ाइल', 'एक्सेल भेजो', 'excel file bhejo', 'एक्सेल फाइल चाहिए']) assert.deepEqual(parseCommand(text), { cmd: 'excel', month: null }, text);
  const october = { cmd: 'excel', month: { month: 10, year: null } };
  for (const text of ['एक्सेल अक्टूबर', 'excel october', 'Excel Oct', 'एक्सेल अक्तूबर', 'अक्टूबर का एक्सेल', 'excel 10', 'एक्सेल १०']) assert.deepEqual(parseCommand(text), october, text);
  const dated = { cmd: 'excel', month: { month: 10, year: 2026 } };
  for (const text of ['excel 10-2026', 'excel 10/2026', 'excel 10.2026', 'excel 2026-10', 'एक्सेल अक्टूबर 2026', 'excel october 2026', 'एक्सेल १०-२०२६']) assert.deepEqual(parseCommand(text), dated, text);
  assert.deepEqual(parseCommand('एक्सेल फ़रवरी'), { cmd: 'excel', month: { month: 2, year: null } });
  assert.deepEqual(parseCommand('एक्सेल सितम्बर'), { cmd: 'excel', month: { month: 9, year: null } });
  assert.deepEqual(parseCommand('excel may'), { cmd: 'excel', month: { month: 5, year: null } });
  for (const text of ['excel 13-2026', 'excel 0', 'एक्सेल 30-10', 'excel 2026']) assert.deepEqual(parseCommand(text), { cmd: 'excel', month: 'unclear' }, text);
  for (const text of ['excel में हिसाब कैसे देखूँ', 'सीमेंट excel', 'excel kya hota hai', 'सीमेंट 50 बोरी', 'excellent']) assert.equal(parseCommand(text), null, text);
  assert.deepEqual(parseCommand('रद्द J-2'), { cmd: 'cancel', ref: 'J-2' }, 'the other commands are as they were');
  assert.deepEqual(parseCommand('बाक़ी'), { cmd: 'pending' });
});

// --- Through the app --------------------------------------------------------------------------

test('the contractor gets the document with the right type and name, no model, the ledger untouched, and an open question stays open', async (tc) => {
  const d = await desk(tc);
  await d.say(CONTRACTOR, 'मदद'); // the window is open, so the bill's question is asked
  const orderId = await d.material({ accept: false });
  const ledger = d.siteEntry.core.ledger;
  const open = d.siteEntry.talk.pending(contractor);
  assert.ok(open, 'the bill is waiting for a yes');
  const head = ledger.chainHead();
  const sparks = d.state.sparks;

  await d.say(CONTRACTOR, 'एक्सेल');

  assert.equal(d.documents.length, 1);
  assert.deepEqual(d.documents[0], { to: CONTRACTOR, document: { id: 'media-1', filename: 'hisaab-site-all.xlsx', caption: t('excel.caption_all') } });
  assert.deepEqual([d.uploads[0].mime, d.uploads[0].type, d.uploads[0].fileName], [XLSX_MIME, XLSX_MIME, 'hisaab-site-all.xlsx']);
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.sent', { orders: 1 }));
  assert.equal(d.state.sparks, sparks, 'no model is called');
  assert.equal(ledger.chainHead(), head, 'nothing is written to the ledger');
  assert.deepEqual(d.siteEntry.talk.pending(contractor), open, 'the question is as it was');
  assert.equal(ledger.view(orderId).state, 'billed');

  await d.say(CONTRACTOR, 'हाँ');
  assert.equal(ledger.view(orderId).state, 'accepted', 'and a plain yes still answers it');
});

test('supervisor and operator are told who can get it, and no file goes', async (tc) => {
  const d = await desk(tc);
  await d.material();
  await d.say(SUPERVISOR, 'एक्सेल');
  assert.equal(d.to(SUPERVISOR).at(-1), t('excel.owner_only', { owner: t('records.who.contractor') }));
  await d.say(OPERATOR, 'excel अक्टूबर');
  assert.equal(d.to(OPERATOR).at(-1), t('excel.owner_only', { owner: t('records.who.jcb') }));
  assert.deepEqual([d.uploads.length, d.documents.length, d.state.sparks], [0, 0, 0]);
  const words = [...d.to(SUPERVISOR), ...d.to(OPERATOR)].join(' ');
  assert.ok(!/₹|सीमेंट/.test(words), words);
});

test('a seller\'s file holds only its own ledger; the contractor\'s holds both, under their friendly names', async (tc) => {
  const d = await desk(tc);
  await d.material();
  await d.jcbJob();

  await d.say(SUPPLIER, 'excel');
  assert.equal(d.documents.at(-1)?.document.filename, 'hisaab-supplier-all.xlsx');
  const sup = d.lastBook();
  assert.deepEqual(refsIn(sup, 'Orders'), ['P-1']);
  assert.equal(rowsOf(sup, 'Orders')[0].E, t('records.who.contractor'));
  assert.ok(!sup.text.includes('रामपुर') && !sup.text.includes('JCB,'), 'no JCB job in the supplier\'s file');

  await d.say(OWNER, 'excel');
  assert.equal(d.documents.at(-1)?.document.filename, 'hisaab-jcb-all.xlsx');
  const jcb = d.lastBook();
  assert.deepEqual(refsIn(jcb, 'Orders'), ['J-1']);
  assert.ok(!jcb.text.includes('सीमेंट') && !jcb.text.includes('शिवपुरी'), 'no material in the JCB owner\'s file');
  assert.deepEqual(rowsOf(jcb, 'Deliveries'), [], 'the site\'s hours are the contractor\'s own note');
  assert.ok(!jcb.text.includes('agent:'), 'no internal id');

  await d.say(CONTRACTOR, 'excel');
  const site = d.lastBook();
  assert.deepEqual(refsIn(site, 'Orders').sort(), ['J-1', 'P-1']);
  const others = Object.fromEntries(rowsOf(site, 'Orders').map((r) => [r.A, r.E]));
  assert.deepEqual(others, { 'P-1': t('records.who.supplier'), 'J-1': t('records.who.jcb') });
  assert.ok(!site.text.includes('agent:') && !site.text.includes('-4000-'), 'no internal id');
});

test('the figures are those of orderFacts and paymentSummary, sheet by sheet, and Hindi survives', async (tc) => {
  const d = await desk(tc);
  const first = await d.material();
  await d.jcbJob();
  const ledger = d.siteEntry.core.ledger;
  await d.run(d.siteEntry, contractor, 'claim_payment', { orderId: first, method: 'cash', amountPaise: 1000000, paidOn: '2026-10-31' });
  await d.say(CONTRACTOR, 'excel');
  const book = d.lastBook();
  const facts = orderFacts(ledger);

  assert.ok(book.sheets[0].name.includes('ऑर्डर'), 'the sheet name in Hindi');
  assert.equal(book.sheets[0].rows[0].get('C')?.value, 'साइट (Site)');
  const orders = rowsOf(book, 'Orders');
  const p1 = /** @type {Record<string, string | number>} */ (orders.find((r) => r.A === 'P-1'));
  assert.deepEqual([p1.B, p1.C, p1.F, p1.G], [t('kind.material'), 'शिवपुरी', t(`state.${facts.find((o) => o.ref === 'P-1')?.state}`), 'सीमेंट 50 बोरी']);
  // 30 October 2026 as Excel counts days: a real date, in the date format.
  assert.equal(p1.D, 46325);
  assert.equal(book.sheets[0].rows[1].get('D')?.style, 3);

  const deliveries = rowsOf(book, 'Deliveries');
  const cement = /** @type {Record<string, string | number>} */ (deliveries.find((r) => r.A === 'P-1'));
  assert.deepEqual([cement.B, cement.C, cement.D, cement.E, cement.G], ['सीमेंट', 'बोरी', 50, 50, '412']);
  assert.equal(cement.F, t('records.count_entered.yes', { by: t('records.who.supervisor') }));
  const hours = /** @type {Record<string, string | number>} */ (deliveries.find((r) => r.A === 'J-1'));
  assert.deepEqual([hours.C, hours.E, hours.F], ['घंटे', 5.5, t('records.hours_entered', { by: t('records.who.supervisor') })]);

  for (const f of facts) {
    const inForce = rowsOf(book, 'Bills').filter((r) => r.A === f.ref && r.C === t('excel.in_force'));
    assert.equal(inForce[0].K, /** @type {number} */ (f.balance.billTotalPaise) / 100, `${f.ref} total`);
    assert.equal(inForce.reduce((s, r) => s + Number(r.J), 0), /** @type {number} */ (f.balance.billTotalPaise) / 100, `${f.ref} lines add up to the total`);
  }
  const jcbBill = /** @type {Record<string, string | number>} */ (rowsOf(book, 'Bills').find((r) => r.A === 'J-1'));
  assert.deepEqual([jcbBill.B, jcbBill.D, jcbBill.E, jcbBill.F, jcbBill.G, jcbBill.J], [t('excel.bill'), 'JCB', 6, 'घंटे', 1200, 7200]);

  const pay = rowsOf(book, 'Payments');
  assert.equal(pay.length, 1);
  assert.deepEqual([pay[0].A, pay[0].C, pay[0].D, pay[0].E], ['P-1', t('records.method.cash'), 10000, t('records.payment.waiting')]);

  for (const f of facts) {
    const s = paymentSummary(paymentEvents(ledger.events(f.orderId)));
    const row = /** @type {Record<string, string | number>} */ (rowsOf(book, 'Balance').find((r) => r.A === f.ref));
    assert.deepEqual([row.C, row.D, row.E, row.F, row.G], [/** @type {number} */ (s.billTotalPaise) / 100, s.confirmedPaise / 100, s.waitingPaise / 100, /** @type {number} */ (s.duePaise) / 100, s.creditPaise / 100], f.ref);
    assert.ok(typeof row.C === 'number');
  }
  // Money is in the money format.
  const payments = /** @type {{rows: Map<string, {style: number}>[]}} */ (book.sheets.find((s) => s.name.includes('Payments')));
  assert.equal(payments.rows[1].get('D')?.style, 2);
});

test('a correction is shown after its bill, and only the latest is in force', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material({ count: 4800, accept: false });
  await d.run(d.supEntry, supplier, 'send_correction', { orderId, qtysHundredths: [4800] });
  await d.say(SUPPLIER, 'excel');
  const rows = rowsOf(d.lastBook(), 'Bills');
  assert.deepEqual(rows.map((r) => [r.B, r.C, r.E, r.J, r.K]), [
    [t('excel.bill'), t('excel.not_in_force'), 50, 19000, 19000],
    [t('excel.correction', { n: 1 }), t('excel.in_force'), 48, 18240, 18240],
  ]);
  const summary = paymentSummary(paymentEvents(d.supEntry.core.ledger.events(orderId)));
  assert.equal(summary.billTotalPaise, 1824000);
  assert.equal(rowsOf(d.lastBook(), 'Balance')[0].C, 18240);
  await d.say(CONTRACTOR, 'excel');
  const [count] = rowsOf(d.lastBook(), 'Deliveries');
  assert.deepEqual([count.D, count.E, count.F], [50, 48, t('records.count_entered.typed', { by: t('records.who.supervisor') })]);
});

test('a refused bill and a refused payment are left out, as the helpers leave them', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.material({ accept: false });
  const ledger = d.supEntry.core.ledger;
  await d.run(d.supEntry, supplier, 'record_received', { orderId, amountPaise: 123400, method: 'cash', receivedOn: '2026-10-29' });
  await d.say(SUPPLIER, 'excel');
  assert.equal(rowsOf(d.lastBook(), 'Payments').length, 1, 'counted before the refusal');
  const refuse = (/** @type {string} */ refersTo) => ledger.append({ orderId, direction: 'in', type: 'REFUSE', msgId: randomUUID(), at: new Date(d.state.nowMs).toISOString(), body: { body: { refers_to: refersTo, code: 'WRONG_STATE' } } });
  const payment = /** @type {string} */ (ofType(ledger.events(orderId), 'PAYMENT_RECEIVED', 'out').at(-1)?.msgId);
  assert.ok(refuse(payment));
  const bill = /** @type {string} */ (ofType(ledger.events(orderId), 'BILL', 'out').at(-1)?.msgId);
  assert.ok(refuse(bill));
  await d.say(SUPPLIER, 'excel');
  const book = d.lastBook();
  assert.deepEqual(rowsOf(book, 'Payments'), []);
  assert.deepEqual(rowsOf(book, 'Bills'), []);
  assert.deepEqual(rowsOf(book, 'Balance'), []);
  assert.equal(ledger.view(orderId).billTotalPaise, null);
  assert.equal(rowsOf(book, 'Orders')[0].F, t('state.delivered'));
});

test('a month filters by the order\'s day; a period with nothing says so and sends no file', async (tc) => {
  const d = await desk(tc);
  await d.material({ day: '2026-10-30' });
  await d.material({ day: '2026-11-02' });
  await d.say(CONTRACTOR, 'excel 10-2026');
  assert.equal(d.documents.at(-1)?.document.filename, 'hisaab-site-2026-10.xlsx');
  assert.equal(d.documents.at(-1)?.document.caption, t('excel.caption_month', { month: 'अक्टूबर 2026' }));
  assert.deepEqual(refsIn(d.lastBook(), 'Orders'), ['P-1']);
  assert.deepEqual(refsIn(d.lastBook(), 'Balance'), ['P-1']);
  await d.say(CONTRACTOR, 'एक्सेल नवंबर 2026');
  assert.equal(d.documents.at(-1)?.document.filename, 'hisaab-site-2026-11.xlsx');
  assert.deepEqual(refsIn(d.lastBook(), 'Orders'), ['P-2']);

  // Today is 29 October 2026: "अक्टूबर" is this year, a month still to come is last year's.
  await d.say(CONTRACTOR, 'एक्सेल अक्टूबर');
  assert.equal(d.documents.at(-1)?.document.filename, 'hisaab-site-2026-10.xlsx');
  const files = d.documents.length;
  await d.say(CONTRACTOR, 'एक्सेल दिसंबर');
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.none_month', { month: 'दिसंबर 2025' }));
  await d.say(CONTRACTOR, 'excel 01-2020');
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.none_month', { month: 'जनवरी 2020' }));
  assert.equal(d.documents.length, files, 'no file');
  await d.say(CONTRACTOR, 'एक्सेल 13-2026');
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.month_unclear'));
  assert.equal(d.state.sparks, 0);
});

test('with no records at all it says so and sends no file', async (tc) => {
  const d = await desk(tc);
  await d.say(OWNER, 'एक्सेल');
  assert.equal(d.to(OWNER).at(-1), t('excel.none'));
  assert.deepEqual([d.uploads.length, d.documents.length], [0, 0]);
});

test('a failed upload or send is said in plain Hindi and never claimed as sent', async (tc) => {
  const d = await desk(tc);
  await d.material();
  d.state.failMedia = true;
  await d.say(CONTRACTOR, 'एक्सेल');
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.send_failed'));
  d.state.failMedia = false;
  d.state.failDocument = true;
  await d.say(CONTRACTOR, 'एक्सेल');
  assert.equal(d.to(CONTRACTOR).at(-1), t('excel.send_failed'));
  assert.equal(d.documents.length, 0);
  assert.ok(!d.to(CONTRACTOR).includes(t('excel.sent', { orders: 1 })));
  assert.ok(d.logs.some((l) => l.includes('document to') && !PHONES.some((p) => l.includes(p))), 'logged with the number masked');
  d.state.failDocument = false;
  await d.say(CONTRACTOR, 'एक्सेल');
  assert.equal(d.documents.length, 1);
});

test('one trace check holds counts, with no content and no phone number', async (tc) => {
  const d = await desk(tc);
  await d.material();
  await d.say(CONTRACTOR, 'एक्सेल');
  const checks = d.siteEntry.trace.list({}).filter((/** @type {any} */ e) => e.detail.name === 'records_file');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, 'check');
  assert.equal(checks[0].detail.pass, true);
  assert.equal(checks[0].detail.sheets, 5);
  assert.ok(checks[0].detail.rows >= 4);
  const text = JSON.stringify(checks[0]);
  assert.ok(!text.includes('सीमेंट') && !text.includes('शिवपुरी') && !PHONES.some((p) => text.includes(p)), text);
});

test('no phone number anywhere in the file, whatever was sent', async (tc) => {
  const d = await desk(tc);
  await d.material();
  await d.jcbJob();
  for (const phone of [CONTRACTOR, SUPPLIER, OWNER]) {
    await d.say(phone, 'excel');
    const { text } = d.lastBook();
    for (const p of PHONES) {
      assert.ok(!text.includes(p), `${p} in the file of ${phone.slice(-4)}`);
      assert.ok(!text.includes(p.slice(2)), `${p.slice(-4)} without its country code`);
    }
  }
});

test('src/export is not served to the web', async (tc) => {
  const d = await desk(tc);
  for (const path of ['/src/export/xlsx.js', '/src/export/records.js', '/judge/../src/export/xlsx.js', '/judge/src/export/xlsx.js']) {
    assert.equal((await globalThis.fetch(`${d.base}${path}`)).status, 404, path);
  }
});

// --- The workbook on a ledger made by hand: names no tool would pass ------------------------------

/** One order with these names, on a ledger of its own. @param {string} site @param {string} item */
function handLedger(site, item) {
  const ledger = openLedger(':memory:');
  const orderId = randomUUID();
  const at = '2026-10-29T06:00:00.000Z';
  ledger.ensureOrder({ orderId, kind: 'material', counterparty: 'agent:supplier-1', site, at });
  ledger.append({ orderId, direction: 'out', type: 'BOOKING_REQUEST', msgId: randomUUID(), at, body: { body: { kind: 'material', site, day: '2026-10-30', items: [{ name: item, qtyHundredths: 5000, unit: 'बोरी' }] } } });
  return ledger;
}

test('=SUM(1) as a site or item name stays text', () => {
  const ledger = handLedger('=SUM(1)', '=1+1');
  const made = /** @type {{bytes: Buffer}} */ (recordsWorkbook({ ledger, side: 'buyer', month: null }));
  const book = readWorkbook(made.bytes);
  const sheet = book.sheets[0];
  assert.deepEqual([sheet.rows[1].get('C')?.type, sheet.rows[1].get('C')?.value], ['s', '=SUM(1)']);
  assert.equal(sheet.rows[1].get('G')?.value, '=1+1 50 बोरी');
  assert.doesNotMatch(book.text, /<f[ >/]/, 'no formula element in the file');
  ledger.close();
});

test('a phone number typed into a name is cut to its last 4 digits', () => {
  const ledger = handLedger('शिवपुरी 9190000000', 'सीमेंट +91 91900 00099');
  const { text } = readWorkbook(/** @type {{bytes: Buffer}} */ (recordsWorkbook({ ledger, side: 'buyer', month: null })).bytes);
  assert.ok(!text.includes('9190000000') && !text.includes('91900'), text.slice(0, 200));
  assert.ok(text.includes('शिवपुरी …0000') && text.includes('सीमेंट …0099'));
  ledger.close();
});

test('over the cap: without a month it asks for one, with a month it says so, and nothing goes', async () => {
  const ledger = handLedger('शिवपुरी', 'सीमेंट');
  let sends = 0;
  const send = async () => { sends += 1; return /** @type {const} */ ({ ok: true, id: 'x' }); };
  const base = { ledger, side: /** @type {const} */ ('buyer'), agentName: 'site', send, maxBytes: 100 };
  const all = await sendRecords({ ...base, month: null });
  assert.deepEqual([all.ok, all.key], [false, 'excel.too_big']);
  const month = await sendRecords({ ...base, month: '2026-10' });
  assert.deepEqual([month.ok, month.key, month.params], [false, 'excel.too_big_month', { month: 'अक्टूबर 2026' }]);
  assert.equal(sends, 0);
  assert.equal((await sendRecords({ ...base, maxBytes: undefined, month: null })).key, 'excel.sent');
  assert.equal(sends, 1);
  ledger.close();
});
