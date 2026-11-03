// Three agents and a router, each in its own process with its own data folder, behind a stand-in for
// Caddy that follows the routes of the real deploy/aws/Caddyfile.services file, and a stand-in Graph API
// server. The data folders and settings come from src/service/migrate.js, as they would on the server,
// from an invented one-process folder. Invented people and numbers only (phones 9190000000xx).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHmac } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeys } from '../../src/protocol/keys.js';
import { parseEnvFile, split } from '../../src/service/migrate.js';
import { sentText } from '../wa/sent-text.js';

export const OWNER = '919000000101';
export const OPERATOR = '919000000102';
export const SUPPLIER = '919000000121';
export const SUPERVISOR = '919000000111';
export const CONTRACTOR = '919000000112';
export const STRANGER = '919000000199';
export const EXPORT_TOKEN = 'test-export-token-not-real';
/** Known on two lines when there are three: the JCB agent's owner on one, the supplier agent's on another. */
export const TWO_LINES = '919000000131';
const SECRET = { jcb: 'secret-jcb-not-real', site: 'secret-site-not-real', supplier: 'secret-sup-not-real' };
const CHILD = fileURLToPath(new URL('./child.js', import.meta.url));
/** @type {Record<string, 'jcb' | 'site' | 'supplier'>} */
const LINE = { [OWNER]: 'jcb', [OPERATOR]: 'jcb', [SUPPLIER]: 'jcb', [SUPERVISOR]: 'site', [CONTRACTOR]: 'site', [STRANGER]: 'site', [TWO_LINES]: 'jcb' };
const LINE_ID = { jcb: 'line-jcb', site: 'line-site', supplier: 'line-sup' };
/** The settings that give the supplier its own number. */
export const SUPPLIER_LINE_SETTINGS = ['HB_WA_SUPPLIER_PHONE_NUMBER_ID=line-sup', `HB_WA_SUPPLIER_APP_SECRET=${SECRET.supplier}`, 'HB_WA_SUPPLIER_VERIFY_TOKEN=verify-sup', 'HB_WA_SUPPLIER_ACCESS_TOKEN=tok-sup'];

const freePort = () => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
    s.close(() => resolve(port));
  });
});

/**
 * The one-process service's folder and settings, with invented people.
 * @param {string} dir @param {string} baseUrl
 * @param {{sharedNumber?: boolean, threeLines?: boolean}} [o] sharedNumber: both lines the same WhatsApp number, as on the server now;
 *   threeLines: a number for each agent, the supplier's people on their own line and one person on two lines
 */
