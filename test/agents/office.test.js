// The site office: exact commands parsed by code, what is received on site from the ledger alone,
// and approvals with limits over the real agents (a supervisor's step above the limit waits for the
// contractor's "OK J-n"; a decision is taken once and survives a restart).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice, parseCommand, stockOf } from '../../src/agents/office.js';
import { runTool } from '../../src/agents/common.js';
import { openLedger } from '../../src/ledger/store.js';
import { openRefs } from '../../src/ledger/refs.js';
import { t } from '../../src/i18n/index.js';
import { setup, person } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const contractor = { ...person('contractor', 'agent:contractor-1'), name: 'Contractor' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012', name: 'Supervisor' };

test('exact commands: Latin and Devanagari, any case, references with or without hyphen and spaces', () => {
  /** @type {[string, any][]} */
  const table = [
    ['status J-1', { cmd: 'status', ref: 'J-1' }],
    ['STATUS p 2', { cmd: 'status', ref: 'P-2' }],
    ['स्थिति जे-3', { cmd: 'status', ref: 'J-3' }],
    ['हालत p1।', { cmd: 'status', ref: 'P-1' }],
    ['status', null],
    ['status J-1 please', null],
    ['pending', { cmd: 'pending' }],
    ['बाक़ी', { cmd: 'pending' }],
    ['बाकी', { cmd: 'pending' }],
    ['pending J-1', null],
    ['stock', { cmd: 'stock', item: null }],
    ['स्टॉक सीमेंट', { cmd: 'stock', item: 'सीमेंट' }],
    ['Stock Sand', { cmd: 'stock', item: 'sand' }],
    ['ok J-1', { cmd: 'ok', ref: 'J-1', note: null }],
    ['OK j1 jaldi bhejo', { cmd: 'ok', ref: 'J-1', note: 'jaldi bhejo' }],
    ['ओके P - 4', { cmd: 'ok', ref: 'P-4', note: null }],
    ['हाँ J-2', { cmd: 'ok', ref: 'J-2', note: null }],
    ['मंज़ूर j-2', { cmd: 'ok', ref: 'J-2', note: null }],
    ['no J-2 baarish hai', { cmd: 'no', ref: 'J-2', reason: 'baarish hai' }],
    ['नहीं J-2 आज ज़रूरत नहीं', { cmd: 'no', ref: 'J-2', reason: 'आज ज़रूरत नहीं' }],
    ['no j2', { cmd: 'no', ref: 'J-2', reason: null }],
    ['ok', null],
    ['हाँ', null],
    ['नहीं', null],
    ['ok #1', null],
    ['no X-2 reason', null],
    ['kal JCB chahiye', null],
    ['मदद', null],
  ];
  for (const [text, want] of table) assert.deepEqual(parseCommand(text), want, text);
});

/** @param {string} site @param {any[]} events */
const order = (site, events) => ({ site, events: events.map((e, i) => ({ seq: i + 1, orderId: 'o', msgId: e.msgId ?? null, at: '2026-10-29T00:00:00Z', prevHash: '', hash: '', ...e })) });

test('stock is what each site received: the site\'s own count where it counted, else the signed challan', () => {
  const cement = { name: 'Cement', qtyHundredths: 5000, unit: 'बोरी' };
  const rows = stockOf([
    // Delivered 50 bags, the site counted 48.
    order('Shivpuri', [
      { direction: 'in', type: 'DELIVERY', body: { body: { items: [cement, { name: 'Sand', qtyHundredths: 250, unit: 'ट्रॉली' }] } } },
      { direction: 'local', type: 'NOTE', body: { kind: 'site_count', items: [{ ...cement, qtyHundredths: 4800 }, { name: 'sand ', qtyHundredths: 250, unit: 'ट्रॉली' }] } },
    ]),
    // Delivered 20 bags, not counted yet.
    order('Shivpuri', [{ direction: 'in', type: 'DELIVERY', body: { body: { items: [{ ...cement, qtyHundredths: 2000 }] } } }]),
    // Another site; and an order with no delivery adds nothing.
    order('Gwalior', [{ direction: 'in', type: 'DELIVERY', body: { body: { items: [{ ...cement, qtyHundredths: 1000 }] } } }]),
    order('Gwalior', [{ direction: 'out', type: 'BOOKING_REQUEST', body: { body: { kind: 'material', items: [cement] } } }]),
    // Malformed items are ignored, never guessed.
    order('Datia', [{ direction: 'in', type: 'DELIVERY', body: { body: { items: [{ name: 'Cement', qtyHundredths: 1.5, unit: 'बोरी' }, { qtyHundredths: 100 }] } } }]),
  ]);
  assert.deepEqual(rows, [
    { site: 'Shivpuri', name: 'Cement', unit: 'बोरी', receivedHundredths: 6800, challanHundredths: 7000 },
    { site: 'Shivpuri', name: 'Sand', unit: 'ट्रॉली', receivedHundredths: 250, challanHundredths: 250 },
    { site: 'Gwalior', name: 'Cement', unit: 'बोरी', receivedHundredths: 1000, challanHundredths: 1000 },
  ]);
  assert.deepEqual(stockOf([]), []);
});

/**
 * A contractor agent's office and conversation over the real agents, with a stand-in Spark.
 * @param {any} s @param {import('../../src/agents/office.js').Limits | undefined} limits
 */
function siteDesk(s, limits) {
  /** @type {{name: string, args: any}[]} */
  const calls = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: calls.splice(0) });
  /** @type {[string, string, string, any][]} [to, key, text, params] */
  const said = [];
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params), params]); };
  const tell = (/** @type {string} */ role, /** @type {string} */ key, /** @type {any} */ params) => { said.push([`all:${role}`, key, t(key, params), params]); };
  const office = createOffice({ ledger: s.siteCore.ledger, tools: s.site.tools, kind: 'contractor', limits, tell, reply, now: s.siteCore.now });
  const talk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now, office });
  /** Says a text and, for a read-back, "हाँ". @param {any} who @param {string} text @param {{name: string, args: any}} [call] */
  const ask = async (who, text, call) => {
    if (call) calls.push(call);
    await talk.onText(who, text);
  };
  const last = (/** @type {string} */ to) => /** @type {[string, string, string, any]} */ (said.filter((x) => x[0] === to).at(-1));
  return { office, talk, said, ask, last };
}

