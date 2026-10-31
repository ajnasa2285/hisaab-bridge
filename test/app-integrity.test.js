// The ledger check through the assembled app: at start and on its timer, silent when healthy, the owner
// told once per failure, retried when they could not be reached, and never in the way of a message.
// Graph API and model are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from '../src/app.js';
import { runTool } from '../src/agents/common.js';
import { t } from '../src/i18n/index.js';
import { openLedger } from '../src/ledger/store.js';
import { checkFiles } from '../src/ledger/check-files.js';
import { deleteFrom, rewriteRow } from './ledger/forge.js';

const CONTRACTOR = '919000000071';
const SUPPLIER = '919000000072';
const OWNER = '919000000073';
const SITE_ID = 'agent:contractor-1';
const SUP_ID = 'agent:supplier-1';
const JCB_ID = 'agent:jcb-1';
const CHECK_MS = 120_000;
const ALARM = t('common.records_disagree');
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** @typedef {import('../src/wa/directory.js').Person} Person */
/** @param {string} phone @param {string} agent @param {any} role @returns {Person} */
const who = (phone, agent, role) => ({ line: 'line-site', phone, agent, role, name: role });
const contractor = who(CONTRACTOR, SITE_ID, 'contractor');
const supplier = who(SUPPLIER, SUP_ID, 'supplier');
const owner = who(OWNER, JCB_ID, 'jcb_owner');

/**
 * @param {import('node:test').TestContext} tc
 * @param {{integrityCheckMs?: number | null}} [o]
 */
