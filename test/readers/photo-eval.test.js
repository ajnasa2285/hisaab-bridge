import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluationArgs } from '../../eval/checkpoint.js';
import { validateSplit, splitDigest } from '../../eval/private-data.js';
import { loadPhotoDatasets, photoReadiness, preparePhotoRun, runPhotoEvaluation } from '../../eval/photo-run.js';
import { summarizePhotos } from '../../eval/photo-metrics.js';

/** All stores, files, bytes and responses are invented and live only in memory.
 * @param {boolean} [meterHeldout] */
function fixture(meterHeldout = true) {
  /** @type {Record<import('../../eval/private-data.js').DatasetKind,import('../../eval/private-data.js').Split|null>} */
  const splits = {
    meter: { version: 1, frozen: true, files: {
      'invented-meter-dev.png': { group: 'meter-dev', side: 'development', sha256: 'a'.repeat(64) },
      ...(meterHeldout ? { 'invented-meter-held.png': { group: 'meter-held', side: /** @type {const} */ ('heldout'), sha256: 'b'.repeat(64) } } : {}),
    } },
    upi: { version: 1, frozen: false, files: {
      'invented-upi-dev.png': { group: 'upi-dev', side: 'development', sha256: 'c'.repeat(64) },
    } },
    challan: null,
  };
  /** @type {Record<string,Record<string,any>>} */
  const saved = { meter: {}, upi: {}, challan: {} };
  /** @type {string[]} */
  const opened = [], hashed = [];
  /** @type {any[]} */
  const logs = [], aggregates = [];
  /** @type {Record<string,import('../../eval/photo-metrics.js').Cost[]>} */
  const costs = {};
  /** @type {(kind:import('../../eval/private-data.js').DatasetKind)=>ReturnType<typeof import('../../eval/private-data.js').createPrivateData>} */
  const createStore = kind => ({
    imageNames: () => Object.keys(splits[kind]?.files ?? {}),
    loadSplit: () => {
      const split = splits[kind];
      if (!split) throw new Error('split_missing');
      validateSplit(split, Object.keys(split.files)); return split;
    },
    imageHash: name => { hashed.push(name); return splits[kind]?.files[name].sha256 ?? ''; },
    readImage: name => { opened.push(name); return { mime: 'image/png', bytes: new Uint8Array([kind === 'meter' ? 1 : kind === 'upi' ? 2 : 3]) }; },
    privatePath: name => `${kind}/${name}`,
    readPrivateJson: (name, fallback) => {
      assert.notEqual(name, 'answers.json', 'folder truth does not depend on field answer keys');
      return name === 'split.json' ? splits[kind] : saved[kind][name] ?? fallback;
    },
    writePrivateJson: (name, value) => { saved[kind][name] = value; },
  });
  /** @type {typeof import('../../src/readers/photo.js').classifyPhoto} */
  const read = async image => {
    const path = process.env.META_COST_LOG;
    assert.ok(path);
    (costs[path] ??= []).push({ input_tokens: 10, output_tokens: 2, costNanoUsd: 21000 });
    return { ok: true, kind: image.bytes[0] === 1 ? 'meter' : image.bytes[0] === 2 ? 'upi' : 'challan', clear: true, model: 'muse-spark-1.3', latencyMs: 5 };
  };
  const dependencies = { createStore, read, readCosts: (/** @type {string} */ path) => costs[path] ?? [],
    saveAggregate: (/** @type {string} */ name, /** @type {unknown} */ aggregate) => { aggregates.push({ name, aggregate }); },
    log: (/** @type {unknown} */ value) => { logs.push(value); }, readerHash: 'invented-reader-hash', dateIST: '2027-04-18' };
  return { splits, saved, opened, hashed, logs, aggregates, costs, dependencies };
}

/** @param {import('node:test').TestContext} t */
function npmEval(t) {
  const prior = process.env.npm_lifecycle_event;
  process.env.npm_lifecycle_event = 'eval';
  t.after(() => { if (prior === undefined) delete process.env.npm_lifecycle_event; else process.env.npm_lifecycle_event = prior; });
}

test('photo CLI accepts development, heldout and readiness, but never heldout rescoring', () => {
  assert.deepEqual(parseEvaluationArgs(['photo']), { kind: 'photo', heldout: false, scoreOnly: false, check: false });
  assert.equal(parseEvaluationArgs(['photo', '--heldout']).heldout, true);
  assert.equal(parseEvaluationArgs(['photo', '--check']).check, true);
  for (const args of [['photo', '--score-latest'], ['photo', '--heldout', '--score-latest'], ['photo', '--check', '--check']]) assert.throws(() => parseEvaluationArgs(args));
});

