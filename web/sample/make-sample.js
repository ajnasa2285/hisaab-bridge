// Makes web/sample/export.json: one whole JCB job and one whole material job run by the real
// agents (src/agents) over real A2A HTTP between three in-memory ledgers (JCB, contractor,
// supplier), with invented names and numbers only. The shape of the export is documented in
// web/README.md. Run: node web/sample/make-sample.js
//
// Each run makes fresh keys, so the file changes every time; the signatures inside it verify with
// the public keys it carries (test/web/sample.test.js checks that).
//
// Each side also carries its trace ("inside the agent", src/trace/), recorded by the same hooks the
// service uses: the code checks, decisions, signed messages and ledger rows are the real agents'
// own. The sample has no Meta model, so the Muse steps (understanding a message, reading a photo)
// are invented entries in the trace, with invented latencies, where the service would call Muse;
// the explanations go through the real explanation code with a stand-in that returns fixed words.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../../src/protocol/canonical.js';
import { generateKeys, publicKeyFromText, publicKeyText, signMessage } from '../../src/protocol/keys.js';
import { allocate, paymentSummary } from '../../src/ledger/payments.js';
import { paymentChecks } from '../../src/trace/payments.js';
import { usualChecks } from '../../src/trace/usual.js';
import { openLedger } from '../../src/ledger/store.js';
import { openRefs } from '../../src/ledger/refs.js';
import { agentCardJson, createA2AHandler, sendToAgent } from '../../src/transport/a2a.js';
import { createLink } from '../../src/agents/link.js';
import { runTool } from '../../src/agents/common.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createContractorAgent } from '../../src/agents/contractor.js';
import { createSupplierAgent } from '../../src/agents/supplier.js';
import { openTrace, withTrace } from '../../src/trace/trace.js';
import { traceLedger, traceLink, traceReceived, traceSpark, traceTools, traceTransport } from '../../src/trace/hooks.js';

/** @typedef {import('../../src/protocol/messages.js').MessageType} MessageType */
/** @typedef {import('../../src/wa/directory.js').Person} Person */
/** @typedef {import('../../src/ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {import('../../src/trace/trace.js').TraceEntry} TraceEntry */
/** @typedef {import('../../src/trace/trace.js').Recorder} Recorder */

/**
 * @typedef {object} LedgerExport
 * @property {string} agentId
 * @property {string} publicKey                 "ed25519:<base64>"
 * @property {{order_id: string, kind: string, counterparty: string, site: string, created_at: string}[]} orders
 * @property {LedgerEvent[]} events             every event of every order, in seq order
 * @property {{ok: true, events: number} | {ok: false, brokenAt: number}} chain  verifyChain() at export time
 * @property {Record<string, string>} [refs]    this side's reference (J-n / P-n) per order_id
 * @property {TraceEntry[]} [trace]             this agent's trace (inside the agent), oldest first
 * @property {LearningStats} [learning]         this agent's learning-from-corrections counts (invented in the sample)
 */
/** @typedef {{v: 'hb-export/0.1', exportedAt: string, jcb: LedgerExport, contractor: LedgerExport, supplier: LedgerExport}} Export */

// Invented photo fingerprints: the sample has no real images.
const SHA_START = '1a'.repeat(32);
const SHA_END = '2b'.repeat(32);
const SHA_UPI = '3c'.repeat(32);
const SHA_CHALLAN = '4d'.repeat(32);
const SHA_UPI_2 = '5e'.repeat(32);
const MODEL = 'muse-spark-1.2';

/** @param {string} role @param {string} agent @param {string} phone @returns {Person} */
const person = (role, agent, phone) => ({ line: 'line', phone, agent, role: /** @type {any} */ (role), name: role });

const owner = person('jcb_owner', 'agent:jcb-1', '919000000001');
const operator = person('operator', 'agent:jcb-1', '919000000002');
const contractor = person('contractor', 'agent:contractor-1', '919000000003');
const supervisor = person('supervisor', 'agent:contractor-1', '919000000004');
const supplier = person('supplier', 'agent:supplier-1', '919000000005');

