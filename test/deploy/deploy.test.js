import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/main.js';

const aws = new URL('../../deploy/aws/', import.meta.url);
const read = (/** @type {string} */ f) => readFileSync(new URL(f, aws), 'utf8');

/** @param {URL} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const u = new URL(n, dir);
    return statSync(u).isDirectory() ? walk(new URL(`${n}/`, dir)) : [fileURLToPath(u)];
  });
}

/** @param {string} text */
function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('the env example lists every variable src/ reads, and holds no secret', () => {
  const names = new Set();
  for (const f of walk(new URL('../../src/', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    for (const m of readFileSync(decodeURIComponent(f.replace(/^\/([A-Za-z]:)/, '$1')), 'utf8').matchAll(/\b(?:HB|META|MUSE)_[A-Z0-9_]*[A-Z0-9]\b/g)) names.add(m[0]);
  }
  // main.js builds the HB_WA_<LINE>_<PART> names from a template.
  for (const w of ['JCB', 'SITE']) for (const p of ['PHONE_NUMBER_ID', 'APP_SECRET', 'VERIFY_TOKEN', 'ACCESS_TOKEN']) names.add(`HB_WA_${w}_${p}`);
  names.delete('HB_WA_');
  assert.ok(names.size >= 15, 'found the variables in src/');
  const example = parseEnv(read('hisaab.env.example'));
  for (const n of names) assert.ok(n in example, `${n} missing from hisaab.env.example`);
  for (const [k, v] of Object.entries(example)) {
    if (/TOKEN|SECRET|KEY|PASSWORD/.test(k)) assert.equal(v, '', `${k} must be empty in the example`);
    if (k !== 'HB_WA_GRAPH_VERSION' && !/TOKEN|SECRET|KEY/.test(k)) assert.ok(!/^[A-Za-z0-9_-]{32,}$/.test(v), `${k} looks like a secret`);
  }
  assert.equal(example.HB_PORT, '8080');
  assert.equal(example.META_API_BASE, 'https://api.meta.ai/v1');
  assert.equal(example.HB_WA_GRAPH_VERSION, '');
});

test('the Caddyfile proxies only /wa/*, /agents/* and /health and answers 404 to the rest', () => {
  const c = read('Caddyfile');
  const matcher = /^\s*@\w+\s+path\s+(.+)$/m.exec(c);
  assert.deepEqual(matcher?.[1].trim().split(/\s+/).sort(), ['/agents/*', '/health', '/wa/*']);
  assert.equal(c.match(/reverse_proxy/g)?.length, 1, 'one proxy only');
  assert.match(c, /reverse_proxy 127\.0\.0\.1:\{\$HB_PORT:8080\}/);
  assert.match(c, /respond "Not found" 404/);
  assert.match(c, /max_size 1MB/);
  assert.doesNotMatch(c, /file_server|browse/);
});

test('people.json.example is accepted by loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-deploy-'));
  try {
    writeFileSync(join(dir, 'people.json'), read('people.json.example'));
    /** @type {Record<string, string>} */
    const env = { ...parseEnv(read('hisaab.env.example')), HB_DATA_DIR: dir, HB_BASE_URL: 'https://example.test' };
    for (const k of Object.keys(env)) if (/^HB_WA_(JCB|SITE)_/.test(k)) env[k] = `dummy-${k.toLowerCase()}`;
    const cfg = loadConfig(env);
    assert.equal(cfg.people.length, 5);
    assert.deepEqual(cfg.people.filter((p) => p.role === 'supplier').map((p) => p.agent), ['agent:supplier-1']);
    assert.ok(cfg.people.every((p) => /^9190000000\d\d$/.test(p.phone)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
