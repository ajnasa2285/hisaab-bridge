import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeCosts } from './metrics.js';
import { evaluationReader } from './readers.js';
import { REPO, createPrivateData, splitDigest, safeMain } from './private-data.js';
import { parseEvaluationArgs, partitionDigest, validateCachedRun, validateCheckpointDate, evaluationReadiness } from './checkpoint.js';

/** @param {string} kind @returns {string} */
function readerDigest(kind) {
  const hash = createHash('sha256');
  for (const path of [`src/readers/${kind}.js`, 'src/meta/client.js', 'src/meta/schema.js']) hash.update(readFileSync(join(REPO, path)));
  return hash.digest('hex');
}

/** @param {string[]} [args] */
export async function runEvaluation(args = process.argv.slice(2)) {
  const { kind, heldout, scoreOnly, check } = parseEvaluationArgs(args);
  const reader = evaluationReader(kind), store = createPrivateData(reader.kind);
  const { loadSplit, imageHash, readImage, privatePath, readPrivateJson, writePrivateJson } = store;
  if (check) { console.log(JSON.stringify(evaluationReadiness(reader, store), null, 2)); return; }
  // Held-out evaluation must be an explicit npm eval invocation, never an incidental import.
  if (heldout && (process.env.npm_lifecycle_event !== 'eval' || scoreOnly)) throw new Error('heldout_requires_npm_eval');
  const split = loadSplit(), digest = splitDigest(split), readerHash = readerDigest(kind);
  const side = heldout ? 'heldout' : 'development';
  const files = Object.entries(split.files).filter(([, v]) => v.side === side);
  if (!files.length) throw new Error('empty_partition');
  for (const [name, entry] of files) if (imageHash(name) !== entry.sha256) throw new Error('image_changed');
  const answers = readPrivateJson('answers.json', {});
  for (const [name] of files) if (Object.hasOwn(answers, name) && !reader.validAnswer(answers[name])) throw new Error('invalid_answer_key');
  const dateIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const prior = readPrivateJson('heldout-lock.json', null);
  if (heldout) {
    validateCheckpointDate(readPrivateJson('checkpoint-plan.json', null), dateIST);
    if (!split.frozen || Object.keys(split.files).some(name => !reader.validAnswer(answers[name]))) throw new Error('heldout_requires_frozen_split_and_answers');
    if (prior?.checkpoints?.includes(dateIST)) throw new Error('heldout_checkpoint_already_used');
    writePrivateJson('heldout-lock.json', { splitDigest: digest, readerHash,
      checkpoints: [...(prior?.checkpoints ?? []), dateIST] });
  }
  const promptsChangedSinceHeldout = prior ? prior.readerHash !== readerHash : false;
  const runId = randomUUID();
  const costFile = privatePath(`cost-${runId}.jsonl`, false);
  /** @type {{file:string,prediction:any,elapsedMs:number}[]} */
  let predictions = [];
  /** @type {any[]} */
  let costs = [];
  const configuredModel = process.env.MUSE_SPARK_MODEL;
  let model = configuredModel && /^muse-spark-1\.[123]$/.test(configuredModel) ? configuredModel : null;
  if (scoreOnly) {
    const last = readPrivateJson('latest-development.json', null);
    validateCachedRun(last, split, readerHash);
    predictions = last.predictions; costs = last.costs; model = last.model;
  } else {
    const previousLog = process.env.META_COST_LOG;
    process.env.META_COST_LOG = costFile;
    try {
      for (const [name] of files) {
        const start = performance.now();
        const prediction = await reader.read(readImage(name));
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
    const saved = { splitDigest: digest, partitionDigest: partitionDigest(split, side), readerHash, model, predictions, costs };
    writePrivateJson(`run-${runId}.json`, saved);
    if (!heldout) writePrivateJson('latest-development.json', saved);
  }
  const metrics = reader.summarize(predictions.map(p => ({ prediction: p.prediction, elapsedMs: p.elapsedMs, expected: answers[p.file] })));
  const aggregate = {
    reader: reader.version, dateIST, partition: side, model,
    status: predictions.length < files.length ? 'incomplete' : metrics.labeled === 0 ? 'awaiting_human_answers' : metrics.unlabeled > 0 ? 'partially_labeled' : 'scored',
    splitFrozen: split.frozen, promptsChangedSinceHeldout, rescored: scoreOnly,
    planned: files.length, notRun: files.length - predictions.length,
    ...metrics, cost: summarizeCosts(costs),
  };
  const out = join(REPO, 'eval/results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${kind}-${dateIST}-${side}-${runId}.json`), JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(aggregate, null, 2));
}

export async function runMeterEvaluation() { await runEvaluation(); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await safeMain(runEvaluation);