async function desk(tc, o = {}) {
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-integrity-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {string[]} */
  const logs = [];
  const state = { failNext: 0, nowMs: Date.parse('2026-10-29T02:30:00Z') };
  /** @type {typeof globalThis.fetch} */
  const fetch = async (_input, init) => {
    if (state.failNext > 0) { state.failNext -= 1; return new Response('{}', { status: 400 }); }
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ to: body.to, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
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
  const file = (/** @type {string} */ name) => join(dir, `${name}.db`);
  const open = () => {
    app = createApp({
      baseUrl: base,
      agents: [
        { name: 'jcb', kind: 'jcb', id: JCB_ID, title: 'JCB', privateKey: jk.privateKey, ledgerFile: file('jcb'),
          peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
        { name: 'supplier', kind: 'supplier', id: SUP_ID, title: 'Supplier', privateKey: sk.privateKey, ledgerFile: file('supplier'),
          peers: [peer(SITE_ID, ck.publicKey, toSeller)], peerUrls: { [SITE_ID]: `${base}/agents/site` } },
        { name: 'site', kind: 'contractor', id: SITE_ID, title: 'Site', privateKey: ck.privateKey, ledgerFile: file('site'),
          peers: [peer(JCB_ID, jk.publicKey, toSite), peer(SUP_ID, sk.publicKey, toSite)],
          peerUrls: { [JCB_ID]: `${base}/agents/jcb`, [SUP_ID]: `${base}/agents/supplier` }, jcbAgentId: JCB_ID, supplierAgentId: SUP_ID },
      ],
      lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v', accessToken: 'tok' }],
      people: [contractor, supplier, owner],
      waStoreFile: join(dir, 'wa.db'),
      spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      fetch,
      now: () => state.nowMs,
      log: (/** @type {string} */ l) => { logs.push(l); },
      ...(o.integrityCheckMs === null ? {} : { integrityCheckMs: o.integrityCheckMs ?? CHECK_MS }),
    });
  };
  open();
  let open_ = true;
  tc.after(async () => {
    tc.mock.timers.reset();
    await new Promise((r) => server.close(() => r(undefined)));
    if (open_) app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const checked0 = async () => {
    for (let i = 0; i < 250 && checkLines(logs).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    await quiet();
  };
  /** The logs and sends have stopped moving. */
  const quiet = async () => {
    let seen = -1;
    for (let i = 0; i < 200; i += 1) {
      const now = logs.length + sent.length;
      if (now === seen) return;
      seen = now;
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  await checked0();
  /** Until one more check has logged (each logs at least one line), then until everything has stopped. @param {number} lines the log lines before it */
  const checked = async (lines) => {
    for (let i = 0; i < 250 && checkLines(logs).length <= lines; i += 1) await new Promise((r) => setTimeout(r, 20));
    await quiet();
  };
  let n = 0;
  return {
    get app() { return app; }, sent, logs, state, file, quiet, checked, jk, ck, sk,
    entry: (/** @type {string} */ id) => app.agent(id),
    alarms: (/** @type {string} */ phone) => sent.filter((s) => s.to === phone && s.text === ALARM).length,
    close: () => { app.close(); open_ = false; },
    reopen: async () => { const lines = checkLines(logs).length; open(); open_ = true; await checked(lines); },
    /** One check by the timer. */
    tick: async () => { const lines = checkLines(logs).length; tc.mock.timers.tick(CHECK_MS); await checked(lines); },
    /** @param {string} phone @param {string} text */
    say: async (phone, text) => {
      n += 1;
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
        messages: [{ from: phone, id: `wamid.in${n}`, timestamp: String(Math.floor(state.nowMs / 1000)), type: 'text', text: { body: text } }] } }] }] });
      const r = await globalThis.fetch(`${base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret-site').update(body).digest('hex')}` }, body });
      assert.equal(r.status, 200);
      await quiet();
    },
    /** A material order, billed, between the contractor's and the supplier's agents. */
    order: async () => {
      /** @param {string} id @param {Person} p @param {string} tool @param {any} args */
      const run = async (id, p, tool, args) => {
        const r = await runTool(app.agent(id).agent.tools, p, { tool, args });
        assert.equal(r.ok, true, `${tool}: ${r.key}`);
        await quiet();
      };
      await run(SITE_ID, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
      const orderId = String(app.agent(SITE_ID).core.ledger.orders()[0].order_id);
      await run(SUP_ID, supplier, 'reply_order', { orderId, answer: 'yes', ratesPaise: [38000] });
      await run(SUP_ID, supplier, 'record_delivery', { orderId, items: [CEMENT], sha256: 'd'.repeat(64) });
      await run(SITE_ID, contractor, 'confirm_count', { orderId, qtysHundredths: [5000] });
      await run(SUP_ID, supplier, 'send_bill', { orderId });
      return orderId;
    },
  };
}

/** @param {any} ledger */
const edit = (ledger) => rewriteRow(ledger, 1, (m) => { m.body.items[0].qtyHundredths = 9900; });
/** The log lines of the check. @param {string[]} logs */
const checkLines = (logs) => logs.filter((l) => l.startsWith('integrity:'));

test('healthy: checked at start and on the timer, logged, and nobody is sent anything', async (tc) => {
  const d = await desk(tc);
  assert.deepEqual(checkLines(d.logs), ['integrity: ok, 3 ledgers, 0 receipts compared'], 'at start');
  await d.order();
  for (const phone of [CONTRACTOR, SUPPLIER, OWNER]) await d.say(phone, 'मदद');
  const sentBefore = d.sent.length;
  await d.tick();
  assert.equal(d.sent.length, sentBefore, 'no message at all');
  assert.match(checkLines(d.logs).at(-1) ?? '', /^integrity: ok, 3 ledgers, [1-9]\d* receipts compared$/);
});

test('the timer is 6 hours unless told otherwise, and stops on close', async (tc) => {
  const d = await desk(tc, { integrityCheckMs: null });
  assert.equal(checkLines(d.logs).length, 1);
  tc.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  await d.quiet();
  assert.equal(checkLines(d.logs).length, 1, 'not yet');
  tc.mock.timers.tick(1);
  await d.checked(1);
  assert.equal(checkLines(d.logs).length, 2);
  d.close();
  tc.mock.timers.tick(6 * 60 * 60 * 1000);
  await d.quiet();
  assert.equal(checkLines(d.logs).length, 2, 'nothing after close');
});

