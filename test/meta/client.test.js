import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { museSpark, transcribe, listModels } from '../../src/meta/client.js';
import { supportedSchema, matchesSchema } from '../../src/meta/schema.js';
import { costNanoUsd } from '../../eval/cost.js';

const MODEL = 'muse-spark-1.3';
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

/** @param {import('node:test').TestContext} t */
function environment(t) {
  const keys = ['META_API_KEY', 'META_API_BASE', 'MUSE_SPARK_MODEL', 'MUSE_TRANSCRIBE_MODEL', 'META_COST_LOG'];
  const before = keys.map(k => process.env[k]);
  process.env.META_API_KEY = 'invented-unit-test-key';
  process.env.META_API_BASE = 'https://api.meta.ai/v1';
  process.env.MUSE_SPARK_MODEL = MODEL;
  process.env.MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
  delete process.env.META_COST_LOG;
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
}

/** @param {unknown} [content] @param {object} [extra] */
function body(content = '{"value":"invented"}', extra = {}) {
  return { model: MODEL, choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } }, ...extra };
}

test('Spark sends documented Meta image/schema shape, returns validated JSON', async t => {
  environment(t);
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ url, /** @type {any} */ init) => {
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, MODEL);
    assert.equal(sent.messages[0].role, 'system');
    assert.deepEqual(sent.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
    assert.deepEqual(sent.response_format, { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } });
    return Response.json(body());
  });
  const result = await museSpark({ system: 'invented instructions', text: 'invented question', images: [{ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }], schema });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.json, { value: 'invented' });
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
    assert.deepEqual(result.toolCalls, []);
  }
});

test('reasoning effort is sent only when asked, and only a documented level', async t => {
  environment(t);
  /** @type {any[]} */
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ _url, /** @type {any} */ init) => { sent.push(JSON.parse(init.body)); return Response.json(body()); });
  assert.ok((await museSpark({ text: 'invented', schema, reasoningEffort: 'minimal' })).ok);
  assert.ok((await museSpark({ text: 'invented', schema })).ok);
  assert.equal(sent[0].reasoning_effort, 'minimal');
  assert.equal(Object.hasOwn(sent[1], 'reasoning_effort'), false);
  for (const level of ['none', 'fast', '']) {
    const result = await museSpark({ text: 'invented', schema, reasoningEffort: /** @type {any} */ (level) });
    assert.equal(result.ok, false);
  }
  assert.equal(sent.length, 2, 'an unknown level never reaches the network');
});

test('missing configuration and unsafe hosts/models never contact the network', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  for (const [key, value] of [['META_API_KEY', ''], ['META_API_BASE', 'https://elsewhere.invalid/v1'], ['META_API_BASE', 'https://api.meta.ai/v1@elsewhere.invalid'], ['MUSE_SPARK_MODEL', 'muse-spark-1.3-contributor'], ['MUSE_SPARK_MODEL', '']]) {
    const saved = process.env[key]; process.env[key] = value;
    const result = await museSpark({ text: 'synthetic' });
    assert.equal(result.ok, false);
    process.env[key] = saved;
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('unsupported schemas and invalid input fail before sending evidence', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  assert.equal((await museSpark({ text: 'test', schema: { $ref: 'https://elsewhere.invalid/schema' } })).ok, false);
  assert.equal((await museSpark({ text: 'test', timeoutMs: -1 })).ok, false);
  assert.equal((await museSpark({ text: 'test', images: [{ mime: 'image/png', bytes: new Uint8Array() }] })).ok, false);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const status of [400, 401, 403, 404]) {
  test(`HTTP ${status} fails permanently without retries or echoing server text`, async t => {
    environment(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('invented sensitive server text', { status }));
    const result = await museSpark({ text: 'synthetic' });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.transient, false); assert.equal(result.reason, `http_${status}`); }
    assert.equal(fetch.mock.callCount(), 1);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  });
}

for (const status of [429, 503]) {
  test(`HTTP ${status} has exactly two retries then returns transient failure`, async t => {
    environment(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
    const result = await museSpark({ text: 'synthetic' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.transient, true);
    assert.equal(fetch.mock.callCount(), 3);
  });
}

test('transient response then success is recovered', async t => {
  environment(t); let count = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? new Response('', { status: 502 }) : Response.json(body()));
  assert.equal((await museSpark({ text: 'synthetic' })).ok, true);
  assert.equal(count, 2);
});

test('timeouts have bounded retries; errors never echo prompts or secrets', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('invented sensitive exception', 'TimeoutError'); });
  const result = await museSpark({ text: 'synthetic' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, 'timeout'); assert.equal(result.transient, true); }
  assert.equal(fetch.mock.callCount(), 3);
});

