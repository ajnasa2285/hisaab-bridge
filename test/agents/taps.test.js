// A reply button names its question by a token. A tap counts only for the question open now; an
// earlier question's button, or one from before a restart, decides nothing and the open question is
// asked again. Typed words are read as always. Stand-in readers; invented data only.

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

/** One JCB job booked and the operator's conversation; what it says, with the token each reply carries. @param {import('node:test').TestContext} tc */
async function desk(tc) {
  const s = await setup({ onTell: () => {} });
  tc.after(() => s.close());
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Invented Site', day: '2026-11-03', hoursTenths: 60 } })).ok, true);
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 100000 } })).ok, true);
  await settle();
  /** @type {{key: string, text: string, token?: string}[]} */ const said = [];
  /** @type {any} */ let next = null;
  const talk = () => createConversation({
    ledger: s.jcbCore.ledger, tools: s.jcb.tools, now: s.jcbCore.now, classifyPhoto: seesPhoto('meter'),
    spark: async () => ({ ok: true, toolCalls: [{ name: 'help', args: {} }] }),
    readMeter: async () => next,
    reply: (_p, key, params, _missed, opts) => { said.push({ key, text: t(key, params), ...(opts?.token ? { token: opts.token } : {}) }); },
  });
  return {
    s, orderId, said, talk,
    /** @param {any} r */ reads: (r) => { next = r; },
    last: () => said.at(-1),
    keys: (/** @type {number} */ from) => said.slice(from).map((x) => x.key),
    start: () => meterReadings(s.jcbCore.ledger.events(orderId)).start?.valueTenths ?? null,
    rows: () => s.jcbCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'EVIDENCE').length,
  };
}

test('a yes/no question carries a fresh token; a tap with it is the typed word', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  d.reads(unsure('9989.4'));
  await talk.onImage(operator, photo(1));
  const token = d.last()?.token;
  assert.match(String(token), /^[A-Za-z0-9_-]{12}$/);
  await talk.onTap(operator, 'yes', String(token));
  assert.equal(d.last()?.key, 'jcb.meter_start_saved');
  assert.equal(d.start(), 99894);
  // A question that does not end "हाँ / नहीं" carries none.
  assert.ok(d.said.filter((x) => !x.text.endsWith('हाँ / नहीं')).every((x) => x.token === undefined));
});

test('a tap of "नहीं" with the token is the typed "नहीं": the digits are asked for', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  d.reads(unsure('9989.4'));
  await talk.onImage(operator, photo(1));
  await talk.onTap(operator, 'no', String(d.last()?.token));
  assert.deepEqual([d.last()?.key, d.last()?.token], ['meter.ask_person_blank', undefined]);
  assert.equal(d.rows(), 0);
});

test('an earlier question\'s button after a newer question decides nothing, and the open question is asked again with its own token', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  d.reads(unsure('9989.4'));
  await talk.onImage(operator, photo(1));
  const first = String(d.last()?.token);
  d.reads(unsure('9983.1'));
  await talk.onImage(operator, photo(2));
  const second = String(d.last()?.token);
  assert.notEqual(first, second, 'each question its own token');
  const before = d.said.length;
  await talk.onTap(operator, 'yes', first);
  assert.deepEqual(d.keys(before), ['common.button_old', 'meter.unsure_read_back']);
  assert.ok(d.last()?.text.includes('9983.1'));
  assert.equal(d.last()?.token, second, 'asked again with the open question\'s buttons');
  assert.equal(d.rows(), 0, 'nothing recorded');
  // Its "नहीं" decides nothing either.
  await talk.onTap(operator, 'no', first);
  assert.equal(d.rows(), 0);
  assert.equal(talk.pending(operator)?.kind, 'meter_digits');
  await talk.onTap(operator, 'yes', second);
  assert.equal(d.start(), 99831);
});

test('an earlier question\'s button with nothing open decides nothing, and says so', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  d.reads(unsure('9989.4'));
  await talk.onImage(operator, photo(1));
  const token = String(d.last()?.token);
  await talk.onText(operator, 'हाँ');
  assert.equal(d.start(), 99894);
  for (const answer of /** @type {const} */ (['yes', 'no'])) {
    const before = d.said.length;
    await talk.onTap(operator, answer, token);
    assert.deepEqual(d.keys(before), ['common.button_old_none']);
  }
  assert.equal(d.rows(), 1);
});

test('after a restart a button\'s token is unknown: nothing is decided, and the person is asked to send it again', async (tc) => {
  const d = await desk(tc);
  d.reads(unsure('9989.4'));
  const before = d.talk();
  await before.onImage(operator, photo(1));
  const token = String(d.last()?.token);
  const after = d.talk();
  await after.onTap(operator, 'yes', token);
  assert.equal(d.last()?.key, 'common.button_old_none');
  assert.equal(d.rows(), 0);
  // The photo sent again is read back again, with a new token.
  await after.onImage(operator, photo(1));
  assert.equal(d.last()?.key, 'meter.unsure_read_back');
  assert.notEqual(d.last()?.token, token);
});

test('a notice sent with buttons (an expectation) answers to its own token only', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  const args = { orderId: d.orderId, which: 'start', valueTenths: 99894, sha256: 'a'.repeat(64), takenAt: null };
  const ask = { key: 'meter.unsure_read_back', params: { reading: '9989.4' } };
  talk.expect(operator, 'record_meter', args, undefined, ask, 'invented-notice-token');
  await talk.onTap(operator, 'yes', 'invented-older-token');
  assert.deepEqual(d.keys(0), ['common.button_old', 'meter.unsure_read_back']);
  assert.equal(d.last()?.token, 'invented-notice-token');
  assert.equal(d.rows(), 0);
  await talk.onTap(operator, 'yes', 'invented-notice-token');
  assert.equal(d.start(), 99894);
});

test('typed "हाँ" and "नहीं" are read as before, whatever buttons were sent', async (tc) => {
  const d = await desk(tc);
  const talk = d.talk();
  d.reads(unsure('9989.4'));
  await talk.onImage(operator, photo(1));
  d.reads(unsure('9983.1'));
  await talk.onImage(operator, photo(2));
  await talk.onText(operator, 'हाँ');
  assert.equal(d.start(), 99831, 'a typed yes answers the question open now');
});
