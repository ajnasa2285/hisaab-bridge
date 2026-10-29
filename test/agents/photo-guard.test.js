// Meter photos are checked before anything is recorded (docs/BUILD2.md "Photo guards and owner
// consent"): forwarded photos are refused, Muse Spark compares the machine with the other reading's
// photo, and a date on the display must be the job's. Readers and the comparison are stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { displayDays, displayDateWrong } from '../../src/agents/meter-guard.js';
import { openMediaStore } from '../../src/media/store.js';
import { parseInbound } from '../../src/wa/webhook.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000002' };
const contractor = person('contractor', 'agent:contractor-1');
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000031' };
const settle = () => new Promise((r) => setTimeout(r, 30));
/** @param {number} n */
const photo = (n) => ({ mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, n, n, n]) });
/** @param {string} raw @param {number} valueTenths @param {string | null} [displayDate] */
const reading = (raw, valueTenths, displayDate = null) => ({ ok: true, kind: 'hour_meter', raw, valueTenths, clear: true, displayDate });

/**
 * A JCB job booked for 29 Oct 2026 (the clock says 08:00 IST that day), and the operator's
 * conversation with stand-in readers and a private media store.
 * @param {import('node:test').TestContext} tc
 */
async function jcbJob(tc) {
  const s = await setup();
  const dir = mkdtempSync(join(tmpdir(), 'hb-photo-guard-'));
  tc.after(async () => { await s.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-10-29', hoursTenths: 60 } })).ok, true);
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } })).ok, true);
  await settle();
  const mediaStore = openMediaStore({ dataDir: dir, agentId: 'agent:jcb-1' });
  /** @type {any[]} */ const reads = [];
  /** @type {any[]} */ const compared = [];
  /** @type {string[]} */ const logs = [];
  /** @type {[string, string][]} */ const said = [];
  const f = {
    s, orderId, reads, compared, logs, said,
    /** @type {any} */ nextRead: null,
    /** @type {any} */ nextSame: { ok: true, same: 'yes', differs: [], model: 'stand-in', latencyMs: 1 },
    meters: () => s.jcbCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE'),
    last: () => said.at(-1)?.[0],
    /** @type {any} */ talk: null,
  };
  f.talk = createConversation({
    ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark: async () => ({ ok: true, toolCalls: [] }), now: s.jcbCore.now, mediaStore,
    classifyPhoto: seesPhoto('meter'),
    readMeter: async (image) => { reads.push(image); return f.nextRead; },
    sameMeter: async (o) => { compared.push(o); if (f.nextSame instanceof Error) throw f.nextSame; return f.nextSame; },
    reply: (_p, key, params) => { said.push([key, t(key, params)]); },
    log: (line) => { logs.push(line); },
  });
  return f;
}

/** The start photo, clear and recorded at once. @param {Awaited<ReturnType<typeof jcbJob>>} f */
async function start(f) {
  f.nextRead = reading('2061.7', 20617);
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.compared.length, 0, 'nothing to compare the first photo with');
}

test('a forwarded meter photo is refused before it is read; nothing is recorded', async (tc) => {
  const f = await jcbJob(tc);
  f.nextRead = reading('2061.7', 20617);
  await f.talk.onImage(operator, { ...photo(1), forwarded: true });
  assert.equal(f.last(), 'meter.forwarded');
  assert.equal(f.said.at(-1)?.[1], 'मीटर की फ़ोटो अभी खींचकर भेजें, फ़ॉरवर्ड की हुई फ़ोटो नहीं चलेगी।');
  assert.equal(f.reads.length, 0);
  assert.equal(f.meters().length, 0);
  // The same photo taken now is fine.
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'jcb.meter_start_saved');
});

test('same machine: no is refused, unsure is read back once, yes is recorded', async (tc) => {
  const f = await jcbJob(tc);
  await start(f);
  // The live case: a different JCB's meter (plain LCD). Refused, nothing recorded, no question left open.
  f.nextSame = { ok: true, same: 'no', differs: ['display', 'make'], model: 'stand-in', latencyMs: 1 };
  f.nextRead = reading('2066.2', 20662);
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'meter.other_machine');
  assert.match(f.said.at(-1)?.[1] ?? '', /मीटर का डिस्प्ले अलग है, मशीन की कंपनी अलग है/);
  assert.equal(f.meters().length, 1);
  assert.deepEqual(Buffer.from(f.compared[0].a.bytes), Buffer.from(photo(1).bytes), 'compared with the kept start photo');
  assert.deepEqual(Buffer.from(f.compared[0].b.bytes), Buffer.from(photo(2).bytes));
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.meters().length, 1, 'a refused photo cannot be confirmed');
  // Unsure: read back once; "हाँ" records it.
  f.nextSame = { ok: true, same: 'unsure', differs: [], model: 'stand-in', latencyMs: 1 };
  await f.talk.onImage(operator, photo(3));
  assert.equal(f.last(), 'meter.same_unsure');
  assert.match(f.said.at(-1)?.[1] ?? '', /2066\.2/);
  assert.equal(f.meters().length, 1);
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_end_saved');
  assert.equal(f.meters().length, 2);
});

