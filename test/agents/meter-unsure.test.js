// An unsure meter reading with a full figure ("9989.4") is read back: "हाँ" records it, typed digits
// record their own, "नहीं" asks for the digits. Anything less is asked for as before, the digits not
// shown. Whatever is recorded goes through the same checks as typed digits. Stand-in readers.

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
/** @param {string} raw */
const unsure = (raw) => ({ ok: true, kind: 'hour_meter', raw, valueTenths: null, clear: false, displayDate: null, dashClock: null, model: 'stand-in', latencyMs: 1 });
/** @param {number} valueTenths */
const clear = (valueTenths) => ({ ok: true, kind: 'hour_meter', raw: (valueTenths / 10).toFixed(1), valueTenths, clear: true, displayDate: null, dashClock: null, model: 'stand-in', latencyMs: 1 });

/** One JCB job booked and the operator's conversation. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  const s = await setup({ onTell: () => {} });
  tc.after(() => s.close());
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-03', hoursTenths: 60 } })).ok, true);
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 100000 } })).ok, true);
  await settle();
  /** @type {[string, string][]} */ const said = [];
  const f = {
    said,
    /** @type {any} */ next: null,
    last: () => said.at(-1)?.[0],
    lastText: () => said.at(-1)?.[1] ?? '',
    readings: () => meterReadings(s.jcbCore.ledger.events(orderId)),
    rows: () => s.jcbCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE').length,
    /** @type {any} */ talk: null,
  };
  f.talk = createConversation({
    ledger: s.jcbCore.ledger, tools: s.jcb.tools, now: s.jcbCore.now, classifyPhoto: seesPhoto('meter'),
    spark: async () => ({ ok: true, toolCalls: [{ name: 'help', args: {} }] }),
    readMeter: async () => f.next,
    reply: (_p, key, params) => { said.push([key, t(key, params)]); },
  });
  return f;
}

test('an unsure start "9989.4" is read back with its figure; "हाँ" records 99894 tenths', async (tc) => {
  const f = await desk(tc);
  f.next = unsure('9989.4');
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'meter.unsure_read_back');
  assert.equal(f.lastText(), 'मीटर 9989.4 पढ़ा। सही है? हाँ / नहीं');
  assert.equal(f.rows(), 0, 'nothing recorded before the answer');
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.readings().start?.valueTenths, 99894);
  assert.equal(f.talk.pending(operator), null);
});

test('"नहीं" asks for the digits, recording nothing, and the digits typed then are the reading', async (tc) => {
  const f = await desk(tc);
  f.next = unsure('9989.4');
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, 'नहीं');
  assert.equal(f.last(), 'meter.ask_person_blank');
  assert.ok(!f.lastText().includes('9989.4'), 'the doubtful figure is not shown again');
  assert.equal(f.rows(), 0);
  assert.equal(f.talk.pending(operator)?.kind, 'meter_digits');
  // A "हाँ" now is no answer to a question no longer asked: nothing is recorded from the read figure.
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.rows(), 0);
  f.next = unsure('9989.4');
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, 'नहीं');
  await f.talk.onText(operator, '9983.1');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.readings().start?.valueTenths, 99831);
});

test('digits typed at the read-back record their own figure', async (tc) => {
  const f = await desk(tc);
  f.next = unsure('9989.4');
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '9983.1');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.readings().start?.valueTenths, 99831);
  assert.equal(f.rows(), 1);
});

test('digits with no dot typed at the read-back are still read back for a start', async (tc) => {
  const f = await desk(tc);
  f.next = unsure('9989.4');
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '99831');
  assert.equal(f.last(), 'meter.typed_no_dot');
  assert.equal(f.rows(), 0);
});

test('a raw with no dot, a "?" or nothing still asks for the digits, without showing them', async (tc) => {
  const f = await desk(tc);
  for (const [raw, key] of [['99894', 'meter.ask_person_blank'], ['', 'meter.ask_person_blank'], ['99?9.4', 'meter.ask_person'], ['9989.4?', 'meter.ask_person'], ['9989.45', 'meter.ask_person']]) {
    f.next = unsure(raw);
    await f.talk.onImage(operator, photo(1));
    assert.equal(f.last(), key, raw);
    if (raw === '99894') assert.ok(!f.lastText().includes('99894'));
    // No read figure to say yes to: a "हाँ" records nothing.
    await f.talk.onText(operator, 'हाँ');
    assert.equal(f.rows(), 0, raw);
  }
});

test('an unsure end read back: "हाँ" records the end above the start', async (tc) => {
  const f = await desk(tc);
  f.next = clear(99831);
  await f.talk.onImage(operator, photo(1));
  f.next = unsure('9989.3');
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'meter.unsure_read_back');
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_end_saved');
  assert.deepEqual([f.readings().start?.valueTenths, f.readings().end?.valueTenths], [99831, 99893]);
  assert.notEqual(f.readings().end?.sha256, f.readings().start?.sha256, 'the end keeps its own photo');
});

test('an unsure end whose figure is more than 24 h on: "हाँ" is refused, the question stays open, and the right digits are the end', async (tc) => {
  const f = await desk(tc);
  f.next = clear(10000);
  await f.talk.onImage(operator, photo(1));
  f.next = unsure('9989.3');
  await f.talk.onImage(operator, photo(2));
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'jcb.meter_hours_impossible');
  assert.equal(f.rows(), 1);
  await f.talk.onText(operator, '1006.0');
  assert.equal(f.last(), 'jcb.meter_end_saved');
  assert.equal(f.readings().end?.valueTenths, 10060);
});

test('an unsure end below the start: "हाँ" records no end; the start is offered as the thing to correct', async (tc) => {
  const f = await desk(tc);
  f.next = clear(99893);
  await f.talk.onImage(operator, photo(1));
  f.next = unsure('9983.1');
  await f.talk.onImage(operator, photo(2));
  await f.talk.onText(operator, 'हाँ');
  assert.equal(f.last(), 'step.correct_meter');
  assert.equal(f.readings().end, null);
  assert.equal(f.rows(), 1);
});
