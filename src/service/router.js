// The router: the one service that talks to WhatsApp. It owns the webhooks (signature checked on the raw
// bytes before anything is parsed, src/wa/wa.js), the access tokens, which messages were seen and who is
// inside the 24-hour window. It holds no agent's key and no ledger, and it decides nothing: a message
// goes by {line, phone} to the one agent that person belongs to. It also serves what belongs to no agent:
// /health and the judge page.
//
//   /wa/<line>/webhook         WhatsApp (src/wa/wa.js)
//   POST /internal/wa/send     an agent sends to one of its own people, inside the window (internal token)
//   POST /internal/wa/media    an agent fetches a photo or voice note of a message routed to it (internal token)
//   /judge/, /health           as in src/app.js
//
// What lives where (src/wa/store.js): wa_seen and wa_window here, because every message passes here and
// every send is checked here. wa_missed and wa_integrity_told in each agent's own wa.db, because only that
// agent's ledger can rebuild a notice and only that agent knows what it told its owner.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createCloudClient } from '../wa/cloud.js';
import { createDirectory } from '../wa/directory.js';
import { openWaStore } from '../wa/store.js';
import { createWa } from '../wa/wa.js';
import { t } from '../i18n/index.js';
import { isJudgePath, serveJudge } from '../judge-page.js';
import { bearer, postJson, readJson, safeEqual, sendJson } from './internal.js';
import { loadRouterConfig } from './config.js';

// Handling can wait on models and on another agent; past this the person is told to send it again.
const INBOUND_TIMEOUT_MS = 10 * 60 * 1000;
// An agent restarting is back in seconds: only a refused connection, where nothing was delivered, is tried again.
const REFUSED_RETRIES = 2;
const REFUSED_RETRY_MS = 1500;

/**
 * @param {ReturnType<typeof loadRouterConfig>} cfg
 * @param {{fetch?: typeof globalThis.fetch, refusedRetryMs?: number, log?: (line: string) => void}} [o]
 */
export function createRouter(cfg, o = {}) {
  const log = o.log ?? ((/** @type {string} */ l) => console.log(`${new Date().toISOString()} ${l}`));
  const directory = createDirectory({ lines: cfg.lines.map((l) => l.phoneNumberId), people: cfg.people });
  const store = openWaStore(cfg.waStoreFile);
  const clients = new Map(cfg.lines.map((l) => [l.phoneNumberId, createCloudClient({ phoneNumberId: l.phoneNumberId, accessToken: l.accessToken, graphVersion: l.graphVersion, fetch: o.fetch })]));
  const agentById = new Map(cfg.agents.map((a) => [a.id, a]));
  // A photo or voice note may be fetched only by the agent its message went to, while it is handled.
  /** @type {Map<string, string>} media id to agent id */
  const openMedia = new Map();

  /**
   * @param {typeof cfg.agents[number]} agent @param {import('../wa/webhook.js').Inbound} msg
   * @returns {Promise<any>}
   */
  async function forward(agent, msg) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const r = await postJson(`${agent.url}/internal/wa/inbound`, agent.token, { msg }, { timeoutMs: INBOUND_TIMEOUT_MS });
        if (r.status !== 200) throw new Error(`agent ${agent.name} answered ${r.status}`);
        return r.json;
      } catch (e) {
        const refused = /** @type {NodeJS.ErrnoException} */ (e).code === 'ECONNREFUSED';
        if (!refused || attempt >= REFUSED_RETRIES) throw new Error(`agent ${agent.name} not reached${refused ? ' (not running)' : ''}`);
        await new Promise((r) => { setTimeout(r, o.refusedRetryMs ?? REFUSED_RETRY_MS); });
      }
    }
  }

  const wa = createWa({
    lines: cfg.lines.map((l) => ({ name: l.name, phoneNumberId: l.phoneNumberId, appSecret: l.appSecret, verifyToken: l.verifyToken, client: /** @type {any} */ (clients.get(l.phoneNumberId)) })),
    directory,
    store,
    unknownReply: () => t('wa.unknown_sender'),
    failureReply: (e) => t(e instanceof Error && /too large/.test(e.message) ? 'common.media_too_large' : 'common.try_again'),
    log,
    onMessage: async (msg, person) => {
      const agent = agentById.get(person.agent);
      if (!agent) throw new Error('no such agent');
      if (msg.mediaId) openMedia.set(msg.mediaId, agent.id);
      try {
        const r = await forward(agent, msg);
        if (r?.ok !== true) throw new Error(r?.tooLarge ? 'media too large' : `agent ${agent.name} could not handle it`);
      } finally {
        if (msg.mediaId) openMedia.delete(msg.mediaId);
      }
    },
  });

  /** @param {typeof cfg.agents[number]} agent @param {any} b */
  async function send(agent, b) {
    // Only to this agent's own people: a mistake or a takeover in one agent cannot write as another.
    const person = typeof b?.line === 'string' && typeof b.phone === 'string' ? directory.route(b.line, b.phone) : null;
    if (!person || person.agent !== agent.id) return { ok: false, reason: 'not this agent\'s person' };
    if (b.kind === 'text') return wa.send(b.line, b.phone, String(b.text));
    const bytes = new Uint8Array(Buffer.from(String(b.bytes), 'base64'));
    if (b.kind === 'image') return wa.sendImage(b.line, b.phone, { bytes, mime: String(b.mime), caption: String(b.caption) });
    if (b.kind === 'document') return wa.sendDocument(b.line, b.phone, { bytes, mime: String(b.mime), fileName: String(b.fileName), caption: String(b.caption) });
    return { ok: false, reason: 'unknown kind' };
  }

  /** @param {typeof cfg.agents[number]} agent @param {any} b */
  async function media(agent, b) {
    const client = typeof b?.line === 'string' ? clients.get(b.line) : undefined;
    if (!client || typeof b.mediaId !== 'string' || openMedia.get(b.mediaId) !== agent.id) return { ok: false };
    try {
      const m = await client.fetchMedia(b.mediaId);
      return { ok: true, mimeType: m.mimeType, sha256: m.sha256, bytes: m.bytes.toString('base64') };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'error';
      log(`router: media for ${agent.name} failed: ${message}`);
      return { ok: false, tooLarge: /too large/.test(message) };
    }
  }

  /** @param {string} path @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function internal(path, req, res) {
    const given = bearer(req);
    const agent = cfg.agents.find((a) => safeEqual(given, a.token));
    if (!agent || req.method !== 'POST' || (path !== '/internal/wa/send' && path !== '/internal/wa/media')) {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 413, { ok: false, reason: 'too large' });
      return;
    }
    sendJson(res, 200, await (path === '/internal/wa/send' ? send(agent, body) : media(agent, body)));
  }

  return {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (path.startsWith('/internal/')) {
        await internal(path, req, res);
        return;
      }
      if (await wa.handle(req, res)) return;
      if (isJudgePath(path)) {
        await serveJudge(path, req, res);
        return;
      }
      res.writeHead(404).end();
    },
    close: () => store.close(),
  };
}

/**
 * Starts the router from its environment.
 * @param {Record<string, string | undefined>} env
 * @param {Parameters<typeof createRouter>[1]} [o]
 */
export function startRouter(env, o) {
  const cfg = loadRouterConfig(env);
  const router = createRouter(cfg, o);
  const server = createServer((req, res) => {
    router.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`hisaab-bridge router listening on ${cfg.host}:${cfg.port}; ${cfg.lines.length} lines, ${cfg.people.length} people`);
  });
  const stop = () => server.close(() => {
    router.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { cfg, router, server };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    startRouter(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'could not start');
    process.exit(1);
  }
}
