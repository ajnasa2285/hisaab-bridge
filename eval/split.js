import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { imageNames, imageHash, readPrivateJson, writePrivateJson, validateSplit, loadSplit, safeMain } from './private-data.js';

/** All initial photos remain together; new photos need deliberate capture groups. */
export function initializeDevelopment() {
  if (readPrivateJson('split.json', null)) throw new Error('split_already_exists');
  /** @type {import('./private-data.js').Split} */
  const split = { version: 1, frozen: false, files: Object.fromEntries(imageNames().map(name => [name,
    { side: 'development', group: 'initial-development-batch', sha256: imageHash(name) }])) };
  validateSplit(split, imageNames());
  writePrivateJson('split.json', split);
  return Object.keys(split.files).length;
}

/** groups.json contains only new files, with {group,side}; existing assignments never move. */
export function addGroups() {
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await safeMain(async () => {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('invalid_arguments');
    if (args[0] === '--initial-development') {
      console.log(JSON.stringify({ development: initializeDevelopment(), heldout: 0 }));
    } else if (args[0] === '--add-groups') {
      addGroups(); console.log('नए समूह जोड़ दिए गए।');
    } else if (args[0] === '--freeze') {
      const split = loadSplit();
      if (!Object.values(split.files).some(f => f.side === 'heldout')) throw new Error('heldout_empty');
      split.frozen = true; writePrivateJson('split.json', split); console.log('विभाजन तय हो गया।');
    } else throw new Error('invalid_arguments');
  });
}
