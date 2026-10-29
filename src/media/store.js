// Private, content-addressed photo bytes. Nothing from this store belongs in a ledger or export.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_MIMES = /** @type {const} */ (['image/jpeg', 'image/png', 'image/webp']);
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** @param {Uint8Array} bytes */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {string} path @param {string} parent */
function within(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve existing ancestors too, so a symlink cannot put private bytes inside a checkout. @param {string} path */
function realTarget(path) {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('media: invalid data directory');
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}

/** @param {string} path */
function assertPrivate(path) {
  if (within(path, realpathSync(REPO))) throw new Error('media: data directory must be outside the repository');
  let ancestor = path;
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) throw new Error('media: data directory must be outside the repository');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

/**
 * One directory per agent, under HB_DATA_DIR. Tests pass an isolated temporary dataDir.
 * @param {{dataDir?: string, agentId: string}} o
 */
export function openMediaStore(o) {
  const dataDir = o.dataDir ?? process.env.HB_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) throw new Error('media: absolute HB_DATA_DIR is required');
  if (!/^agent:[a-z0-9][a-z0-9._-]{0,63}$/.test(o.agentId)) throw new Error('media: invalid agent id');
  const root = realTarget(dataDir);
  assertPrivate(root);
  const directory = join(root, 'media', digest(Buffer.from(o.agentId)));
  assertPrivate(realTarget(directory));
  for (const dir of [join(root, 'media'), directory]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('media: private directory cannot be a symlink');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  /** @param {string} sha256 @returns {{sha256: string, mime: string, bytes: Buffer}|null} */
  function get(sha256) {
    if (!SHA256.test(sha256)) return null;
    try {
      const file = join(directory, sha256);
      const metadata = `${file}.json`;
      const stat = lstatSync(file);
      const metaStat = lstatSync(metadata);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MEDIA_BYTES || !metaStat.isFile() || metaStat.size > 256) return null;
      const info = JSON.parse(readFileSync(metadata, 'utf8'));
      if (!MEDIA_MIMES.includes(info.mime) || info.sha256 !== sha256 || info.size !== stat.size) return null;
      const bytes = readFileSync(file);
      if (bytes.length > MAX_MEDIA_BYTES || digest(bytes) !== sha256) return null;
      return { sha256, mime: info.mime, bytes };
    } catch {
      // A missing or corrupt copy is unavailable evidence, never something to display.
      return null;
    }
  }

  return {
    get,
    /** @param {{bytes: Uint8Array, mime: string, sha256?: string}} image */
    put(image) {
      if (!(image.bytes instanceof Uint8Array) || image.bytes.length < 1 || image.bytes.length > MAX_MEDIA_BYTES) throw new Error('media: photo empty or too large');
      if (!MEDIA_MIMES.some((mime) => mime === image.mime)) throw new Error('media: unsupported MIME');
      const sha256 = digest(image.bytes);
      if (image.sha256 !== undefined && image.sha256 !== sha256) throw new Error('media: hash mismatch');
      const file = join(directory, sha256);
      const prior = get(sha256);
      if (prior) {
        if (prior.mime !== image.mime) throw new Error('media: MIME differs from the saved copy');
        return { sha256, mime: prior.mime };
      }
      // Exclusive creation never overwrites evidence or follows a pre-existing file symlink.
      writeFileSync(file, image.bytes, { flag: 'wx', mode: 0o600 });
      writeFileSync(`${file}.json`, JSON.stringify({ sha256, mime: image.mime, size: image.bytes.length }), { flag: 'wx', mode: 0o600 });
      return { sha256, mime: image.mime };
    },
  };
}

/** @typedef {ReturnType<typeof openMediaStore>} MediaStore */
