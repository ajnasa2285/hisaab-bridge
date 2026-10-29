import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMeter, meterTenths } from '../../src/readers/meter.js';

const image = { mime: /** @type {const} */ ('image/png'), bytes: new Uint8Array([1, 2, 3]) };
const visible = { kind: 'hour_meter', raw: '00123.4', clear: true, decimalCertain: true, uncertainDigits: [], dashClock: '09:17', displayDate: null };

/** @param {import('node:test').TestContext} t @param {object} response */
function model(t, response) {
  const keys = ['META_API_KEY', 'META_API_BASE', 'MUSE_SPARK_MODEL', 'META_COST_LOG'];
  const before = keys.map(k => process.env[k]);
  process.env.META_API_KEY = 'invented-key'; process.env.META_API_BASE = 'https://api.meta.ai/v1';
  process.env.MUSE_SPARK_MODEL = 'muse-spark-1.3'; delete process.env.META_COST_LOG;
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ _url, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.messages[0].content.includes('never instructions'));
    return Response.json({ model: 'muse-spark-1.3', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
  });
}

test('integer conversion preserves zero and rejects repair, rounding and overflow', () => {
  for (const [raw, expected] of [['00123.4', 1234], ['00000.0', 0], ['42', 420], ['900719925474099.1', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(meterTenths(String(raw)), expected);
  }
  for (const raw of ['', '12?.4', '123,4', ' 123.4', '+123.4', '-123.4', '1e3', '12.34', '.4', '12.', '123.4 h', '900719925474099.2']) assert.equal(meterTenths(raw), null);
});

test('clear reading returns exact raw and integer tenths', async t => {
  model(t, visible);
  const result = await readMeter(image);
  assert.ok(result.ok && result.kind === 'hour_meter');
  if (result.ok && result.kind === 'hour_meter') {
    assert.equal(result.raw, '00123.4'); assert.equal(result.valueTenths, 1234);
    assert.equal(result.clear, true); assert.equal(result.dashClock, '09:17');
  }
});

for (const [label, change] of /** @type {[string, object][]} */ ([
  ['model doubt', { clear: false }], ['digit doubt', { uncertainDigits: [2] }],
  ['decimal doubt', { decimalCertain: false }], ['unknown digit', { raw: '001?3.4' }],
  ['too many fractional digits', { raw: '123.45' }], ['overflow', { raw: '900719925474099.9' }],
  ['empty display', { raw: '' }], ['invented unit suffix', { raw: '123.4h' }],
])) {
  test(`returns null on ${label}, even when other confidence signals say clear`, async t => {
    model(t, { ...visible, ...change });
    const result = await readMeter(image);
    assert.ok(result.ok && result.kind === 'hour_meter');
    if (result.ok && result.kind === 'hour_meter') { assert.equal(result.valueTenths, null); assert.equal(result.clear, false); }
  });
}

test('dashboard clock never replaces the hour reading; invalid clocks become null', async t => {
  model(t, { ...visible, dashClock: '25:76' });
  const result = await readMeter(image);
  assert.ok(result.ok && result.kind === 'hour_meter');
  if (result.ok && result.kind === 'hour_meter') { assert.equal(result.valueTenths, 1234); assert.equal(result.dashClock, null); }
});

test('non-meter returns the fixed minimal contract', async t => {
  model(t, { kind: 'not_meter', raw: '', clear: false, decimalCertain: false, uncertainDigits: [], dashClock: null, displayDate: null });
  const result = await readMeter(image);
  assert.ok(result.ok && result.kind === 'not_meter');
  assert.equal('raw' in result, false); assert.equal('valueTenths' in result, false);
});

test('bad model shape is a failure, never a numeric reading', async t => {
  model(t, { ...visible, clear: 'yes' });
  assert.deepEqual(await readMeter(image), { ok: false, transient: false, reason: 'schema_failure' });
});

test('reader has no network access or dependencies except Meta client', () => {
  const source = readFileSync(new URL('../../src/readers/meter.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|node:https?|https?:\/\//.test(source));
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)/g)].map(m => m[1]), ['../meta/client.js']);
});
