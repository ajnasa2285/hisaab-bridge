import { setTimeout as delay } from 'node:timers/promises';
import { recordCost } from '../../eval/cost.js';
import { isObject, matchesSchema, supportedSchema } from './schema.js';

/** @typedef {{mime: 'image/jpeg'|'image/png'|'image/webp', bytes: Uint8Array}} ImageInput */
/** @typedef {{input_tokens: number, output_tokens: number}} Usage */
/** @typedef {{ok:false, transient:boolean, reason:string, latencyMs:number}} Failure */
/** @typedef {{ok:true, json:any, text:string, toolCalls:{name:string,args:any}[], usage:Usage, model:string, latencyMs:number}} SparkSuccess */
const SPARK_MODELS = new Set(['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3']);
const BASE = 'https://api.meta.ai/v1';
// Documented Chat Completions levels (https://dev.meta.ai/docs/reasoning); "none" is a 400 for Spark.
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
let costLogFailed = false;

/** @param {string} reason @param {number} start @param {boolean} [transient] @returns {Failure} */
function failure(reason, start, transient = false) {
  return { ok: false, transient, reason, latencyMs: Math.round(performance.now() - start) };
}

/** @param {'spark'|'voice'} kind */
function config(kind) {
  const key = process.env.META_API_KEY;
  const base = process.env.META_API_BASE;
  const model = kind === 'spark' ? process.env.MUSE_SPARK_MODEL : process.env.MUSE_TRANSCRIBE_MODEL;
  if (!key || base !== BASE || !model) return null;
  if (kind === 'spark' ? !SPARK_MODELS.has(model) : model !== 'muse-voice-transcribe-1.0') return null;
  return { key, base, model };
}

/** @param {any} body @returns {import('../../eval/cost.js').TokenUsage|null} */
function tokenUsage(body) {
  const u = body?.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  if (![u?.prompt_tokens, u?.completion_tokens, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > u.prompt_tokens) return null;
  return { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, cached_tokens: cached };
}

/** @param {unknown} error */
function connectionReason(error) {
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  const cause = error instanceof Error ? error.cause : null;
  if (isObject(cause) && ['ENOTFOUND', 'EAI_AGAIN'].includes(cause.code)) return 'dns_failed';
  return 'connection_failed';
}

/** Bounded retries. Entire response body is covered by the attempt timeout.
 * @param {{key:string,base:string,model:string}} cfg
 * @param {string} endpoint @param {() => BodyInit} body
 * @param {Record<string,string>} headers @param {number} timeoutMs
 * @param {(body:any) => any} decode
 * @returns {Promise<any|Failure>}
 */
async function request(cfg, endpoint, body, headers, timeoutMs, decode) {
  const start = performance.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptStart = performance.now();
    let result;
    /** @type {import('../../eval/cost.js').TokenUsage|null} */
    let usage = null;
    /** @type {number|null} */
    let audioMs = null;
    try {
      const response = await fetch(`${cfg.base}${endpoint}`, {
        method: 'POST', headers: { Authorization: `Bearer ${cfg.key}`, ...headers },
        body: body(), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        result = failure(`http_${response.status}`, start, response.status === 429 || response.status >= 500);
      } else {
        let payload;
        try { payload = await response.json(); } catch (error) {
          if (error instanceof SyntaxError) result = failure('invalid_json', start);
          else throw error;
        }
        if (!result) {
          usage = tokenUsage(payload);
          if (endpoint === '/asr/transcribe' && Number.isSafeInteger(payload?.audioDurationMs) && payload.audioDurationMs >= 0) audioMs = payload.audioDurationMs;
          try { result = { ...decode(payload), model: cfg.model, latencyMs: Math.round(performance.now() - start) }; }
          catch { result = failure('schema_failure', start); }
        }
      }
    } catch (error) { result = failure(connectionReason(error), start, true); }
    try {
      recordCost({ model: cfg.model, latencyMs: Math.round(performance.now() - attemptStart),
        ok: result.ok, reason: result.ok ? null : result.reason, usage, audioMs });
    } catch (error) {
      // Cost accounting never stops the product: said once, and the model's result stands.
      if (!costLogFailed) {
        costLogFailed = true;
        console.error(`meta client: cost log not written (${isObject(error) && typeof error.code === 'string' ? error.code : 'error'})`);
      }
    }
    if (result.ok || !result.transient || attempt === 2) return result;
    await delay(250 * 2 ** attempt);
  }
  return failure('retry_exhausted', start, true);
}

/**
 * @param {{system?:string, text:string, images?:ImageInput[], schema?:object, tools?:object[], timeoutMs?:number,
 *   reasoningEffort?:'minimal'|'low'|'medium'|'high'|'xhigh'|'max'}} req
 * @returns {Promise<SparkSuccess|Failure>}
 */
export async function museSpark(req) {
  const start = performance.now();
  const cfg = config('spark');
  if (!cfg) return failure('configuration_missing_or_invalid', start);
  const timeoutMs = req.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || typeof req.text !== 'string'
    || (req.system !== undefined && typeof req.system !== 'string')
    || (req.reasoningEffort !== undefined && !REASONING_EFFORTS.has(req.reasoningEffort))) return failure('invalid_request', start);
  if (req.schema && !supportedSchema(req.schema)) return failure('unsupported_schema', start);
  const images = req.images ?? [];
  if (!Array.isArray(images) || images.length > 50 || images.some(i => !i || !['image/jpeg', 'image/png', 'image/webp'].includes(i.mime)
    || !(i.bytes instanceof Uint8Array) || i.bytes.length === 0 || i.bytes.length > 50 * 1024 * 1024)) return failure('invalid_image', start);
  const toolDefs = req.tools ?? [];
  if (!Array.isArray(toolDefs) || toolDefs.some(t => !isObject(t) || t.type !== 'function' || !isObject(t.function)
    || typeof t.function.name !== 'string' || !supportedSchema(t.function.parameters))) return failure('invalid_tools', start);
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: [ { type: 'text', text: req.text }, ...images.map(i => ({
    type: 'image_url', image_url: { url: `data:${i.mime};base64,${Buffer.from(i.bytes).toString('base64')}` },
  })) ] });
  const body = JSON.stringify({ model: cfg.model, messages,
    ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'result', schema: req.schema, strict: true } } } : {}),
    ...(toolDefs.length ? { tools: toolDefs } : {}),
  });
  return request(cfg, '/chat/completions', () => body, { 'Content-Type': 'application/json' }, timeoutMs, payload => {
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const usage = tokenUsage(payload);
    if (!usage || payload.model !== cfg.model || !message || message.refusal || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('invalid');
    const text = message.content ?? '';
    if (typeof text !== 'string') throw new Error('invalid');
    const json = req.schema ? JSON.parse(text) : null;
    if (req.schema && !matchesSchema(json, req.schema)) throw new Error('invalid');
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || (choice.finish_reason === 'tool_calls' && !calls.length)) throw new Error('invalid');
    const toolCalls = calls.map((/** @type {any} */ call) => {
      const def = toolDefs.find(t => isObject(t) && t.function.name === call?.function?.name);
      if (!isObject(def) || call.type !== 'function' || typeof call.function.arguments !== 'string') throw new Error('invalid');
      const args = JSON.parse(call.function.arguments);
      if (!matchesSchema(args, def.function.parameters)) throw new Error('invalid');
      return { name: call.function.name, args };
    });
    return { ok: true, json, text, toolCalls, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } };
  });
}

