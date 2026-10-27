import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluationArgs, partitionDigest, validateCachedRun, validateCheckpointDate, evaluationReadiness } from '../../eval/checkpoint.js';
import { parseAnswerKeyArgs } from '../../eval/answer-key.js';
import { validateFreeze } from '../../eval/split.js';
import { createPrivateData, splitDigest, validateSplit } from '../../eval/private-data.js';
import { validAnswer, answerFromInput } from '../../eval/answers.js';
import { evaluationReader } from '../../eval/readers.js';

/** Invented membership and hashes, unrelated to private evidence.
 * @returns {import('../../eval/private-data.js').Split} */
function splitFixture() {
  return { version: 1, frozen: false, files: {
    'invented-dev.png': { group: 'dev-capture', side: 'development', sha256: 'a'.repeat(64) },
    'invented-held-a.png': { group: 'held-capture', side: 'heldout', sha256: 'b'.repeat(64) },
    'invented-held-b.png': { group: 'held-capture', side: 'heldout', sha256: 'c'.repeat(64) },
  } };
}

test('both reader commands route deliberately, invalid/combined modes fail', () => {
  assert.deepEqual(parseEvaluationArgs(['upi', '--check']), { kind: 'upi', check: true, heldout: false, scoreOnly: false });
  assert.equal(parseEvaluationArgs(['meter', '--heldout']).heldout, true);
  for (const args of [[], ['arbitrary'], ['upi', '--heldout', '--score-latest'], ['meter', '--check', '--score-latest'], ['meter', '--heldout', '--heldout']]) assert.throws(() => parseEvaluationArgs(args));
  assert.deepEqual(parseAnswerKeyArgs([]), { kind: 'meter', heldout: false, review: false });
  assert.deepEqual(parseAnswerKeyArgs(['upi', '--heldout', '--review']), { kind: 'upi', heldout: true, review: true });
  assert.throws(() => parseAnswerKeyArgs(['unknown']));
  assert.throws(() => createPrivateData(/** @type {any} */ ('../other')));
});

test('freeze requires confirmed human answers for development AND heldout', () => {
  const split = splitFixture(), known = answerFromInput('00654.3', '');
  assert.throws(() => validateFreeze(split, {}, validAnswer), /owner_labels/);
  assert.throws(() => validateFreeze(split, { 'invented-held-a.png': known, 'invented-held-b.png': known }, validAnswer), /owner_labels/);
  const answers = Object.fromEntries(Object.keys(split.files).map(n => [n, known]));
  assert.doesNotThrow(() => validateFreeze(split, answers, validAnswer));
  assert.equal(split.frozen, false, 'validation itself cannot freeze a split');
  const fake = { ...known, confirmedBy: 'model' };
  assert.throws(() => validateFreeze(split, { ...answers, 'invented-dev.png': fake }, validAnswer));
});

test('a related held-out batch must stay together and requires a nonempty other side', () => {
  const split = splitFixture();
  assert.doesNotThrow(() => validateSplit(split, Object.keys(split.files)));
  split.files['invented-held-b.png'].side = 'development';
  assert.throws(() => validateSplit(split, Object.keys(split.files)), /split_leakage/);
  const emptyHeldout = { ...split, files: { 'invented-dev.png': split.files['invented-dev.png'] } };
  assert.throws(() => validateFreeze(emptyHeldout, {}, validAnswer), /heldout_empty/);
});

test('checkpoint date prevents an early run and rejects invalid calendar dates', () => {
  assert.throws(() => validateCheckpointDate({ notBeforeIST: '2027-04-18' }, '2027-04-17'), /checkpoint_not_due/);
  assert.doesNotThrow(() => validateCheckpointDate({ notBeforeIST: '2027-04-18' }, '2027-04-18'));
  assert.doesNotThrow(() => validateCheckpointDate(null, '2027-04-18'));
  for (const notBeforeIST of ['2027-02-30', '2027-13-01', 'soon']) assert.throws(() => validateCheckpointDate({ notBeforeIST }, '2027-04-18'));
});

