import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPhoto, PHOTO_VERSION } from '../src/readers/photo.js';
import { createPrivateData, REPO, splitDigest } from './private-data.js';
import { validateCheckpointDate } from './checkpoint.js';
import { summarizePhotos } from './photo-metrics.js';

/** @typedef {import('./private-data.js').DatasetKind} DatasetKind */
/** @typedef {ReturnType<typeof createPrivateData>} Store */
/** @typedef {{kind:DatasetKind,store:Store,split:import('./private-data.js').Split|null}} Dataset */
/** @type {DatasetKind[]} */
const DATASETS = ['meter', 'upi', 'challan'];

/** Read existing membership only. Never initialize, freeze or move a photo.
 * @param {(kind:DatasetKind)=>Store} [createStore] @returns {Dataset[]} */
export function loadPhotoDatasets(createStore = createPrivateData) {
  return DATASETS.map(kind => {
    const store = createStore(kind);
    let names;
    try { names = store.imageNames(); }
    catch (error) {
      // A future dataset folder may not exist yet. Other filesystem errors fail closed.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { kind, store, split: null };
      throw error;
    }
    if (!names.length && !store.readPrivateJson('split.json', null)) return { kind, store, split: null };
    return { kind, store, split: store.loadSplit() };
  });
}

/** Readiness does not open pixels, write checkpoints or invoke a model.
 * @param {Dataset[]} datasets */
export function photoReadiness(datasets) {
  return { reader: PHOTO_VERSION, truth: 'dataset_folder', perKind: Object.fromEntries(datasets.map(({ kind, split }) => {
    const entries = Object.values(split?.files ?? {});
    const development = entries.filter(entry => entry.side === 'development').length;
    const heldout = entries.length - development;
    return [kind, { images: entries.length, development, heldout, frozen: split?.frozen ?? false,
      status: !entries.length ? 'awaiting_photos' : 'assigned', heldoutReady: heldout > 0 && split?.frozen === true }];
  })) };
}

/** Validate every participating dataset before spending on any photo.
 * @param {Dataset[]} datasets @param {{heldout:boolean,dateIST:string,readerHash:string}} options */
export function preparePhotoRun(datasets, { heldout, dateIST, readerHash }) {
  const side = heldout ? 'heldout' : 'development';
  /** @type {Map<string,{kind:DatasetKind,side:string}>} */
  const hashes = new Map();
  for (const { kind, split } of datasets) for (const entry of Object.values(split?.files ?? {})) {
    const seen = hashes.get(entry.sha256);
    if (seen && (seen.side !== entry.side || seen.kind !== kind)) throw new Error('photo_split_leakage_or_conflicting_kind');
    hashes.set(entry.sha256, { kind, side: entry.side });
  }
  const plans = datasets.map(dataset => {
    const { store, split } = dataset;
    const files = Object.entries(split?.files ?? {}).filter(([, entry]) => entry.side === side);
    const prior = split ? store.readPrivateJson('photo-heldout-lock.json', null) : null;
    if (prior && prior.splitDigest !== splitDigest(/** @type {import('./private-data.js').Split} */ (split))) throw new Error('photo_frozen_split_changed');
    for (const [name, entry] of files) if (store.imageHash(name) !== entry.sha256) throw new Error('image_changed');
    if (heldout && files.length) {
      validateCheckpointDate(store.readPrivateJson('checkpoint-plan.json', null), dateIST);
      if (!split?.frozen) throw new Error('photo_heldout_requires_frozen_split');
      if (prior?.checkpoints?.includes(dateIST)) throw new Error('photo_heldout_checkpoint_already_used');
    }
    return { ...dataset, files, prior, promptsChangedSinceHeldout: prior ? prior.readerHash !== readerHash : false };
  });
  if (!plans.some(plan => plan.files.length)) throw new Error('empty_partition');
  return plans;
}

/** @param {string} path @returns {import('./photo-metrics.js').Cost[]} */
function readCosts(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function readerDigest() {
  const hash = createHash('sha256');
  for (const path of ['src/readers/photo.js', 'src/meta/client.js', 'src/meta/schema.js']) hash.update(readFileSync(join(REPO, path)));
  return hash.digest('hex');
}

/** @param {string} name @param {unknown} aggregate */
function saveAggregate(name, aggregate) {
  const out = join(REPO, 'eval/results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx' });
}

