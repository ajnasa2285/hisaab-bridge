// Before/after eval for learning from corrections (docs/briefs/CLAUDE-learn-corrections.md "Eval").
// Invented challans only (eval/learn/answers.json, rendered by eval/learn/render.py).
//
// Per pair: read doc A without memory and score it; every misread quantity is recorded as a
// correction in an in-memory openLearn() store, the way the app records one. Then doc B (same
// invented supplier, other figures) is read with memory off and with memory on. When A was read
// right nothing is recorded, so B with memory equals B without memory and is not read twice.
//
//   node eval/learn/run.js [--pairs p1,p2] [--write]
//
// Needs META_API_BASE, MUSE_SPARK_MODEL and META_API_KEY in the environment (never printed). Only
// aggregate numbers are printed and written (eval/results/learn-<date>-<uuid>.json with --write, or
// on a full run); no image bytes, no key.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChallan, parseQtyHundredths } from '../../src/readers/challan.js';
import { openLearn, promptBlock } from '../../src/learn/corrections.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** @typedef {{name: string, unit: string, qty: string}} KeyItem */
/** @typedef {{id: string, pair: string, role: 'A'|'B', layout: string, party: string, challanNo: string, items: KeyItem[]}} KeyDoc */

/** @returns {KeyDoc[]} */
export function loadKey() {
  return JSON.parse(readFileSync(join(HERE, 'answers.json'), 'utf8')).docs;
}

/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Pairs each answer-key line with a read line: by name (one contains the other), else by printed
 * position when that line is still free. Returns, per key line, the read line or null.
 * @param {KeyItem[]} key @param {{name: string, qtyHundredths: number|null, raw: string}[]} read
 */
export function matchItems(key, read) {
  const used = new Set();
  return key.map((k, i) => {
    const kn = norm(k.name);
    let j = read.findIndex((r, n) => !used.has(n) && (norm(r.name).includes(kn) || (norm(r.name).length > 3 && kn.includes(norm(r.name)))));
    if (j < 0 && i < read.length && !used.has(i)) j = i;
    if (j < 0) return null;
    used.add(j);
    return read[j];
  });
}

/** Hundredths as the plain number a person would type ("50", "2.5"). @param {number} h */
export const plainNumber = (h) => (h % 100 === 0 ? String(h / 100) : (h / 100).toFixed(2).replace(/0$/, ''));

/**
 * Scores one reading against one answer-key document: each item's qty and challanNo.
 * @param {KeyDoc} key @param {any} reading
 */
export function score(key, reading) {
  /** @type {{field: string, expected: string, got: string|null, ok: boolean, confidentWrong: boolean, raw: string|null, keyQty: string}[]} */
  const fields = [];
  const ok = reading?.ok === true && reading.kind === 'challan';
  const clear = ok && reading.clear === true;
  const items = ok ? matchItems(key.items, reading.items) : key.items.map(() => null);
  key.items.forEach((k, i) => {
    const want = /** @type {number} */ (parseQtyHundredths(k.qty));
    const got = items[i]?.qtyHundredths ?? null;
    const good = got === want;
    fields.push({ field: `qty ${k.name}`, expected: k.qty, got: got === null ? null : plainNumber(got), ok: good,
      confidentWrong: clear && !good && got !== null, raw: items[i]?.raw ?? null, keyQty: k.qty });
  });
  const no = ok ? reading.challanNo : null;
  const noOk = typeof no === 'string' && no.trim().toLowerCase() === key.challanNo.toLowerCase();
  fields.push({ field: 'challanNo', expected: key.challanNo, got: no, ok: noOk, confidentWrong: clear && !noOk && no !== null, raw: null, keyQty: '' });
  return { fields, ok, clear, latencyMs: ok ? reading.latencyMs : (reading?.latencyMs ?? null) };
}

/** @param {number} n @param {number} d */
const rate = (n, d) => ({ numerator: n, denominator: d, basisPoints: d ? Math.round(n * 10000 / d) : null });
/** @param {number[]} xs */
const p50 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };

