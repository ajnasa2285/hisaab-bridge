import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPrivateData, validateSplit, safeMain } from './private-data.js';
import { evaluationReader } from './readers.js';

/** All initial photos remain together; new photos need deliberate capture groups.
 * @param {import('./private-data.js').DatasetKind} [kind] */
export function initializeDevelopment(kind = 'meter') {
  const { readPrivateJson, imageNames, imageHash, writePrivateJson } = createPrivateData(kind);
  if (readPrivateJson('split.json', null)) throw new Error('split_already_exists');
  if (!imageNames().length) throw new Error('empty_dataset');
  /** @type {import('./private-data.js').Split} */
  const split = { version: 1, frozen: false, files: Object.fromEntries(imageNames().map(name => [name,
    { side: 'development', group: 'initial-development-batch', sha256: imageHash(name) }])) };
  validateSplit(split, imageNames());
  writePrivateJson('split.json', split);
  return Object.keys(split.files).length;
}

/** groups.json contains only new files, with {group,side}; existing assignments never move.
 * @param {import('./private-data.js').DatasetKind} [kind] */
export function addGroups(kind = 'meter') {
  const { readPrivateJson, imageNames, imageHash, writePrivateJson } = createPrivateData(kind);
  const split = readPrivateJson('split.json', null);
  const groups = readPrivateJson('groups.json', null);
  if (!split || split.frozen || !groups || readPrivateJson('heldout-lock.json', null)) throw new Error('split_locked_or_missing');
  for (const [name, g] of Object.entries(groups)) {
    if (Object.hasOwn(split.files, name) || !g || typeof g !== 'object' || !('group' in g) || !('side' in g)) throw new Error('invalid_new_group');
    split.files[name] = { group: g.group, side: g.side, sha256: imageHash(name) };
  }
  validateSplit(split, imageNames());
  writePrivateJson('split.json', split);
}

/** Freezing requires owner-confirmed answers on BOTH partitions.
 * @param {import('./private-data.js').Split} split @param {Record<string,unknown>} answers
 * @param {(answer:unknown)=>boolean} validAnswer */
export function validateFreeze(split, answers, validAnswer) {
  if (!Object.values(split.files).some(f => f.side === 'heldout')) throw new Error('heldout_empty');
  if (!Object.values(split.files).some(f => f.side === 'development')) throw new Error('development_empty');
  if (!answers || Object.keys(split.files).some(name => !validAnswer(answers[name]))) throw new Error('owner_labels_required_before_freeze');
}

/** @param {import('./private-data.js').DatasetKind} [kind] */
export function freezeSplit(kind = 'meter') {
  const store = createPrivateData(kind);
  const split = store.loadSplit();
  validateFreeze(split, store.readPrivateJson('answers.json', {}), evaluationReader(kind).validAnswer);
  for (const [name, entry] of Object.entries(split.files)) if (store.imageHash(name) !== entry.sha256) throw new Error('image_changed');
  split.frozen = true;
  store.writePrivateJson('split.json', split);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await safeMain(async () => {
    const args = process.argv.slice(2);
    const kind = args[0] && !args[0].startsWith('--') ? evaluationReader(args.shift() ?? '').kind : 'meter';
    if (args.length !== 1) throw new Error('invalid_arguments');
    if (args[0] === '--initial-development') {
      console.log(JSON.stringify({ development: initializeDevelopment(kind), heldout: 0 }));
    } else if (args[0] === '--add-groups') {
      addGroups(kind); console.log('नए समूह जोड़ दिए गए।');
    } else if (args[0] === '--freeze') {
      freezeSplit(kind); console.log('विभाजन तय हो गया।');
    } else throw new Error('invalid_arguments');
  });
}