const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/**
 * A stand-in for Muse Spark's explanation of a difference: fixed, neutral words citing only figures
 * in the ledger. It runs through the real explanation code and its checks.
 * @param {any} req
 */
async function explainStandIn(req) {
  const material = typeof req.text === 'string' && req.text.includes('बोरी');
  const explanation = material
    ? 'चालान और बिल में सीमेंट 50 बोरी लिखा है; साइट की गिनती में 48 बोरी दर्ज है।'
    : 'बिल के 6.1 घंटे मीटर की फ़ोटो से निकले हैं; ठेकेदार का आँकड़ा 5.5 घंटे है।';
  return { ok: /** @type {const} */ (true), json: { explanation }, text: '', toolCalls: [], model: MODEL, latencyMs: material ? 3410 : 3780, usage: { input_tokens: 900, output_tokens: 60 } };
}

/**
 * Three agents on local HTTP, each with its own keys, ledger and trace, a clock the flow can move
 * forward. The contractor's agent has two peers; the sellers never talk to each other.
 */
async function setup() {
  const jk = generateKeys();
  const ck = generateKeys();
  const sk = generateKeys();
  let nowMs = Date.parse('2026-10-28T03:30:00Z'); // 09:00 IST
  const now = () => nowMs;
  /** @type {MessageType[]} */
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  /** @type {MessageType[]} */
  const toContractor = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'RECEIPT', 'REFUSE'];
  const pub = (/** @type {import('node:crypto').KeyObject} */ k) => publicKeyFromText(publicKeyText(k));
  const jcbCore = {
    self: { id: 'agent:jcb-1', privateKey: jk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: pub(ck.publicKey), mayReceiveFrom: new Set(toSeller) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const supCore = {
    self: { id: 'agent:supplier-1', privateKey: sk.privateKey },
    peers: new Map([['agent:contractor-1', { id: 'agent:contractor-1', publicKey: pub(ck.publicKey), mayReceiveFrom: new Set(toSeller) }]]),
    ledger: openLedger(':memory:'),
    now,
  };
  const siteCore = {
    self: { id: 'agent:contractor-1', privateKey: ck.privateKey },
    peers: new Map([
      ['agent:jcb-1', { id: 'agent:jcb-1', publicKey: pub(jk.publicKey), mayReceiveFrom: new Set(toContractor) }],
      ['agent:supplier-1', { id: 'agent:supplier-1', publicKey: pub(sk.publicKey), mayReceiveFrom: new Set([...toContractor, /** @type {MessageType} */ ('DELIVERY')]) }],
    ]),
    ledger: openLedger(':memory:'),
    now,
  };
  const traces = {
    jcb: openTrace({ agent: 'jcb', now, text: true, secret: 'sample' }),
    site: openTrace({ agent: 'site', now, text: true, secret: 'sample' }),
    sup: openTrace({ agent: 'supplier', now, text: true, secret: 'sample' }),
  };
  traceLedger(jcbCore.ledger, traces.jcb);
  traceLedger(siteCore.ledger, traces.site);
  traceLedger(supCore.ledger, traces.sup);
  const peerUrls = new Map();
  /** @param {any} core @param {Recorder} rec */
  const link = (core, rec) => {
    const trips = new Map();
    return traceLink(createLink(core, { peerUrls, transport: traceTransport(sendToAgent, trips) }), rec, trips);
  };
  const jcbLink = link(jcbCore, traces.jcb);
  const siteLink = link(siteCore, traces.site);
  const supLink = link(supCore, traces.sup);
  const silent = () => {};
  const jcb = createJcbAgent({ agent: jcbCore, link: jcbLink, tell: silent, spark: traceSpark(explainStandIn, traces.jcb) });
  const site = createContractorAgent({ agent: siteCore, link: siteLink, tell: silent, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1', spark: traceSpark(explainStandIn, traces.site) });
  const sup = createSupplierAgent({ agent: supCore, link: supLink, tell: silent, spark: traceSpark(explainStandIn, traces.sup) });

  /** @type {import('node:http').Server[]} */
  const servers = [];
  for (const [core, a, name, rec] of /** @type {const} */ ([[jcbCore, jcb, 'jcb', traces.jcb], [siteCore, site, 'site', traces.site], [supCore, sup, 'supplier', traces.sup]])) {
    /** @type {any} */
    let handle = null;
    const server = createServer(async (req, res) => {
      if (!(await withTrace(rec, {}, () => handle(req, res)))) res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    const baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    handle = createA2AHandler(core, agentCardJson({ id: core.self.id, name, description: name, baseUrl, publicKeyText: publicKeyText(core.self.privateKey) }),
      { onApplied: (m) => { void a.onApplied(m); }, onReceived: traceReceived(rec) });
    peerUrls.set(core.self.id, baseUrl);
    servers.push(server);
  }
  return {
    jcb: { ...jcb, tools: traceTools(jcb.tools, traces.jcb) },
    site: { ...site, tools: traceTools(site.tools, traces.site) },
    sup: { ...sup, tools: traceTools(sup.tools, traces.sup) },
    jcbCore, siteCore, supCore, traces,
    advance: (/** @type {number} */ minutes) => { nowMs += minutes * 60_000; },
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined))))),
  };
}