test('same machine yes: the end reading is recorded at once', async (tc) => {
  const f = await jcbJob(tc);
  await start(f);
  f.nextRead = reading('2066.2', 20662);
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'jcb.meter_end_saved');
  assert.equal(f.compared.length, 1);
  assert.equal(f.meters().length, 2);
});

test('the comparison failing (error or timeout) never blocks work: recorded as before, said in the log only', async (tc) => {
  for (const failure of [{ ok: false, transient: true, reason: 'timeout' }, new Error('offline')]) {
    const f = await jcbJob(tc);
    await start(f);
    f.nextSame = failure;
    f.nextRead = reading('2066.2', 20662);
    await f.talk.onImage(operator, photo(2));
    assert.equal(f.last(), 'jcb.meter_end_saved');
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /same-machine check/);
    assert.ok(f.said.every(([key]) => !key.startsWith('meter.')), 'the person is not told about the failure');
  }
});

test('a date on the display: another day is refused; the day before (night shift) and no date are fine', async (tc) => {
  const f = await jcbJob(tc);
  // The live case: an old photo showing "26 OCT" for a job on 29 Oct.
  f.nextRead = reading('6799.9', 67999, '26 OCT');
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'meter.display_date');
  assert.match(f.said.at(-1)?.[1] ?? '', /26 OCT.*29 अक्टूबर 2026/);
  assert.equal(f.meters().length, 0);
  f.nextRead = reading('2061.7', 20617, '28 OCT');
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'jcb.meter_start_saved', 'a night shift that began the day before');
  f.nextRead = reading('2066.2', 20662, null);
  await f.talk.onImage(operator, photo(3));
  assert.equal(f.last(), 'jcb.meter_end_saved', 'no date on the display');
});

test('display dates code reads, and the ones it ignores', () => {
  const near = '2026-10-29';
  assert.deepEqual(displayDays('26 OCT', near), ['2026-10-26']);
  assert.deepEqual(displayDays('Oct 26', near), ['2026-10-26']);
  assert.deepEqual(displayDays('26-Oct-2026', near), ['2026-10-26']);
  assert.deepEqual(displayDays('26/10/2026', near), ['2026-10-26']);
  assert.deepEqual(displayDays('26.10.26', near), ['2026-10-26']);
  assert.deepEqual(displayDays('2026-10-26', near), ['2026-10-26']);
  assert.deepEqual(displayDays('03/10', near), ['2026-10-03', '2027-03-10'], 'day-month or month-day (the nearest year)');
  assert.deepEqual(displayDays('31 DEC', '2027-01-01'), ['2026-12-31'], 'no year: the nearest one');
  for (const raw of ['', 'SERVICE', '12:30', '31/02/2026', '99 OCT', null]) assert.equal(displayDays(raw, near), null, String(raw));
  const nowMs = Date.parse('2026-10-29T02:30:00Z');
  assert.equal(displayDateWrong('garbled ?? text', near, nowMs).wrong, false, 'unparseable is ignored');
  assert.equal(displayDateWrong('29 OCT', near, nowMs).wrong, false);
  assert.equal(displayDateWrong('26 OCT', null, nowMs).wrong, false, 'a job without a day rules nothing out');
  assert.equal(displayDateWrong('10/29', near, nowMs).wrong, false, 'month-day');
  assert.equal(displayDateWrong('03/10', near, nowMs).wrong, true, 'neither reading is near the job');
  // Work done a day later than booked: today's date is fine too.
  assert.equal(displayDateWrong('30 OCT', near, Date.parse('2026-10-30T05:00:00Z')).wrong, false);
});

test('the webhook carries the forwarded flag; a forwarded challan photo is still read', async (tc) => {
  /** @param {any} context */
  const inbound = (context) => parseInbound({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'line-1' },
    messages: [{ from: '919000000002', id: 'wamid.invented', timestamp: '1761700000', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' }, ...(context ? { context } : {}) }],
  } }] }] })[0];
  assert.equal(inbound({ forwarded: true }).forwarded, true);
  assert.equal(inbound({ frequently_forwarded: true }).forwarded, true);
  assert.equal(inbound(null).forwarded, undefined);
  assert.equal(inbound({ forwarded: false }).forwarded, undefined);

  // Challans are often forwarded by the supplier's staff: only meter photos are refused.
  const s = await setup();
  tc.after(() => s.close());
  const items = [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }];
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-10-29', items } })).ok, true);
  await settle();
  const orderId = String(/** @type {any} */ (s.supCore.ledger.orders()[0]).order_id);
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } })).ok, true);
  await settle();
  /** @type {string[]} */ const keys = [];
  const talk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark: async () => ({ ok: true, toolCalls: [] }), now: s.supCore.now,
    classifyPhoto: seesPhoto('challan'), reply: (_p, key) => { keys.push(key); },
    readChallan: async () => ({ ok: true, kind: 'challan', challanNo: '701', date: '2026-10-29', clear: true, items: [{ ...items[0], raw: '50' }] }) });
  await talk.onImage(supplier, { ...photo(7), forwarded: true });
  assert.equal(keys.at(-1), 'supplier.delivery_sent');
});
