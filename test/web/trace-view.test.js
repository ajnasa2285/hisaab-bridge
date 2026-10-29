// The judge page's "inside the agent" view: the pure functions that turn trace entries into rows and
// a summary, for every kind; the file is served by the app like the page's others; and the committed
// sample carries a trace for both stories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEXTS } from '../../web/texts.js';
import { duration, isTrace, orderTrace, seqOf, summaryText, traceRow, traceSummary } from '../../web/trace-view.js';
import { createApp } from '../../src/app.js';

const en = TEXTS.en;
/** @param {string} kind @param {string} title @param {Record<string, any>} detail @param {number | null} [ms] @param {number} [id] */
const entry = (kind, title, detail, ms = null, id = 1) => ({ id, at: '2026-10-29T03:00:00.000Z', agent: 'jcb', orderId: 'o1', ref: 'J-1', convo: 'c-1', kind, title, detail, ms });
const events = [{ seq: 4, msgId: 'abcdef12-0000-4000-8000-000000000000' }, { seq: 5, msgId: '12345678-0000-4000-8000-000000000000' }];

test('a Muse step is marked as Meta model work, with the model, the job, the effort and the latency', () => {
  const r = traceRow(entry('model', 'meter reads 1234.5', { job: 'meter', model: 'muse-spark-1.2', reasoningEffort: 'default', vision: true, ok: true }, 2620), en);
  assert.deepEqual([r.meta, r.icon, r.label, r.text, r.mark], [true, '✨', 'Meta model', 'meter reads 1234.5', '']);
  assert.equal(r.extra, 'Meta model: muse-spark-1.2 · read the hour meter · vision · 2.6 s');
  assert.match(r.cls, /\bmuse\b/);
  const failed = traceRow(entry('model', 'understand: no answer (timeout)', { job: 'understand', model: 'Muse Spark', reasoningEffort: 'minimal', ok: false }, 30000), TEXTS.hi);
  assert.deepEqual([failed.mark, failed.extra], ['bad', 'Meta मॉडल: Muse Spark · संदेश समझा · effort minimal · 30.0 s']);
});

test('a code check shows ✓, ✗, or ⏸ for a step held for approval', () => {
  assert.equal(traceRow(entry('check', 'meter end above start ✓ 1240.6 > 1234.5', { pass: true }), en).mark, 'ok');
  assert.equal(traceRow(entry('check', 'explanation dropped ✗ (numbers)', { pass: false }), en).mark, 'bad');
  const held = traceRow(entry('check', 'approval needed: no limit set → held', { pass: false, name: 'approval', held: true }), en);
  assert.deepEqual([held.mark, held.icon], ['held', '⏸']);
});

test('decisions, messages in, replies: who, the words when kept, the text key', () => {
  const d = traceRow(entry('decision', 'contractor "OK J-1" → request_jcb (for the supervisor)', { role: 'contractor', onBehalfOf: 'supervisor', reply: 'OK J-1', tool: 'request_jcb' }), en);
  assert.deepEqual([d.label, d.extra, d.icon], ['person decided', 'contractor (supervisor)', '🙋']);
  assert.equal(traceRow(entry('received', 'text from jcb_owner', { channel: 'text', role: 'jcb_owner', text: 'हाँ 1200' }), en).extra, '“हाँ 1200”');
  assert.equal(traceRow(entry('received', 'photo from operator', { channel: 'photo', role: 'operator', text: null }), en).extra, '');
  assert.equal(traceRow(entry('reply', 'jcb.bill_sent → jcb_owner', { key: 'jcb.bill_sent' }, 32), en).extra, 'jcb.bill_sent · 32 ms');
});

test('signed messages and ledger rows link to the ledger card by sequence number', () => {
  const out = traceRow(entry('signed_out', 'BILL → agent:contractor-1 · receipt ✓', { type: 'BILL', msg: 'abcdef12', to: 'agent:contractor-1', verified: true, receipt: '99aa11bb' }, 28), en, events);
  assert.deepEqual([out.mark, out.seq, out.extra], ['ok', 4, 'BILL → agent:contractor-1 · receipt 99aa11bb · 28 ms']);
  const refused = traceRow(entry('signed_in', 'BILL ← agent:jcb-1 · refused (BAD_SIG)', { type: 'BILL', msg: '12345678', from: 'agent:jcb-1', verified: false }), en, events);
  assert.deepEqual([refused.mark, refused.seq], ['bad', 5]);
  const row = traceRow(entry('ledger', '#5 BILL out · 9fedf59', { seq: 5, hash: '9fedf59aa1b2', prev: '4c6485d00000' }), en, events);
  assert.deepEqual([row.seq, row.extra], [5, '#5 · hash 9fedf59aa1b2 · prev 4c6485d00000']);
  assert.equal(seqOf(entry('signed_out', 'x', { msg: 'ffffffff' }), events), null);
  assert.equal(seqOf(entry('check', 'x', {}), events), null);
});