/** @param {import('../../src/agents/common.js').Said} r @param {string} step */
function must(r, step) {
  if (!r.ok) throw new Error(`sample: ${step} failed with ${r.key}`);
  return r;
}

const settle = () => new Promise((res) => setImmediate(res));

/**
 * One message from a person, handled as the service handles it: received, the (invented) Muse
 * steps the service would take, then the real step, then the reply's key.
 * @param {Recorder} rec @param {Person} who @param {string | null} text null: a photo
 * @param {(rec: Recorder) => void} muse the invented model steps (and their checks) before the step
 * @param {() => Promise<import('../../src/agents/common.js').Said>} step
 * @param {string} name
 */
async function said(rec, who, text, muse, step, name) {
  return withTrace(rec, { convo: rec.convoOf(who), role: who.role, text }, async () => {
    const channel = text === null ? 'photo' : /^(ok|no|नहीं) [JP]-\d+/i.test(text) ? 'command' : 'text';
    rec.add('received', `${channel} from ${who.role}`, { channel, role: who.role, text: rec.words(text) });
    muse(rec);
    const r = must(await step(), name);
    rec.add('reply', `${r.key} → ${who.role}`, { key: r.key, to: who.role, people: 1 }, { ms: 40 });
    return r;
  });
}

/** An invented Muse Spark step, as the service's wrapper records it. @param {Recorder} rec @param {string} title @param {Record<string, any>} detail @param {number} ms */
const muse = (rec, title, detail, ms) => rec.add('model', title, { model: MODEL, reasoningEffort: 'default', ok: true, ...detail }, { ms });
const none = () => {};

/** @typedef {{recorded: number, readsWithMemory: number, correctedAfterMemory: number, readBackByMemory: number}} LearnCounts */
/** @typedef {{v: 'hb-learn/0.1', on: boolean, kinds: Record<string, LearnCounts>} & LearnCounts} LearningStats */

/** Invented counts per agent and kind: [recorded, readsWithMemory, correctedAfterMemory, readBackByMemory]. */
const LEARNING = /** @type {const} */ ({
  jcb: { meter: [5, 8, 1, 2], voice: [3, 4, 0, 1] },
  contractor: { challan: [4, 6, 1, 1], site_challan: [2, 3, 0, 1], upi: [1, 0, 0, 0], voice: [2, 2, 0, 0] },
  supplier: { invoice: [3, 5, 1, 1], challan: [2, 2, 0, 0], upi: [1, 1, 0, 0] },
});

/**
 * Each side's `learning` field in the shape of src/learn/corrections.js `stats()`, with invented
 * numbers: the sample runs no corrections, so these only show how the judge page's card reads.
 * @param {Export} x
 */
