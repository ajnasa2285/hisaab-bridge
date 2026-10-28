// A static server for the judge page during development, nothing else: serves the repository root
// so web/ can read web/sample/export.json, and answers web/results/ from eval/results/ the way the
// app does at /judge/results/ (src/app.js). No dependencies, no build. Never deployed.
// Run: node web/serve.js   then open http://127.0.0.1:8787/web/

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
/** @type {Record<string, string>} */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/web/' }).end();
    return;
  }
  // The results, as the judge page asks for them next to itself: a JSON list of names, one file.
  const results = /^\/web\/results\/([^/]*)$/.exec(url.pathname);
  if (results) {
    const dir = join(ROOT, 'eval', 'results');
    try {
      const names = (await readdir(dir)).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n)).sort();
      const name = decodeURIComponent(results[1]);
      if (name === '') {
        res.writeHead(200, { 'content-type': TYPES['.json'] }).end(JSON.stringify(names));
      } else if (names.includes(name)) {
        res.writeHead(200, { 'content-type': TYPES['.json'] }).end(await readFile(join(dir, name)));
      } else {
        res.writeHead(404).end();
      }
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || rel.split(sep).includes('..') || rel.startsWith('node_modules') || rel.startsWith('.git')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) {
      const index = await readFile(join(file, 'index.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] }).end(index);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`judge page: http://127.0.0.1:${PORT}/web/`);
});