export function inventOneFolder(dir, baseUrl, o = {}) {
  mkdirSync(join(dir, 'keys'), { recursive: true });
  for (const f of ['jcb', 'contractor', 'supplier']) {
    writeFileSync(join(dir, 'keys', `${f}.pem`), generateKeys().privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  writeFileSync(join(dir, 'people.json'), JSON.stringify([
    { line: 'jcb', phone: OWNER, agent: 'jcb', role: 'jcb_owner', name: 'Owner' },
    { line: 'jcb', phone: OPERATOR, agent: 'jcb', role: 'operator', name: 'Operator' },
    { line: o.threeLines ? 'supplier' : 'jcb', phone: SUPPLIER, agent: 'supplier', role: 'supplier', name: 'Supplier' },
    { line: 'site', phone: SUPERVISOR, agent: 'contractor', role: 'supervisor', name: 'Supervisor' },
    { line: 'site', phone: CONTRACTOR, agent: 'contractor', role: 'contractor', name: 'Contractor' },
    ...(o.threeLines ? [
      { line: 'jcb', phone: TWO_LINES, agent: 'jcb', role: 'jcb_owner', name: 'Partner' },
      { line: 'supplier', phone: TWO_LINES, agent: 'supplier', role: 'supplier', name: 'Partner' },
    ] : []),
  ]));
  const envFile = join(dir, 'hisaab.env');
  writeFileSync(envFile, [`HB_DATA_DIR=${dir}`, `HB_BASE_URL=${baseUrl}`, 'HB_PORT=8080', 'HB_HOST=127.0.0.1', `HB_EXPORT_TOKEN=${EXPORT_TOKEN}`,
    `HB_WA_JCB_PHONE_NUMBER_ID=${o.sharedNumber ? 'line-site' : 'line-jcb'}`, `HB_WA_JCB_APP_SECRET=${o.sharedNumber ? SECRET.site : SECRET.jcb}`, 'HB_WA_JCB_VERIFY_TOKEN=verify-jcb', 'HB_WA_JCB_ACCESS_TOKEN=tok-jcb',
    'HB_WA_SITE_PHONE_NUMBER_ID=line-site', `HB_WA_SITE_APP_SECRET=${SECRET.site}`, 'HB_WA_SITE_VERIFY_TOKEN=verify-site', 'HB_WA_SITE_ACCESS_TOKEN=tok-site',
    ...(o.threeLines ? SUPPLIER_LINE_SETTINGS : []),
    'META_API_KEY=meta-test-key-not-real', 'META_API_BASE=https://api.meta.ai/v1', 'MUSE_SPARK_MODEL=muse-spark-1.3', ''].join('\n'));
  return envFile;
}

/**
 * The routes of the Caddyfile, in order: which paths go to which port. A handle's matcher is either a
 * path list or nothing (the last one, 404).
 * @param {string} text @param {Record<string, number>} ports the port each placeholder stands for
 */
export function caddyRoutes(text, ports) {
  /** @type {Record<string, string[]>} */
  const matchers = {};
  for (const m of text.matchAll(/^\s*@(\w+)\s+path\s+(.+)$/gm)) matchers[m[1]] = m[2].trim().split(/\s+/);
  /** @type {{paths: string[], port: number}[]} */
  const routes = [];
  for (const m of text.matchAll(/handle @(\w+) \{[\s\S]*?reverse_proxy 127\.0\.0\.1:\{\$(\w+):(\d+)\}/g)) routes.push({ paths: matchers[m[1]], port: ports[m[2]] });
  return routes;
}

/** Caddy's path matcher: an exact path, or a prefix ending in * . @param {string} pattern @param {string} path */
const matches = (pattern, path) => {
  if (!pattern.includes('*')) return pattern === path;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(path);
};

/** @param {string} prefix */
export function makeDirs(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, one: join(root, 'one'), prefix: join(root, 'hisaab-'), env: join(root, 'env') };
}

/**
 * Starts everything.
 * @param {import('node:test').TestContext} tc
 * @param {{checkMs?: number, sharedNumber?: boolean, threeLines?: boolean}} [o]
 */
export async function startServices(tc, o = {}) {
  const dirs = makeDirs('hb-split-');
  /** `token`: the access token it went out with; `buttons`: a question's reply buttons. @type {{to: string, line: string, text: string, kind: string, token: string, buttons?: {id: string, title: string}[]}[]} */
  const sent = [];
  /** Photo bytes by media id. @type {Record<string, string>} */
  const media = {};
  let graphFails = 0;
  // Reply-button messages refused, the texts after them not.
  let buttonFails = 0;
  const graph = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const file = /^\/file\/(.+)$/.exec(url);
      if (file) { res.end(media[file[1]] ?? ''); return; }
      const lookup = /^\/v[\d.]+\/(media-[a-z0-9-]+)$/.exec(url);
      if (lookup) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: `https://graph.test/file/${lookup[1]}`, mime_type: 'image/jpeg', file_size: Buffer.byteLength(media[lookup[1]] ?? '') }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (url.endsWith('/media')) { res.end(JSON.stringify({ id: 'uploaded-1' })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      // A question's buttons and the text sent when they fail are one notice that did not go.
      if (graphFails > 0) { if (body.type !== 'interactive') graphFails -= 1; res.statusCode = 400; res.end('{}'); return; }
      if (buttonFails > 0 && body.type === 'interactive') { buttonFails -= 1; res.statusCode = 400; res.end(JSON.stringify({ error: { code: 131009 } })); return; }
      const line = /\/(line-[a-z]+)\/messages$/.exec(url)?.[1] ?? '?';
      sent.push({ to: body.to, line, text: sentText(body) ?? body.image?.caption ?? body.document?.caption ?? '', kind: body.type, token: String(req.headers.authorization).replace('Bearer ', ''),
        ...(body.type === 'interactive' ? { buttons: body.interactive.action.buttons.map((/** @type {any} */ b) => b.reply) } : {}) });
      res.end(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }));
    });
  });
  await new Promise((r) => graph.listen(0, '127.0.0.1', () => r(undefined)));
  const graphUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (graph.address()).port}`;

  // The front door, on a port known before the agents start: their cards and peers name it.
  const ports = { HB_PORT: await freePort(), HB_PORT_JCB: await freePort(), HB_PORT_SITE: await freePort(), HB_PORT_SUPPLIER: await freePort(), FRONT: await freePort() };
  const base = `http://127.0.0.1:${ports.FRONT}`;
  const routes = caddyRoutes(readFileSync(new URL('../../deploy/aws/Caddyfile.services', import.meta.url), 'utf8'), ports);
  const front = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = routes.find((r) => r.paths.some((p) => matches(p, path)));
    if (!route) { res.writeHead(404).end('Not found'); return; }
    const up = request({ host: '127.0.0.1', port: route.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => front.listen(ports.FRONT, '127.0.0.1', () => r(undefined)));

  const envIn = inventOneFolder(dirs.one, base, { sharedNumber: o.sharedNumber, threeLines: o.threeLines });
  /** @type {string[]} */
  const migrated = [];
  assert.equal(await split({ from: dirs.one, envIn, toPrefix: dirs.prefix, envOut: dirs.env }, (l) => { migrated.push(l); }), true, migrated.join(' / '));
  return finish(tc, { dirs, sent, media, front, graph, graphUrl, ports, base, routes, migrated, setGraphFails: (/** @type {number} */ n) => { graphFails = n; }, setButtonFails: (/** @type {number} */ n) => { buttonFails = n; }, checkMs: o.checkMs, sharedNumber: o.sharedNumber });
}

