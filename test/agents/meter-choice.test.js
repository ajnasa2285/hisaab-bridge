// A meter photo with two open jobs (live, 31 Oct: J-2 and J-3 both booked, and no answer resolved
// "which job?"): the photo is held as the one open question, the jobs are listed by number, reference,
// site and day, a number or a reference answers it, and the normal meter flow goes on for that job.
// A reference in the photo's caption answers it before it is asked. Readers are stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000002' };
const contractor = person('contractor', 'agent:contractor-1');
const settle = () => new Promise((r) => setTimeout(r, 30));
/** @param {number} n */
const photo = (n) => ({ mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([0xff, 0xd8, n, n, n]) });
/** @param {number} valueTenths @param {boolean} [clear] */
const reading = (valueTenths, clear = true) => ({ ok: true, kind: 'hour_meter', raw: (valueTenths / 10).toFixed(1), valueTenths: clear ? valueTenths : null, clear, displayDate: null });

/**
 * Two (or `jobs`) JCB jobs booked, and the operator's conversation with a stand-in reader.
 * @param {import('node:test').TestContext} tc @param {number} [jobs]
 */
async function desk(tc, jobs = 2) {
  const s = await setup();
  tc.after(() => s.close());
  for (let i = 1; i <= jobs; i += 1) {
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: `Invented Site ${i}`, day: `2026-11-0${i}`, hoursTenths: 60 } })).ok, true);
    await settle();
    s.advance(1000);
  }
  const ids = s.jcbCore.ledger.orders().map((/** @type {any} */ x) => String(x.order_id));
  for (const orderId of ids) assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } })).ok, true);
  await settle();
  /** @type {[string, string][]} */ const said = [];
  /** @type {any[]} */ const reads = [];
  const f = {
    s, ids, said, reads,
    /** @type {any} */ next: reading(20617),
    /** @type {number} */ models: 0,
    last: () => said.at(-1)?.[0],
    lastText: () => said.at(-1)?.[1] ?? '',
    meters: (/** @type {string} */ id) => s.jcbCore.ledger.events(id).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE'),
    /** @type {any} */ talk: null,
  };
  f.talk = createConversation({
    ledger: s.jcbCore.ledger, tools: s.jcb.tools, now: s.jcbCore.now, classifyPhoto: seesPhoto('meter'),
    spark: async () => { f.models += 1; return { ok: true, toolCalls: [{ name: 'help', args: {} }] }; },
    readMeter: async (image) => { reads.push(image); return f.next; },
    reply: (_p, key, params) => { said.push([key, t(key, params)]); },
  });
  return f;
}

test('two booked jobs: the photo is held, unread, and the jobs are listed by number, reference, site and day', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'meter.which_job');
  for (const part of ['1. J-1', 'Invented Site 1', '1 नवंबर 2026', '2. J-2', 'Invented Site 2', '2 नवंबर 2026']) assert.ok(f.lastText().includes(part), `${part} in: ${f.lastText()}`);
  assert.equal(f.reads.length, 0, 'read only once the job is known');
  assert.equal(f.talk.pending(operator)?.kind, 'meter_job');
  for (const id of f.ids) assert.equal(f.meters(id).length, 0);
});

test('a number answers it: that job gets the reading, the other nothing; the held photo is the one read', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(7));
  await f.talk.onText(operator, '2');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.meters(f.ids[0]).length, 0);
  assert.equal(f.meters(f.ids[1]).length, 1);
  assert.deepEqual([...f.reads[0].bytes], [...photo(7).bytes]);
  assert.equal(f.talk.pending(operator), null);
  assert.equal(f.models, 0, 'the model never saw the answer');
});

for (const [answer, index] of /** @type {[string, number][]} */ ([['J-1', 0], ['j2', 1], ['जे 2', 1], ['१', 0], ['2.', 1]])) {
  test(`"${answer}" answers it`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(operator, photo(1));
    await f.talk.onText(operator, answer);
    assert.equal(f.last(), 'jcb.meter_start_saved');
    assert.equal(f.meters(f.ids[index]).length, 1);
    assert.equal(f.meters(f.ids[1 - index]).length, 0);
  });
}

