// The trace recorder on its own: masking, what is never kept, retention, correlation to an order,
// and that a failure inside it is dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, maskDigits, openTrace, traceCheck, withTrace } from '../../src/trace/trace.js';
import { sparkJob, traceReader, traceSpark, traceTools } from '../../src/trace/hooks.js';

test('runs of 8 or more digits are masked, shorter figures are kept; a UTR keeps its own field', () => {
  assert.equal(maskDigits('call 9190000000123 or ९१९०००००००१२'), 'call ••••••••••••• or ••••••••••••');
  assert.equal(maskDigits('हाँ 1200, 6.1 घंटे, चालान 412'), 'हाँ 1200, 6.1 घंटे, चालान 412');
  assert.deepEqual(clean({ utr: '000011112222', note: 'utr 000011112222' }), { utr: '000011112222', note: 'utr ••••••••••••' });
});

test('bytes, images, audio and phones never enter a detail', () => {
  const d = /** @type {any} */ (clean({ bytes: new Uint8Array([1, 2]), image: { bytes: 'x' }, audio: 'a', phone: '919000000001', kept: { raw: new Uint8Array([3]), ok: 1 } }));
  assert.deepEqual(d, { kept: { raw: null, ok: 1 } });
});

test('a person\'s words are kept only when text is on', () => {
  const off = openTrace({ agent: 'site' });
  const on = openTrace({ agent: 'site', text: true });
  assert.equal(off.words('हाँ 1200'), null);
  assert.equal(on.words('मेरा नंबर 9190000000123 है'), 'मेरा नंबर ••••••••••••• है');
  off.close();
  on.close();
});

test('a conversation id is a keyed hash, never the phone, stable for one person', () => {
  const rec = openTrace({ agent: 'jcb', secret: 'k' });
  const p = { agent: 'agent:jcb-1', line: 'line', phone: '919000000001' };
  assert.match(rec.convoOf(p), /^c-[0-9a-f]{10}$/);
  assert.equal(rec.convoOf(p), rec.convoOf({ ...p }));
  assert.notEqual(rec.convoOf(p), rec.convoOf({ ...p, phone: '919000000002' }));
  assert.ok(!rec.convoOf(p).includes('0000001'));
  rec.close();
});

test('only the last entries are kept', () => {
  const rec = openTrace({ agent: 'site', keep: 5 });
  for (let i = 0; i < 12; i += 1) rec.add('check', `c${i}`, { pass: true });
  assert.deepEqual(rec.list().map((e) => e.title), ['c7', 'c8', 'c9', 'c10', 'c11']);
  rec.close();
});

test('entries of a handling join its order once known; a check inside the handling is recorded; outside it nothing', async () => {
  const rec = openTrace({ agent: 'jcb' });
  traceCheck('outside', true);
  await withTrace(rec, { convo: 'c-1', role: 'operator' }, async () => {
    rec.add('received', 'photo from operator', { channel: 'photo' });
    traceCheck('meter end above start ✓ 1240.6 > 1234.5', true, { startTenths: 12345, endTenths: 12406 });
    rec.attach('order-1');
    rec.add('reply', 'jcb.meter_end_saved → operator', { key: 'jcb.meter_end_saved' });
  });
  const all = rec.list();
  assert.deepEqual(all.map((e) => [e.kind, e.orderId, e.convo]), [['received', 'order-1', 'c-1'], ['check', 'order-1', 'c-1'], ['reply', 'order-1', 'c-1']]);
  assert.equal(all[1].detail.endTenths, 12406);
  assert.deepEqual(rec.list({ orderId: 'other' }), []);
  rec.close();
});

test('a broken trace drops its entries and never throws into the agent', async () => {
  const rec = openTrace({ agent: 'site' });
  rec.close();
  assert.doesNotThrow(() => rec.add('check', 'x', {}));
  const spark = traceSpark(async (/** @type {any} */ _req) => ({ ok: true, toolCalls: [{ name: 'request_jcb', args: {} }] }), rec);
  assert.deepEqual(await spark({ text: 'x', tools: [] }), { ok: true, toolCalls: [{ name: 'request_jcb', args: {} }] });
  const tools = traceTools({ step: { roles: ['contractor'], commits: true, run: () => ({ ok: true, key: 'done' }) } }, rec);
  assert.deepEqual(await withTrace(rec, { convo: 'c' }, () => tools.step.run(/** @type {any} */ ({ role: 'contractor' }), {})), { ok: true, key: 'done' });
});

test('model steps: the job from the request shape, the model, effort, latency and the structured output, never the prompt or image', async () => {
  const rec = openTrace({ agent: 'site' });
  assert.equal(sparkJob({ schema: {} }, {}), 'explain');
  assert.equal(sparkJob({ tools: [{ function: { name: 'orders' } }, { function: { name: 'answer' } }] }, { ok: true, toolCalls: [{ name: 'orders' }] }), 'ask_plan');
  assert.equal(sparkJob({ tools: [{ function: { name: 'answer' } }] }, { ok: true, toolCalls: [{ name: 'answer', args: {} }] }), 'ask_answer');
  assert.equal(sparkJob({ tools: [{ function: { name: 'request_jcb' } }] }, {}), 'understand');
  const spark = traceSpark(async (/** @type {any} */ _req) => ({ ok: true, toolCalls: [{ name: 'request_jcb', args: { site: 'Shivpuri', hours: '6' } }], model: 'muse-spark-1.2', latencyMs: 812 }), rec);
  await spark({ system: 'SECRET PROMPT', text: 'kal JCB', tools: [{ type: 'function', function: { name: 'request_jcb' } }], reasoningEffort: 'minimal' });
  const read = traceReader('meter', async (/** @type {any} */ _image) => ({ ok: true, kind: 'hour_meter', raw: '1234.5', valueTenths: 12345, clear: true, dashClock: null, model: 'muse-spark-1.2', latencyMs: 2100 }), rec);
  await read?.({ mime: 'image/jpeg', bytes: new TextEncoder().encode('IMAGE-BYTES') });
  const [m, r] = rec.list();
  assert.deepEqual([m.kind, m.detail.job, m.detail.model, m.detail.reasoningEffort, m.ms, m.detail.calls[0].tool, m.detail.calls[0].args.site], ['model', 'understand', 'muse-spark-1.2', 'minimal', 812, 'request_jcb', 'Shivpuri']);
  assert.deepEqual([r.detail.job, r.detail.raw, r.detail.valueTenths, r.ms, r.title], ['meter', '1234.5', 12345, 2100, 'meter reads 1234.5']);
  const json = JSON.stringify(rec.list());
  assert.ok(!json.includes('SECRET PROMPT') && !json.includes('IMAGE-BYTES') && !json.includes('kal JCB'));
  rec.close();
});