async function main() {
  const args = process.argv.slice(2);
  const pairArg = args.includes('--pairs') ? args[args.indexOf('--pairs') + 1].split(',') : null;
  const docs = loadKey();
  const pairs = [...new Set(docs.map((d) => d.pair))].filter((p) => !pairArg || pairArg.includes(p)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const full = !pairArg;
  // Every HTTP attempt (retries too) is one line here; whitelisted metadata only (eval/cost.js).
  process.env.META_COST_LOG ??= join(tmpdir(), `hb-learn-eval-${randomUUID()}.jsonl`);
  const costLog = process.env.META_COST_LOG;
  const attempts = () => (existsSync(costLog) ? readFileSync(costLog, 'utf8').split('\n').filter(Boolean).length : 0);
  const before = attempts();

  let reads = 0;
  /** @type {number[]} */
  const latencies = [];
  /** @param {KeyDoc} doc @param {string} [memory] */
  async function read(doc, memory) {
    const image = { mime: /** @type {'image/png'} */ ('image/png'), bytes: readFileSync(join(HERE, 'images', `${doc.id}.png`)) };
    reads++;
    const t = performance.now();
    const r = await readChallan(image, memory ? { memory } : undefined);
    latencies.push(Math.round(performance.now() - t));
    if (!r.ok) console.log(`  ${doc.id}: read failed (${r.reason})`);
    return r;
  }

  // Layout search: read the named docs once without memory and print the score; nothing is written.
  if (args.includes('--probe')) {
    for (const id of args[args.indexOf('--probe') + 1].split(',')) {
      const doc = /** @type {KeyDoc} */ (docs.find((d) => d.id === id));
      const s = score(doc, await read(doc));
      console.log(`${id} [${doc.layout}]: ${s.fields.map((f) => `${f.field}=${f.got ?? '∅'}${f.ok ? '' : `(want ${f.expected})`}`).join('; ')} clear=${s.clear}`);
    }
    console.log(`Muse Spark calls this run: ${reads} reads, ${attempts() - before} HTTP attempts`);
    return;
  }

  const learn = openLearn({ enabled: true });
  const tally = { a: { n: 0, ok: 0, cw: 0 }, off: { n: 0, ok: 0, cw: 0 }, on: { n: 0, ok: 0, cw: 0 } };
  /** @type {any[]} */
  const perPair = [];
  let recorded = 0;
  for (const pair of pairs) {
    const A = /** @type {KeyDoc} */ (docs.find((d) => d.pair === pair && d.role === 'A'));
    const B = /** @type {KeyDoc} */ (docs.find((d) => d.pair === pair && d.role === 'B'));
    const sa = score(A, await read(A));
    let recordedHere = 0;
    for (const f of sa.fields) {
      if (!sa.ok || f.ok || !f.field.startsWith('qty ')) continue;
      const lines = A.items.length;
      const row = learn.record({ kind: 'challan', party: A.party, field: f.field, read: f.got ?? 'unclear', corrected: f.keyQty,
        layout: `${lines} lines; challan; raw: ${(f.raw ?? '').slice(0, 80)}`, memory: 0 });
      if (row) recordedHere++;
    }
    recorded += recordedHere;
    const sOff = score(B, await read(B));
    const block = promptBlock(learn.past({ kind: 'challan', party: B.party }));
    const sOn = block ? score(B, await read(B, block)) : sOff;
    for (const [k, s] of /** @type {const} */ ([['a', sa], ['off', sOff], ['on', sOn]])) {
      tally[k].n += s.fields.length; tally[k].ok += s.fields.filter((f) => f.ok).length; tally[k].cw += s.fields.filter((f) => f.confidentWrong).length;
    }
    const line = (/** @type {typeof sa} */ s) => s.fields.map((f) => `${f.field}=${f.got ?? '∅'}${f.ok ? '' : `(want ${f.expected})`}`).join('; ') + ` clear=${s.clear}`;
    console.log(`${pair} [${A.layout}]`);
    console.log(`  A      : ${line(sa)}`);
    console.log(`  B off  : ${line(sOff)}`);
    console.log(`  B on   : ${block ? line(sOn) : '(no correction recorded; same as off, not read again)'}`);
    perPair.push({ pair, layout: A.layout, fields: sOff.fields.length,
      aCorrect: sa.fields.filter((f) => f.ok).length, correctionsRecorded: recordedHere, memoryUsed: Boolean(block),
      bCorrectOff: sOff.fields.filter((f) => f.ok).length, bCorrectOn: sOn.fields.filter((f) => f.ok).length,
      bConfidentWrongOff: sOff.fields.filter((f) => f.confidentWrong).length, bConfidentWrongOn: sOn.fields.filter((f) => f.confidentWrong).length });
  }
  learn.close();
  const calls = attempts() - before;
  const summary = {
    v: 'hb-learn-eval/0.1', model: process.env.MUSE_SPARK_MODEL ?? null, data: 'invented documents (eval/learn/answers.json)',
    pairs: pairs.length, fieldsPerReading: 'each item qty + challanNo',
    docA: { fields: tally.a.n, accuracy: rate(tally.a.ok, tally.a.n), wrongButConfident: tally.a.cw },
    docB: {
      fields: tally.off.n,
      accuracyMemoryOff: rate(tally.off.ok, tally.off.n), accuracyMemoryOn: rate(tally.on.ok, tally.on.n),
      wrongButConfidentMemoryOff: tally.off.cw, wrongButConfidentMemoryOn: tally.on.cw,
    },
    correctionsRecorded: recorded, readerCalls: reads, httpAttempts: calls, p50LatencyMs: p50(latencies), perPair,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Muse Spark calls this run: ${reads} reads, ${calls} HTTP attempts`);
  if (full || args.includes('--write')) {
    const day = new Date().toISOString().slice(0, 10);
    const out = join(ROOT, 'eval', 'results', `learn-${day}-${randomUUID()}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
    console.log(`wrote ${out}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) await main();
