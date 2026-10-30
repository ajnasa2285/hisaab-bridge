// One open question per person (red-team whatsapp1, whatsapp2): a notice never takes the place of an
// open read-back, later questions wait and are asked in turn, and a yes/no older than the question is
// not an answer to it. A person with no open question sees no change. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { person } from './helpers.js';

const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000081' };
const T0 = Date.parse('2026-10-30T06:00:00Z');
const MIN = 60_000;

/** @param {{open?: () => boolean}} [o] */
function desk(o = {}) {
  let nowMs = T0;
  /** @type {string[]} */
  const ran = [];
  /** @type {[string, any][]} */
  const said = [];
  /** @param {string} name @returns {import('../../src/agents/common.js').Tool} */
  const tool = (name) => ({ roles: ['contractor'], commits: true, describe: () => ({ key: `ask.${name}` }), stillOpen: name === 'accept_bill' ? o.open : undefined,
    run: () => { ran.push(name); return { ok: true, key: `did.${name}` }; } });
  const ledger = /** @type {any} */ ({ orders: () => [], events: () => [], view: () => ({}), order: () => null });
  const talk = createConversation({ ledger, now: () => nowMs, tools: { book: tool('book'), accept_bill: tool('accept_bill'), confirm_payment: tool('confirm_payment') },
    spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }), reply: (_p, key, params) => { said.push([key, params]); } });
  return { talk, ran, said, advance: (/** @type {number} */ ms) => { nowMs += ms; }, now: () => nowMs, keys: () => said.map(([k]) => k) };
}

test('whatsapp1: a notice does not steal the yes meant for the open question; it is asked next', async () => {
  const d = desk();
  d.talk.expect(contractor, 'book', { orderId: 'o1' }, undefined, { key: 'notice.book' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' }, undefined, { key: 'notice.bill', params: { ref: 'P-2' } });
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, ['book'], 'the open question, not the newest notice');
  assert.deepEqual(d.said, [['did.book', undefined], ['notice.bill', { ref: 'P-2' }]], 'then the waiting question is asked, in its own words');
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, ['book', 'accept_bill']);
});

test('whatsapp1: a no to the open question leaves the waiting one to be asked; three in turn', async () => {
  const d = desk();
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' });
  d.talk.expect(contractor, 'confirm_payment', { orderId: 'o3' }, { tool: 'book', args: { orderId: 'o3', no: true } });
  await d.talk.onText(contractor, 'नहीं');
  assert.deepEqual(d.ran, []);
  assert.deepEqual(d.keys(), ['step.cancelled', 'ask.accept_bill']);
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, ['accept_bill']);
  await d.talk.onText(contractor, 'नहीं');
  assert.deepEqual(d.ran, ['accept_bill', 'book'], 'the waiting question keeps what its "no" means');
});

test('whatsapp1: the same question twice is asked once', async () => {
  const d = desk();
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' });
  await d.talk.onText(contractor, 'हाँ');
  await d.talk.onText(contractor, 'हाँ');
  await d.talk.onText(contractor, 'मदद');
  assert.deepEqual(d.ran, ['book', 'accept_bill']);
});

test('whatsapp1: a question that lapsed: a bare yes is not the answer to the waiting one, which is asked first', async () => {
  const d = desk();
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' }, undefined, { key: 'notice.bill' });
  d.advance(31 * MIN);
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, [], 'nothing runs on it');
  assert.deepEqual(d.keys(), ['notice.bill']);
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, ['accept_bill']);
});

test('whatsapp1: a waiting question that no longer applies is dropped, not asked', async () => {
  let open = true;
  const d = desk({ open: () => open });
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' }, undefined, { key: 'notice.bill' });
  open = false;
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.keys(), ['did.book']);
  assert.equal(d.talk.pending(contractor), null);
});

test('whatsapp1: with no open question nothing changes: the notice\'s yes runs at once, with no extra message', async () => {
  const d = desk();
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' }, undefined, { key: 'notice.bill' });
  await d.talk.onText(contractor, 'हाँ');
  assert.deepEqual(d.ran, ['accept_bill']);
  assert.deepEqual(d.keys(), ['did.accept_bill']);
});

test('whatsapp2: a yes older than the question is not an answer; the question stays and is asked again', async () => {
  const d = desk();
  d.advance(10 * MIN);
  d.talk.expect(contractor, 'accept_bill', { orderId: 'o2' }, undefined, { key: 'notice.bill' });
  await d.talk.onText(contractor, 'हाँ', { atMs: T0 + 5 * MIN });
  assert.deepEqual(d.ran, []);
  assert.deepEqual(d.keys(), ['notice.bill']);
  assert.notEqual(d.talk.pending(contractor), null);
  await d.talk.onText(contractor, 'हाँ', { atMs: d.now() + 2000 });
  assert.deepEqual(d.ran, ['accept_bill']);
});

test('whatsapp2: a no older than the question decides nothing either', async () => {
  const d = desk();
  d.advance(10 * MIN);
  d.talk.expect(contractor, 'book', { orderId: 'o1' }, { tool: 'accept_bill', args: { orderId: 'o1' } }, { key: 'notice.book' });
  await d.talk.onText(contractor, 'नहीं', { atMs: T0 });
  assert.deepEqual(d.ran, []);
  assert.deepEqual(d.keys(), ['notice.book']);
});

test('whatsapp2: WhatsApp\'s time is in whole seconds: a quick answer in the same second counts', async () => {
  const d = desk();
  d.advance(10 * MIN + 400);
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  await d.talk.onText(contractor, 'हाँ', { atMs: Math.floor(d.now() / 1000) * 1000 });
  assert.deepEqual(d.ran, ['book']);
  // A message without a time (a test stand-in, a missing timestamp) is handled as before.
  d.talk.expect(contractor, 'book', { orderId: 'o1' });
  await d.talk.onText(contractor, 'हाँ', { atMs: 0 });
  assert.deepEqual(d.ran, ['book', 'book']);
});
