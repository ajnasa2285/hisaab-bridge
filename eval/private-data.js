import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const METER_DATA = resolve(REPO, '../hisaab-data/meters');

/** Resolve only a direct, non-symlink child of the private meter folder.
 * @param {string} name @param {boolean} [mustExist] */
export function privatePath(name, mustExist = true) {
  if (!name || basename(name) !== name || /[\\/:]/.test(name) || name === '.' || name === '..') throw new Error('invalid_private_path');
  const root = realpathSync(METER_DATA);
  if (root.toLowerCase() !== METER_DATA.toLowerCase()) throw new Error('private_root_redirected');
  const p = join(root, name);
  if (existsSync(p)) {
    if (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink() || dirname(realpathSync(p)).toLowerCase() !== root.toLowerCase()) throw new Error('private_file_redirected');
  } else if (mustExist) throw new Error('private_file_missing');
  return p;
}

export function imageNames() {
  return readdirSync(METER_DATA, { withFileTypes: true })
    .filter(d => d.isFile() && /\.(jpe?g|png|webp)$/i.test(d.name)).map(d => d.name).sort();
}

/** @param {string} name */
export function imageHash(name) { return createHash('sha256').update(readFileSync(privatePath(name))).digest('hex'); }

/** @param {string} name @returns {import('../src/meta/client.js').ImageInput} */
export function readImage(name) {
  const extension = extname(name).toLowerCase();
  const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return { mime, bytes: readFileSync(privatePath(name)) };
}

/** @param {string} name @param {any} fallback @returns {any} */
export function readPrivateJson(name, fallback) {
  const path = privatePath(name, false);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

/** Atomic replacement, with a separate snapshot of the previous version.
 * @param {string} name @param {unknown} data */
export function writePrivateJson(name, data) {
  const path = privatePath(name, false);
  if (existsSync(path)) writeFileSync(privatePath(`${name}.${randomUUID()}.backup`, false), readFileSync(path), { flag: 'wx', mode: 0o600 });
  const temporary = privatePath(`${name}.${randomUUID()}.tmp`, false);
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

/** @typedef {{version:1, frozen:boolean, files:Record<string,{group:string,side:'development'|'heldout',sha256:string}>}} Split */

/** Checks membership, exact-byte duplicates and capture groups before any model call.
 * @param {Split} split @param {string[]} names */
export function validateSplit(split, names) {
  if (!split || split.version !== 1 || typeof split.frozen !== 'boolean' || !split.files || typeof split.files !== 'object') throw new Error('invalid_split');
  if (Object.keys(split.files).length !== names.length || names.some(n => !Object.hasOwn(split.files, n))) throw new Error('split_unassigned_or_missing_files');
  const groups = new Map(), hashes = new Map();
  for (const name of names) {
    const f = split.files[name];
    if (!f || !['development', 'heldout'].includes(f.side) || typeof f.group !== 'string' || !f.group.trim() || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('invalid_split_entry');
    if ((groups.has(f.group) && groups.get(f.group) !== f.side) || (hashes.has(f.sha256) && hashes.get(f.sha256) !== f.side)) throw new Error('split_leakage');
    groups.set(f.group, f.side); hashes.set(f.sha256, f.side);
  }
}

/** @param {Split} split */
export function splitDigest(split) { return createHash('sha256').update(JSON.stringify(split)).digest('hex'); }

export function loadSplit() {
  /** @type {Split|null} */
  const split = readPrivateJson('split.json', null);
  if (!split) throw new Error('split_missing');
  validateSplit(split, imageNames());
  const lock = readPrivateJson('heldout-lock.json', null);
  if (lock && splitDigest(split) !== lock.splitDigest) throw new Error('frozen_split_changed');
  return split;
}

/** No raw exceptions, filesystem names or private values in process output.
 * @param {() => Promise<void>} run */
export async function safeMain(run) {
  try { await run(); }
  catch { console.error('काम पूरा नहीं हुआ। निजी डेटा, विभाजन और सेटिंग जाँचें।'); process.exitCode = 1; }
}
