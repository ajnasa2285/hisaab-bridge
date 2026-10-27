import { validAnswer } from './answers.js';

/** @param {number} numerator @param {number} denominator */
function rate(numerator, denominator) {
  return { numerator, denominator, basisPoints: denominator ? Math.round(numerator * 10000 / denominator) : null };
}

/** @typedef {Awaited<ReturnType<typeof import('../src/readers/meter.js').readMeter>>} Reading */
/** Pure aggregate projection: no keys, names, raw readings, clocks or private identifiers.
 * @param {{prediction:Reading,expected?:unknown,elapsedMs:number}[]} rows */
export function summarizeMeters(rows) {
  let labeled = 0, readable = 0, exact = 0, valueExact = 0, wrong = 0, assessedConfident = 0;
  let unclear = 0, confident = 0, notMeter = 0, failures = 0, clockCount = 0, clockExact = 0;
  let classificationCount = 0, classificationExact = 0;
  for (const row of rows) {
    const p = row.prediction, a = row.expected;
    const hasAnswer = validAnswer(a);
    if (hasAnswer) {
      labeled++;
      classificationCount++;
      if (p.ok && p.kind === a.kind) classificationExact++;
      if (a.kind === 'hour_meter' && a.clear) {
        readable++;
        if (p.ok && p.kind === 'hour_meter' && p.clear && p.valueTenths === a.valueTenths) {
          valueExact++;
          if (p.raw === a.raw) exact++;
        }
      }
      if (a.kind === 'hour_meter' && a.dashClock !== null) {
        clockCount++;
        if (p.ok && p.kind === 'hour_meter' && p.dashClock === a.dashClock) clockExact++;
      }
    }
    if (!p.ok) { failures++; continue; }
    if (p.kind === 'not_meter') { notMeter++; continue; }
    if (!p.clear || p.valueTenths === null) { unclear++; continue; }
    confident++;
    if (hasAnswer) {
      assessedConfident++;
      // A confident value on evidence the human cannot read is unsafe too.
      if (a.kind !== 'hour_meter' || !a.clear || p.valueTenths !== a.valueTenths) wrong++;
    }
  }
  const times = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  return {
    evaluated: rows.length, labeled, unlabeled: rows.length - labeled, failures,
    confident, unclear, notMeter,
    exactAccuracy: rate(exact, readable), valueAccuracy: rate(valueExact, readable),
    classificationAccuracy: rate(classificationExact, classificationCount), dashClockAccuracy: rate(clockExact, clockCount),
    wrongButConfidentCount: labeled ? wrong : null,
    assessedConfident, unassessedConfident: confident - assessedConfident,
    unclearRate: rate(unclear, rows.length), failureRate: rate(failures, rows.length),
    latencyMs: { count: times.length, total: times.reduce((a, b) => a + b, 0),
      p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null },
  };
}

/** @param {{input_tokens:number|null,output_tokens:number|null,costNanoUsd:number|null}[]} calls */
export function summarizeCosts(calls) {
  return {
    attempts: calls.length, knownUsageCalls: calls.filter(c => c.input_tokens !== null && c.output_tokens !== null).length,
    inputTokens: calls.reduce((sum, c) => sum + (c.input_tokens ?? 0), 0),
    outputTokens: calls.reduce((sum, c) => sum + (c.output_tokens ?? 0), 0),
    knownCostNanoUsd: calls.reduce((sum, c) => sum + (c.costNanoUsd ?? 0), 0),
    unknownCostCalls: calls.filter(c => c.costNanoUsd === null).length,
    costIsComplete: calls.every(c => c.costNanoUsd !== null),
    pricingDate: '2026-10-27',
  };
}
