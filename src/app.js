// The whole service in one process: the WhatsApp lines, the people directory, one conversation per
// agent, the agents themselves, and each agent's A2A endpoint. The JCB, contractor and supplier
// agents keep separate keys and separate ledgers and talk to each other only over A2A, exactly as
// they would on three servers: the contractor's agent with each seller, the sellers never with each
// other.
//
//   /wa/<line>/webhook                              WhatsApp (src/wa/wa.js)
//   /agents/<name>/.well-known/agent-card.json      Agent Card
//   /agents/<name>/a2a                              A2A JSON-RPC
//   /agents/<name>/export                           one side of the ledgers for the judge page (token only)
//   /judge/                                         the judge page (web/, an allow-list of its own files)
//   /judge/results/                                 the aggregate reader results (eval/results/*.json)
//   /health                                         "ok"

import { readdir, readFile } from 'node:fs/promises';
import { openLedger } from './ledger/store.js';
import { openRefs } from './ledger/refs.js';
import { agentCardJson, createA2AHandler } from './transport/a2a.js';
import { publicKeyText } from './protocol/keys.js';
import { createLink } from './agents/link.js';
import { createJcbAgent } from './agents/jcb.js';
import { createContractorAgent } from './agents/contractor.js';
import { createSupplierAgent } from './agents/supplier.js';
import { createConversation } from './agents/conversation.js';
import { createOffice } from './agents/office.js';
import { createEvidenceService, forwardEvidence } from './agents/evidence.js';
import { openMediaStore } from './media/store.js';
import { createDirectory } from './wa/directory.js';
import { openWaStore } from './wa/store.js';
import { createWa } from './wa/wa.js';
import { createCloudClient } from './wa/cloud.js';
import { maskPhone } from './wa/webhook.js';
import { toWav } from './wa/audio.js';
import { t } from './i18n/index.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const RETRY_MS = 60 * 1000;

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
  'sample/export.json': 'application/json; charset=utf-8',
};
const RESULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const JUDGE_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

/** @typedef {import('./protocol/messages.js').Peer} Peer */
/** @typedef {import('./wa/directory.js').Person} Person */
/**
 * @typedef {{
 *   name: string, kind: 'jcb' | 'contractor' | 'supplier', id: string, title: string,
 *   privateKey: import('node:crypto').KeyObject, ledgerFile: string,
 *   peers: Peer[], peerUrls: Record<string, string>, jcbAgentId?: string, supplierAgentId?: string,
 *   limits?: import('./agents/office.js').Limits,
 * }} AgentConfig
 * @typedef {{name: string, phoneNumberId: string, appSecret: string, verifyToken: string, accessToken: string, graphVersion?: string}} LineConfig
 */

/**
 * @param {{
 *   baseUrl: string,
 *   dataDir?: string,
 *   agents: AgentConfig[],
 *   lines: LineConfig[],
 *   people: Person[],
 *   waStoreFile: string,
 *   spark: import('./orchestrator/orchestrator.js').Spark,
 *   readMeter?: import('./agents/conversation.js').MeterReader,
 *   sameMeter?: import('./agents/conversation.js').SameMeterCheck,
 *   readUpi?: import('./agents/conversation.js').UpiReader,
 *   readChallan?: import('./agents/conversation.js').ChallanReader,
 *   classifyPhoto?: import('./agents/conversation.js').PhotoClassifier,
 *   transcribe?: (req: {audio: Uint8Array, mime: string, language?: 'hi'}) => Promise<{ok: true, text: string} | {ok: false, transient: boolean, reason: string}>,
 *   toWav?: typeof import('./wa/audio.js').toWav,
 *   fetch?: typeof globalThis.fetch,
 *   transport?: (baseUrl: string, m: any) => Promise<unknown>,
 *   exportToken?: string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} cfg
 */
