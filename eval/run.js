import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMeter, METER_VERSION } from '../src/readers/meter.js';
import { validAnswer } from './answers.js';
import { summarizeMeters, summarizeCosts } from './metrics.js';
import { REPO, loadSplit, splitDigest, imageHash, readImage, privatePath, readPrivateJson, writePrivateJson, safeMain } from './private-data.js';

/** @returns {string} */
function readerDigest() {
  const hash = createHash('sha256');
  for (const path of ['src/readers/meter.js', 'src/meta/client.js', 'src/meta/schema.js']) hash.update(readFileSync(join(REPO, path)));
  return hash.digest('hex');
}

export async function runMeterEvaluation() {
  const args = process.argv.slice(2);
  if (args[0] !== 'meter' || args.slice(1).some(a => !['--heldout', '--score-latest'].includes(a))) throw new Error('invalid_arguments');
  const heldout = args.includes('--heldout'), scoreOnly = args.includes('--score-latest');
  // Held-out evaluation must be an explicit npm eval invocation, never an incidental import.
  if (heldout && (process.env.npm_lifecycle_event !== 'eval' || scoreOnly)) throw new Error('heldout_requires_npm_eval');
  const split = loadSplit(), digest = splitDigest(split), readerHash = readerDigest();
  const side = heldout ? 'heldout' : 'development';
  const files = Object.entries(split.files).filter(([, v]) => v.side === side);
  if (!files.length) throw new Error('empty_partition');
  for (const [name, entry] of files) if (imageHash(name) !== entry.sha256) throw new Error('image_changed');
  const answers = readPrivateJson('answers.json', {});
  for (const [name] of files) if (Object.hasOwn(answers, name) && !validAnswer(answers[name])) throw new Error('invalid_answer_key');
  const dateIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const prior = readPrivateJson('heldout-lock.json', null);
  if (heldout) {
    if (!split.frozen || files.some(([name]) => !validAnswer(answers[name]))) throw new Error('heldout_requires_frozen_split_and_answers');
    if (prior?.checkpoints?.includes(dateIST)) throw new Error('heldout_checkpoint_already_used');
    writePrivateJson('heldout-lock.json', { splitDigest: digest, readerHash,
      checkpoints: [...(prior?.checkpoints ?? []), dateIST] });
  }
  const promptsChangedSinceHeldout = prior ? prior.readerHash !== readerHash : false;
  const runId = randomUUID();
  const costFile = privatePath(`cost-${runId}.jsonl`, false);
  /** @type {{file:string,prediction:import('./metrics.js').Reading,elapsedMs:number}[]} */
  let predictions = [];
  /** @type {any[]} */
  let costs = [];
  let model = process.env.MUSE_SPARK_MODEL ?? null;
  if (scoreOnly) {
    const last = readPrivateJson('latest-development.json', null);
    if (!last || last.splitDigest !== digest || last.readerHash !== readerHash
      || last.predictions.length !== files.length || files.some(([n]) => !last.predictions.some((/** @type {{file:string}} */ p) => p.file === n))) throw new Error('cached_run_stale');
    predictions = last.predictions; costs = last.costs; model = last.model;
  } else {
    const previousLog = process.env.META_COST_LOG;
    process.env.META_COST_LOG = costFile;
    try {
      for (const [name] of files) {
        const start = performance.now();
        const prediction = await readMeter(readImage(name));
        predictions.push({ file: name, prediction, elapsedMs: Math.round(performance.now() - start) });
        console.log(JSON.stringify({ completed: predictions.length, planned: files.length, ok: prediction.ok }));
        // Stop on infrastructure/config failures, preserving a partial report instead of hammering the API.
        if (!prediction.ok && prediction.reason !== 'schema_failure') break;
      }
    } finally {
      if (previousLog === undefined) delete process.env.META_COST_LOG;
      else process.env.META_COST_LOG = previousLog;
    }
    costs = existsSync(costFile) ? readFileSync(costFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const saved = { splitDigest: digest, readerHash, model, predictions, costs };
    writePrivateJson(`run-${runId}.json`, saved);
    if (!heldout) writePrivateJson('latest-development.json', saved);
  }
  const metrics = summarizeMeters(predictions.map(p => ({ prediction: p.prediction, elapsedMs: p.elapsedMs, expected: answers[p.file] })));
  const aggregate = {
    reader: METER_VERSION, dateIST, partition: side, model,
    status: metrics.labeled === 0 ? 'awaiting_human_answers' : metrics.unlabeled > 0 ? 'partially_labeled' : 'scored',
    splitFrozen: split.frozen, promptsChangedSinceHeldout, rescored: scoreOnly,
    planned: files.length, notRun: files.length - predictions.length,
    ...metrics, cost: summarizeCosts(costs),
  };
  const out = join(REPO, 'eval/results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `meter-${dateIST}-${side}-${runId}.json`), JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(aggregate, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await safeMain(runMeterEvaluation);
