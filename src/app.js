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
//   /agents/<name>/trace?since=<iso>&order=<ref>    inside the agent: its working trace (token only)
//   /judge/                                         the judge page (web/, an allow-list of its own files)
//   /judge/results/                                 the aggregate reader results (eval/results/*.json)
//   /health                                         "ok"

import { readdir, readFile } from 'node:fs/promises';
import { openLedger } from './ledger/store.js';
import { openRefs, spokenRefs } from './ledger/refs.js';
import { agentCardJson, createA2AHandler, sendToAgent } from './transport/a2a.js';
import { publicKeyText } from './protocol/keys.js';
import { createLink, undeliveredNotice, undeliveredNotices, unsureNotice, unsureNotices } from './agents/link.js';
import { createJcbAgent } from './agents/jcb.js';
import { createContractorAgent } from './agents/contractor.js';
import { createSupplierAgent } from './agents/supplier.js';
import { createConversation } from './agents/conversation.js';
import { readCashReceipt } from './readers/cash-receipt.js';
import { createOffice, parseCommand } from './agents/office.js';
import { openSiteNames } from './agents/site-names.js';
import { missedWaiting } from './agents/payment-view.js';
import { currentTrace, openTrace, withTrace } from './trace/trace.js';
import { traceLedger, traceLink, traceReader, traceReceived, traceSpark, traceTools, traceTranscribe, traceTransport } from './trace/hooks.js';
import { join } from 'node:path';
import { createEvidenceService, forwardEvidence } from './agents/evidence.js';
import { openMediaStore } from './media/store.js';
import { normaliseVoice, openLearn, voiceParty, voiceReplacements } from './learn/corrections.js';
import { traceCheck } from './trace/trace.js';
import { createDirectory } from './wa/directory.js';
import { openWaStore } from './wa/store.js';
import { createWa } from './wa/wa.js';
import { createCloudClient } from './wa/cloud.js';
import { maskPhone } from './wa/webhook.js';
import { toWav } from './wa/audio.js';
import { t } from './i18n/index.js';
import { createHash, timingSafeEqual } from 'node:crypto';

// The reason src/wa/wa.js gives when a person has not written in the last 24 hours.
const OUTSIDE_WINDOW = 'outside 24h window';
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
  'trace-view.js': 'text/javascript; charset=utf-8',
  'payments-view.js': 'text/javascript; charset=utf-8',
  'usual-view.js': 'text/javascript; charset=utf-8',
  'order-state.js': 'text/javascript; charset=utf-8',
  'learning-view.js': 'text/javascript; charset=utf-8',
  'sample/export.json': 'application/json; charset=utf-8',
};
const RESULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const JUDGE_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

/**
 * The people on an agent whose steps send messages to the other agent.
 * @param {AgentConfig['kind']} kind @returns {import('./wa/directory.js').Role[]}
 */