export function createApp(cfg) {
  const now = cfg.now ?? Date.now;
  const log = cfg.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  const directory = createDirectory({ lines: cfg.lines.map((l) => l.phoneNumberId), people: cfg.people });
  const store = openWaStore(cfg.waStoreFile);
  const clients = new Map(cfg.lines.map((l) => [l.phoneNumberId, createCloudClient({ phoneNumberId: l.phoneNumberId, accessToken: l.accessToken, graphVersion: l.graphVersion, fetch: cfg.fetch })]));

  /** Sends a text to a person on their line; outside the 24-hour window it is only logged. @param {Person} p @param {string} text */
  async function sendTo(p, text) {
    const r = await wa.send(p.line, p.phone, text);
    if (!r.ok) log(`notice to ${p.role} ${maskPhone(p.phone)} not sent: ${r.reason}`);
  }

  /** @type {Map<string, {cfg: AgentConfig, core: any, agent: {tools: any, onApplied: (m: any) => Promise<void>}, link: ReturnType<typeof createLink>, talk: ReturnType<typeof createConversation>, a2a: ReturnType<typeof createA2AHandler>}>} */
  const agents = new Map();
  for (const a of cfg.agents) {
    const core = {
      self: { id: a.id, privateKey: a.privateKey },
      peers: new Map(a.peers.map((p) => [p.id, p])),
      ledger: openLedger(a.ledgerFile),
      now,
      mediaStore: cfg.dataDir ? openMediaStore({ dataDir: cfg.dataDir, agentId: a.id }) : undefined,
    };
    const link = createLink(core, { peerUrls: new Map(Object.entries(a.peerUrls)), transport: cfg.transport,
      onEvidence: (m) => evidence.onEvidence(m) });
    /** @type {import('./agents/common.js').Tell} */
    const tell = async (role, key, params, expect) => {
      for (const p of directory.people(a.id, role)) {
        await sendTo(p, t(key, params));
        if (expect) entry.talk.expect(p, expect.tool, expect.args, expect.no);
      }
    };
    const evidence = createEvidenceService({ agent: core, link, kind: a.kind, tell, spark: cfg.spark,
      readMeter: cfg.readMeter, readChallan: cfg.readChallan, readUpi: cfg.readUpi,
      show: async (image, caption) => {
        const roles = a.kind === 'contractor' ? ['contractor', 'supervisor'] : a.kind === 'jcb' ? ['jcb_owner'] : ['supplier'];
        for (const role of roles) for (const p of directory.people(a.id, /** @type {import('./wa/directory.js').Role} */ (role))) {
          await forwardEvidence({ image, caption,
            sendImage: (photo, text) => wa.sendImage(p.line, p.phone, { ...photo, caption: text }),
            sendText: (text) => sendTo(p, text) });
        }
      },
    });
    // The person's count/dispute acknowledgement goes first; photo readers run afterwards.
    // These requests are observations and cannot change a bill or a person's decision.
    const automaticEvidence = {
      /** @param {string} orderId */
      async countDifference(orderId) {
        setImmediate(() => { evidence.countDifference(orderId).catch(() => log(`${a.name}: count evidence unavailable`)); });
      },
      /** @param {string} orderId */
      async disputedBill(orderId) {
        setImmediate(() => { evidence.disputedBill(orderId).catch(() => log(`${a.name}: bill evidence unavailable`)); });
      },
    };
    const agent = a.kind === 'jcb'
      ? createJcbAgent({ agent: core, link, tell, spark: cfg.spark })
      : a.kind === 'supplier'
        ? createSupplierAgent({ agent: core, link, tell, spark: cfg.spark })
        : createContractorAgent({ agent: core, link, tell, spark: cfg.spark, jcbAgentId: /** @type {string} */ (a.jcbAgentId), supplierAgentId: a.supplierAgentId, evidence: automaticEvidence });
    /** @type {import('./agents/conversation.js').Reply} */
    const reply = (p, key, params) => sendTo(p, t(key, params));
    // References, exact commands, and (contractor) approvals with this agent's limits.
    // The owner's yes/no to sharing a photo (evidence.tools) is a step like the agent's own.
    const tools = { ...agent.tools, ...evidence.tools };
    const office = createOffice({ ledger: core.ledger, tools, kind: a.kind, limits: a.limits, tell, reply, now, evidence });
    // Every agent asks Muse Spark what a photo is; each then reads only its own kinds: meters (JCB),
    // UPI screenshots and the site's copy of a challan (contractor), challans (supplier).
    const talk = createConversation({
      ledger: core.ledger, tools, spark: cfg.spark, readMeter: a.kind === 'jcb' ? cfg.readMeter : undefined,
      sameMeter: a.kind === 'jcb' ? cfg.sameMeter : undefined, log,
      readUpi: a.kind === 'contractor' ? cfg.readUpi : undefined,
      readChallan: a.kind === 'supplier' || a.kind === 'contractor' ? cfg.readChallan : undefined,
      classifyPhoto: cfg.classifyPhoto, reply, now, office,
      mediaStore: core.mediaStore,
    });
    const card = agentCardJson({ id: a.id, name: a.title, description: a.title, baseUrl: `${cfg.baseUrl}/agents/${a.name}`, publicKeyText: publicKeyText(a.privateKey) });
    const a2a = createA2AHandler(core, card, {
      onApplied: (m) => {
        agent.onApplied(m).then(() => evidence.onApplied(m)).catch((e) => log(`${a.name}: notice after ${m.type} failed: ${e instanceof Error ? e.message : 'error'}`));
      },
    });
    const entry = { cfg: a, core, agent, link, talk, a2a };
    agents.set(a.id, entry);
  }

  const wa = createWa({
    lines: cfg.lines.map((l) => ({ name: l.name, phoneNumberId: l.phoneNumberId, appSecret: l.appSecret, verifyToken: l.verifyToken, client: /** @type {any} */ (clients.get(l.phoneNumberId)) })),
    directory,
    store,
    unknownReply: () => t('wa.unknown_sender'),
    now,
    log,
    onMessage: async (msg, person) => {
      const entry = agents.get(person.agent);
      if (!entry) return;
      if (msg.kind === 'text' || msg.kind === 'button') return entry.talk.onText(person, msg.text ?? '');
      if (msg.kind === 'image' && msg.mediaId) {
        const media = await /** @type {any} */ (clients.get(person.line)).fetchMedia(msg.mediaId, { expectedSha256: undefined });
        return entry.talk.onImage(person, { mime: media.mimeType, bytes: new Uint8Array(media.bytes), takenAt: null, forwarded: msg.forwarded === true });
      }
      if (msg.kind === 'audio' && msg.mediaId && cfg.transcribe) {
        // A voice note is read as the text it says; the same read-back follows before anything commits.
        const media = await /** @type {any} */ (clients.get(person.line)).fetchMedia(msg.mediaId);
        const wav = await (cfg.toWav ?? toWav)(new Uint8Array(media.bytes));
        if (!wav.ok) {
          log(`voice from ${person.role} ${maskPhone(person.phone)} not converted: ${wav.reason}`);
          return sendTo(person, t('voice.not_understood'));
        }
        const said = await cfg.transcribe({ audio: wav.wav, mime: 'audio/wav', language: 'hi' });
        if (!said.ok || !said.text.trim()) return sendTo(person, t('voice.not_understood'));
        return entry.talk.onText(person, said.text);
      }
      // Documents are not handled yet.
      return sendTo(person, t('common.unknown_step'));
    },
  });

  // Messages that could not reach the other agent are delivered again, unchanged.
  const timer = setInterval(() => {
    for (const { link, cfg: a } of agents.values()) {
      link.retryPending().then((rs) => {
        for (const r of rs) if (!r.ok && r.reason !== 'unreachable') log(`${a.name}: re-delivery ${r.reason}`);
      }).catch(() => {});
    }
  }, RETRY_MS);
  timer.unref();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (await wa.handle(req, res)) return;
    if (path === '/judge' || path.startsWith('/judge/')) {
      await serveJudge(path, req, res);
      return;
    }
    const m = /^\/agents\/([a-z0-9-]{1,32})\//.exec(path);
    const entry = m ? [...agents.values()].find((x) => x.cfg.name === m[1]) : undefined;
    if (entry && req.method === 'GET' && path === `/agents/${entry.cfg.name}/export`) {
      // Real pilot data: only with the export token, and never at all when no token is configured.
      const auth = req.headers.authorization ?? '';
      if (!cfg.exportToken || !safeEqual(auth, `Bearer ${cfg.exportToken}`)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(exportSide(entry)));
      return;
    }
    if (entry && (await entry.a2a(req, res))) return;
    res.writeHead(404).end();
  }

  /**
   * The judge page and its results, GET only, each response with the page's headers.
   * @param {string} path
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function serveJudge(path, req, res) {
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

  /** One side in the judge page's `hb-export/0.1` shape (web/README.md, CONTRACTS section 10). @param {any} entry */
  function exportSide(entry) {
    const ledger = entry.core.ledger;
    const orders = ledger.orders();
    const events = orders.flatMap((/** @type {{order_id: string}} */ o) => ledger.events(o.order_id)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.seq - b.seq);
    // This side's own references (J-n / P-n), one per order; optional in the shape, so an older
    // page still reads the export.
    const refs = openRefs(ledger);
    /** @type {Record<string, string>} */
    const refByOrder = {};
    for (const o of orders) {
      const ref = refs.refOf(o.order_id);
      if (ref !== null) refByOrder[o.order_id] = ref;
    }
    return { v: 'hb-export/0.1', exportedAt: new Date(now()).toISOString(), agentId: entry.cfg.id, publicKey: publicKeyText(entry.cfg.privateKey), orders, events, chain: ledger.verifyChain(), refs: refByOrder };
  }

  return {
    handle,
    /** For tests and the judge export. @param {string} id */
    agent: (id) => agents.get(id),
    close() {
      clearInterval(timer);
      for (const { core } of agents.values()) core.ledger.close();
      store.close();
    },
  };
}

/** Constant-time comparison of two strings of any length. @param {string} a @param {string} b */
function safeEqual(a, b) {
  const h = (/** @type {string} */ x) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(a), h(b));
}
