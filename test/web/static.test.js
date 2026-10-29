// The judge page served by the app itself at /judge/: only its own files, with the page's headers,
// no listing, no traversal; the reader results listed and served by validated name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

/** An app with no agents and no lines: enough for the page. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-judge-'));
  const app = createApp({ baseUrl: 'http://127.0.0.1', agents: [], lines: [], people: [], waStoreFile: join(dir, 'wa.db'), spark: async () => ({ ok: true, toolCalls: [] }), log: () => {} });
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return {
    base,
    close: async () => {
      app.close();
      await new Promise((r) => server.close(() => r(undefined)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * One GET over a plain socket: the path goes out exactly as written.
 * @param {string} base @param {string} path
 * @returns {Promise<{status: number, head: string, body: string}>}
 */
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(port), hostname, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { data += d; });
    sock.on('error', reject);
    sock.on('close', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), head, body: rest.join('\r\n\r\n') });
    });
  });
}

/** @param {Response} r */
function checkHeaders(r) {
  assert.equal(r.headers.get('content-security-policy'), CSP);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
}

test('the page and its own files are served at /judge/ with the headers and the right types', async () => {
  const s = await start();
  try {
    const redirect = await fetch(`${s.base}/judge`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/judge/');
    checkHeaders(redirect);

    const index = await fetch(`${s.base}/judge/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    checkHeaders(index);
    assert.match(await index.text(), /<script type="module" src="judge.js">/);

    for (const [file, type] of [['index.html', 'text/html; charset=utf-8'], ['judge.css', 'text/css; charset=utf-8'], ['judge.js', 'text/javascript; charset=utf-8'], ['texts.js', 'text/javascript; charset=utf-8'], ['sample/export.json', 'application/json; charset=utf-8']]) {
      const r = await fetch(`${s.base}/judge/${file}`);
      assert.equal(r.status, 200, file);
      assert.equal(r.headers.get('content-type'), type, file);
      checkHeaders(r);
    }
    const sample = await (await fetch(`${s.base}/judge/sample/export.json`)).json();
    assert.equal(sample.v, 'hb-export/0.1');
    for (const path of ['/judge/payments-view.js', '/judge/order-state.js', '/src/ledger/payments.js']) {
      const shared = await fetch(`${s.base}${path}`);
      assert.equal(shared.status, 200);
      assert.equal(shared.headers.get('content-type'), 'text/javascript; charset=utf-8');
      checkHeaders(shared);
      assert.match(await shared.text(), /paymentSummary/);
    }
    assert.equal((await fetch(`${s.base}/src/ledger/store.js`)).status, 404);
    for (const path of ['/judge/usual-view.js', '/src/ledger/usual.js']) {
      const shared = await fetch(`${s.base}${path}`);
      assert.equal(shared.status, 200);
      checkHeaders(shared);
      assert.match(await shared.text(), /usualFigures/);
    }
    assert.equal((await fetch(`${s.base}/src/ledger/usual.js`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.base}/src/ledger/payments.js`, { method: 'POST' })).status, 405);

    const head = await fetch(`${s.base}/judge/judge.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
    assert.equal((await fetch(`${s.base}/judge/judge.js`, { method: 'POST' })).status, 405);
  } finally {
    await s.close();
  }
});

test('nothing outside the allow-list is reachable: no listing, no development files, no traversal', async () => {
  const s = await start();
  try {
    for (const path of [
      '/judge/serve.js', '/judge/sample/make-sample.js', '/judge/README.md', '/judge/sample/', '/judge/sample',
      '/judge/../package.json', '/judge/..%2Fpackage.json', '/judge/%2e%2e/package.json', '/judge/sample/../serve.js',
      '/judge/sample%2F..%2Fserve.js', '/judge/..\\package.json', '/judge/%2e%2e%5cpackage.json',
      '/judge/results/../package.json', '/judge/results/..%2Fpackage.json', '/judge/results/x.json/../../package.json',
      '/judge/judge.js/', '/judge/JUDGE.JS', '/judge/judge.js%00', '/judge/%', '/judgement',
    ]) {
      const r = await fetch(`${s.base}${path}`, { redirect: 'manual' });
      assert.equal(r.status, 404, path);
      // A ".." segment (even as %2e%2e) is folded by the URL parser before the request leaves, so
      // some of these never reach /judge at all; everything that does carries the page's headers.
      if (new URL(`${s.base}${path}`).pathname.startsWith('/judge/')) checkHeaders(r);
      assert.doesNotMatch(await r.text(), /"name": "hisaab-bridge"|createServer/, `${path} leaked a file`);
    }
    // Sent raw, so the ".." reaches the server unfolded.
    for (const path of ['/judge/../package.json', '/judge/sample/../../package.json', '/judge/results/../../package.json', '/judge/./serve.js']) {
      const raw = await rawGet(s.base, path);
      assert.equal(raw.status, 404, path);
      assert.match(raw.head, /content-security-policy:/i, path);
      assert.doesNotMatch(raw.body, /"name": "hisaab-bridge"|createServer/, `${path} leaked a file`);
    }
  } finally {
    await s.close();
  }
});

test('the results are listed by name and served one by one, validated names only', async () => {
  const s = await start();
  try {
    const list = await fetch(`${s.base}/judge/results/`);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('content-type'), 'application/json; charset=utf-8');
    checkHeaders(list);
    const names = await list.json();
    const onDisk = readdirSync(new URL('../../eval/results/', import.meta.url)).filter((n) => n.endsWith('.json')).sort();
    assert.deepEqual(names, onDisk);
    assert.ok(names.length > 0, 'eval/results has files');
    for (const n of names) assert.match(n, /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);

    const one = await fetch(`${s.base}/judge/results/${names[0]}`);
    assert.equal(one.status, 200);
    assert.equal(one.headers.get('content-type'), 'application/json; charset=utf-8');
    checkHeaders(one);
    const data = await one.json();
    assert.equal(typeof data.reader, 'string');

    for (const bad of ['missing.json', 'package.json', '../package.json', '..%2F..%2Fpackage.json', `${names[0]}/`, `${names[0]}.txt`, 'results.json', '.json', 'a.JSON']) {
      assert.equal((await fetch(`${s.base}/judge/results/${bad}`)).status, 404, bad);
    }
  } finally {
    await s.close();
  }
});
