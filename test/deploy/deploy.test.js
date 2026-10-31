import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/main.js';
import { MAX_BODY_BYTES } from '../../src/transport/a2a.js';

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

test('the Caddyfile proxies only /wa/*, /agents/*, /health, the judge page and its ledger modules, and answers 404 to the rest', () => {
  const c = read('Caddyfile');
  const matchers = [...c.matchAll(/^\s*@(\w+)\s+path\s+(.+)$/gm)].map((m) => [m[1], m[2].trim().split(/\s+/).sort()]);
  assert.deepEqual(matchers, [['a2a', ['/agents/*/a2a']], ['app', ['/agents/*', '/health', '/judge', '/judge/*', '/src/ledger/cross-check.js', '/src/ledger/payments.js', '/src/ledger/usual.js', '/wa/*']]], 'a2a first: Caddy tries named handles in order');
  assert.equal(c.match(/reverse_proxy 127\.0\.0\.1:\{\$HB_PORT:8080\}/g)?.length, 2, 'both go to the app');
  assert.equal(c.match(/reverse_proxy/g)?.length, 2, 'and nowhere else');
  assert.match(c, /respond "Not found" 404/);
  assert.doesNotMatch(c, /file_server|browse/);
});

test('the proxy lets a whole evidence photo through to the agents, keeps the rest at 1 MB, and setup.sh installs it', () => {
  const c = read('Caddyfile');
  /** The cap inside one handle block, in bytes (Caddy's MB is 1000 x 1000). @param {string} name */
  const capOf = (name) => {
    const m = new RegExp(`handle @${name} \\{\\s*request_body \\{\\s*max_size (\\d+)MB\\s*\\}`).exec(c);
    assert.ok(m, `${name} has its own cap`);
    return Number(m[1]) * 1000 * 1000;
  };
  assert.ok(capOf('a2a') >= MAX_BODY_BYTES, 'the a2a path takes what src/transport/a2a.js takes');
  assert.equal(capOf('app'), 1000 * 1000, 'the webhook path stays at 1 MB');
  assert.equal(c.match(/request_body/g)?.length, 2, 'no site-wide cap above the two');
  const setup = read('setup.sh');
  assert.match(setup, /install -m 0644 "\$APP_DIR\/deploy\/aws\/Caddyfile" \/etc\/caddy\/Caddyfile/);
  assert.match(setup, /systemctl restart caddy/);
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