const senderRoles = (kind) => (kind === 'contractor' ? ['contractor', 'supervisor'] : kind === 'jcb' ? ['jcb_owner'] : ['supplier']);

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
 *   readCashReceipt?: import('./agents/conversation.js').CashReceiptReader,
 *   readChallan?: import('./agents/conversation.js').ChallanReader,
 *   classifyPhoto?: import('./agents/conversation.js').PhotoClassifier,
 *   transcribe?: (req: {audio: Uint8Array, mime: string, language?: 'hi'}) => Promise<{ok: true, text: string} | {ok: false, transient: boolean, reason: string}>,
 *   toWav?: typeof import('./wa/audio.js').toWav,
 *   fetch?: typeof globalThis.fetch,
 *   transport?: (baseUrl: string, m: any) => Promise<unknown>,
 *   exportToken?: string,
 *   traceText?: boolean,
 *   learn?: boolean,
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

  /**
   * Sends a text to a person on their line; outside the 24-hour window it is only logged, and a notice
   * about an order (`missed`: its reference and text key) is remembered to be told again, rebuilt from
   * the ledger, when the person next writes (tellWaiting).
   * @param {Person} p @param {string} text @param {{ref: unknown, key: string}} [missed]
   * @returns {Promise<boolean>} sent
   */
  async function sendTo(p, text, missed) {
    const r = await wa.send(p.line, p.phone, text);
    if (!r.ok) log(`notice to ${p.role} ${maskPhone(p.phone)} not sent: ${r.reason}`);
    if (!r.ok && r.reason === OUTSIDE_WINDOW && missed && typeof missed.ref === 'string' && missed.ref !== '—') store.missed(p.line, p.phone, missed.ref, missed.key, now());
    return r.ok;
  }

  /**
   * A person writes after notices to them could not be sent: first what is still waiting for them,
   * each notice once, as the agent rebuilds it from its ledger now (an order that moved on is not told
   * again; a notice that is not about an open request of theirs is dropped). Then their message is
   * handled as usual. What could not be sent is kept for the next time. On the contractor's agent such
   * a notice sets no expectation: it asks for "हाँ <ref>", and a plain "हाँ" right after it decides nothing.
   * @param {Person} person @param {{cfg: AgentConfig, core: any, talk: ReturnType<typeof createConversation>, office: ReturnType<typeof createOffice>,
   *   agent: {waiting?: (role: string) => {key: string, params: Record<string, string | number>, also?: RegExp}[]}}} entry
   */
  async function tellWaiting(person, entry) {
    const missed = store.takeMissed(person.line, person.phone);
    if (!missed.length) return;
    let unsent = missed;
    /** @type {string[]} */
    const told = [];
    try {
      const open = [...(entry.agent.waiting?.(person.role) ?? []), ...entry.office.waiting(person), ...undeliveredNotices(entry.core.ledger), ...unsureNotices(entry.core.ledger)];
      const notices = missedWaiting(missed, open);
      unsent = missed.filter((m) => missedWaiting([m], notices).length > 0);
      for (const n of notices) {
        if (!(await sendTo(person, t(n.key, n.params)))) continue;
        told.push(String(n.params.ref));
        unsent = unsent.filter((m) => missedWaiting([m], [n]).length === 0);
      }
    } catch (e) {
      log(`missed notices to ${person.role} ${maskPhone(person.phone)} not told: ${e instanceof Error ? e.message : 'error'}`);
    }
    for (const m of unsent) store.missed(person.line, person.phone, m.ref, m.key, now());
    if (entry.cfg.kind === 'contractor' && told.length) entry.talk.replayed(person, told);
  }

  /** @type {Map<string, {cfg: AgentConfig, core: any, agent: {tools: any, onApplied: (m: any) => Promise<void>, waiting?: (role: string) => {key: string, params: Record<string, string | number>, also?: RegExp}[]}, link: ReturnType<typeof createLink>, talk: ReturnType<typeof createConversation>, office: ReturnType<typeof createOffice>, a2a: ReturnType<typeof createA2AHandler>,
   *   trace: import('./trace/trace.js').Recorder, learn: import('./learn/corrections.js').Learn, siteNames: import('./agents/site-names.js').SiteNames, transcribe: ((req: {audio: Uint8Array, mime: string, language?: 'hi'}) => Promise<{ok: true, text: string} | {ok: false, transient: boolean, reason: string}>) | undefined}>} */
  const agents = new Map();
  // People's own words go into the trace only when asked for (the demo), digits masked.
  const traceText = cfg.traceText ?? process.env.HB_TRACE_TEXT === '1';
  for (const a of cfg.agents) {
    const core = {
      self: { id: a.id, privateKey: a.privateKey },
      peers: new Map(a.peers.map((p) => [p.id, p])),
      ledger: openLedger(a.ledgerFile),
      now,
      mediaStore: cfg.dataDir ? openMediaStore({ dataDir: cfg.dataDir, agentId: a.id }) : undefined,
    };
    // Inside the agent (src/trace/): a working log in its own file, apart from the ledger. The hooks
    // wrap the model calls, the tools, the ledger's append and the link; none changes what they do.
    const trace = openTrace({ file: cfg.dataDir ? join(cfg.dataDir, `${a.name}.trace.db`) : undefined, agent: a.name, text: traceText, now,
      secret: createHash('sha256').update(a.privateKey.export({ type: 'pkcs8', format: 'der' })).update('trace').digest() });
    traceLedger(core.ledger, trace);
    // Learning from corrections (src/learn/): this agent's own memory, in its own file, never sent to
    // another agent. `HB_LEARN=0` (or cfg.learn false) turns its use off; recording goes on.
    const learn = openLearn({ file: cfg.dataDir ? join(cfg.dataDir, `${a.name}.learn.db`) : undefined, now, enabled: cfg.learn });
    // The site names people told this agent (src/agents/site-names.js): its own file, apart from the ledger.
    const siteNames = openSiteNames({ file: cfg.dataDir ? join(cfg.dataDir, `${a.name}.sites.db`) : undefined, now });
    const spark = traceSpark(cfg.spark, trace);
    const readers = {
      readMeter: traceReader('meter', cfg.readMeter, trace), readUpi: traceReader('upi', cfg.readUpi, trace),
      readChallan: traceReader('challan', cfg.readChallan, trace), classifyPhoto: traceReader('photo_kind', cfg.classifyPhoto, trace),
      sameMeter: traceReader('same_meter', cfg.sameMeter, trace),
      readCashReceipt: traceReader('cash_receipt', cfg.readCashReceipt ?? readCashReceipt, trace),
    };
    const trips = new Map();
    const link = traceLink(createLink(core, { peerUrls: new Map(Object.entries(a.peerUrls)), transport: traceTransport(cfg.transport ?? sendToAgent, trips),
      onEvidence: (m) => evidence.onEvidence(m),
      onUndelivered: async (m) => {
        log(`${a.name}: ${m.type} expired undelivered`);
        const notice = undeliveredNotice(core.ledger, m.order_id);
        for (const role of senderRoles(a.kind)) await tell(role, notice.key, notice.params);
      },
      onUnsure: async (m) => {
        log(`${a.name}: ${m.type} past its expiry, no answer yet`);
        const notice = unsureNotice(core.ledger, m.order_id);
        for (const role of senderRoles(a.kind)) await tell(role, notice.key, notice.params);
      } }), trace, trips);
    /** @param {string} key @param {string} to @param {number} people */
    const traceReply = (key, to, people) => trace.add('reply', `${key} → ${to}${people === 1 ? '' : ` (${people})`}`, { key, to, people }, { ms: trace.sinceStart() });
    /** @type {import('./agents/common.js').Tell} */
    const tell = async (role, key, params, expect) => {
      const people = directory.people(a.id, role);
      traceReply(key, role, people.length);
      for (const p of people) {
        // With a question already open, this one waits (src/agents/conversation.js): the person is told
        // what a bare "हाँ" answers now. An expectation stands only on a notice that really went.
        const waits = expect && entry.talk.pending(p) !== null;
        const sent = await sendTo(p, waits ? `${t(key, params)}\n\n${t('common.question_waits')}` : t(key, params), { ref: params?.ref, key });
        if (expect && sent) entry.talk.expect(p, expect.tool, expect.args, expect.no, { key, params });
      }
    };
    const evidence = createEvidenceService({ agent: core, link, kind: a.kind, tell, spark,
      readMeter: readers.readMeter, readChallan: readers.readChallan, readUpi: readers.readUpi,
      show: async (image, caption) => {
        for (const role of senderRoles(a.kind)) for (const p of directory.people(a.id, role)) {
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
      ? createJcbAgent({ agent: core, link, tell, spark })
      : a.kind === 'supplier'
        ? createSupplierAgent({ agent: core, link, tell, spark })
        : createContractorAgent({ agent: core, link, tell, spark, jcbAgentId: /** @type {string} */ (a.jcbAgentId), supplierAgentId: a.supplierAgentId, evidence: automaticEvidence });
    /** @type {import('./agents/conversation.js').Reply} */
    const reply = async (p, key, params) => {
      traceReply(key, p.role, 1);
      await sendTo(p, t(key, params));
    };
    // The owner's yes/no to sharing a photo (evidence.tools) is a step like the agent's own.
    const tools = traceTools({ ...agent.tools, ...evidence.tools }, trace);
    // References, exact commands, and (contractor) approvals with this agent's limits.
    const office = createOffice({ ledger: core.ledger, tools, kind: a.kind, limits: a.limits, tell, reply, now, evidence });
    traceApprovals(office, agent.tools, a, trace);
    // Every agent asks Muse Spark what a photo is; each then reads only its own kinds: meters (JCB),
    // UPI screenshots and the site's copy of a challan (contractor), challans (supplier).
    const talk = createConversation({
      ledger: core.ledger, tools, spark, readMeter: a.kind === 'jcb' ? readers.readMeter : undefined,
      sameMeter: a.kind === 'jcb' ? readers.sameMeter : undefined, log,
      readUpi: a.kind === 'contractor' ? readers.readUpi : undefined,
      readCashReceipt: a.kind === 'contractor' ? readers.readCashReceipt : undefined,
      readChallan: a.kind === 'supplier' || a.kind === 'contractor' ? readers.readChallan : undefined,
      classifyPhoto: readers.classifyPhoto, reply, now, office,
      mediaStore: core.mediaStore, learn, siteNames,
      peopleSites: () => (a.kind === 'contractor' ? [...directory.people(a.id, 'contractor'), ...directory.people(a.id, 'supervisor')].flatMap((p) => (typeof p.site === 'string' ? [p.site] : [])) : []),
    });
    const card = agentCardJson({ id: a.id, name: a.title, description: a.title, baseUrl: `${cfg.baseUrl}/agents/${a.name}`, publicKeyText: publicKeyText(a.privateKey) });
    const a2a = createA2AHandler(core, card, {
      onApplied: (m) => {
        agent.onApplied(m).then(() => evidence.onApplied(m)).catch((e) => log(`${a.name}: notice after ${m.type} failed: ${e instanceof Error ? e.message : 'error'}`));
      },
      onReceived: traceReceived(trace),
    });
    const entry = { cfg: a, core, agent, link, talk, office, a2a, trace, learn, siteNames, transcribe: traceTranscribe(cfg.transcribe, trace) };
    agents.set(a.id, entry);
  }

  const wa = createWa({
    lines: cfg.lines.map((l) => ({ name: l.name, phoneNumberId: l.phoneNumberId, appSecret: l.appSecret, verifyToken: l.verifyToken, client: /** @type {any} */ (clients.get(l.phoneNumberId)) })),
    directory,
    store,
    unknownReply: () => t('wa.unknown_sender'),
    failureReply: (e) => t(e instanceof Error && /too large/.test(e.message) ? 'common.media_too_large' : 'common.try_again'),
    now,
    log,
    onMessage: async (msg, person) => {
      const entry = agents.get(person.agent);
      if (!entry) return;
      await tellWaiting(person, entry);
      const text = msg.kind === 'text' || msg.kind === 'button' ? msg.text ?? '' : null;
      // One handling per message: everything recorded while it runs carries this person's conversation.
      return withTrace(entry.trace, { convo: entry.trace.convoOf(person), role: person.role, text }, async () => {
        const channel = text !== null ? (parseCommand(text) ? 'command' : 'text') : msg.kind === 'image' ? 'photo' : msg.kind === 'audio' ? 'voice' : msg.kind;
        entry.trace.add('received', `${channel} from ${person.role}`, { channel, role: person.role, text: entry.trace.words(text) });
        if (text !== null) return entry.talk.onText(person, text, { atMs: msg.atMs });
        if (msg.kind === 'image' && msg.mediaId) {
          const media = await /** @type {any} */ (clients.get(person.line)).fetchMedia(msg.mediaId, { expectedSha256: undefined });
          return entry.talk.onImage(person, { mime: media.mimeType, bytes: new Uint8Array(media.bytes), takenAt: null, forwarded: msg.forwarded === true, ...(msg.caption ? { caption: msg.caption } : {}) });
        }
        if (msg.kind === 'audio' && msg.mediaId && entry.transcribe) {
          // A voice note is read as the text it says; the same read-back follows before anything commits.
          const media = await /** @type {any} */ (clients.get(person.line)).fetchMedia(msg.mediaId);
          const wav = await (cfg.toWav ?? toWav)(new Uint8Array(media.bytes));
          if (!wav.ok) {
            log(`voice from ${person.role} ${maskPhone(person.phone)} not converted: ${wav.reason}`);
            { await sendTo(person, t('voice.not_understood')); return; }
          }
          const said = await entry.transcribe({ audio: wav.wav, mime: 'audio/wav', language: 'hi' });
          if (!said.ok || !said.text.trim()) { await sendTo(person, t('voice.not_understood')); return; }
          const c = currentTrace();
          if (c) c.text = said.text;
          // Words this person corrected at least twice are replaced first and shown to them
          // (src/learn/corrections.js), then "पीवन" → "P-1" before anything reads it (live, 30 Oct).
          const glossary = entry.learn.glossary(voiceParty(person));
          const heard = normaliseVoice(said.text, glossary);
          if (heard !== said.text.normalize('NFC')) traceCheck('voice: words replaced from corrections people confirmed twice', true, { name: 'learn_glossary', words: glossary.size });
          return entry.talk.onText(person, spokenRefs(heard), { voice: said.text, atMs: msg.atMs, replaced: voiceReplacements(said.text, glossary) });
        }
        // Documents are not handled yet.
        { await sendTo(person, t('common.unknown_step')); return; }
      });
    },
  });

  // Messages that could not reach the other agent are delivered again, unchanged. A pass over many
  // unreachable messages can outlast the interval; the next one for that agent then waits its turn.
  /** @type {Set<string>} */
  const retrying = new Set();
  const timer = setInterval(() => {
    for (const { link, cfg: a } of agents.values()) {
      if (retrying.has(a.name)) continue;
      retrying.add(a.name);
      link.retryPending().then((rs) => {
        for (const r of rs) if (!r.ok && r.reason !== 'unreachable') log(`${a.name}: re-delivery ${r.reason}`);
      }).catch(() => {}).finally(() => { retrying.delete(a.name); });
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
    if (path === '/judge' || path.startsWith('/judge/') || path === '/src/ledger/payments.js' || path === '/src/ledger/usual.js') {
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
    if (entry && req.method === 'GET' && path === `/agents/${entry.cfg.name}/trace`) {
      // The same rule as the export: only with the token, never at all when none is configured.
      const auth = req.headers.authorization ?? '';
      if (!cfg.exportToken || !safeEqual(auth, `Bearer ${cfg.exportToken}`)) {
        res.writeHead(404).end();
        return;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(traceSide(entry, query.get('since'), query.get('order'))));
      return;
    }
    // A message from the other agent is one handling of this agent's trace (no person, no conversation).
    if (entry && (await withTrace(entry.trace, {}, () => entry.a2a(req, res)))) return;
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
    // Only the two pure ledger modules used by the browser, no general source-directory serving.
    if (path === '/src/ledger/payments.js' || path === '/src/ledger/usual.js') {
      const module = path === '/src/ledger/payments.js' ? './ledger/payments.js' : './ledger/usual.js';
      try { send(200, 'text/javascript; charset=utf-8', await readFile(new URL(module, import.meta.url))); }
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
    return { v: 'hb-export/0.1', exportedAt: new Date(now()).toISOString(), agentId: entry.cfg.id, publicKey: publicKeyText(entry.cfg.privateKey), orders, events, chain: ledger.verifyChain(), refs: refByOrder,
      // Counts only, from this agent's correction memory (optional in the shape; the judge page's learning card).
      learning: entry.learn.stats() };
  }

  /**
   * One agent's trace for the judge page (`hb-trace/0.1`, web/README.md): entries in order, each with
   * this side's reference for its order; only those since an instant and for one reference when asked.
   * @param {any} entry @param {string | null} since @param {string | null} ref
   */
  function traceSide(entry, since, ref) {
    const refs = openRefs(entry.core.ledger);
    const sinceIso = since && !Number.isNaN(Date.parse(since)) ? new Date(Date.parse(since)).toISOString() : undefined;
    const want = ref ? ref.trim().toUpperCase() : null;
    const orderId = want ? refs.orderOfRef(want) : undefined;
    const entries = want && !orderId ? [] : entry.trace.list({ since: sinceIso, orderId: orderId ?? undefined, ref: want ?? undefined })
      .map((/** @type {import('./trace/trace.js').TraceEntry} */ e) => ({ ...e, orderId: e.orderId ?? (e.ref ? refs.orderOfRef(e.ref) ?? null : null), ref: e.ref ?? (e.orderId ? refs.refOf(e.orderId) : null) }));
    return { v: 'hb-trace/0.1', exportedAt: new Date(now()).toISOString(), agentId: entry.cfg.id, name: entry.cfg.name, entries };
  }

  return {
    handle,
    /** For tests and the judge export. @param {string} id */
    agent: (id) => agents.get(id),
    close() {
      clearInterval(timer);
      for (const { core, trace, learn, siteNames } of agents.values()) {
        core.ledger.close();
        trace.close();
        learn.close();
        siteNames.close();
      }
      store.close();
    },
  };
}

/**
 * The approval gate's check, on the trace: for a supervisor's step that may be held, the limit, the
 * estimate and the outcome, exactly as the office decides it (its own `holds`, called again; it
 * reads and never writes).
 * @param {ReturnType<typeof createOffice>} office
 * @param {Record<string, import('./agents/common.js').Tool>} tools the agent's own tools
 * @param {AgentConfig} a @param {import('./trace/trace.js').Recorder} trace
 */
function traceApprovals(office, tools, a, trace) {
  const commit = office.commit;
  office.commit = async (person, tool, args) => {
    let held = false;
    try {
      const step = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
      if (step?.hold && a.kind === 'contractor' && person.role === 'supervisor') {
        const limit = a.limits?.procurementPaise;
        const estimate = step.hold.estimatePaise(args);
        held = office.holds(person, tool, args);
        const why = limit === undefined ? 'no limit set' : estimate === null ? 'value cannot be estimated' : estimate > limit ? `estimate ₹${estimate / 100} above limit ₹${limit / 100}` : `estimate ₹${estimate / 100} within limit ₹${limit / 100}`;
        trace.add('check', `approval ${held ? 'needed' : 'not needed'}: ${why} → ${held ? 'held for the contractor' : 'runs'}`,
          { pass: !held, name: 'approval', limit: step.hold.limit, limitPaise: limit ?? null, estimatePaise: estimate, held },
          { orderId: typeof args?.orderId === 'string' ? args.orderId : null });
      }
    } catch { /* dropped */ }
    const r = await commit(person, tool, args);
    // A held step has its reference before its order exists: the request joins the order through it.
    if (held && typeof r.params?.ref === 'string') trace.tagRef(r.params.ref);
    return r;
  };
}

/** Constant-time comparison of two strings of any length. @param {string} a @param {string} b */
function safeEqual(a, b) {
  const h = (/** @type {string} */ x) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(a), h(b));
}
