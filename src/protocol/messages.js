// Agent-to-agent messages (docs/CONTRACTS.md section 4): their shape, how they are built and
// signed, and the checks a receiver runs, always in the same order, before anything is applied:
// version -> known sender -> signature -> addressed to me -> not expired -> not a repeat ->
// type allowed from this sender -> body well formed. The order state is the ledger's check.

import { randomUUID } from 'node:crypto';
import { signMessage, verifyMessage } from './keys.js';
import { evidenceBytes, evidenceMetadata, EVIDENCE_MIMES } from './evidence.js';

export const VERSION = 'hb/0.1';
const DAY_MS = 24 * 3600 * 1000;

export const TYPES = /** @type {const} */ ([
  'BOOKING_REQUEST', 'BOOKING_REPLY', 'DELIVERY', 'BILL', 'RECEIPT', 'ACCEPT',
  'DISPUTE', 'CORRECTION', 'PAYMENT_CLAIM', 'SETTLED', 'REFUSE', 'EVIDENCE_REQUEST', 'EVIDENCE',
]);
/** @typedef {typeof TYPES[number]} MessageType */

export const REFUSAL_CODES = /** @type {const} */ ([
  'UNSUPPORTED', 'NOT_CONNECTED', 'BAD_SIGNATURE', 'NOT_FOR_ME', 'EXPIRED', 'WRONG_STATE', 'BAD_BODY',
  'no_such_record', 'not_party', 'not_kept',
]);
/** @typedef {typeof REFUSAL_CODES[number]} RefusalCode */

/**
 * @typedef {object} Message
 * @property {string} v
 * @property {string} msg_id
 * @property {MessageType} type
 * @property {string} from
 * @property {string} to
 * @property {string} order_id
 * @property {number} rev
 * @property {string} created_at
 * @property {string} expires_at
 * @property {Record<string, any>} body
 * @property {string} sig
 */

/**
 * @typedef {object} Peer
 * @property {string} id                       e.g. "agent:jcb-1"
 * @property {import('node:crypto').KeyObject} publicKey
 * @property {Set<MessageType>} mayReceiveFrom  the types this peer may send to us
 */