export function learningExample(x) {
  for (const name of /** @type {const} */ (['jcb', 'contractor', 'supplier'])) {
    /** @type {Record<string, LearnCounts>} */
    const kinds = {};
    for (const [kind, [recorded, readsWithMemory, correctedAfterMemory, readBackByMemory]] of Object.entries(LEARNING[name])) {
      kinds[kind] = { recorded, readsWithMemory, correctedAfterMemory, readBackByMemory };
    }
    const sum = (/** @type {keyof LearnCounts} */ f) => Object.values(kinds).reduce((n, k) => n + k[f], 0);
    x[name].learning = { v: 'hb-learn/0.1', on: true, kinds, recorded: sum('recorded'), readsWithMemory: sum('readsWithMemory'),
      correctedAfterMemory: sum('correctedAfterMemory'), readBackByMemory: sum('readBackByMemory') };
  }
}

/**
 * Build 5's contract-only example, independent of the parallel recording-tools branch. These
 * signed invented events extend the exported chains; no runtime ledger validation is bypassed.
 * @param {Export} x @param {Awaited<ReturnType<typeof setup>>} s
 */
function paymentExample(x, s) {
  const ids = [randomUUID(), randomUUID()];
  let tick = Date.parse(x.exportedAt);
  const now = () => new Date(tick += 60_000).toISOString();
  for (let i = 0; i < ids.length; i += 1) {
    const at = now();
    for (const side of [x.contractor, x.supplier]) {
      side.orders.push({ order_id: ids[i], kind: 'material', counterparty: side === x.contractor ? x.supplier.agentId : x.contractor.agentId, site: 'नमूना साइट', created_at: at });
      (side.refs ??= {})[ids[i]] = `P-${i + 2}`;
    }
  }
  /** @param {any} orderId @param {string} type @param {Record<string, any>} body @param {boolean} seller */
  const send = (orderId, type, body, seller) => {
    const at = now();
    const core = seller ? s.supCore : s.siteCore;
    const message = signMessage({ v: 'hb/0.1', msg_id: randomUUID(), type, from: core.self.id,
      to: seller ? x.contractor.agentId : x.supplier.agentId, order_id: orderId, rev: 1,
      created_at: at, expires_at: new Date(Date.parse(at) + 86400000).toISOString(), body }, core.self.privateKey);
    for (const side of [x.contractor, x.supplier]) {
      const seq = (side.events.at(-1)?.seq ?? 0) + 1;
      const direction = side.agentId === core.self.id ? 'out' : 'in';
      const prevHash = side.events.at(-1)?.hash ?? '0'.repeat(64);
      const content = canonicalize({ seq, order_id: orderId, direction, type, msg_id: message.msg_id, body: message, at });
      const hash = createHash('sha256').update(prevHash).update(content).digest('hex');
      /** @type {LedgerEvent} */
      const event = { seq, orderId, direction, type, msgId: message.msg_id, body: message, at, prevHash, hash };
      side.events.push(event);
      const trace = side.trace ??= [];
      const traceBase = { at, agent: side === x.contractor ? 'site' : 'supplier', orderId, ref: side.refs?.[orderId] ?? null, convo: null, ms: null };
      trace.push({ ...traceBase, id: (trace.at(-1)?.id ?? 0) + 1, kind: 'ledger', title: `#${seq} ${type}`, detail: { seq, type, direction, msg: message.msg_id, hash, prev: prevHash } });
      const sameParty = side.orders.filter((o) => o.counterparty === (side === x.contractor ? x.supplier.agentId : x.contractor.agentId))
        .map((o) => ({ orderId: o.order_id, events: side.events.filter((e) => e.orderId === o.order_id) }));
      for (const check of paymentChecks(event, sameParty)) trace.push({ ...traceBase, id: (trace.at(-1)?.id ?? 0) + 1, kind: 'check', title: check.title, detail: check.detail });
      for (const check of usualChecks(event, side.events)) trace.push({ ...traceBase, id: (trace.at(-1)?.id ?? 0) + 1, kind: 'check', title: check.title, detail: check.detail });
      side.chain = { ok: true, events: side.events.length };
    }
    return message.msg_id;
  };
  const bills = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i], total = i === 0 ? 100000 : 80000;
    send(id, 'BOOKING_REQUEST', { kind: 'material', site: 'नमूना साइट', day: '2026-11-02', items: [{ name: 'ईंट', qtyHundredths: 10000, unit: 'नग' }] }, false);
    send(id, 'BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'ईंट', unit: 'नग', ratePaise: total / 100 }] }, true);
    if (i === 0) send(id, 'PAYMENT_RECEIVED', { bill: null, method: 'cash', amountPaise: 20000, receivedOn: '2026-11-02' }, true);
    send(id, 'DELIVERY', { items: [{ name: 'ईंट', qtyHundredths: 10000, unit: 'नग', ratePaise: total / 100 }], challan: { sha256: 'd'.repeat(64), number: `N-${i + 1}` }, deliveredAt: now() }, true);
    bills.push(send(id, 'BILL', { lines: [{ what: 'ईंट', qtyHundredths: 10000, ratePaise: total / 100, amountPaise: total }], totalPaise: total,
      evidence: [{ kind: 'challan', sha256: 'd'.repeat(64), readValue: `N-${i + 1}`, takenAt: null, sentAt: now() }] }, true));
    send(id, 'ACCEPT', { bill: bills[i] }, false);
  }
  const cash = send(ids[0], 'PAYMENT_CLAIM', { bill: bills[0], method: 'cash', amountPaise: 10000, paidOn: '2026-11-02' }, false);
  send(ids[0], 'PAYMENT_ACK', { payment: cash, amountPaise: 10000, received: true }, true);
  const group = { id: randomUUID(), totalPaise: 130000, orders: ids };
  const shares = allocate(group.totalPaise, ids.map((id) => ({ orderId: id, duePaise: paymentSummary(x.contractor.events.filter((e) => e.orderId === id)).duePaise })));
  for (const share of shares ?? []) {
    const i = ids.indexOf(/** @type {any} */ (share.orderId));
    const claim = send(share.orderId, 'PAYMENT_CLAIM', { bill: bills[i], method: 'upi', amountPaise: share.amountPaise, paidOn: '2026-11-02', utr: '000000000003', screenshot: { sha256: 'e'.repeat(64) }, group }, false);
    send(share.orderId, 'PAYMENT_ACK', { payment: claim, amountPaise: share.amountPaise, received: true }, true);
  }
  const paid = paymentSummary(x.contractor.events.filter((e) => e.orderId === ids[0]));
  send(ids[0], 'SETTLED', { bill: bills[0], amountPaise: paid.confirmedPaise, payments: paid.payments.filter((p) => p.status === 'confirmed').map((p) => p.msgId) }, true);
  send(ids[1], 'PAYMENT_CLAIM', { bill: bills[1], method: 'cash', amountPaise: 5000, paidOn: '2026-11-02' }, false);
  const denied = send(ids[1], 'PAYMENT_CLAIM', { bill: bills[1], method: 'cash', amountPaise: 1000, paidOn: '2026-11-02' }, false);
  send(ids[1], 'PAYMENT_ACK', { payment: denied, amountPaise: 1000, received: false }, true);
  send(ids[1], 'PAYMENT_RECEIVED', { bill: bills[1], method: 'cash', amountPaise: 25000, receivedOn: '2026-11-02' }, true);
  // Three invented accepted cement orders establish the usual rate. The fourth bill stays for a
  // person's decision at ₹500 instead of ₹380: code flags it but leaves the order billed.
  for (let i = 0; i < 4; i += 1) {
    const id = randomUUID(), at = now(), ratePaise = i === 3 ? 50000 : 38000;
    for (const side of [x.contractor, x.supplier]) {
      side.orders.push({ order_id: id, kind: 'material', counterparty: side === x.contractor ? x.supplier.agentId : x.contractor.agentId, site: 'नमूना साइट', created_at: at });
      (side.refs ??= {})[id] = `P-${i + 4}`;
    }
    send(id, 'BOOKING_REQUEST', { kind: 'material', site: 'नमूना साइट', day: '2026-11-02', items: [CEMENT] }, false);
    send(id, 'BOOKING_REPLY', { answer: 'yes', rates: [{ name: CEMENT.name, unit: CEMENT.unit, ratePaise }] }, true);
    send(id, 'DELIVERY', { items: [CEMENT], challan: { sha256: 'f'.repeat(64), number: `U-${i + 1}` }, deliveredAt: now() }, true);
    const bill = send(id, 'BILL', { lines: [{ what: CEMENT.name, qtyHundredths: CEMENT.qtyHundredths, ratePaise, amountPaise: ratePaise * 50 }], totalPaise: ratePaise * 50,
      evidence: [{ kind: 'challan', sha256: 'f'.repeat(64), readValue: `U-${i + 1}`, takenAt: null, sentAt: now() }] }, true);
    if (i < 3) send(id, 'ACCEPT', { bill }, false);
  }
  x.exportedAt = now();
}