/** @param {import('node:test').TestContext} tc @param {any} s */
async function finish(tc, s) {
  const { dirs, ports, graphUrl, base, sent, media } = s;
  /** Settings as migrate.js wrote them, on this test's ports. @param {string} name */
  const settings = (name) => {
    const env = parseEnvFile(readFileSync(join(dirs.env, `${name}.env`), 'utf8'));
    if (name === 'router') {
      Object.assign(env, { HB_PORT: String(ports.HB_PORT), HB_AGENT_URL_JCB: `http://127.0.0.1:${ports.HB_PORT_JCB}`, HB_AGENT_URL_SITE: `http://127.0.0.1:${ports.HB_PORT_SITE}`, HB_AGENT_URL_SUPPLIER: `http://127.0.0.1:${ports.HB_PORT_SUPPLIER}`, TEST_GRAPH_URL: graphUrl });
    } else {
      const port = /** @type {any} */ ({ jcb: ports.HB_PORT_JCB, site: ports.HB_PORT_SITE, supplier: ports.HB_PORT_SUPPLIER })[name];
      Object.assign(env, { HB_PORT: String(port), HB_ROUTER_URL: `http://127.0.0.1:${ports.HB_PORT}`, ...(s.checkMs ? { TEST_CHECK_MS: String(s.checkMs) } : {}) });
    }
    return env;
  };
  /** @type {Map<string, {child: import('node:child_process').ChildProcess, output: string[], exited: Promise<number | null>}>} */
  const children = new Map();
  /** @param {string} name */
  async function start(name) {
    const output = /** @type {string[]} */ ([]);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, name === 'router' ? 'router' : 'agent'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, ...settings(name) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => output.push(String(d)));
    child.stderr?.on('data', (d) => output.push(String(d)));
    const exited = new Promise((r) => { child.on('exit', (code) => r(code)); });
    children.set(name, { child, output, exited: /** @type {Promise<number|null>} */ (exited) });
    const port = name === 'router' ? ports.HB_PORT : /** @type {any} */ ({ jcb: ports.HB_PORT_JCB, site: ports.HB_PORT_SITE, supplier: ports.HB_PORT_SUPPLIER })[name];
    for (let i = 0; i < 200; i += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${name} did not start: ${output.join('')}`);
  }
  /** @param {string} name */
  async function kill(name) {
    const c = children.get(name);
    if (!c) return;
    c.child.kill('SIGKILL');
    await c.exited;
    children.delete(name);
  }
  await Promise.all(['router', 'jcb', 'site', 'supplier'].map(start));
  tc.after(async () => {
    await Promise.all([...children.keys()].map(kill));
    await new Promise((r) => s.front.close(() => r(undefined)));
    await new Promise((r) => s.graph.close(() => r(undefined)));
    for (let i = 0; i < 5; i += 1) {
      try { rmSync(dirs.root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  });

  let n = 0;
  /** @param {string} from @param {any} message @param {'jcb' | 'site' | 'supplier'} [onLine] the number written to, when not their usual one */
  const post = async (from, message, onLine) => {
    n += 1;
    const line = onLine ?? (s.sharedNumber ? 'site' : LINE[from]);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: LINE_ID[line] },
      messages: [{ from, id: `wamid.e2e${n}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] });
    const r = await fetch(`${base}/wa/${line}/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET[line]).update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
    return { body, line };
  };
  /** Messages have stopped moving for a while: across processes there is nothing nearer to wait on. */
  const settle = async () => {
    let [last, still] = [-1, 0];
    for (let i = 0; i < 300 && still < 6; i += 1) {
      const exports = await Promise.all(['jcb', 'site', 'supplier'].map((name) => (children.has(name) ? exportOf(name).catch(() => ({ events: [] })) : { events: [] })));
      const now = sent.length + exports.reduce((sum, x) => sum + x.events.length, 0);
      still = now === last ? still + 1 : 0;
      last = now;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const lastTo = (/** @type {string} */ phone) => sent.filter((/** @type {any} */ x) => x.to === phone).at(-1)?.text ?? '';
  /** @param {string} from @param {string} text @param {'jcb' | 'site' | 'supplier'} [onLine] */
  const say = async (from, text, onLine) => { await post(from, { type: 'text', text: { body: text } }, onLine); await settle(); };
  /** The buttons of the last question with buttons sent to this person. @param {string} phone @returns {{id: string, title: string}[]} */
  const buttonsTo = (phone) => sent.filter((/** @type {any} */ x) => x.to === phone && x.buttons).at(-1)?.buttons ?? [];
  /**
   * A reply button tapped, as WhatsApp sends it: by default the one with this title on the last question
   * with buttons sent to this person. @param {string} from @param {string} title @param {string} [id] another id, as an old button has
   */
  const tap = async (from, title, id) => {
    await post(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: id ?? buttonsTo(from).find((b) => b.title === title)?.id ?? 'yes:none-sent-yet', title } } });
    await settle();
  };
  /** @param {string} from @param {string} shows what the stand-in readers will see */
  const photo = async (from, shows) => {
    const id = `media-${n + 1}`;
    media[id] = shows;
    await post(from, { type: 'image', image: { id, mime_type: 'image/jpeg' } });
    await settle();
  };
  const yesIfAsked = async (/** @type {string} */ phone) => { if (/हाँ \/ नहीं|"हाँ"/u.test(lastTo(phone))) await say(phone, 'हाँ'); };
  /** @param {string} name */
  const exportOf = async (name) => (await fetch(`${base}/agents/${name}/export`, { headers: { authorization: `Bearer ${EXPORT_TOKEN}` } })).json();

  return { ...s, settings, start, kill, children, post, say, tap, buttonsTo, photo, settle, lastTo, yesIfAsked, exportOf, sent, media, base, secret: SECRET };
}

/**
 * A whole JCB job over WhatsApp, every step through the webhook and across the processes.
 * @param {Awaited<ReturnType<typeof startServices>>} s
 */
export async function jcbJob(s) {
  for (const p of [OWNER, OPERATOR, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
  await s.say(SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
  await s.say(CONTRACTOR, 'ok J-1');
  await s.say(OWNER, 'हाँ 1200');
  await s.photo(OPERATOR, 'meter:12345');
  await s.yesIfAsked(OPERATOR);
  await s.photo(OPERATOR, 'meter:12406');
  await s.yesIfAsked(OPERATOR);
  await s.say(OWNER, 'बिल');
  await s.yesIfAsked(OWNER);
  await s.yesIfAsked(CONTRACTOR);
  await s.photo(CONTRACTOR, 'upi:732000');
  await s.yesIfAsked(CONTRACTOR);
  await s.yesIfAsked(OWNER);
}