test('classification buckets are exclusive, unsure matching guesses do not count correct, and costs stay honest', () => {
  /** @type {import('../../eval/photo-metrics.js').PhotoRow[]} */
  const rows = [
    { expected: 'meter', prediction: { ok: true, kind: 'meter', clear: true, model: 'private-model-text', latencyMs: 1 }, elapsedMs: 10, costs: [{ input_tokens: 10, output_tokens: 2, costNanoUsd: 21000 }] },
    { expected: 'upi', prediction: { ok: true, kind: 'upi', clear: false, model: 'm', latencyMs: 1 }, elapsedMs: 20, costs: [] },
    { expected: 'challan', prediction: { ok: true, kind: 'other', clear: true, model: 'm', latencyMs: 1 }, elapsedMs: 30, costs: [{ input_tokens: null, output_tokens: null, costNanoUsd: null }] },
    { expected: 'meter', prediction: { ok: false, transient: true, reason: 'private-error-text' }, elapsedMs: 40, costs: [] },
  ];
  const result = summarizePhotos(rows);
  assert.equal(result.correct, 1); assert.equal(result.unsure, 1); assert.equal(result.wrongButConfidentCount, 1); assert.equal(result.failures, 1);
  assert.deepEqual(result.accuracy, { numerator: 1, denominator: 4, basisPoints: 2500 });
  assert.deepEqual(result.latencyMs, { count: 4, total: 100, p50: 20, p95: 40 });
  assert.equal(result.cost.knownCostNanoUsd, 21000); assert.equal(result.cost.unknownCostCalls, 1);
  assert.equal(result.cost.missingCostRecords, 2); assert.equal(result.cost.costIsComplete, false);
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(summarizePhotos([]).accuracy.basisPoints, null);
  assert.throws(() => summarizePhotos([{ ...rows[0], elapsedMs: /** @type {any} */ ('private-latency') }]), /invalid_photo_metadata/);
  assert.throws(() => summarizePhotos([{ ...rows[0], costs: [{ input_tokens: /** @type {any} */ ('private-cost'), output_tokens: 0, costNanoUsd: 0 }] }]), /invalid_photo_metadata/);
});

test('development evaluation reuses folder truth and sides, writes only numeric aggregates, and restores cost logging', async t => {
  const f = fixture(), before = JSON.stringify(f.splits);
  const originalLog = process.env.META_COST_LOG;
  process.env.META_COST_LOG = 'invented-existing-log';
  t.after(() => { if (originalLog === undefined) delete process.env.META_COST_LOG; else process.env.META_COST_LOG = originalLog; });
  await runPhotoEvaluation({ heldout: false, check: false }, f.dependencies);
  assert.deepEqual(f.opened, ['invented-meter-dev.png', 'invented-upi-dev.png']);
  assert.deepEqual(f.hashed, f.opened);
  assert.equal(JSON.stringify(f.splits), before);
  assert.equal(process.env.META_COST_LOG, 'invented-existing-log');
  const { name, aggregate } = f.aggregates[0];
  assert.match(name, /^photo-2027-04-18-development-[a-f0-9-]+\.json$/);
  assert.equal(aggregate.correct, 2); assert.equal(aggregate.planned, 2); assert.equal(aggregate.notRun, 0);
  assert.equal(aggregate.perKind.meter.correct, 1); assert.equal(aggregate.perKind.upi.correct, 1);
  assert.equal(aggregate.perKind.challan.status, 'awaiting_photos'); assert.equal(aggregate.other.status, 'no_dataset');
  assert.equal(aggregate.cost.knownCostNanoUsd, 42000); assert.equal(aggregate.cost.costIsComplete, true);
  assert.ok(!/invented|sha256|bytes|\.png/.test(JSON.stringify(f.logs)));
  assert.ok(Object.keys(f.saved.meter).some(key => key.startsWith('photo-run-')));
  assert.equal(f.saved.meter['photo-heldout-lock.json'], undefined);
});

test('heldout reserves only participating datasets before inference, independent of field-reader checkpoint', async t => {
  npmEval(t);
  const f = fixture(), before = JSON.stringify(f.splits);
  f.saved.meter['heldout-lock.json'] = { splitDigest: splitDigest(/** @type {import('../../eval/private-data.js').Split} */ (f.splits.meter)), readerHash: 'field-reader', checkpoints: ['2027-04-18'] };
  const oldRead = f.dependencies.read;
  f.dependencies.read = async image => {
    assert.deepEqual(f.saved.meter['photo-heldout-lock.json'].checkpoints, ['2027-04-18']);
    assert.equal(f.saved.upi['photo-heldout-lock.json'], undefined);
    return oldRead(image);
  };
  await runPhotoEvaluation({ heldout: true, check: false }, f.dependencies);
  assert.deepEqual(f.opened, ['invented-meter-held.png']);
  assert.equal(JSON.stringify(f.splits), before);
  assert.equal(f.saved.meter['heldout-lock.json'].readerHash, 'field-reader');
  assert.equal(f.aggregates[0].aggregate.perKind.upi.status, 'empty_partition');
  assert.equal(f.aggregates[0].aggregate.splitFrozen, true);
  await assert.rejects(runPhotoEvaluation({ heldout: true, check: false }, f.dependencies), /checkpoint_already_used/);
  assert.equal(f.opened.length, 1);
});