/** Dependencies permit invented, in-memory evaluation tests without touching private data.
 * CLI users cannot select arbitrary data paths or readers.
 * @param {{heldout:boolean,check:boolean}} options
 * @param {{createStore?:(kind:DatasetKind)=>Store,read?:typeof classifyPhoto,readCosts?:typeof readCosts,
 * saveAggregate?:typeof saveAggregate,log?:(value:unknown)=>void,readerHash?:string,dateIST?:string}} [dependencies] */
export async function runPhotoEvaluation({ heldout, check }, dependencies = {}) {
  const datasets = loadPhotoDatasets(dependencies.createStore);
  const log = dependencies.log ?? (value => console.log(JSON.stringify(value, null, 2)));
  if (check) { log(photoReadiness(datasets)); return; }
  if (heldout && process.env.npm_lifecycle_event !== 'eval') throw new Error('heldout_requires_npm_eval');
  const dateIST = dependencies.dateIST ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const readerHash = dependencies.readerHash ?? readerDigest();
  const plans = preparePhotoRun(datasets, { heldout, dateIST, readerHash });
  const side = heldout ? 'heldout' : 'development', runId = randomUUID();
  const planned = plans.reduce((sum, plan) => sum + plan.files.length, 0);
  // Reserve every participating checkpoint before the first request, including interrupted runs.
  if (heldout) for (const plan of plans) if (plan.files.length) {
    plan.store.writePrivateJson('photo-heldout-lock.json', { splitDigest: splitDigest(/** @type {import('./private-data.js').Split} */ (plan.split)),
      readerHash, checkpoints: [...(plan.prior?.checkpoints ?? []), dateIST] });
  }
  /** @type {(import('./photo-metrics.js').PhotoRow & {file:string})[]} */
  const rows = [];
  const read = dependencies.read ?? classifyPhoto, costsFor = dependencies.readCosts ?? readCosts;
  const previousLog = process.env.META_COST_LOG;
  let stopped = false;
  try {
    for (const plan of plans) {
      if (!plan.files.length) continue;
      const costFile = plan.store.privatePath(`photo-cost-${runId}.jsonl`, false);
      process.env.META_COST_LOG = costFile;
      let recordedCosts = 0;
      for (const [file] of plan.files) {
        if (stopped) break;
        const start = performance.now();
        const prediction = await read(plan.store.readImage(file));
        const elapsedMs = Math.round(performance.now() - start), costs = costsFor(costFile);
        rows.push({ file, expected: plan.kind, prediction, elapsedMs, costs: costs.slice(recordedCosts) });
        recordedCosts = costs.length;
        log({ completed: rows.length, planned, ok: prediction.ok });
        if (!prediction.ok && prediction.reason !== 'schema_failure') stopped = true;
      }
      plan.store.writePrivateJson(`photo-run-${runId}.json`, { readerHash, partition: side,
        splitDigest: splitDigest(/** @type {import('./private-data.js').Split} */ (plan.split)),
        predictions: rows.filter(row => row.expected === plan.kind) });
    }
  } finally {
    if (previousLog === undefined) delete process.env.META_COST_LOG;
    else process.env.META_COST_LOG = previousLog;
  }
  const configuredModel = process.env.MUSE_SPARK_MODEL;
  const aggregate = {
    reader: PHOTO_VERSION, dateIST, partition: side,
    model: configuredModel && /^muse-spark-1\.[123]$/.test(configuredModel) ? configuredModel : null,
    truth: 'dataset_folder', status: rows.length < planned ? 'incomplete' : 'scored',
    splitFrozen: plans.filter(plan => plan.files.length).every(plan => plan.split?.frozen),
    promptsChangedSinceHeldout: plans.some(plan => plan.promptsChangedSinceHeldout),
    planned, notRun: planned - rows.length, ...summarizePhotos(rows),
    perKind: Object.fromEntries(plans.map(plan => {
      const kindRows = rows.filter(row => row.expected === plan.kind);
      return [plan.kind, { planned: plan.files.length, notRun: plan.files.length - kindRows.length,
        status: !plan.split ? 'awaiting_photos' : !plan.files.length ? 'empty_partition' : kindRows.length < plan.files.length ? 'incomplete' : 'scored',
        ...summarizePhotos(kindRows) }];
    })),
    other: { status: 'no_dataset', evaluated: 0 },
  };
  (dependencies.saveAggregate ?? saveAggregate)(`photo-${dateIST}-${side}-${runId}.json`, aggregate);
  log(aggregate);
}
