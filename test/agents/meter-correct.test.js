// A wrong meter reading (live, J-4, 2 Nov: 9983.1 typed as 99831, and "9983.1" then got only the help
// text, with no way on: no end reading could follow it and a job with a reading cannot be cancelled).
// Digits with no dot are read back on a start reading; a bare figure from the operator corrects the
// latest reading before the bill, in a new row that keeps the old one. Readers are stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { meterReadings } from '../../src/agents/jcb.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000002' };
const contractor = person('contractor', 'agent:contractor-1');
const settle = () => new Promise((r) => setTimeout(r, 30));
/** @param {number} n */
const photo = (n) => ({ mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, n, n, n]) });
const unclear = { ok: true, kind: 'hour_meter', raw: '99831', valueTenths: null, clear: false, displayDate: null, dashClock: null, model: 'stand-in', latencyMs: 1 };
/** @param {number} valueTenths */
const clear = (valueTenths) => ({ ok: true, kind: 'hour_meter', raw: (valueTenths / 10).toFixed(1), valueTenths, clear: true, displayDate: null, dashClock: null, model: 'stand-in', latencyMs: 1 });

/**
 * `jobs` JCB jobs booked and the conversation of the JCB side, with a stand-in reader.
 * @param {import('node:test').TestContext} tc @param {number} [jobs]
 */
async function desk(tc, jobs = 1) {
  /** @type {[string, string, string][]} */ const told = [];
  const s = await setup({ onTell: (_side, role, key) => { told.push([role, key, '']); } });
  tc.after(() => s.close());
  for (let i = 1; i <= jobs; i += 1) {
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: `Invented Site ${i}`, day: `2026-11-0${i}`, hoursTenths: 60 } })).ok, true);
    await settle();
    s.advance(1000);
  }
  const ids = s.jcbCore.ledger.orders().map((/** @type {any} */ x) => String(x.order_id));
  for (const orderId of ids) assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 100000 } })).ok, true);
  await settle();
  /** @type {[string, string][]} */ const said = [];
  const f = {
    s, ids, said, told,
    /** @type {any} */ next: unclear,
    /** @type {number} */ models: 0,
    last: () => said.at(-1)?.[0],
    lastText: () => said.at(-1)?.[1] ?? '',
    readings: (id = ids[0]) => meterReadings(s.jcbCore.ledger.events(id)),
    rows: (id = ids[0]) => s.jcbCore.ledger.events(id).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE'),
    /** @type {any} */ talk: null,
  };
  f.talk = createConversation({
    ledger: s.jcbCore.ledger, tools: s.jcb.tools, now: s.jcbCore.now, classifyPhoto: seesPhoto('meter'),
    spark: async () => { f.models += 1; return { ok: true, toolCalls: [{ name: 'help', args: {} }] }; },
    readMeter: async () => f.next,
    reply: (_p, key, params) => { said.push([key, t(key, params)]); },
  });
  return f;
}

test('start digits with no dot are read back, and the dotted figure offered there is recorded', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'meter.ask_person');
  await f.talk.onText(operator, '99831');
  assert.equal(f.last(), 'meter.typed_no_dot');
  assert.ok(f.lastText().includes('9983.1'), f.lastText());
  assert.equal(f.rows().length, 0);
  await f.talk.onText(operator, '9983.1');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.readings().start?.valueTenths, 99831);
});

test('start digits with no dot: a yes records them as whole hours, a no records nothing', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '99831');
  await f.talk.onText(operator, 'नहीं');
  assert.equal(f.last(), 'step.cancelled');
  assert.equal(f.rows().length, 0);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '99831');
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.readings().start?.valueTenths, 998310);
});

test('the digits with a dot, on a start reading, are recorded at once as before', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '9983.1');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.readings().start?.valueTenths, 99831);
});

