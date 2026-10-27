import { validUpiAnswer } from './upi-answers.js';
import { validUpiTime } from '../src/readers/upi.js';

/** @typedef {Awaited<ReturnType<typeof import('../src/readers/upi.js').readUpi>>} UpiReading */
/** @typedef {'amountPaise'|'date'|'time'|'utr'|'status'|'payeeName'|'payeeVpa'|'payerName'} UpiField */
/** @type {UpiField[]} */
const FIELDS = ['amountPaise', 'date', 'time', 'utr', 'status', 'payeeName', 'payeeVpa', 'payerName'];

/** @param {number} numerator @param {number} denominator */
function rate(numerator, denominator) {
  return { numerator, denominator, basisPoints: denominator ? Math.round(numerator * 10000 / denominator) : null };
}

/** UTC timestamp spelling may omit zero milliseconds without changing the instant.
 * All other fields retain exact equality. @param {UpiField} field @param {unknown} left @param {unknown} right */
function sameField(field, left, right) {
  return left === right || (field === 'time' && validUpiTime(left) && validUpiTime(right)
    && Date.parse(left) === Date.parse(right));
}

/** Pure projection: only static field names and aggregate numbers can leave this module.
 * Null expected fields do not earn accuracy credit for a model abstention. A non-null
 * prediction on an expected-null field is unsupported evidence, not a proven typo.
 * Wrong-but-confident conservatively includes both errors and unsupported claims.
 * @param {{prediction:UpiReading,expected?:unknown,elapsedMs:number}[]} rows */
export function summarizeUpi(rows) {
  let labeled = 0, readable = 0, exact = 0, failures = 0, confident = 0, unclear = 0, notUpi = 0;
  let classificationExact = 0, assessedConfident = 0, wrongButConfident = 0;
  let incorrectButConfident = 0, unsupportedButConfident = 0;
  let incorrectFieldClaims = 0, unsupportedFieldClaims = 0, unassessedFieldClaims = 0;
  /** @type {Record<UpiField,{expected:number,correct:number,nonNullClaims:number,incorrectClaims:number,unsupportedClaims:number,unassessedClaims:number}>} */
  const counts = /** @type {any} */ (Object.fromEntries(FIELDS.map(f => [f,
    { expected: 0, correct: 0, nonNullClaims: 0, incorrectClaims: 0, unsupportedClaims: 0, unassessedClaims: 0 }])));

  for (const row of rows) {
    const p = row.prediction, a = row.expected;
    const hasAnswer = validUpiAnswer(a);
    if (hasAnswer) {
      labeled++;
      if (p.ok && p.kind === a.kind) classificationExact++;
      if (a.kind === 'upi_payment') {
        for (const field of FIELDS) {
          if (a[field] === null) continue;
          counts[field].expected++;
          if (p.ok && p.kind === 'upi_payment' && sameField(field, p[field], a[field])) counts[field].correct++;
        }
        if (a.clear) {
          readable++;
          if (p.ok && p.kind === 'upi_payment' && p.clear && FIELDS.every(f => sameField(f, p[f], a[f]))) exact++;
        }
      }
    }
    if (!p.ok) { failures++; continue; }
    if (p.kind === 'not_upi') { notUpi++; continue; }
    if (p.clear) confident++;
    else unclear++;

    let wrongFields = 0, unsupportedFields = 0;
    for (const field of FIELDS) {
      if (p[field] === null) continue;
      counts[field].nonNullClaims++;
      if (!hasAnswer) {
        counts[field].unassessedClaims++; unassessedFieldClaims++;
      } else if (a.kind === 'not_upi' || (a[field] !== null && !sameField(field, p[field], a[field]))) {
        counts[field].incorrectClaims++; incorrectFieldClaims++; wrongFields++;
      } else if (a[field] === null) {
        counts[field].unsupportedClaims++; unsupportedFieldClaims++; unsupportedFields++;
      }
    }
    if (p.clear && hasAnswer) {
      assessedConfident++;
      if (wrongFields > 0 || unsupportedFields > 0 || a.kind === 'not_upi') wrongButConfident++;
      if (wrongFields > 0 || a.kind === 'not_upi') incorrectButConfident++;
      if (unsupportedFields > 0) unsupportedButConfident++;
    }
  }

  const fieldAccuracy = Object.fromEntries(FIELDS.map(f => [f, rate(counts[f].correct, counts[f].expected)]));
  const fieldClaims = Object.fromEntries(FIELDS.map(f => [f, {
    nonNull: counts[f].nonNullClaims, incorrect: counts[f].incorrectClaims,
    unsupported: counts[f].unsupportedClaims, unassessed: counts[f].unassessedClaims,
  }]));
  const times = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  return {
    evaluated: rows.length, labeled, unlabeled: rows.length - labeled, failures,
    confident, unclear, notUpi, exactAccuracy: rate(exact, readable),
    classificationAccuracy: rate(classificationExact, labeled), fieldAccuracy, fieldClaims,
    wrongButConfidentCount: labeled ? wrongButConfident : null,
    incorrectButConfidentCount: labeled ? incorrectButConfident : null,
    unsupportedButConfidentCount: labeled ? unsupportedButConfident : null,
    assessedConfident, unassessedConfident: confident - assessedConfident,
    incorrectFieldClaims, unsupportedFieldClaims, unassessedFieldClaims,
    unsafeFieldClaims: incorrectFieldClaims + unsupportedFieldClaims,
    unclearRate: rate(unclear, rows.length), failureRate: rate(failures, rows.length),
    latencyMs: { count: times.length, total: times.reduce((a, b) => a + b, 0),
      p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null },
  };
}