test('a forced edit: each owner concerned is told once, nobody else, and the logs carry no phone or contents', async (tc) => {
  const d = await desk(tc);
  await d.order();
  for (const phone of [CONTRACTOR, OWNER]) await d.say(phone, 'मदद');
  edit(d.entry(SUP_ID).core.ledger);
  assert.equal(d.entry(SUP_ID).core.ledger.verifyChain().ok, true);

  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 1, 'one message however many receipts fail');
  assert.equal(d.alarms(OWNER), 0, 'the JCB owner is not concerned');
  assert.equal(d.alarms(SUPPLIER), 0, 'outside the 24-hour window');
  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 1, 'not told again');

  // Outside the window: kept, and told at the first check after they write.
  assert.ok(d.logs.some((l) => l === 'integrity: supplier not told yet: outside 24h window'));
  await d.say(SUPPLIER, 'मदद');
  assert.equal(d.alarms(SUPPLIER), 0, 'writing alone does not tell');
  await d.tick();
  assert.equal(d.alarms(SUPPLIER), 1);
  await d.tick();
  assert.deepEqual([d.alarms(SUPPLIER), d.alarms(CONTRACTOR), d.alarms(OWNER)], [1, 1, 0]);

  const lines = checkLines(d.logs);
  assert.ok(lines.some((l) => /problem\(s\).*site seq \d+, receipt from supplier: (entry|head)_missing/.test(l)), lines.join('\n'));
  for (const l of lines) {
    assert.doesNotMatch(l, /9190000|\d{4}$|Rampur|सीमेंट|9900/, l);
    assert.doesNotMatch(l, /\b[0-9a-f]{8}-[0-9a-f]{4}/, 'no order id');
  }
  assert.ok(!ALARM.match(/\d/), 'the message names no figure');
});

test('a new failure tells them again; the same one does not, and a send that failed is retried', async (tc) => {
  const d = await desk(tc);
  await d.order();
  await d.say(CONTRACTOR, 'मदद');
  edit(d.entry(SUP_ID).core.ledger);
  d.state.failNext = 1;
  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 0, 'Graph refused it');
  assert.ok(d.logs.some((l) => l.startsWith('integrity: contractor not told yet:')));
  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 1, 'told at the next check');

  // Another ledger, a different failure.
  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 1);
  d.entry(JCB_ID).core.ledger.db.exec('DROP TRIGGER events_no_update');
  const orderId = String(d.entry(SITE_ID).core.ledger.orders()[0].order_id);
  d.entry(JCB_ID).core.ledger.ensureOrder({ orderId, kind: 'material', counterparty: SITE_ID, site: 'x', at: '2026-10-29T02:30:00.000Z' });
  d.entry(JCB_ID).core.ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: 'n1', body: { kind: 'invented' }, at: '2026-10-29T02:30:00.000Z' });
  d.entry(JCB_ID).core.ledger.db.exec("UPDATE events SET at = '2020-01-01T00:00:00.000Z' WHERE seq = 1");
  await d.say(OWNER, 'मदद');
  await d.tick();
  assert.equal(d.alarms(OWNER), 1, 'a broken chain tells that agent\'s owner');
  assert.equal(d.alarms(CONTRACTOR), 1, 'and not the contractor, whose records it does not touch');
  assert.ok(d.logs.some((l) => /jcb: chain broken at seq 1/.test(l)));
});

test('at start: an edit made while the service was down is found, and a restart does not tell again', async (tc) => {
  const d = await desk(tc);
  await d.order();
  await d.say(CONTRACTOR, 'मदद');
  d.close();
  const ledger = openLedger(d.file('supplier'));
  edit(ledger);
  ledger.close();
  await d.reopen();
  assert.equal(d.alarms(CONTRACTOR), 1, 'told by the check at start');
  d.close();
  await d.reopen();
  await d.tick();
  assert.equal(d.alarms(CONTRACTOR), 1, 'remembered across the restart');
});

