import { validChallanAnswer } from './challan-answers.js';

/** @typedef {Awaited<ReturnType<typeof import('../src/readers/challan.js').readChallan>>} ChallanReading */
/** @typedef {'challanNo'|'date'|'vehicle'} ChallanField */
/** @type {ChallanField[]} */
const FIELDS = ['challanNo', 'date', 'vehicle'];

/** @param {number} numerator @param {number} denominator */
function rate(numerator, denominator) {
  return { numerator, denominator, basisPoints: denominator ? Math.round(numerator * 10000 / denominator) : null };
}
/** @param {unknown} v */
const folded = v => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : v;

/** @param {{name:string,qtyHundredths:number|null,unit:string|null}} a @param {{name:string,qtyHundredths:number|null,unit:string|null}} b */
function sameItem(a, b) { return folded(a.name) === folded(b.name) && a.qtyHundredths === b.qtyHundredths && a.unit === b.unit; }
/** Printed order, same length, every line equal.
 * @param {any[]} left @param {any[]} right */
function sameItems(left, right) { return left.length === right.length && left.every((item, i) => sameItem(item, right[i])); }
/** @param {ChallanField} field @param {unknown} left @param {unknown} right */
function sameField(field, left, right) { return left === right || (field !== 'date' && folded(left) === folded(right)); }

/** Pure projection of aggregate numbers only. A non-null claim on a field the human marked absent is
 * unsupported; a different non-null claim is incorrect; either makes a confident reading wrong-but-confident.
 * A non-empty item list is a claim that must equal the human list.
 * @param {{prediction:ChallanReading,expected?:unknown,elapsedMs:number}[]} rows */
export function summarizeChallan(rows) {
  let labeled = 0, readable = 0, exact = 0, failures = 0, confident = 0, unclear = 0, notChallan = 0;
  let classificationExact = 0, assessedConfident = 0, wrongButConfident = 0, itemListsExpected = 0, itemListsCorrect = 0;
  let incorrectFieldClaims = 0, unsupportedFieldClaims = 0, unassessedFieldClaims = 0, itemListMistakes = 0;
  /** @type {Record<ChallanField,{expected:number,correct:number,nonNullClaims:number,incorrectClaims:number,unsupportedClaims:number}>} */
  const counts = /** @type {any} */ (Object.fromEntries(FIELDS.map(f => [f, { expected: 0, correct: 0, nonNullClaims: 0, incorrectClaims: 0, unsupportedClaims: 0 }])));

  for (const row of rows) {
    const p = row.prediction, a = row.expected;
    const hasAnswer = validChallanAnswer(a);
    if (hasAnswer) {
      labeled++;
      if (p.ok && p.kind === a.kind) classificationExact++;
      if (a.kind === 'challan') {
        const readableChallan = p.ok && p.kind === 'challan';
        for (const field of FIELDS) {
          if (a[field] === null) continue;
          counts[field].expected++;
          if (readableChallan && sameField(field, p[field], a[field])) counts[field].correct++;
        }
        if (a.items.length) { itemListsExpected++; if (readableChallan && sameItems(p.items, a.items)) itemListsCorrect++; }
        if (a.clear) {
          readable++;
          if (readableChallan && p.clear && FIELDS.every(f => sameField(f, p[f], a[f])) && sameItems(p.items, a.items)) exact++;
        }
      }
    }
    if (!p.ok) { failures++; continue; }
    if (p.kind === 'not_challan') { notChallan++; continue; }
    if (p.clear) confident++; else unclear++;

    let wrong = 0;
    for (const field of FIELDS) {
      if (p[field] === null) continue;
      counts[field].nonNullClaims++;
      if (!hasAnswer) { unassessedFieldClaims++; continue; }
      if (a.kind === 'not_challan' || (a[field] !== null && !sameField(field, p[field], a[field]))) { counts[field].incorrectClaims++; incorrectFieldClaims++; wrong++; }
      else if (a[field] === null) { counts[field].unsupportedClaims++; unsupportedFieldClaims++; wrong++; }
    }
    if (hasAnswer && p.items.length && (a.kind === 'not_challan' || !sameItems(p.items, a.items))) { itemListMistakes++; wrong++; }
    if (p.clear && hasAnswer) {
      assessedConfident++;
      if (wrong > 0 || a.kind === 'not_challan') wrongButConfident++;
    }
  }

  const times = rows.map(r => r.elapsedMs).sort((x, y) => x - y);
  return {
    evaluated: rows.length, labeled, unlabeled: rows.length - labeled, failures,
    confident, unclear, notChallan, exactAccuracy: rate(exact, readable),
    classificationAccuracy: rate(classificationExact, labeled),
    fieldAccuracy: Object.fromEntries(FIELDS.map(f => [f, rate(counts[f].correct, counts[f].expected)])),
    itemListAccuracy: rate(itemListsCorrect, itemListsExpected),
    fieldClaims: Object.fromEntries(FIELDS.map(f => [f, { nonNull: counts[f].nonNullClaims, incorrect: counts[f].incorrectClaims, unsupported: counts[f].unsupportedClaims }])),
    wrongButConfidentCount: labeled ? wrongButConfident : null,
    assessedConfident, unassessedConfident: confident - assessedConfident,
    incorrectFieldClaims, unsupportedFieldClaims, unassessedFieldClaims, itemListMistakes,
    unsafeFieldClaims: incorrectFieldClaims + unsupportedFieldClaims + itemListMistakes,
    unclearRate: rate(unclear, rows.length), failureRate: rate(failures, rows.length),
    latencyMs: { count: times.length, total: times.reduce((x, y) => x + y, 0),
      p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null },
  };
}