test('J-4 as it happened: a start of 99831 is corrected, the old row stays, and the job can finish', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '99831');
  await f.talk.onText(operator, 'हाँ');
  const first = f.rows()[0];
  // The same figure again changes nothing and is not a correction.
  await f.talk.onText(operator, '99831');
  assert.notEqual(f.last(), 'step.correct_meter');
  await f.talk.onText(operator, '9983.1');
  assert.equal(f.last(), 'step.correct_meter');
  assert.equal(f.rows().length, 1, 'read back first: nothing recorded yet');
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_corrected');
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body.valueTenths, 998310, 'the old reading is still in the ledger');
  assert.equal(rows[1].body.valueTenths, 99831);
  assert.equal(rows[1].body.sha256, first.body.sha256, 'the same photo');
  assert.equal(rows[1].body.corrects, first.msgId);
  assert.ok(f.told.some(([role, key]) => role === 'jcb_owner' && key === 'jcb.meter_corrected_owner'));
  // The end reading now follows it, and the bill comes from the corrected start.
  f.next = clear(99891);
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'jcb.meter_end_saved');
  const bill = await runTool(f.s.jcb.tools, owner, { tool: 'send_bill', args: { orderId: f.ids[0] } });
  assert.equal(bill.ok, true, bill.key);
  const sent = f.s.jcbCore.ledger.events(f.ids[0]).filter((e) => e.type === 'BILL').at(-1)?.body.body;
  assert.equal(sent.lines[0].hoursTenths, 60);
  assert.equal(sent.totalPaise, 600000);
});

test('an end reading can be corrected before the bill, and the owner gets the new hours', async (tc) => {
  const f = await desk(tc);
  f.next = clear(10000);
  await f.talk.onImage(operator, photo(1));
  f.next = clear(10080);
  await f.talk.onImage(operator, photo(2));
  await f.talk.onText(operator, '1006');
  assert.equal(f.last(), 'step.correct_meter');
  f.told.length = 0;
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_corrected');
  assert.equal(f.readings().end?.valueTenths, 10060);
  assert.deepEqual(f.told.map(([role, key]) => [role, key]), [['jcb_owner', 'jcb.meter_corrected_owner'], ['jcb_owner', 'jcb.meter_done']]);
});

test('a correction that breaks the readings is refused, and nothing is written', async (tc) => {
  const f = await desk(tc);
  f.next = clear(10000);
  await f.talk.onImage(operator, photo(1));
  f.next = clear(10060);
  await f.talk.onImage(operator, photo(2));
  const orderId = f.ids[0];
  const low = await runTool(f.s.jcb.tools, operator, { tool: 'correct_meter', args: { orderId, which: 'end', valueTenths: 9000 } });
  assert.equal(low.key, 'jcb.end_not_after_start');
  const far = await runTool(f.s.jcb.tools, operator, { tool: 'correct_meter', args: { orderId, which: 'start', valueTenths: 1000 } });
  assert.equal(far.key, 'jcb.meter_hours_impossible');
  assert.equal(f.rows().length, 2);
});

test('once a bill is out a figure is no correction, and the tool refuses it', async (tc) => {
  const f = await desk(tc);
  f.next = clear(10000);
  await f.talk.onImage(operator, photo(1));
  f.next = clear(10060);
  await f.talk.onImage(operator, photo(2));
  assert.equal((await runTool(f.s.jcb.tools, owner, { tool: 'send_bill', args: { orderId: f.ids[0] } })).ok, true);
  await settle();
  await f.talk.onText(operator, '1007');
  assert.notEqual(f.last(), 'step.correct_meter');
  const refused = await runTool(f.s.jcb.tools, operator, { tool: 'correct_meter', args: { orderId: f.ids[0], which: 'end', valueTenths: 10070 } });
  assert.equal(refused.key, 'jcb.meter_has_bill');
  assert.equal(f.rows().length, 2);
});

test('only the operator corrects, and with two jobs that have readings a bare figure decides nothing', async (tc) => {
  const f = await desk(tc, 2);
  f.next = clear(10000);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '1');
  await f.talk.onImage(operator, photo(2));
  await f.talk.onText(operator, '2');
  assert.notEqual(f.readings(f.ids[0]).start, null);
  assert.notEqual(f.readings(f.ids[1]).start, null);
  await f.talk.onText(operator, '999.9');
  assert.notEqual(f.last(), 'step.correct_meter');
  const byOwner = await runTool(f.s.jcb.tools, owner, { tool: 'correct_meter', args: { orderId: f.ids[0], which: 'start', valueTenths: 9999 } });
  assert.equal(byOwner.ok, false);
});