const AGENT_ID_RE = /^agent:[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_TEXT = 500;

/** @param {unknown} n */
const nat = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
/** @param {unknown} n */
const pos = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0;
/** @param {unknown} s */
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_TEXT;
/** @param {unknown} s */
const optText = (s) => s === undefined || text(s);
/** @param {unknown} s */
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
/** @param {unknown} s */
const isDay = (s) => typeof s === 'string' && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
/** @param {unknown} s */
const isIso = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

/** @param {any} it */
const item = (it) => it && typeof it === 'object' && text(it.name) && pos(it.qtyHundredths) && text(it.unit);
/** @param {any} items */
const items = (items) => Array.isArray(items) && items.length > 0 && items.length <= 20 && items.every(item);
/** @param {any} r */
const rate = (r) => r && typeof r === 'object' && text(r.name) && text(r.unit) && pos(r.ratePaise);
/** A material "yes": one rate per item and unit, never two for the same pair. @param {any} rates */
const rates = (rates) => Array.isArray(rates) && rates.length > 0 && rates.length <= 20 && rates.every(rate)
  && new Set(rates.map((/** @type {any} */ r) => JSON.stringify([r.name, r.unit]))).size === rates.length;
/** @param {any} e */
const evidence = (e) => e && typeof e === 'object' && typeof e.sha256 === 'string' && SHA256_RE.test(e.sha256)
  && (e.kind === 'meter' || e.kind === 'challan') && (e.readValue === null || typeof e.readValue === 'string')
  && (e.takenAt === null || isIso(e.takenAt)) && isIso(e.sentAt) && (e.record === undefined || isUuid(e.record));
/** @param {any} c */
const siteCount = (c) => c && typeof c === 'object' && isUuid(c.record) && typeof c.sha256 === 'string' && SHA256_RE.test(c.sha256)
  && isIso(c.at) && (c.number === undefined || c.number === null || text(c.number))
  && Array.isArray(c.items) && c.items.length <= 20 && c.items.every((/** @type {any} */ i) => i && text(i.name) && text(i.unit) && nat(i.qtyHundredths));
/** @param {any} b @param {string[]} keys */
const only = (b, keys) => Object.keys(b).every((k) => keys.includes(k));
/** @param {any} l */
const billLine = (l) => l && typeof l === 'object' && text(l.what) && nat(l.ratePaise) && nat(l.amountPaise)
  && (l.qtyHundredths === undefined || pos(l.qtyHundredths)) && (l.hoursTenths === undefined || nat(l.hoursTenths))
  && (l.qtyHundredths !== undefined) !== (l.hoursTenths !== undefined);
/** @param {any} b */
const billBody = (b) => Array.isArray(b.lines) && b.lines.length > 0 && b.lines.length <= 50 && b.lines.every(billLine)
  && nat(b.totalPaise) && b.totalPaise === b.lines.reduce((/** @type {number} */ s, /** @type {any} */ l) => s + l.amountPaise, 0)
  && Array.isArray(b.evidence) && b.evidence.length <= 50 && b.evidence.every(evidence);

/** @type {Record<MessageType, (b: any) => boolean>} */
const BODY_OK = {
  BOOKING_REQUEST: (b) => (b.kind === 'jcb_hours' || b.kind === 'material') && text(b.site) && isDay(b.day)
    && (b.time === undefined || TIME_RE.test(b.time)) && optText(b.note)
    && (b.kind === 'jcb_hours' ? (b.hoursTenths === undefined || pos(b.hoursTenths)) && b.items === undefined
      : items(b.items) && b.hoursTenths === undefined),
  BOOKING_REPLY: (b) => ['yes', 'no', 'other_time'].includes(b.answer) && (b.day === undefined || isDay(b.day))
    && (b.time === undefined || TIME_RE.test(b.time)) && (b.ratePaise === undefined || nat(b.ratePaise)) && optText(b.note)
    && (b.rates === undefined || (b.answer === 'yes' && rates(b.rates)))
    && (b.answer !== 'other_time' || isDay(b.day)),
  DELIVERY: (b) => items(b.items) && b.challan && typeof b.challan.sha256 === 'string' && SHA256_RE.test(b.challan.sha256)
    && isIso(b.deliveredAt),
  BILL: (b) => billBody(b) && b.replaces === undefined,
  RECEIPT: (b) => isUuid(b.receipt_for) && typeof b.entry_hash === 'string' && SHA256_RE.test(b.entry_hash)
    && typeof b.chain_head === 'string' && SHA256_RE.test(b.chain_head),
  ACCEPT: (b) => isUuid(b.bill),
  DISPUTE: (b) => isUuid(b.bill) && text(b.reason) && b.theirFigure && typeof b.theirFigure === 'object'
    && ['hoursTenths', 'qtyHundredths', 'totalPaise'].some((k) => nat(b.theirFigure[k]))
    && (b.siteCount === undefined || siteCount(b.siteCount)),
  CORRECTION: (b) => billBody(b) && isUuid(b.replaces),
  PAYMENT_CLAIM: (b) => isUuid(b.bill) && pos(b.amountPaise) && text(b.utr) && isDay(b.paidOn)
    && b.screenshot && typeof b.screenshot.sha256 === 'string' && SHA256_RE.test(b.screenshot.sha256),
  SETTLED: (b) => isUuid(b.bill) && isUuid(b.payment) && pos(b.amountPaise),
  REFUSE: (b) => isUuid(b.refers_to) && REFUSAL_CODES.includes(b.code),
  EVIDENCE_REQUEST: (b) => only(b, ['order', 'refers_to', 'reason']) && isUuid(b.order) && isUuid(b.refers_to)
    && ['bill_disputed', 'count_differs', 'asked'].includes(b.reason),
  EVIDENCE: (b) => only(b, ['refers_to', 'items', 'metadata_sig']) && isUuid(b.refers_to)
    && (b.metadata_sig === undefined || /^ed25519:[A-Za-z0-9+/]{86}==$/.test(b.metadata_sig))
    && Array.isArray(b.items) && b.items.length === 1 && b.items.every((/** @type {any} */ i) => i
      && only(i, ['record', 'sha256', 'mime', 'bytes']) && isUuid(i.record) && typeof i.sha256 === 'string'
      && SHA256_RE.test(i.sha256) && EVIDENCE_MIMES.includes(i.mime) && evidenceBytes(i.bytes) !== null),
};

/**
 * @param {MessageType} type
 * @param {unknown} body
 * @returns {boolean}
 */
export function bodyIsValid(type, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  try {
    return BODY_OK[type](body);
  } catch {
    return false;
  }
}

/**
 * Builds and signs a message. Throws on a malformed body: a sender bug must not leave the agent.
 * @param {{type: MessageType, from: string, to: string, orderId: string, rev?: number,
 *   body: Record<string, any>, privateKey: import('node:crypto').KeyObject, nowMs: number, ttlMs?: number}} o
 * @returns {Message}
 */
export function buildMessage(o) {
  if (!AGENT_ID_RE.test(o.from) || !AGENT_ID_RE.test(o.to)) throw new TypeError('buildMessage: bad agent id');
  if (!isUuid(o.orderId)) throw new TypeError('buildMessage: bad order id');
  if (!bodyIsValid(o.type, o.body)) throw new TypeError(`buildMessage: bad ${o.type} body`);
  const rev = o.rev ?? 1;
  if (!pos(rev)) throw new TypeError('buildMessage: bad rev');
  const unsigned = {
    v: VERSION,
    msg_id: randomUUID(),
    type: o.type,
    from: o.from,
    to: o.to,
    order_id: o.orderId,
    rev,
    created_at: new Date(o.nowMs).toISOString(),
    expires_at: new Date(o.nowMs + (o.ttlMs ?? DAY_MS)).toISOString(),
    body: o.body,
  };
  if (o.type === 'EVIDENCE') {
    const metadata = signMessage(evidenceMetadata(unsigned), o.privateKey);
    unsigned.body = { ...o.body, metadata_sig: metadata.sig };
  }
  return signMessage(unsigned, o.privateKey);
}

/**
 * The receiver's checks, in the fixed order. Nothing about our own ledger is revealed on refusal.
 * @param {unknown} raw the message as received
 * @param {{selfId: string, peers: Map<string, Peer>, nowMs: number, seen: (msgId: string) => boolean}} ctx
 * @returns {{ok: true, message: Message} | {ok: false, code: RefusalCode, msgId: string|null, from: string|null}}
 */
export function checkIncoming(raw, ctx) {
  const m = /** @type {any} */ (raw);
  const msgId = m && isUuid(m.msg_id) ? m.msg_id : null;
  const from = m && typeof m.from === 'string' && AGENT_ID_RE.test(m.from) ? m.from : null;
  /** @param {RefusalCode} code */
  const refuse = (code) => ({ ok: /** @type {const} */ (false), code, msgId, from });

  if (!m || typeof m !== 'object' || m.v !== VERSION || msgId === null || !TYPES.includes(m.type)) return refuse('UNSUPPORTED');
  const peer = from === null ? undefined : ctx.peers.get(from);
  if (!peer) return refuse('NOT_CONNECTED');
  if (!verifyMessage(m, peer.publicKey)) return refuse('BAD_SIGNATURE');
  if (m.to !== ctx.selfId) return refuse('NOT_FOR_ME');
  const expires = Date.parse(m.expires_at);
  if (!isIso(m.created_at) || Number.isNaN(expires) || expires <= ctx.nowMs) return refuse('EXPIRED');
  // Repeats still validate their shape: a reused id must not bypass the evidence guards.
  // The caller also binds it to the exact stored inbound message before rebuilding an answer.
  if (!ctx.seen(msgId) && !peer.mayReceiveFrom.has(m.type)) return refuse('NOT_CONNECTED');
  if (!isUuid(m.order_id) || !pos(m.rev) || !bodyIsValid(m.type, m.body)) return refuse('BAD_BODY');
  if ((m.type === 'EVIDENCE_REQUEST' || m.type === 'EVIDENCE')
    && !only(m, ['v', 'msg_id', 'type', 'from', 'to', 'order_id', 'rev', 'created_at', 'expires_at', 'body', 'sig'])) return refuse('BAD_BODY');
  if (m.type === 'EVIDENCE_REQUEST' && m.body.order !== m.order_id) return refuse('BAD_BODY');
  if (m.type === 'EVIDENCE' && !verifyMessage(evidenceMetadata(m), peer.publicKey)) return refuse('BAD_SIGNATURE');
  return { ok: true, message: /** @type {Message} */ (m) };
}