for (const answer of ['3', 'J-9', 'हाँ']) {
  test(`"${answer}" does not say which job: asked again, the photo still held`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(operator, photo(1));
    await f.talk.onText(operator, answer);
    assert.equal(f.last(), 'meter.which_job');
    assert.equal(f.talk.pending(operator)?.kind, 'meter_job');
    await f.talk.onText(operator, '1');
    assert.equal(f.meters(f.ids[0]).length, 1);
  });
}

for (const word of ['नहीं', 'रद्द', 'cancel']) {
  test(`"${word}" drops the photo; nothing is recorded`, async (tc) => {
    const f = await desk(tc);
    await f.talk.onImage(operator, photo(1));
    await f.talk.onText(operator, word);
    assert.equal(f.last(), 'step.cancelled');
    assert.equal(f.talk.pending(operator), null);
    assert.equal(f.reads.length, 0);
    for (const id of f.ids) assert.equal(f.meters(id).length, 0);
  });
}

test('any other message lapses the question, drops the photo, and is read as a new message', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, 'मशीन कब आएगी');
  assert.equal(f.models, 1);
  assert.equal(f.talk.pending(operator), null);
  for (const id of f.ids) assert.equal(f.meters(id).length, 0);
});

test('after the choice the normal flow goes on: an unclear reading asks for the digits, for that job', async (tc) => {
  const f = await desk(tc);
  f.next = reading(20617, false);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, 'J-2');
  assert.equal(f.last(), 'meter.ask_person');
  assert.equal(f.talk.pending(operator)?.kind, 'meter_digits');
  await f.talk.onText(operator, '2061.7');
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.meters(f.ids[1])[0].body.valueTenths, 20617);
  assert.equal(f.meters(f.ids[0]).length, 0);
});

test('a job working and a job booked also ask; the end reading goes to the job chosen', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, photo(1));
  await f.talk.onText(operator, '1');
  f.next = reading(20667);
  await f.talk.onImage(operator, photo(2));
  assert.equal(f.last(), 'meter.which_job');
  await f.talk.onText(operator, '1');
  assert.equal(f.last(), 'jcb.meter_end_saved');
  assert.deepEqual(f.meters(f.ids[0]).map((e) => e.body.which), ['start', 'end']);
});

test('a reference in the caption answers it before it is asked', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, { ...photo(1), caption: 'J-2 शुरू' });
  assert.equal(f.last(), 'jcb.meter_start_saved');
  assert.equal(f.meters(f.ids[1]).length, 1);
  assert.equal(f.meters(f.ids[0]).length, 0);
});

test('a caption with no reference, or a job not open, still asks', async (tc) => {
  const f = await desk(tc);
  for (const caption of ['आज का मीटर', 'J-9', 'J-1 J-2']) {
    await f.talk.onImage(operator, { ...photo(1), caption });
    assert.equal(f.last(), 'meter.which_job', caption);
  }
  assert.equal(f.reads.length, 0);
});

test('one open job: no question, and a caption naming another job is asked about, never put on this one', async (tc) => {
  const f = await desk(tc, 1);
  await f.talk.onImage(operator, { ...photo(1), caption: 'J-5' });
  assert.equal(f.last(), 'meter.which_job');
  assert.equal(f.meters(f.ids[0]).length, 0);
  await f.talk.onImage(operator, photo(1));
  assert.equal(f.last(), 'jcb.meter_start_saved');
});

test('a forwarded photo is refused before anything is asked', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(operator, { ...photo(1), forwarded: true });
  assert.equal(f.last(), 'meter.forwarded');
  assert.equal(f.talk.pending(operator), null);
});

test('a notice that asks something waits behind the question, and is asked after it', async (tc) => {
  const f = await desk(tc);
  await f.talk.onImage(owner, photo(1));
  assert.equal(f.last(), 'meter.which_job');
  f.talk.expect(owner, 'send_bill', { orderId: f.ids[0] });
  assert.equal(f.talk.pending(owner)?.kind, 'meter_job', 'the open question stays');
  await f.talk.onText(owner, '2');
  assert.equal(f.said.at(-2)?.[0], 'jcb.meter_start_saved');
  assert.equal(f.last(), 'step.send_bill');
});