/**
 * The JCB job: request (held for the contractor's OK) → yes (₹1,200/h) → start and end meter →
 * bill 6.1 h → dispute 5.5 h → correction → accept → payment claim → settled.
 * @param {Awaited<ReturnType<typeof setup>>} s
 */
async function jcbJob(s) {
  const { site: rs, jcb: rj } = s.traces;
  await withTrace(rs, { convo: rs.convoOf(supervisor), role: 'supervisor', text: 'कल सुबह 8 बजे शिवपुरी साइट पर JCB चाहिए, 6 घंटे' }, async () => {
    rs.add('received', 'text from supervisor', { channel: 'text', role: 'supervisor', text: rs.words('कल सुबह 8 बजे शिवपुरी साइट पर JCB चाहिए, 6 घंटे') });
    muse(rs, 'understand → request_jcb', { job: 'understand', tools: 9, calls: [{ tool: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }] }, 1840);
    rs.add('check', 'approval needed: value cannot be estimated → held for the contractor', { pass: false, name: 'approval', limit: 'procurement', limitPaise: 1000000, estimatePaise: null, held: true });
    rs.tagRef('J-1');
    rs.add('reply', 'office.approval_needed → contractor', { key: 'office.approval_needed', to: 'contractor', people: 1 }, { ms: 1890 });
    rs.add('reply', 'office.held_step → supervisor', { key: 'office.held_step', to: 'supervisor', people: 1 }, { ms: 1910 });
  });
  s.advance(6);
  await said(rs, contractor, 'OK J-1', none, () => runTool(s.site.tools, supervisor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 } }), 'request_jcb');
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  s.advance(25);
  await settle();
  await said(rj, owner, 'हाँ 1200', none, () => runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } }), 'reply_booking');
  s.advance(23 * 60 + 10); // next morning, 08:05 IST
  const meterPhoto = (/** @type {string} */ raw, /** @type {number} */ v, /** @type {number | null} */ start) => (/** @type {Recorder} */ rec) => {
    muse(rec, 'photo kind: meter', { job: 'photo_kind', vision: true, kind: 'meter', clear: true }, 1380);
    muse(rec, `meter reads ${raw}`, { job: 'meter', vision: true, kind: 'hour_meter', raw, valueTenths: v, clear: true, dashClock: null }, 2620);
    rec.add('check', 'meter reading clear and consistent ✓ → recorded at once', { pass: true, name: 'meter_photo', which: start === null ? 'start' : 'end', valueTenths: v, startTenths: start, endTenths: null });
  };
  await said(rj, operator, null, meterPhoto('1234.5', 12345, null), () => runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_START, takenAt: '2026-10-29T02:33:00Z' } }), 'meter start');
  s.advance(6 * 60 + 20);
  await said(rj, operator, null, meterPhoto('1240.6', 12406, 12345), () => runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_END, takenAt: '2026-10-29T08:52:00Z' } }), 'meter end');
  s.advance(40);
  await said(rj, owner, 'बिल', none, () => runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } }), 'send_bill');
  await settle();
  s.advance(95);
  await said(rs, contractor, 'नहीं 5.5 लंच में 36 मिनट मशीन खड़ी रही', none, () => runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 55, reason: 'machine stood 36 minutes for the lunch break' } }), 'dispute_bill');
  await settle();
  s.advance(30);
  await said(rj, owner, 'सुधार 5.5 घंटे', (rec) => muse(rec, 'understand → send_correction', { job: 'understand', tools: 7, calls: [{ tool: 'send_correction', args: { ref: 'J-1', hours: '5.5' } }] }, 1520),
    () => runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 55 } }), 'send_correction');
  s.advance(12);
  await said(rs, contractor, 'हाँ', none, () => runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } }), 'accept_bill');
  s.advance(20 * 60);
  await said(rs, contractor, null, (rec) => {
    muse(rec, 'photo kind: upi', { job: 'photo_kind', vision: true, kind: 'upi', clear: true }, 1290);
    muse(rec, 'UPI receipt: ₹6600 success', { job: 'upi', vision: true, kind: 'upi_payment', amountPaise: 660000, utr: '000000000001', status: 'success', date: '2026-10-30', clock: null, clear: true }, 2950);
    rec.add('check', 'UPI amount ✓ = bill: ₹6,600 / ₹6,600', { pass: true, name: 'upi_amount', paidPaise: 660000, billPaise: 660000, utr: '000000000001' });
  }, () => runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 660000, utr: '000000000001', paidOn: '2026-10-30', screenshotSha256: SHA_UPI } }), 'claim_payment');
  s.advance(50);
  await said(rj, owner, 'हाँ', none, () => runTool(s.jcb.tools, owner, { tool: 'confirm_payment', args: { orderId } }), 'confirm_payment');
  await settle();
}

