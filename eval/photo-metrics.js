import { summarizeCosts } from './metrics.js';

/** @typedef {{input_tokens:number|null,output_tokens:number|null,costNanoUsd:number|null}} Cost */
/** @typedef {{expected:'meter'|'upi'|'challan'|'other',prediction:Awaited<ReturnType<typeof import('../src/readers/photo.js').classifyPhoto>>,elapsedMs:number,costs:Cost[]}} PhotoRow */

/** @param {number} numerator @param {number} denominator */
function rate(numerator, denominator) {
  return { numerator, denominator, basisPoints: denominator ? Math.round(numerator * 10000 / denominator) : null };
}

/** Project only counts and numeric metadata; never include image names or model text.
 * An unsure response stays unsure even if its tentative kind matches the folder.
 * @param {PhotoRow[]} rows */
export function summarizePhotos(rows) {
  let correct = 0, unsure = 0, wrongButConfidentCount = 0, failures = 0;
  for (const row of rows) {
    const p = row.prediction;
    if (!Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 || !Array.isArray(row.costs)
      || row.costs.some(c => !c || ['input_tokens', 'output_tokens', 'costNanoUsd'].some(key => {
        const value = c[/** @type {keyof Cost} */ (key)];
        return value !== null && (!Number.isSafeInteger(value) || value < 0);
      }))) throw new Error('invalid_photo_metadata');
    if (!p.ok) failures++;
    else if (!p.clear) unsure++;
    else if (p.kind === row.expected) correct++;
    else wrongButConfidentCount++;
  }
  const times = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const cost = summarizeCosts(rows.flatMap(row => row.costs));
  const missingCostRecords = rows.filter(row => row.costs.length === 0).length;
  return {
    evaluated: rows.length, correct, unsure, wrongButConfidentCount, failures,
    accuracy: rate(correct, rows.length), unsureRate: rate(unsure, rows.length),
    wrongButConfidentRate: rate(wrongButConfidentCount, rows.length), failureRate: rate(failures, rows.length),
    latencyMs: { count: times.length, total: times.reduce((sum, time) => sum + time, 0),
      p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null },
    cost: { ...cost, missingCostRecords, costIsComplete: cost.costIsComplete && missingCostRecords === 0 },
  };
}
