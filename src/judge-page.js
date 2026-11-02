// The judge page and its results, served the same by the one-process service (src/app.js) and by the
// router (src/service/router.js).

import { readdir, readFile } from 'node:fs/promises';

// The judge page is served from web/ by the app itself, file by file from this list and nothing
// else: no directory listing, no `web/serve.js`, no `web/sample/make-sample.js`, no path that is
// not spelled here. The reader results are the aggregate files of eval/results/ (names only).
const WEB_DIR = new URL('../web/', import.meta.url);
const RESULTS_DIR = new URL('../eval/results/', import.meta.url);
/** @type {Record<string, string>} published path → content type */
const JUDGE_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'judge.css': 'text/css; charset=utf-8',
  'judge.js': 'text/javascript; charset=utf-8',
  'texts.js': 'text/javascript; charset=utf-8',
  'trace-view.js': 'text/javascript; charset=utf-8',
  'payments-view.js': 'text/javascript; charset=utf-8',
  'usual-view.js': 'text/javascript; charset=utf-8',
  'order-state.js': 'text/javascript; charset=utf-8',
  'learning-view.js': 'text/javascript; charset=utf-8',
  'sample/export.json': 'application/json; charset=utf-8',
};
// The only source files the browser may read: the pure ledger modules the page imports.
/** @type {Record<string, string>} path → module */
const JUDGE_SOURCES = {
  '/src/ledger/payments.js': './ledger/payments.js',
  '/src/ledger/usual.js': './ledger/usual.js',
  '/src/ledger/cross-check.js': './ledger/cross-check.js',
};
const RESULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const JUDGE_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

/** Is this path the judge page's? @param {string} path */
export const isJudgePath = (path) => path === '/judge' || path.startsWith('/judge/') || Object.hasOwn(JUDGE_SOURCES, path);

/**
 * The judge page and its results, GET only, each response with the page's headers.
 * @param {string} path
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function serveJudge(path, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...JUDGE_HEADERS, allow: 'GET, HEAD' }).end();
    return;
  }
  if (path === '/judge') {
    res.writeHead(302, { ...JUDGE_HEADERS, location: '/judge/' }).end();
    return;
  }
  /** @param {number} status @param {string} type @param {Uint8Array | string} body */
  const send = (status, type, body) => {
    res.writeHead(status, { ...JUDGE_HEADERS, 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  // Only the pure ledger modules used by the browser, no general source-directory serving.
  if (Object.hasOwn(JUDGE_SOURCES, path)) {
    try { send(200, 'text/javascript; charset=utf-8', await readFile(new URL(JUDGE_SOURCES[path], import.meta.url))); }
    catch { send(404, 'text/plain; charset=utf-8', 'not found'); }
    return;
  }
  // The path is matched as sent, after decoding, against the allow-list only: there is no file
  // system lookup for anything else, so "..", encoded slashes and the like can reach nothing.
  let rel;
  try {
    rel = decodeURIComponent(path.slice('/judge/'.length));
  } catch {
    send(404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  if (rel === '') rel = 'index.html';
  try {
    if (rel === 'results/') {
      send(200, 'application/json; charset=utf-8', JSON.stringify(await resultNames()));
      return;
    }
    if (rel.startsWith('results/')) {
      const name = rel.slice('results/'.length);
      if (!RESULT_NAME.test(name) || !(await resultNames()).includes(name)) {
        send(404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      send(200, 'application/json; charset=utf-8', await readFile(new URL(name, RESULTS_DIR)));
      return;
    }
    const type = Object.hasOwn(JUDGE_FILES, rel) ? JUDGE_FILES[rel] : null;
    if (type === null) {
      send(404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    send(200, type, await readFile(new URL(rel, WEB_DIR)));
  } catch {
    send(404, 'text/plain; charset=utf-8', 'not found');
  }
}

/** The aggregate result files, names only, sorted. */
async function resultNames() {
  try {
    return (await readdir(RESULTS_DIR)).filter((n) => RESULT_NAME.test(n)).sort();
  } catch {
    return [];
  }
}