/** @param {Uint8Array} bytes */
function supportedWav(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.length > 32 * 1024 * 1024 || b.toString('ascii', 0, 4) !== 'RIFF'
    || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) return false;
  let rate = 0, dataBytes = 0, valid = false;
  for (let p = 12; p + 8 <= b.length;) {
    const tag = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    const offset = p + 8;
    if (offset + size > b.length) return false;
    if (tag === 'fmt ') {
      if (size < 16) return false;
      rate = b.readUInt32LE(offset + 4);
      valid = b.readUInt16LE(offset) === 1 && b.readUInt16LE(offset + 2) === 1
        && [16000, 24000].includes(rate) && b.readUInt16LE(offset + 14) === 16
        && b.readUInt16LE(offset + 12) === 2 && b.readUInt32LE(offset + 8) === rate * 2;
    }
    if (tag === 'data') dataBytes += size;
    p = offset + size + size % 2;
  }
  return valid && dataBytes > 0 && dataBytes % 2 === 0 && dataBytes <= rate * 2 * 600;
}

/** @param {{audio:Uint8Array,mime:string,language?:'hi'}} req
 * @returns {Promise<{ok:true,text:string,model:string,latencyMs:number}|Failure>} */
export async function transcribe(req) {
  const start = performance.now();
  const cfg = config('voice');
  if (!cfg) return failure('configuration_missing_or_invalid', start);
  if (!(req.audio instanceof Uint8Array) || !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(req.mime)
    || !supportedWav(req.audio) || (req.language !== undefined && req.language !== 'hi')) return failure('unsupported_audio', start);
  return request(cfg, '/asr/transcribe', () => {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ model: cfg.model, audioEncoding: 'WAV',
      mode: 'PUSH_TO_TALK', languageBias: ['Hindi'] })], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(req.audio)], { type: 'audio/wav' }), 'audio.wav');
    return form;
  }, { Accept: 'application/json' }, 60000, payload => {
    if (typeof payload?.transcript !== 'string' || !Number.isSafeInteger(payload.audioDurationMs)
      || payload.audioDurationMs < 0 || !Array.isArray(payload.turns)) throw new Error('invalid');
    return { ok: true, text: payload.transcript };
  });
}

/** One explicit catalog check; this is deliberately not retried. */
export async function listModels() {
  const key = process.env.META_API_KEY;
  const base = process.env.META_API_BASE;
  if (!key || base !== 'https://api.meta.ai/v1') {
    return { ok: false, reason: 'configuration_missing_or_invalid' };
  }
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    if (!Array.isArray(body.data)) return { ok: false, reason: 'invalid_catalog' };
    const models = body.data.map((/** @type {{id?: unknown}} */ item) => item.id)
      .filter((/** @type {unknown} */ id) => typeof id === 'string' && /^muse-[a-z0-9.-]+$/.test(id));
    return { ok: true, models };
  } catch {
    return { ok: false, reason: 'catalog_connection_failed' };
  }
}
