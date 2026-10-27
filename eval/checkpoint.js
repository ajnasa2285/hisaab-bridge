import { createHash } from 'node:crypto';
import { splitDigest } from './private-data.js';

/** @param {string[]} args */
export function parseEvaluationArgs(args) {
  const kind = args[0];
  if (!['meter', 'upi'].includes(kind) || args.slice(1).some(a => !['--heldout', '--score-latest', '--check'].includes(a))
    || new Set(args).size !== args.length) throw new Error('invalid_arguments');
  const heldout = args.includes('--heldout'), scoreOnly = args.includes('--score-latest'), check = args.includes('--check');
  if ((heldout && scoreOnly) || (check && scoreOnly)) throw new Error('invalid_arguments');
  return { kind, heldout, scoreOnly, check };
}

/** Unseen held-out additions do not invalidate development predictions.
 * @param {import('./private-data.js').Split} split @param {'development'|'heldout'} side */
export function partitionDigest(split, side) {
  return createHash('sha256').update(JSON.stringify(Object.entries(split.files)
    .filter(([, f]) => f.side === side).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}

/** @param {any} last @param {import('./private-data.js').Split} split @param {string} readerHash */
export function validateCachedRun(last, split, readerHash) {
  const files = Object.entries(split.files).filter(([, f]) => f.side === 'development');
  if (!last || last.readerHash !== readerHash || !Array.isArray(last.predictions)
    || last.predictions.length !== files.length || new Set(last.predictions.map((/** @type {{file:string}} */ p) => p.file)).size !== files.length
    || files.some(([n]) => !last.predictions.some((/** @type {{file:string}} */ p) => p.file === n))) throw new Error('cached_run_stale');
  /** @param {unknown} v */
  const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if ((last.model !== null && (typeof last.model !== 'string' || !/^muse-spark-1\.[123]$/.test(last.model)))
    || last.predictions.some((/** @type {any} */ p) => !count(p.elapsedMs)) || !Array.isArray(last.costs)
    || last.costs.some((/** @type {any} */ c) => !c || ['input_tokens', 'output_tokens', 'costNanoUsd'].some(k => c[k] !== null && !count(c[k])))) {
    throw new Error('invalid_cached_metadata');
  }
  // Migrate old all-development caches only if the exact original split can be reconstructed.
  const initialOnly = { version: /** @type {const} */ (1), frozen: false, files: Object.fromEntries(files) };
  if (last.partitionDigest !== partitionDigest(split, 'development')
    && last.splitDigest !== splitDigest(split) && last.splitDigest !== splitDigest(initialOnly)) throw new Error('cached_run_stale');
}

/** @param {unknown} plan @param {string} dateIST */
export function validateCheckpointDate(plan, dateIST) {
  if (plan === null) return;
  if (!plan || typeof plan !== 'object' || !('notBeforeIST' in plan) || typeof plan.notBeforeIST !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(plan.notBeforeIST) || !Number.isFinite(Date.parse(plan.notBeforeIST))
    || new Date(plan.notBeforeIST).toISOString().slice(0, 10) !== plan.notBeforeIST) throw new Error('invalid_checkpoint_plan');
  if (dateIST < plan.notBeforeIST) throw new Error('checkpoint_not_due');
}

/** Aggregate readiness; never opens image pixels or calls a model.
 * @param {import('./readers.js').Reader} reader @param {ReturnType<typeof import('./private-data.js').createPrivateData>} store */
export function evaluationReadiness(reader, store) {
  const names = store.imageNames();
  const initial = store.readPrivateJson('split.json', null);
  if (!initial) return { reader: reader.version, images: names.length, assigned: 0, frozen: false,
    development: 0, heldout: 0, labeled: 0, readyToFreeze: false, status: names.length ? 'split_missing' : 'awaiting_photos' };
  const split = store.loadSplit(), answers = store.readPrivateJson('answers.json', {});
  const entries = Object.entries(split.files);
  const labeled = entries.filter(([name]) => reader.validAnswer(answers[name])).length;
  const development = entries.filter(([, f]) => f.side === 'development').length;
  const heldout = entries.length - development;
  return { reader: reader.version, images: names.length, assigned: entries.length, frozen: split.frozen,
    development, heldout, labeled, readyToFreeze: development > 0 && heldout > 0 && labeled === entries.length,
    status: labeled === entries.length ? 'labeled' : 'awaiting_human_answers' };
}
