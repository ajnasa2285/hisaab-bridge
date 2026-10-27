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
//   /health                                         "ok"

import { openLedger } from './ledger/store.js';
import { agentCardJson, createA2AHandler } from './transport/a2a.js';
import { publicKeyText } from './protocol/keys.js';
import { createLink } from './agents/link.js';
import { createJcbAgent } from './agents/jcb.js';
import { createContractorAgent } from './agents/contractor.js';
import { createSupplierAgent } from './agents/supplier.js';
import { createConversation } from './agents/conversation.js';
import { createOffice } from './agents/office.js';
import { createDirectory } from './wa/directory.js';
import { openWaStore } from './wa/store.js';
import { createWa } from './wa/wa.js';
import { createCloudClient } from './wa/cloud.js';
import { maskPhone } from './wa/webhook.js';
import { toWav } from './wa/audio.js';
import { t } from './i18n/index.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const RETRY_MS = 60 * 1000;

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
 *   agents: AgentConfig[],
 *   lines: LineConfig[],
 *   people: Person[],
 *   waStoreFile: string,
 *   spark: import('./orchestrator/orchestrator.js').Spark,
 *   readMeter?: import('./agents/conversation.js').MeterReader,
 *   readUpi?: import('./agents/conversation.js').UpiReader,
 *   readChallan?: import('./agents/conversation.js').ChallanReader,
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
    };
    const link = createLink(core, { peerUrls: new Map(Object.entries(a.peerUrls)), transport: cfg.transport });
    /** @type {import('./agents/common.js').Tell} */
    const tell = async (role, key, params, expect) => {
      for (const p of directory.people(a.id, role)) {
        await sendTo(p, t(key, params));
        if (expect) entry.talk.expect(p, expect.tool, expect.args);
      }
    };
    const agent = a.kind === 'jcb'
      ? createJcbAgent({ agent: core, link, tell })
      : a.kind === 'supplier'
        ? createSupplierAgent({ agent: core, link, tell })
        : createContractorAgent({ agent: core, link, tell, jcbAgentId: /** @type {string} */ (a.jcbAgentId), supplierAgentId: a.supplierAgentId });
    /** @type {import('./agents/conversation.js').Reply} */
    const reply = (p, key, params) => sendTo(p, t(key, params));
    // References, exact commands, and (contractor) approvals with this agent's limits.
    const office = createOffice({ ledger: core.ledger, tools: agent.tools, kind: a.kind, limits: a.limits, tell, reply, now });
    // Each agent reads only its own kind of photo: meters (JCB), UPI screenshots (contractor), challans (supplier).
    const talk = createConversation({
      ledger: core.ledger, tools: agent.tools, spark: cfg.spark, readMeter: a.kind === 'jcb' ? cfg.readMeter : undefined,
      readUpi: a.kind === 'contractor' ? cfg.readUpi : undefined,
      readChallan: a.kind === 'supplier' ? cfg.readChallan : undefined,
      reply, now, office,
    });
    const card = agentCardJson({ id: a.id, name: a.title, description: a.title, baseUrl: `${cfg.baseUrl}/agents/${a.name}`, publicKeyText: publicKeyText(a.privateKey) });
    const a2a = createA2AHandler(core, card, {
      onApplied: (m) => {
        agent.onApplied(m).catch((e) => log(`${a.name}: notice after ${m.type} failed: ${e instanceof Error ? e.message : 'error'}`));
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
        return entry.talk.onImage(person, { mime: media.mimeType, bytes: new Uint8Array(media.bytes), takenAt: null });
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

  /** One side in the judge page's `hb-export/0.1` shape (web/README.md). @param {any} entry */
  function exportSide(entry) {
    const ledger = entry.core.ledger;
    const orders = ledger.orders();
    const events = orders.flatMap((/** @type {{order_id: string}} */ o) => ledger.events(o.order_id)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.seq - b.seq);
    return { v: 'hb-export/0.1', exportedAt: new Date(now()).toISOString(), agentId: entry.cfg.id, publicKey: publicKeyText(entry.cfg.privateKey), orders, events, chain: ledger.verifyChain() };
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
