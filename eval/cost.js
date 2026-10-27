import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {{input_tokens: number, output_tokens: number, cached_tokens: number}} TokenUsage */
/** @typedef {{model: string, latencyMs: number, ok: boolean, reason: string|null,
 * usage: TokenUsage|null, audioMs?: number|null}} CallRecord */

// Nano-USD per token: Meta standard pricing verified 2026-10-27.
// https://dev.meta.ai/docs/pricing-rate-limits
/** @param {string} model @param {TokenUsage|null} usage @param {number|null} [audioMs] */
export function costNanoUsd(model, usage, audioMs = null) {
  if (/^muse-spark-1\.[123]$/.test(model) && usage) {
    const value = (usage.input_tokens - usage.cached_tokens) * 1250 + usage.cached_tokens * 150 + usage.output_tokens * 4250;
    return Number.isSafeInteger(value) ? value : null;
  }
  // $0.18/hour = 50 nano-USD/ms. Unknown processed duration stays unknown.
  if (model === 'muse-voice-transcribe-1.0' && audioMs !== null) return audioMs * 50;
  return null;
}

/** Logs only whitelisted metadata; never request/response bodies or exceptions.
 * @param {CallRecord} record
 */
export function recordCost(record) {
  const path = process.env.META_COST_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({
    model: record.model, latencyMs: record.latencyMs, ok: record.ok, reason: record.reason,
    input_tokens: record.usage?.input_tokens ?? null, output_tokens: record.usage?.output_tokens ?? null,
    cached_tokens: record.usage?.cached_tokens ?? null,
    costNanoUsd: costNanoUsd(record.model, record.usage, record.audioMs),
  }) + '\n', { encoding: 'utf8', mode: 0o600 });
}
