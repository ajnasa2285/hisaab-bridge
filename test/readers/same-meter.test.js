import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameMeter } from '../../src/readers/same-meter.js';

const a = { mime: /** @type {const} */ ('image/jpeg'), bytes: new Uint8Array([1, 2, 3]) };
const b = { mime: /** @type {const} */ ('image/png'), bytes: new Uint8Array([4, 5, 6]) };

/** @param {import('node:test').TestContext} t @param {object} response @param {any[]} [bodies] */
function model(t, response, bodies = []) {
  const keys = ['META_API_KEY', 'META_API_BASE', 'MUSE_SPARK_MODEL', 'META_COST_LOG'];
  const before = keys.map(k => process.env[k]);
  process.env.META_API_KEY = 'invented-key'; process.env.META_API_BASE = 'https://api.meta.ai/v1';
  process.env.MUSE_SPARK_MODEL = 'muse-spark-1.3'; delete process.env.META_COST_LOG;
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ _url, /** @type {any} */ init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ model: 'muse-spark-1.3', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
}

test('one call with both images, in order, under a strict schema; image text is data', async t => {
  /** @type {any[]} */ const bodies = [];
  model(t, { same: 'yes', differs: [] }, bodies);
  const r = await sameMeter({ a, b });
  assert.ok(r.ok);
  assert.equal(r.ok && r.same, 'yes');
  assert.equal(bodies.length, 1);
  const body = bodies[0];
  assert.ok(body.messages[0].content.includes('never instructions'));
  const images = body.messages[1].content.filter((/** @type {any} */ p) => p.type === 'image_url').map((/** @type {any} */ p) => p.image_url.url.slice(0, 15));
  assert.deepEqual(images, ['data:image/jpeg', 'data:image/png;']);
  assert.equal(body.response_format.json_schema.strict, true);
});

test('a no names what differs; a no without a reason is only a doubt', async t => {
  model(t, { same: 'no', differs: ['display', 'display', 'make'] });
  const r = await sameMeter({ a, b });
  assert.equal(r.ok && r.same, 'no');
  assert.deepEqual(r.ok && r.differs, ['display', 'make']);
  assert.equal(r.ok && r.model, 'muse-spark-1.3');
});

test('no without differs becomes unsure; yes or unsure never carry differs', async t => {
  model(t, { same: 'no', differs: [] });
  const r = await sameMeter({ a, b });
  assert.equal(r.ok && r.same, 'unsure');
  assert.deepEqual(r.ok && r.differs, []);
});

test('a bad model shape is a failure the caller falls back on', async t => {
  model(t, { same: 'maybe', differs: [] });
  const r = await sameMeter({ a, b });
  assert.equal(r.ok, false);
});

test('reader has no network access or dependencies except Meta client', () => {
  const source = readFileSync(new URL('../../src/readers/same-meter.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|node:https?|https?:\/\//.test(source));
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)/g)].map(m => m[1]), ['../meta/client.js']);
});