/**
 * The material job with the supplier: 50 bags of cement (held for the contractor's OK) → yes at
 * ₹350/बोरी → delivery with challan 412 → the site counts 48 → bill 50 × ₹350 → dispute 48 →
 * correction → accept → payment claim → settled. The site's count is a local NOTE on the
 * contractor's ledger only.
 * @param {Awaited<ReturnType<typeof setup>>} s
 */
async function materialJob(s) {
  const { site: rs, sup: rp } = s.traces;
  s.advance(30);
  await withTrace(rs, { convo: rs.convoOf(supervisor), role: 'supervisor', text: 'परसों शिवपुरी में सीमेंट 50 बोरी सुबह 9 बजे' }, async () => {
    rs.add('received', 'text from supervisor', { channel: 'text', role: 'supervisor', text: rs.words('परसों शिवपुरी में सीमेंट 50 बोरी सुबह 9 बजे') });
    muse(rs, 'understand → request_material', { job: 'understand', tools: 9, calls: [{ tool: 'request_material', args: { site: 'Shivpuri', day: 'day_after', time: '9', items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } }] }, 2110);
    rs.add('check', 'approval needed: value cannot be estimated → held for the contractor', { pass: false, name: 'approval', limit: 'procurement', limitPaise: 1000000, estimatePaise: null, held: true });
    rs.tagRef('P-1');
    rs.add('reply', 'office.approval_needed → contractor', { key: 'office.approval_needed', to: 'contractor', people: 1 }, { ms: 2160 });
    rs.add('reply', 'office.held_step → supervisor', { key: 'office.held_step', to: 'supervisor', people: 1 }, { ms: 2180 });
  });
  s.advance(4);
  await said(rs, contractor, 'OK P-1', none, () => runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-31', time: '09:00', items: [CEMENT] } }), 'request_material');
  const order = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders().find((/** @type {any} */ o) => o.kind === 'material'));
  const orderId = order.order_id;
  await settle();
  s.advance(40);
  await said(rp, supplier, 'हाँ 350', none, () => runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } }), 'reply_order');
  s.advance(22 * 60 + 15); // 31 Oct, 09:10 IST
  await said(rp, supplier, null, (rec) => {
    muse(rec, 'photo kind: challan', { job: 'photo_kind', vision: true, kind: 'challan', clear: true }, 1410);
    muse(rec, 'challan 412: 1 item(s)', { job: 'challan', vision: true, kind: 'challan', challanNo: '412', items: [CEMENT], clear: true, signed: null }, 3240);
  }, () => runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_CHALLAN, challanNo: '412' } }), 'record_delivery');
  await settle();
  s.advance(35);
  await said(rs, supervisor, '48', none, () => runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [4800] } }), 'confirm_count');
  s.advance(50);
  await said(rp, supplier, 'बिल', none, () => runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } }), 'send_bill (material)');
  await settle();
  s.advance(70);
  await said(rs, contractor, 'नहीं 48 साइट पर 48 बोरी गिनी', none, () => runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, reason: 'साइट पर 48 बोरी गिनी' } }), 'dispute_bill (material)');
  await settle();
  s.advance(45);
  await said(rp, supplier, 'सुधार 48', (rec) => muse(rec, 'understand → send_correction', { job: 'understand', tools: 7, calls: [{ tool: 'send_correction', args: { ref: 'P-1', quantities: ['48'] } }] }, 1660),
    () => runTool(s.sup.tools, supplier, { tool: 'send_correction', args: { orderId, qtysHundredths: [4800] } }), 'send_correction (material)');
  s.advance(15);
  await said(rs, contractor, 'हाँ', none, () => runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } }), 'accept_bill (material)');
  s.advance(26 * 60);
  await said(rs, contractor, null, (rec) => {
    muse(rec, 'photo kind: upi', { job: 'photo_kind', vision: true, kind: 'upi', clear: true }, 1240);
    muse(rec, 'UPI receipt: ₹16800 success', { job: 'upi', vision: true, kind: 'upi_payment', amountPaise: 1680000, utr: '000000000002', status: 'success', date: '2026-11-01', clock: null, clear: true }, 3010);
    rec.add('check', 'UPI amount ✓ = bill: ₹16,800 / ₹16,800', { pass: true, name: 'upi_amount', paidPaise: 1680000, billPaise: 1680000, utr: '000000000002' });
  }, () => runTool(s.site.tools, contractor, { tool: 'claim_payment', args: { orderId, amountPaise: 1680000, utr: '000000000002', paidOn: '2026-11-01', screenshotSha256: SHA_UPI_2 } }), 'claim_payment (material)');
  s.advance(40);
  await said(rp, supplier, 'हाँ', none, () => runTool(s.sup.tools, supplier, { tool: 'confirm_payment', args: { orderId } }), 'confirm_payment (material)');
  await settle();
}

