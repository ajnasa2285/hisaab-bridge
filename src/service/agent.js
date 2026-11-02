// One agent as its own running service: HB_AGENT=jcb|site|supplier, its own data folder, its own key
// and nothing of another agent's (src/service/config.js). It is the same app as ever (src/app.js) with one
// agent in it; WhatsApp comes and goes through the router (src/service/router.js).
//
//   POST /internal/wa/inbound             a message the router routed here (internal token)
//   POST /agents/<name>/receipt-check     another agent's signed request for the ledger check (src/service/receipt-check.js)
//   /agents/<name>/...                    as in src/app.js: Agent Card, A2A, export, trace

import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createApp } from '../app.js';
import { publicKeyText } from '../protocol/keys.js';
import { bearer, readJson, safeEqual, sendJson } from './internal.js';
import { createGateway } from './gateway.js';
import { askerOf, createPeerCheck, peerView } from './receipt-check.js';
import { loadAgentConfig } from './config.js';

// At start the other agents may not be up yet: the check is tried again soon, a few times.
const CHECK_RETRY_MS = 2 * 60 * 1000;
const CHECK_RETRIES = 5;
const MAX_CHECK_REQUEST_BYTES = 4096;

/**
 * @typedef {Pick<Parameters<typeof createApp>[0], 'spark' | 'readMeter' | 'sameMeter' | 'readUpi' | 'readCashReceipt' | 'readChallan' | 'classifyPhoto' | 'transcribe' | 'toWav'>} Models
 */

/**
 * @param {ReturnType<typeof loadAgentConfig>} cfg
 * @param {Models & {checkRetryMs?: number, integrityCheckMs?: number, log?: (line: string) => void}} models
 */
export function createAgentService(cfg, models) {
  const log = models.log ?? ((/** @type {string} */ l) => console.log(`${new Date().toISOString()} ${l}`));
  const { checkRetryMs, integrityCheckMs, log: _log, ...readers } = models;
  const now = Date.now;
  /** @type {NodeJS.Timeout | null} */
  let retry = null;
  let retries = 0;
  const check = createPeerCheck({
    self: { name: cfg.name, id: cfg.self.id, privateKey: cfg.agent.privateKey, publicKey: createPublicKey(cfg.agent.privateKey) },
    peers: cfg.peerDirectory,
    now,
    onPeerMissed: () => {
      if (retry || retries >= CHECK_RETRIES) return;
      retries += 1;
      retry = setTimeout(() => { retry = null; void app.checkNow(); }, checkRetryMs ?? CHECK_RETRY_MS);
      retry.unref();
    },
  });
  const app = createApp({
    ...readers,
    baseUrl: cfg.baseUrl,
    dataDir: cfg.dataDir,
    agents: [cfg.agent],
    lines: [],
    gateway: createGateway({ routerUrl: cfg.routerUrl, token: cfg.internalToken, lineIds: cfg.lineIds }),
    ledgerCheck: check,
    people: cfg.people,
    waStoreFile: cfg.waStoreFile,
    exportToken: cfg.exportToken,
    traceText: cfg.traceText,
    now,
    log,
    ...(integrityCheckMs === undefined ? {} : { integrityCheckMs }),
  });
  const entry = /** @type {NonNullable<ReturnType<typeof app.agent>>} */ (app.agent(cfg.self.id));

  /**
   * A person's message, answered only when its handling has finished, because the router tells the person
   * when it failed. The headers go at once so the wait shows as work, not as silence.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async function inbound(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { ok: false });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    try {
      const known = await app.inbound(body.msg);
      res.end(JSON.stringify(known ? { ok: true } : { ok: false, unknown: true }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'error';
      log(`${cfg.name}: handling a ${body.msg?.kind} message failed: ${message}`);
      res.end(JSON.stringify({ ok: false, tooLarge: /too large/.test(message) }));
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function receiptCheck(req, res) {
    let asker = null;
    try {
      asker = askerOf(await readJson(req, MAX_CHECK_REQUEST_BYTES), cfg.self.id, entry.core.peers, now());
    } catch { /* not a request: the same answer as no signature */ }
    if (!asker) {
      res.writeHead(404).end();
      return;
    }
    const exportedAt = new Date(now()).toISOString();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(peerView(entry.core.ledger, asker, cfg.self.id, exportedAt)));
  }

  return {
    app,
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/internal/wa/inbound') {
        if (req.method !== 'POST' || !safeEqual(bearer(req), cfg.internalToken)) {
          res.writeHead(404).end();
          return;
        }
        await inbound(req, res);
        return;
      }
      if (path === `/agents/${cfg.name}/receipt-check` && req.method === 'POST') {
        await receiptCheck(req, res);
        return;
      }
      await app.handle(req, res);
    },
    close() {
      if (retry) clearTimeout(retry);
      app.close();
    },
  };
}

/**
 * Starts one agent's service from its environment.
 * @param {Record<string, string | undefined>} env
 * @param {Models & {checkRetryMs?: number, integrityCheckMs?: number}} models
 */
export function startAgent(env, models) {
  const cfg = loadAgentConfig(env);
  const service = createAgentService(cfg, models);
  const server = createServer((req, res) => {
    service.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`hisaab-bridge agent ${cfg.name} listening on ${cfg.host}:${cfg.port}: ${cfg.self.id} ${publicKeyText(cfg.agent.privateKey)}`);
  });
  const stop = () => server.close(() => {
    service.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { cfg, service, server };
}

async function main() {
  // Loaded here, not at the top, so tests can run this module with stand-in models.
  const [{ listModels, museSpark, transcribe }, { readMeter }, { readUpi }, { readChallan }, { classifyPhoto }, { sameMeter }] = await Promise.all([
    import('../meta/client.js'), import('../readers/meter.js'), import('../readers/upi.js'), import('../readers/challan.js'), import('../readers/photo.js'), import('../readers/same-meter.js'),
  ]);
  startAgent(process.env, { spark: museSpark, readMeter, sameMeter, readUpi, readChallan, classifyPhoto, transcribe });
  // A wrong Meta setting would otherwise only show as "try again" replies: say it once at start.
  const models = await listModels();
  const want = [process.env.MUSE_SPARK_MODEL, process.env.MUSE_TRANSCRIBE_MODEL];
  if (!models.ok) console.error(`meta: not usable (${models.reason}); check META_API_KEY and META_API_BASE`);
  else for (const m of want) if (!m || !models.models.includes(m)) console.error(`meta: model "${m ?? ''}" is not in the catalog; check MUSE_SPARK_MODEL / MUSE_TRANSCRIBE_MODEL`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (e) {
    // config: messages name files and variables, never their contents.
    console.error(e instanceof Error ? e.message : 'could not start');
    process.exit(1);
  }
}
