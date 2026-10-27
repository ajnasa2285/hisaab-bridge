import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerFromInput, validAnswer } from '../../eval/answers.js';
import { summarizeMeters, summarizeCosts } from '../../eval/metrics.js';
import { validateSplit } from '../../eval/private-data.js';

/** @param {Partial<Extract<import('../../eval/metrics.js').Reading,{kind:'hour_meter'}>>} [overrides]
 * @returns {import('../../eval/metrics.js').Reading} */
function reading(overrides = {}) {
  return { ok: true, kind: 'hour_meter', raw: '00123.4', valueTenths: 1234, clear: true,
    dashClock: '09:17', model: 'muse-spark-1.3', latencyMs: 100, ...overrides };
}

test('answer-key parser needs explicit valid digits and human confirmation provenance', () => {
  assert.deepEqual(answerFromInput('00123.4', '09:17'), { kind: 'hour_meter', raw: '00123.4', valueTenths: 1234, clear: true, dashClock: '09:17', confirmedBy: 'human' });
  assert.equal(answerFromInput('12?.4', ''), null);
  assert.equal(answerFromInput('12.34', ''), null);
  assert.equal(answerFromInput('123.4', '24:00'), null);
  assert.equal(validAnswer({ kind: 'not_meter' }), false);
  assert.deepEqual(answerFromInput('नहीं', ''), { kind: 'not_meter', confirmedBy: 'human' });
  const unclear = answerFromInput('?', '');
  assert.ok(unclear && unclear.kind === 'hour_meter' && unclear.valueTenths === null && !unclear.clear);
});

test('no human key means unknown accuracy and wrong-but-confident, never zero', () => {
  const result = summarizeMeters([{ prediction: reading(), elapsedMs: 100 }]);
  assert.equal(result.labeled, 0); assert.equal(result.unassessedConfident, 1);
  assert.equal(result.exactAccuracy.basisPoints, null);
  assert.equal(result.wrongButConfidentCount, null);
});

test('accuracy denominator retains abstentions, errors and misclassifications', () => {
  const expected = answerFromInput('00123.4', '09:17');
  const predictions = [reading(), reading({ raw: '00123.5', valueTenths: 1235 }),
    reading({ clear: false, valueTenths: null }),
    { ok: false, transient: true, reason: 'timeout' },
    { ok: true, kind: 'not_meter', model: 'muse-spark-1.3', latencyMs: 100 }];
  const result = summarizeMeters(predictions.map(prediction => ({ prediction: /** @type {import('../../eval/metrics.js').Reading} */ (prediction), expected, elapsedMs: 100 })));
  assert.deepEqual(result.exactAccuracy, { numerator: 1, denominator: 5, basisPoints: 2000 });
  assert.equal(result.wrongButConfidentCount, 1); assert.equal(result.unclear, 1); assert.equal(result.failures, 1);
  assert.equal(result.notMeter, 1);
});

test('confident value on unreadable or non-meter evidence counts unsafe', () => {
  const result = summarizeMeters([
    { prediction: reading(), expected: answerFromInput('?', ''), elapsedMs: 100 },
    { prediction: reading(), expected: answerFromInput('नहीं', ''), elapsedMs: 200 },
  ]);
  assert.equal(result.wrongButConfidentCount, 2);
  assert.equal(result.exactAccuracy.denominator, 0);
  assert.equal(result.latencyMs.p95, 200);
});

test('aggregate projection cannot include evidence fields or unknown caller properties', () => {
  const result = summarizeMeters([{ prediction: reading(), expected: answerFromInput('00123.4', '09:17'), elapsedMs: 100 }]);
  const json = JSON.stringify(result);
  assert.ok(!json.includes('00123.4')); assert.ok(!json.includes('09:17'));
  assert.ok(!/"raw"|"valueTenths"|"file"|"sha256"/.test(json));
});

test('unreported attempt cost remains explicitly incomplete', () => {
  const result = summarizeCosts([{ input_tokens: 10, output_tokens: 2, costNanoUsd: 21000 }, { input_tokens: null, output_tokens: null, costNanoUsd: null }]);
  assert.equal(result.knownCostNanoUsd, 21000); assert.equal(result.unknownCostCalls, 1);
  assert.equal(result.costIsComplete, false); assert.equal(result.attempts, 2);
});

test('capture groups and identical bytes cannot cross partitions; new files fail closed', () => {
  /** @type {import('../../eval/private-data.js').Split} */
  const split = { version: 1, frozen: false, files: {
    'invented-a.png': { group: 'capture-a', side: 'development', sha256: 'a'.repeat(64) },
    'invented-b.png': { group: 'capture-b', side: 'heldout', sha256: 'b'.repeat(64) },
  } };
  const names = Object.keys(split.files);
  assert.doesNotThrow(() => validateSplit(split, names));
  assert.throws(() => validateSplit(split, [...names, 'invented-c.png']));
  split.files['invented-b.png'].group = 'capture-a';
  assert.throws(() => validateSplit(split, names));
  split.files['invented-b.png'].group = 'capture-b';
  split.files['invented-b.png'].sha256 = 'a'.repeat(64);
  assert.throws(() => validateSplit(split, names));
});