/** @param {string} site @param {string} day @param {string | null} hours */
const jcbCall = (site, day, hours) => ({ name: 'request_jcb', args: { site, day, time: '8', hours } });
const settle = () => new Promise((r) => setImmediate(r));

test('approvals with limits: above the limit or not estimable waits for the contractor; OK runs it exactly; decided once', async () => {
  const s = await setup();
  try {
    const d = siteDesk(s, { procurementPaise: 1000000 }); // ₹10,000
    const jcbOrders = () => /** @type {any[]} */ (s.jcbCore.ledger.orders());
    const refs = openRefs(s.siteCore.ledger);

    // No agreed rate yet: the estimate is unknown, so the step is held as J-1. Nothing is signed.
    // No read-back for the supervisor (the contractor's OK is the check): one message with what went.
    await d.ask(supervisor, 'kal Shivpuri JCB 6 ghante', jcbCall('Shivpuri', '30-10', '6'));
    assert.deepEqual(d.last('supervisor').slice(0, 2), ['supervisor', 'office.held_step']);
    assert.ok(d.last('supervisor')[2].includes('J-1') && d.last('supervisor')[2].includes('Shivpuri') && d.last('supervisor')[2].includes('6.0 घंटे'));
    assert.equal(s.siteCore.ledger.orders().length, 0);
    const asked = d.last('all:contractor');
    assert.equal(asked[1], 'office.approval_needed');
    assert.ok(asked[2].includes('Supervisor') && asked[2].includes('Shivpuri') && asked[2].includes('"OK J-1"') && asked[2].includes('"नहीं J-1 कारण"'));
    assert.ok(!asked[2].includes('अनुमान') && !asked[2].includes('—'), 'no estimate without an agreed rate, and no "—" for it');
    assert.ok(!asked[2].includes('हाँ / नहीं'), 'the contractor is not asked a bare yes/no');

    // The supervisor cannot approve; an unknown reference is said so.
    await d.ask(supervisor, 'ok J-1');
    assert.equal(d.last('supervisor')[1], 'office.only_contractor');
    await d.ask(contractor, 'ok J-9');
    assert.equal(d.last('contractor')[1], 'office.no_such_ref');

    // The contractor approves: the stored step runs as the supervisor's request, with the same args.
    await d.ask(contractor, 'OK j1 theek hai');
    assert.deepEqual(d.last('contractor').slice(0, 2), ['contractor', 'site.jcb_requested_time']);
    assert.equal(d.last('contractor')[3].ref, 'J-1');
    const toSup = d.said.filter((x) => x[0] === 'supervisor').slice(-2);
    assert.deepEqual(toSup.map((x) => x[1]), ['office.approved_note', 'site.jcb_requested_time']);
    assert.ok(toSup[0][2].includes('Contractor') && toSup[0][2].includes('theek hai'));
    assert.equal(jcbOrders().length, 1);
    const sent = s.jcbCore.ledger.events(jcbOrders()[0].order_id).find((e) => e.type === 'BOOKING_REQUEST');
    assert.deepEqual(sent?.body.body, { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-30', time: '08:00', hoursTenths: 60 });
    assert.equal(refs.refOf(jcbOrders()[0].order_id), 'J-1');
    await settle();
    assert.ok(s.told.some(([a, role, key, p]) => a === 'jcb' && role === 'jcb_owner' && key === 'jcb.booking_request_time_hours' && p.ref === 'J-1'));

    // A second OK changes nothing and says who decided.
    await d.ask(contractor, 'ok J-1');
    assert.equal(d.last('contractor')[1], 'office.already_decided');
    assert.ok(d.last('contractor')[2].includes('मंज़ूर') && d.last('contractor')[2].includes('Contractor'));
    assert.equal(jcbOrders().length, 1);

    // The JCB owner agrees ₹1,200 an hour; now a supervisor's step can be estimated.
    await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId: jcbOrders()[0].order_id, answer: 'yes', ratePaise: 120000 } });
    await settle();
    // 6 h × ₹1,200 = ₹7,200, within ₹10,000: nobody else checks it, so it is read back once, then sent as J-2.
    await d.ask(supervisor, 'parso Gwalior 6 ghante', jcbCall('Gwalior', '31-10', '6'));
    assert.equal(d.last('supervisor')[1], 'step.request_jcb');
    await d.ask(supervisor, 'हाँ');
    assert.equal(d.last('supervisor')[1], 'site.jcb_requested_time');
    assert.equal(d.last('supervisor')[3].ref, 'J-2');
    assert.equal(jcbOrders().length, 2);
    // 10 h = ₹12,000, above the limit: held as J-3 with its estimate.
    await d.ask(supervisor, 'parso Datia 10 ghante', jcbCall('Datia', '31-10', '10'));
    assert.equal(d.last('supervisor')[1], 'office.held_step');
    assert.ok(d.last('all:contractor')[2].includes('J-3') && d.last('all:contractor')[2].includes('₹12,000'));

    // What waits: the contractor sees the held step; the supervisor his own step and the open jobs.
    await d.ask(contractor, 'pending');
    assert.equal(d.last('contractor')[1], 'office.pending');
    assert.ok(d.last('contractor')[2].includes('J-3') && d.last('contractor')[2].includes('Datia'));
    assert.ok(!d.last('contractor')[2].includes('J-1'), 'a booked job does not wait for the contractor');
    await d.ask(supervisor, 'बाक़ी');
    for (const ref of ['J-1', 'J-2', 'J-3']) assert.ok(d.last('supervisor')[2].includes(ref), ref);
    await d.ask(supervisor, 'status J-3');
    assert.equal(d.last('supervisor')[1], 'office.status_held_estimate');
    assert.ok(d.last('supervisor')[2].includes('मंज़ूरी बाक़ी') && d.last('supervisor')[2].includes('₹12,000'));
    await d.ask(contractor, 'स्थिति J-1');
    assert.equal(d.last('contractor')[1], 'office.status');
    assert.ok(d.last('contractor')[2].includes('तय') && d.last('contractor')[2].includes('₹1,200') && d.last('contractor')[2].includes('Shivpuri'));

    // "No" needs a reason; then it is recorded, the supervisor is told, nothing is sent.
    await d.ask(contractor, 'नहीं J-3');
    assert.equal(d.last('contractor')[1], 'office.reason_needed');
    await d.ask(contractor, 'नहीं J-3 बारिश है');
    assert.equal(d.last('contractor')[1], 'office.you_declined');
    assert.equal(d.last('supervisor')[1], 'office.declined');
    assert.ok(d.last('supervisor')[2].includes('बारिश है') && d.last('supervisor')[2].includes('Contractor'));
    await d.ask(contractor, 'ok J-3');
    assert.equal(d.last('contractor')[1], 'office.already_decided');
    assert.ok(d.last('contractor')[2].includes('मना'));
    assert.equal(jcbOrders().length, 2);
    await d.ask(supervisor, 'status j3');
    assert.ok(d.last('supervisor')[2].includes('बारिश है'));

    // The contractor's own step is never held, whatever its size.
    await d.ask(contractor, 'Datia 20 ghante', jcbCall('Datia', '31-10', '20'));
    await d.ask(contractor, 'हाँ');
    assert.equal(d.last('contractor')[1], 'site.jcb_requested_time');
    assert.equal(d.last('contractor')[3].ref, 'J-4', 'J-3 stays with the declined step');
    assert.equal(jcbOrders().length, 3);

    // Held steps are append-only; decisions are set once.
    assert.deepEqual(d.office.held().map((h) => [h.ref, h.decision?.decision ?? null]), [['J-1', 'ok'], ['J-3', 'no']]);
    assert.throws(() => s.siteCore.ledger.db.exec("UPDATE held_decisions SET decision = 'ok'"), /set once/);
    assert.throws(() => s.siteCore.ledger.db.exec('DELETE FROM held_steps'), /append-only/);
    assert.equal(s.siteCore.ledger.verifyChain().ok, true);
  } finally {
    await s.close();
  }
});

