import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChallanAnswer, validChallanAnswer } from '../../eval/challan-answers.js';
import { summarizeChallan } from '../../eval/challan-metrics.js';
import { evaluationReader } from '../../eval/readers.js';
import { parseEvaluationArgs } from '../../eval/checkpoint.js';
import { parseAnswerKeyArgs } from '../../eval/answer-key.js';

/** Entirely invented values; no private files are read by these tests.
 * @param {Partial<import('../../eval/challan-answers.js').ChallanAnswerInput>} [changes] */
function input(changes = {}) {
  return { kind: /** @type {const} */ ('challan'), challanNo: 'KC-0042', date: '2026-10-20', vehicle: 'XX 00 AB-0000',
    items: [{ name: 'Cement', qty: '200', unit: 'bags' }, { name: 'Sand', qty: '12.25', unit: 'cft' }], clear: true, ...changes };
}
/** @param {object} [changes] @returns {any} */
function reading(changes = {}) {
  return { ok: true, kind: 'challan', challanNo: 'KC-0042', date: '2026-10-20', vehicle: 'XX00AB0000',
    items: [{ name: 'Cement', qtyHundredths: 20000, unit: 'bag', raw: 'x' }, { name: 'Sand', qtyHundredths: 1225, unit: 'cft', raw: 'y' }],
    clear: true, model: 'muse-spark-1.3', latencyMs: 100, ...changes };
}

test('challan human key converts quantities, units and vehicle by code', () => {
  const key = buildChallanAnswer(input());
  assert.ok(key && key.kind === 'challan');
  if (key && key.kind === 'challan') {
    assert.deepEqual(key.items, [{ name: 'Cement', qtyHundredths: 20000, unit: 'bag' }, { name: 'Sand', qtyHundredths: 1225, unit: 'cft' }]);
    assert.equal(key.vehicle, 'XX00AB0000'); assert.equal(key.clear, true); assert.ok(validChallanAnswer(key));
  }
  assert.deepEqual(buildChallanAnswer(input({ kind: 'not_challan' })), { kind: 'not_challan', confirmedBy: 'human' });
});

test('challan human key: ? and empty are null, ? disables clear, bad input is refused', () => {
  const unsure = buildChallanAnswer(input({ date: '', challanNo: '?' }));
  assert.ok(unsure && unsure.kind === 'challan' && unsure.date === null && unsure.challanNo === null && unsure.clear === false);
  const qty = buildChallanAnswer(input({ items: [{ name: 'Cement', qty: '?', unit: 'bags' }] }));
  assert.ok(qty && qty.kind === 'challan' && qty.items[0].qtyHundredths === null && qty.clear === false);
  assert.equal(buildChallanAnswer(input({ items: [{ name: 'Cement', qty: '1.234', unit: 'bags' }] })), null);
  assert.equal(buildChallanAnswer(input({ date: '03/04/2026' })), null);
  assert.equal(buildChallanAnswer(input({ items: [{ name: '', qty: '1', unit: 'bags' }] })), null);
  assert.equal(validChallanAnswer({ kind: 'challan', confirmedBy: 'claude' }), false);
});

test('challan scoring: exact reading, abstention and confident wrong reading', () => {
  const key = buildChallanAnswer(input());
  const wrongQty = reading({ items: [{ name: 'Cement', qtyHundredths: 2000, unit: 'bag', raw: 'x' }, reading().items[1]] });
  const m = summarizeChallan([
    { prediction: reading(), expected: key, elapsedMs: 10 },
    { prediction: reading({ clear: false, date: null, items: [] }), expected: key, elapsedMs: 20 },
    { prediction: wrongQty, expected: key, elapsedMs: 30 },
    { prediction: { ok: false, transient: false, reason: 'schema_failure' }, expected: key, elapsedMs: 40 },
    { prediction: { ok: true, kind: 'not_challan', model: 'm', latencyMs: 1 }, expected: { kind: 'not_challan', confirmedBy: 'human' }, elapsedMs: 50 },
  ]);
  assert.equal(m.evaluated, 5); assert.equal(m.labeled, 5); assert.equal(m.failures, 1); assert.equal(m.notChallan, 1);
  assert.deepEqual(m.exactAccuracy, { numerator: 1, denominator: 4, basisPoints: 2500 });
  assert.deepEqual(m.itemListAccuracy, { numerator: 1, denominator: 4, basisPoints: 2500 });
  assert.equal(m.fieldAccuracy.date.numerator, 2);
  assert.equal(m.wrongButConfidentCount, 1); assert.equal(m.itemListMistakes, 1);
  assert.equal(m.latencyMs.p50, 30);
});

test('challan scoring: unsupported claims and unlabeled rows are kept apart', () => {
  const key = buildChallanAnswer(input({ vehicle: '' }));
  const m = summarizeChallan([
    { prediction: reading(), expected: key, elapsedMs: 1 },
    { prediction: reading(), elapsedMs: 1 },
  ]);
  assert.equal(m.unsupportedFieldClaims, 1); assert.equal(m.wrongButConfidentCount, 1);
  assert.equal(m.unlabeled, 1); assert.equal(m.unassessedFieldClaims, 3); assert.equal(m.unassessedConfident, 1);
});

test('challan dataset kind is registered for evaluation and the answer tool', () => {
  assert.equal(evaluationReader('challan').version, 'challan-v1');
  assert.equal(parseEvaluationArgs(['challan', '--check']).kind, 'challan');
  assert.equal(parseAnswerKeyArgs(['challan']).kind, 'challan');
  assert.throws(() => parseAnswerKeyArgs(['invoice']));
});