test('heldout requires explicit npm eval, due date and frozen participating split', async t => {
  const prior = process.env.npm_lifecycle_event;
  delete process.env.npm_lifecycle_event;
  t.after(() => { if (prior === undefined) delete process.env.npm_lifecycle_event; else process.env.npm_lifecycle_event = prior; });
  const f = fixture();
  await assert.rejects(runPhotoEvaluation({ heldout: true, check: false }, f.dependencies), /requires_npm_eval/);
  process.env.npm_lifecycle_event = 'eval';
  f.saved.meter['checkpoint-plan.json'] = { notBeforeIST: '2027-04-19' };
  await assert.rejects(runPhotoEvaluation({ heldout: true, check: false }, f.dependencies), /checkpoint_not_due/);
  delete f.saved.meter['checkpoint-plan.json'];
  assert.ok(f.splits.meter); f.splits.meter.frozen = false;
  await assert.rejects(runPhotoEvaluation({ heldout: true, check: false }, f.dependencies), /requires_frozen_split/);
  assert.equal(f.opened.length, 0); assert.equal(f.saved.meter['photo-heldout-lock.json'], undefined);
});

test('changed photos, changed locked membership, and cross-folder leakage fail before calls', () => {
  const f = fixture();
  let datasets = loadPhotoDatasets(f.dependencies.createStore);
  const options = { heldout: false, dateIST: '2027-04-18', readerHash: 'invented-reader-hash' };
  datasets[0].store.imageHash = () => 'd'.repeat(64);
  assert.throws(() => preparePhotoRun(datasets, options), /image_changed/);
  datasets = loadPhotoDatasets(f.dependencies.createStore);
  f.saved.meter['photo-heldout-lock.json'] = { splitDigest: 'changed', readerHash: 'hash', checkpoints: [] };
  assert.throws(() => preparePhotoRun(datasets, options), /frozen_split_changed/);
  delete f.saved.meter['photo-heldout-lock.json'];
  assert.ok(f.splits.upi); f.splits.upi.files['invented-upi-dev.png'].sha256 = 'b'.repeat(64);
  assert.throws(() => preparePhotoRun(datasets, options), /leakage_or_conflicting_kind/);
  f.splits.upi.files['invented-upi-dev.png'].sha256 = 'a'.repeat(64);
  assert.throws(() => preparePhotoRun(datasets, options), /leakage_or_conflicting_kind/);
  assert.equal(f.opened.length, 0);
});

test('readiness and empty future folders cause no pixel reads, checkpoints or outputs', async () => {
  const f = fixture();
  const readiness = photoReadiness(loadPhotoDatasets(f.dependencies.createStore));
  assert.equal(readiness.perKind.meter.development, 1); assert.equal(readiness.perKind.meter.heldout, 1);
  assert.equal(readiness.perKind.upi.heldoutReady, false); assert.equal(readiness.perKind.challan.status, 'awaiting_photos');
  await runPhotoEvaluation({ heldout: true, check: true }, f.dependencies);
  assert.equal(f.opened.length, 0); assert.equal(f.hashed.length, 0); assert.equal(f.aggregates.length, 0);
  assert.deepEqual(f.saved, { meter: {}, upi: {}, challan: {} });
  assert.ok(!JSON.stringify(f.logs).includes('invented'));
  const createStore = f.dependencies.createStore;
  const missing = loadPhotoDatasets(kind => kind === 'challan' ? { ...createStore(kind), imageNames: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } : createStore(kind));
  assert.equal(missing[2].split, null);
  assert.throws(() => loadPhotoDatasets(kind => ({ ...createStore(kind), imageNames: () => { throw new Error('private_root_redirected'); } })), /private_root_redirected/);
});

test('infrastructure failure stops across kinds, counts unrun photos, and consumes a heldout checkpoint', async t => {
  npmEval(t);
  const f = fixture();
  f.dependencies.read = async () => ({ ok: false, transient: true, reason: 'timeout' });
  await runPhotoEvaluation({ heldout: false, check: false }, f.dependencies);
  const result = f.aggregates[0].aggregate;
  assert.equal(result.status, 'incomplete'); assert.equal(result.notRun, 1); assert.equal(result.failures, 1);
  assert.equal(result.perKind.upi.notRun, 1); assert.equal(result.cost.costIsComplete, false);
  await runPhotoEvaluation({ heldout: true, check: false }, f.dependencies);
  await assert.rejects(runPhotoEvaluation({ heldout: true, check: false }, f.dependencies), /checkpoint_already_used/);
});

test('schema failures do not prevent other photos from being evaluated', async () => {
  const f = fixture(), oldRead = f.dependencies.read;
  f.dependencies.read = async image => image.bytes[0] === 1 ? { ok: false, transient: false, reason: 'schema_failure' } : oldRead(image);
  await runPhotoEvaluation({ heldout: false, check: false }, f.dependencies);
  const result = f.aggregates[0].aggregate;
  assert.equal(result.evaluated, 2); assert.equal(result.notRun, 0); assert.equal(result.failures, 1); assert.equal(result.correct, 1);
});