test('adding unseen heldout photos preserves cached development scoring', () => {
  const split = splitFixture();
  const initial = { version: /** @type {const} */ (1), frozen: false, files: { 'invented-dev.png': split.files['invented-dev.png'] } };
  const legacy = { readerHash: 'reader', splitDigest: splitDigest(initial), model: 'muse-spark-1.3', costs: [], predictions: [{ file: 'invented-dev.png', elapsedMs: 100 }] };
  assert.doesNotThrow(() => validateCachedRun(legacy, split, 'reader'));
  const modern = { ...legacy, splitDigest: 'different', partitionDigest: partitionDigest(split, 'development') };
  split.frozen = true;
  assert.doesNotThrow(() => validateCachedRun(modern, split, 'reader'));
  assert.throws(() => validateCachedRun(modern, split, 'changed-reader'));
  split.files['invented-dev.png'].sha256 = 'd'.repeat(64);
  assert.throws(() => validateCachedRun(modern, split, 'reader'));
  assert.throws(() => validateCachedRun(legacy, split, 'reader'));
});

test('duplicate or substituted cached predictions cannot pass membership validation', () => {
  const split = splitFixture();
  const cache = { readerHash: 'reader', splitDigest: splitDigest(split), predictions: [{ file: 'invented-held-a.png' }] };
  assert.throws(() => validateCachedRun(cache, split, 'reader'));
  cache.predictions = [{ file: 'invented-dev.png' }, { file: 'invented-dev.png' }];
  assert.throws(() => validateCachedRun(cache, split, 'reader'));
});

test('corrupt cached metadata cannot copy private text into aggregate model, latency or cost', () => {
  const split = splitFixture();
  const cache = { readerHash: 'reader', splitDigest: splitDigest(split), model: 'muse-spark-1.3',
    predictions: [{ file: 'invented-dev.png', elapsedMs: 100 }], costs: [{ input_tokens: 10, output_tokens: 2, costNanoUsd: 21000 }] };
  assert.doesNotThrow(() => validateCachedRun(cache, split, 'reader'));
  assert.throws(() => validateCachedRun({ ...cache, model: 'invented private text' }, split, 'reader'), /invalid_cached_metadata/);
  assert.throws(() => validateCachedRun({ ...cache, predictions: [{ file: 'invented-dev.png', elapsedMs: 'invented private text' }] }, split, 'reader'), /invalid_cached_metadata/);
  assert.throws(() => validateCachedRun({ ...cache, costs: [{ input_tokens: 'invented private text', output_tokens: 2, costNanoUsd: 21000 }] }, split, 'reader'), /invalid_cached_metadata/);
  assert.throws(() => validateCachedRun({ ...cache, costs: [{ input_tokens: 10, output_tokens: -1, costNanoUsd: 0 }] }, split, 'reader'), /invalid_cached_metadata/);
});

test('readiness reports aggregates without model calls, images, answers or filenames', () => {
  const split = splitFixture();
  const store = {
    imageNames: () => Object.keys(split.files),
    readPrivateJson: (/** @type {string} */ name) => name === 'split.json' ? split : { 'invented-dev.png': answerFromInput('00654.3', '') },
    loadSplit: () => split,
    imageHash: () => { throw new Error('must not read images'); },
    readImage: () => { throw new Error('must not read images'); },
    privatePath: () => { throw new Error('must not open files'); },
    writePrivateJson: () => { throw new Error('must not mutate'); },
  };
  const result = evaluationReadiness(evaluationReader('meter'), store);
  assert.equal(result.development, 1); assert.equal(result.heldout, 2); assert.equal(result.labeled, 1);
  assert.equal(result.readyToFreeze, false); assert.equal(result.frozen, false);
  assert.ok(!/invented|00654\.3|sha256/.test(JSON.stringify(result)));
  const empty = { ...store, imageNames: () => [], readPrivateJson: () => null };
  assert.equal(evaluationReadiness(evaluationReader('upi'), empty).status, 'awaiting_photos');
});
