import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MEDIA_BYTES, openMediaStore } from '../../src/media/store.js';

/** @param {import('node:test').TestContext} t */
function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-media-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: openMediaStore({ dataDir, agentId: 'agent:supplier-1' }) };
}

test('media round trip persists the exact bytes and MIME by hash across reopen', (t) => {
  const { dataDir, store } = setup(t);
  const bytes = Buffer.from('invented challan photo');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(store.put({ bytes, mime: 'image/jpeg' }), { sha256, mime: 'image/jpeg' });
  assert.deepEqual(store.put({ bytes, mime: 'image/jpeg', sha256 }), { sha256, mime: 'image/jpeg' });
  assert.deepEqual(openMediaStore({ dataDir, agentId: 'agent:supplier-1' }).get(sha256), { sha256, mime: 'image/jpeg', bytes });
  const agentDir = join(dataDir, 'media', readdirSync(join(dataDir, 'media'))[0]);
  assert.deepEqual(readdirSync(agentDir).sort(), [sha256, `${sha256}.json`].sort());
  assert.deepEqual(readFileSync(join(agentDir, sha256)), bytes);
});

test('two agents cannot read each other’s private media', (t) => {
  const { dataDir, store } = setup(t);
  const saved = store.put({ bytes: Buffer.from('invented site copy'), mime: 'image/png' });
  const other = openMediaStore({ dataDir, agentId: 'agent:contractor-1' });
  assert.equal(other.get(saved.sha256), null);
  assert.equal(store.get('../escape'), null);
});

test('changed bytes or metadata are unavailable on read', (t) => {
  const { dataDir, store } = setup(t);
  const saved = store.put({ bytes: Buffer.from('invented photo'), mime: 'image/png' });
  const agentDir = join(dataDir, 'media', readdirSync(join(dataDir, 'media'))[0]);
  writeFileSync(join(agentDir, saved.sha256), 'different photo');
  assert.equal(store.get(saved.sha256), null);
  const saved2 = store.put({ bytes: Buffer.from('second invented photo'), mime: 'image/jpeg' });
  writeFileSync(join(agentDir, `${saved2.sha256}.json`), '{"mime":"text/html"}');
  assert.equal(store.get(saved2.sha256), null);
});

test('put checks the expected hash, MIME and 5 MB cap before writing', (t) => {
  const { dataDir, store } = setup(t);
  assert.throws(() => store.put({ bytes: Buffer.from('photo'), mime: 'image/png', sha256: '0'.repeat(64) }), /hash mismatch/);
  assert.throws(() => store.put({ bytes: Buffer.alloc(MAX_MEDIA_BYTES + 1), mime: 'image/jpeg' }), /too large/);
  assert.throws(() => store.put({ bytes: Buffer.alloc(0), mime: 'image/jpeg' }), /empty/);
  assert.throws(() => store.put({ bytes: Buffer.from('photo'), mime: 'text/html' }), /unsupported MIME/);
  const agentDir = join(dataDir, 'media', readdirSync(join(dataDir, 'media'))[0]);
  assert.equal(readdirSync(agentDir).length, 0);
  const saved = store.put({ bytes: Buffer.alloc(MAX_MEDIA_BYTES, 7), mime: 'image/webp' });
  assert.equal(store.get(saved.sha256)?.bytes.length, MAX_MEDIA_BYTES);
});

test('configuration refuses repository directories, relative paths and invalid identities', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  assert.throws(() => openMediaStore({ dataDir: join(repo, 'private'), agentId: 'agent:supplier-1' }), /outside the repository/);
  assert.throws(() => openMediaStore({ dataDir: './media', agentId: 'agent:supplier-1' }), /absolute HB_DATA_DIR/);
  assert.throws(() => openMediaStore({ dataDir: tmpdir(), agentId: '../another-agent' }), /invalid agent id/);
});