test('a timeout while reading the body is retryable too', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw new DOMException('body timeout', 'TimeoutError'); } }));
  const result = await museSpark({ text: 'synthetic' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'timeout');
  assert.equal(fetch.mock.callCount(), 3);
});

for (const [label, data] of [
  ['missing field', body('{}')], ['wrong type', body('{"value":42}')], ['extra field', body('{"value":"x","extra":true}')],
  ['invalid JSON', body('not json')], ['different model', body(undefined, { model: 'unverified-model' })],
  ['missing usage', body(undefined, { usage: null })],
  ['truncated', body(undefined, { choices: [{ finish_reason: 'length', message: { content: '{"value":"x"}' } }] })],
  ['refusal', body(undefined, { choices: [{ finish_reason: 'stop', message: { content: '{"value":"x"}', refusal: 'no' } }] })],
]) {
  test(`fails closed on ${label}`, async t => {
    environment(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(data));
    const result = await museSpark({ text: 'synthetic', schema });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.reason, 'schema_failure'); assert.equal(result.transient, false); }
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('invalid HTTP JSON fails without retry', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{'));
  const result = await museSpark({ text: 'synthetic' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_json');
  assert.equal(fetch.mock.callCount(), 1);
});

test('tool calls validate names and arguments, never execute', async t => {
  environment(t);
  let name = 'read_status', args = '{"value":"synthetic"}';
  t.mock.method(globalThis, 'fetch', async () => Response.json(body(null, {
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ type: 'function', function: { name, arguments: args } }] } }],
  })));
  const request = { text: 'synthetic', tools: [{ type: 'function', function: { name: 'read_status', parameters: schema } }] };
  const result = await museSpark(request);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.toolCalls, [{ name: 'read_status', args: { value: 'synthetic' } }]);
  name = 'unexpected'; assert.equal((await museSpark(request)).ok, false);
  name = 'read_status'; args = '{"value":false}'; assert.equal((await museSpark(request)).ok, false);
});

test('cost log records every attempt and known token cost, without content', async t => {
  environment(t);
  const dir = mkdtempSync(fileURLToPath(new URL('./scratch-', import.meta.url)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.META_COST_LOG = join(dir, 'cost.jsonl');
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? new Response('fake private body', { status: 503 }) : Response.json(body()));
  await museSpark({ text: 'fake private prompt' });
  const text = readFileSync(process.env.META_COST_LOG, 'utf8');
  const lines = text.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].costNanoUsd, null);
  assert.equal(lines[1].costNanoUsd, 199000);
  assert.ok(!/private|invented-unit-test-key|messages|content/.test(text));
});

test('catalog is single request and returns model IDs only', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: MODEL, private: 'do not echo' }, { id: 'bad with spaces' }] }));
  assert.deepEqual(await listModels(), { ok: true, models: [MODEL] });
  assert.equal(fetch.mock.callCount(), 1);
});

/** Made-up mono 16 kHz PCM silence. */
function wav() {
  const b = Buffer.alloc(364);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40);
  return b;
}

test('voice uses documented multipart fields and top-level transcript', async t => {
  environment(t);
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ url, /** @type {any} */ init) => {
    assert.equal(url, 'https://api.meta.ai/v1/asr/transcribe');
    assert.equal(init.headers.Accept, 'application/json');
    assert.ok(init.body instanceof FormData);
    const request = JSON.parse(await init.body.get('request').text());
    assert.deepEqual(request, { model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: ['Hindi'] });
    return Response.json({ transcript: 'यह एक परीक्षण है', audioDurationMs: 10, turns: [] });
  });
  const result = await transcribe({ audio: wav(), mime: 'audio/wav', language: 'hi' });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.text, 'यह एक परीक्षण है');
});

test('voice rejects unsupported audio without uploading it', async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload'); });
  assert.equal((await transcribe({ audio: wav(), mime: 'audio/ogg' })).ok, false);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.equal((await transcribe({ audio: stereo, mime: 'audio/wav' })).ok, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('schema subset fails closed and handles nulls, arrays, constraints', () => {
  assert.equal(supportedSchema({ type: 'string', format: 'date' }), false);
  assert.equal(supportedSchema({ type: 'string', pattern: '[' }), false);
  assert.equal(matchesSchema(null, { type: ['string', 'null'] }), true);
  assert.equal(matchesSchema([1, 2], { type: 'array', items: { type: 'integer', maximum: 1 } }), false);
  assert.equal(matchesSchema('ab', { type: 'string', minLength: 3 }), false);
  assert.equal(matchesSchema('123', { anyOf: [{ type: 'string' }, { type: 'null' }] }), true);
  assert.equal(costNanoUsd(MODEL, { input_tokens: 100, output_tokens: 20, cached_tokens: 10 }), 199000);
  assert.equal(costNanoUsd('muse-voice-transcribe-1.0', null, 1000), 50000);
});