/**
 * Runs both jobs and returns the three ledgers, each with its trace, as the export.
 * @returns {Promise<Export>}
 */
export async function buildSample() {
  const s = await setup();
  try {
    await jcbJob(s);
    await materialJob(s);
    // The explanations run after the answer, on the receiving side; let them finish.
    await new Promise((r) => setTimeout(r, 50));

    /** @param {typeof s.jcbCore} core @param {Recorder} rec @returns {LedgerExport} */
    const dump = (core, rec) => {
      const orders = /** @type {LedgerExport['orders']} */ (core.ledger.orders());
      const events = orders.flatMap((o) => core.ledger.events(o.order_id)).sort((a, b) => a.seq - b.seq);
      const refs = openRefs(core.ledger);
      /** @type {Record<string, string>} */
      const refByOrder = {};
      for (const o of orders) {
        const ref = refs.refOf(o.order_id);
        if (ref !== null) refByOrder[o.order_id] = ref;
      }
      // As the service's /agents/<name>/trace serves it: each entry with its order and reference.
      const trace = rec.list().map((e) => {
        const orderId = e.orderId ?? (e.ref ? refs.orderOfRef(e.ref) ?? null : null);
        return { ...e, orderId, ref: e.ref ?? (orderId ? refs.refOf(orderId) : null) };
      });
      return { agentId: core.self.id, publicKey: publicKeyText(core.self.privateKey), orders, events, chain: core.ledger.verifyChain(), refs: refByOrder, trace };
    };
    const exported = { v: /** @type {const} */ ('hb-export/0.1'), exportedAt: new Date(s.jcbCore.now()).toISOString(), jcb: dump(s.jcbCore, s.traces.jcb), contractor: dump(s.siteCore, s.traces.site), supplier: dump(s.supCore, s.traces.sup) };
    paymentExample(exported, s);
    learningExample(exported);
    return exported;
  } finally {
    await s.close();
    for (const rec of Object.values(s.traces)) rec.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL('./export.json', import.meta.url);
  const sample = await buildSample();
  writeFileSync(out, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(out)}: ${sample.jcb.events.length} JCB events, ${sample.contractor.events.length} contractor events, ${sample.supplier.events.length} supplier events, ${sample.jcb.trace?.length} + ${sample.contractor.trace?.length} + ${sample.supplier.trace?.length} trace entries`);
}