test('the summary counts Muse calls, model time, checks passed and people\'s decisions', () => {
  const list = [
    entry('model', 'a', { job: 'photo_kind' }, 1380, 1), entry('model', 'b', { job: 'meter' }, 2620, 2),
    entry('check', 'c', { pass: true }, null, 3), entry('check', 'd', { pass: false }, null, 4), entry('check', 'e', { name: 'approval', held: true, pass: false }, null, 5),
    entry('decision', 'f', { role: 'operator' }, null, 6), entry('ledger', 'g', { seq: 4 }, null, 7),
  ];
  const s = traceSummary(list);
  assert.deepEqual(s, { muse: 2, modelMs: 4000, checks: 3, passed: 2, decisions: 1 });
  assert.equal(summaryText(s, en), "2 Muse calls · model time 4.0 s · checks 2/3 ✓ · people's decisions 1");
  assert.deepEqual([duration(812), duration(13300), duration(null)], ['812 ms', '13.3 s', '']);
});

test('one order\'s entries in order; a list the page cannot read is refused', () => {
  const list = [entry('ledger', 'b', {}, null, 2), { ...entry('ledger', 'x', {}, null, 3), orderId: 'o2' }, entry('received', 'a', {}, null, 1)];
  assert.deepEqual(orderTrace(list, 'o1').map((e) => e.id), [1, 2]);
  assert.deepEqual(orderTrace(undefined, 'o1'), []);
  assert.equal(isTrace(list), true);
  assert.equal(isTrace([{ id: 'x' }]), false);
  assert.equal(isTrace({}), false);
});

test('every kind has a label in both languages', () => {
  for (const kind of ['received', 'model', 'check', 'decision', 'signed_out', 'signed_in', 'ledger', 'reply']) {
    for (const t of [TEXTS.hi, TEXTS.en]) assert.notEqual(traceRow(entry(kind, 't', {}), t).label, kind);
  }
});

test('the app serves the view\'s file with the page\'s headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-tv-'));
  const app = createApp({ baseUrl: 'http://127.0.0.1', agents: [], lines: [], people: [], waStoreFile: join(dir, 'wa.db'), spark: async () => ({ ok: true, toolCalls: [] }), log: () => {} });
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  try {
    const r = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/judge/trace-view.js`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await r.text(), /export function traceRow/);
  } finally {
    app.close();
    await new Promise((r) => server.close(() => r(undefined)));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed sample carries each agent\'s trace for both stories, with Muse steps, checks and decisions, and no phone', () => {
  const x = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  for (const name of ['jcb', 'contractor', 'supplier']) {
    assert.ok(isTrace(x[name].trace), `${name} trace`);
    const orderIds = new Set(x[name].orders.map((/** @type {any} */ o) => o.order_id));
    assert.ok(x[name].trace.every((/** @type {any} */ e) => orderIds.has(e.orderId)), `${name}: every entry belongs to one of its orders`);
  }
  const jcbOrder = x.jcb.orders[0].order_id;
  const j = traceSummary(orderTrace(x.jcb.trace, jcbOrder));
  assert.ok(j.muse >= 4 && j.checks >= 2 && j.decisions >= 4, JSON.stringify(j));
  const p = x.contractor.trace.filter((/** @type {any} */ e) => e.ref === 'P-1');
  assert.ok(p.some((/** @type {any} */ e) => e.detail.name === 'count_vs_delivery' && e.detail.pass === false), 'the site count of 48 differs');
  assert.ok(p.some((/** @type {any} */ e) => e.detail.name === 'explanation_guard' && e.detail.pass === true));
  const text = JSON.stringify(x);
  for (const phone of ['919000000001', '919000000002', '919000000003', '919000000004', '919000000005']) assert.ok(!text.includes(phone));
});