test('with no limit set every supervisor step waits; a held step survives a restart and runs exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-office-'));
  const file = join(dir, 'contractor.db');
  try {
    let s = await setup({ siteLedgerFile: file });
    let d = siteDesk(s, undefined);
    // Even with a known rate (₹1,200 from the contractor's own booking), no limit means it waits.
    await d.ask(contractor, 'kal Shivpuri 2 ghante', jcbCall('Shivpuri', '30-10', '2'));
    await d.ask(contractor, 'हाँ');
    const first = /** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id;
    await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId: first, answer: 'yes', ratePaise: 120000 } });
    await d.ask(supervisor, 'parso Gwalior 1 ghanta', jcbCall('Gwalior', '31-10', '1'));
    assert.equal(d.last('supervisor')[1], 'office.held_step');
    assert.ok(d.last('all:contractor')[2].includes('J-2') && d.last('all:contractor')[2].includes('₹1,200'));
    await s.close();
    s.siteCore.ledger.close();

    // Restart: a new process opens the same file.
    s = await setup({ siteLedgerFile: file });
    d = siteDesk(s, undefined);
    assert.deepEqual(d.office.held().map((h) => [h.ref, h.tool, h.args.site, h.person.role, h.decision]), [['J-2', 'request_jcb', 'Gwalior', 'supervisor', null]]);
    await d.ask(contractor, 'ok J-2');
    assert.equal(d.last('contractor')[1], 'site.jcb_requested_time');
    assert.equal(d.last('contractor')[3].ref, 'J-2');
    const orders = /** @type {any[]} */ (s.jcbCore.ledger.orders());
    assert.equal(orders.length, 1);
    assert.deepEqual(s.jcbCore.ledger.events(orders[0].order_id)[0].body.body, { kind: 'jcb_hours', site: 'Gwalior', day: '2026-10-31', time: '08:00', hoursTenths: 10 });
    assert.equal(openRefs(s.siteCore.ledger).refOf(orders[0].order_id), 'J-2');
    await d.ask(contractor, 'हाँ J-2');
    assert.equal(d.last('contractor')[1], 'office.already_decided');
    await s.close();
    s.siteCore.ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status, pending and stock read the ledger; on the JCB side "ok J-1" is not a command', async () => {
  const ledger = openLedger(':memory:');
  const orderId = '00000000-0000-4000-8000-000000000001';
  ledger.ensureOrder({ orderId, kind: 'material', counterparty: 'agent:supplier-1', site: 'Shivpuri', at: '2026-10-29T01:00:00Z' });
  const at = '2026-10-29T01:00:00Z';
  const cement = { name: 'Cement', qtyHundredths: 5000, unit: 'बोरी' };
  ledger.append({ orderId, direction: 'out', type: 'BOOKING_REQUEST', msgId: 'm1', body: { body: { kind: 'material', site: 'Shivpuri', day: '2026-10-30', items: [cement] } }, at });
  ledger.append({ orderId, direction: 'in', type: 'BOOKING_REPLY', msgId: 'm2', body: { body: { answer: 'yes', rates: [{ name: 'Cement', unit: 'बोरी', ratePaise: 38000 }] } }, at });
  ledger.append({ orderId, direction: 'in', type: 'DELIVERY', msgId: 'm3', body: { body: { items: [cement], challan: { sha256: 'a'.repeat(64) }, deliveredAt: at } }, at });
  ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: null, body: { kind: 'site_count', items: [{ ...cement, qtyHundredths: 4800 }] }, at });

  /** @type {[string, string, string][]} */
  const said = [];
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const office = createOffice({ ledger, tools: {}, kind: 'contractor', tell: () => {}, reply, now: Date.now });
  const r = await office.command(supervisor, { cmd: 'status', ref: 'P-1' });
  assert.equal(r?.key, 'office.status');
  const status = t(/** @type {any} */ (r).key, r?.params);
  for (const part of ['P-1', 'Cement 50 बोरी', 'Shivpuri', '30 अक्टूबर 2026', 'पहुँचा', 'Cement ₹380', 'गिनती']) assert.ok(status.includes(part), part);

  const stock = await office.command(supervisor, { cmd: 'stock', item: null });
  const text = t(/** @type {any} */ (stock).key, stock?.params);
  assert.ok(text.includes('साइट Shivpuri:') && text.includes('Cement: 48 बोरी (चालान में 50 बोरी)'), text);
  assert.equal((await office.command(supervisor, { cmd: 'stock', item: 'sand' }))?.key, 'office.stock_none');
  assert.equal((await office.command(contractor, { cmd: 'pending' }))?.key, 'office.pending_none');
  const sup = await office.command(supervisor, { cmd: 'pending' });
  assert.ok(t(/** @type {any} */ (sup).key, sup?.params).includes('P-1'));
  assert.equal((await office.command(supervisor, { cmd: 'status', ref: 'J-1' }))?.key, 'office.no_such_ref');

  // The JCB side: no stock, and ok/no go to the model (the owner may mean a booking).
  const jcbOffice = createOffice({ ledger: openLedger(':memory:'), tools: {}, kind: 'jcb', tell: () => {}, reply, now: Date.now });
  assert.equal((await jcbOffice.command(owner, { cmd: 'stock', item: null }))?.key, 'office.stock_not_here');
  assert.equal(await jcbOffice.command(owner, { cmd: 'ok', ref: 'J-1', note: null }), null);
  assert.equal(said.length, 0);
  ledger.close();
});