test('a check that fails is logged and message handling goes on; the other ledgers are still checked', async (tc) => {
  const d = await desk(tc);
  await d.order();
  await d.say(CONTRACTOR, 'मदद');
  const helpCount = () => d.sent.filter((s) => s.to === CONTRACTOR && s.text === t('help.contractor')).length;
  const before = helpCount();
  const ledger = d.entry(SUP_ID).core.ledger;
  ledger.verifyChain = () => { throw new SyntaxError('row text that must not reach the log'); };
  ledger.orders = () => { throw new SyntaxError('row text that must not reach the log'); };
  await d.tick();
  const lines = checkLines(d.logs);
  assert.ok(lines.includes('integrity: supplier could not be checked (SyntaxError)'), lines.join('\n'));
  assert.ok(lines.every((l) => !l.includes('row text')));
  assert.equal(d.alarms(CONTRACTOR), 0, 'a check that could not run is no alarm');
  await d.say(CONTRACTOR, 'मदद');
  assert.equal(helpCount(), before + 1, 'the message was handled');
});

test('the script for copies of ledgers: agrees on healthy files, exits 1 on an edit and on deleted rows, prints no contents', async (tc) => {
  const d = await desk(tc);
  const orderId = await d.order();
  const accepted = await runTool(d.entry(SITE_ID).agent.tools, contractor, { tool: 'accept_bill', args: { orderId } });
  assert.equal(accepted.ok, true, 'one more message for the supplier to give a receipt for');
  await d.quiet();
  d.close();
  const args = [`jcb=${d.file('jcb')}`, `site=${d.file('site')}`, `supplier=${d.file('supplier')}`];
  const keys = [`site.key=${publicKeyText(d.ck.privateKey)}`, `supplier.key=${publicKeyText(d.sk.privateKey)}`];
  /** @param {string[]} a */
  const run = async (a) => {
    /** @type {string[]} */
    const out = [];
    const code = await checkFiles(a, (l) => { out.push(l); });
    return { code, out };
  };

  const two = args.slice(1);
  const healthy = await run([...two, ...keys]);
  assert.equal(healthy.code, 0, healthy.out.join('\n'));
  const counts = /(\d+) receipts compared, (\d+) signatures checked/.exec(healthy.out[0]);
  assert.ok(counts && Number(counts[1]) > 0 && counts[1] === counts[2], healthy.out[0]);
  assert.match(healthy.out.at(-1) ?? '', /^OK/);
  assert.equal((await run(two)).code, 0, 'without keys too');
  const noRows = await run(args);
  assert.equal(noRows.code, 2, 'a ledger with no signed row is not a pass');
  assert.match(noRows.out.at(-1) ?? '', /^NOT CHECKED/);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['nonsense'])).code, 2);

  // Back to the row the supplier's last receipt named as its head.
  const site = openLedger(d.file('site'));
  const receipts = /** @type {any[]} */ (site.db.prepare("SELECT body_json FROM events WHERE type = 'RECEIPT' AND direction = 'in' ORDER BY seq").all()).map((r) => JSON.parse(r.body_json)).filter((m) => m.from === SUP_ID);
  site.close();
  const ledger = openLedger(d.file('supplier'));
  const named = /** @type {any} */ (ledger.db.prepare('SELECT seq FROM events WHERE hash = ?').get(receipts.at(-1).body.chain_head)).seq;
  deleteFrom(/** @type {any} */ (ledger), named);
  ledger.close();
  const short = await run(two);
  assert.equal(short.code, 1, 'deleted rows a receipt named');
  assert.match(short.out.at(-1) ?? '', /^NOT OK/);

  const again = openLedger(d.file('site'));
  edit(again);
  again.close();
  const forged = await run(two);
  assert.equal(forged.code, 1);
  assert.doesNotMatch(forged.out.join('\n'), /Rampur|सीमेंट|9190000/);
});
