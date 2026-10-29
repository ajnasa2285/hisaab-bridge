// One agent's side of the conversation: how a received message becomes a ledger event and a signed
// answer, and how a message we send is checked against our own ledger before it leaves.
// Receiving: checkIncoming (identity, signature, expiry, type) -> repeat? answer as before ->
// register the order -> the ledger checks the state and appends -> signed RECEIPT (or REFUSE).
// The answer to a repeat is rebuilt from the stored event, so a retry never changes anything.

import { buildMessage, checkIncoming } from './messages.js';
import { signMessage } from './keys.js';
import { evidenceBytes, evidenceHash, evidenceMetadata, findEvidenceRecord } from './evidence.js';
import { canonicalize } from './canonical.js';

/** @typedef {import('./messages.js').Message} Message */
/** @typedef {import('./messages.js').Peer} Peer */
/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {{put: (image: {bytes: Uint8Array, mime: string, sha256?: string}) => unknown,
 * get: (sha256: string) => {sha256: string, mime: string, bytes: Uint8Array}|null}} MediaStore */
/** @typedef {{self: Self, peers: Map<string, Peer>, ledger: Ledger, now: () => number, mediaStore?: MediaStore}} Agent */

/**
 * @typedef {object} Self
 * @property {string} id
 * @property {import('node:crypto').KeyObject} privateKey
 */

/**
 * The order's site and kind come from the first message about it (a booking request).
 * @param {Message} m
 */
function orderIdentity(m) {
  return { kind: m.body.kind, site: m.body.site };
}

/**
 * @param {Agent} agent
 * @param {unknown} raw
 * @returns {{answer: Message, applied: boolean, message: Message|null}}
 *   answer: the signed RECEIPT or REFUSE to return; applied: true only the first time a message is written
 */
export function receive(agent, raw) {
  const { self, peers, ledger, now } = agent;
  const nowMs = now();
  const checked = checkIncoming(raw, { selfId: self.id, peers, nowMs, seen: (id) => ledger.hasMessage(id) });

  /**
   * @param {import('./messages.js').RefusalCode} code
   * @param {string|null} msgId
   * @param {string|null} to
   * @param {string|null} orderId
   */
  const refusal = (code, msgId, to, orderId) => buildMessage({
    type: 'REFUSE', from: self.id, to: to ?? 'agent:unknown', orderId: orderId ?? '00000000-0000-4000-8000-000000000000',
    body: { refers_to: msgId ?? '00000000-0000-4000-8000-000000000000', code }, privateKey: self.privateKey, nowMs,
  });

  if (!checked.ok) {
    const m = /** @type {any} */ (raw);
    const orderId = m && typeof m.order_id === 'string' && /^[0-9a-f-]{36}$/.test(m.order_id) ? m.order_id : null;
    return { answer: refusal(checked.code, checked.msgId, checked.from, orderId), applied: false, message: null };
  }
  const m = checked.message;

  // A repeat: the same answer as the first time, nothing written.
  const earlier = ledger.eventOfMessage(m.msg_id);
  if (earlier !== null) {
    if (m.type === 'EVIDENCE') {
      const bytes = evidenceBytes(m.body.items[0].bytes);
      if (!bytes || evidenceHash(bytes) !== m.body.items[0].sha256) return { answer: refusal('BAD_BODY', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
    if (earlier.direction !== 'in' || canonicalize(earlier.body) !== canonicalize(m.type === 'EVIDENCE' ? evidenceMetadata(m) : m)) {
      return { answer: refusal('BAD_BODY', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
    if (m.type === 'EVIDENCE_REQUEST') {
      const sent = ledger.events(m.order_id).find((e) => e.direction === 'out' && e.type === 'EVIDENCE' && e.body.body.refers_to === m.msg_id);
      const response = sent ? restoreEvidence(agent, /** @type {Message} */ (sent.body)) : null;
      return { answer: response ?? refusal('not_kept', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
    return { answer: receiptFor(agent, m, earlier.hash, nowMs), applied: false, message: m };
  }

  const existing = /** @type {{counterparty: string}|null} */ (ledger.order(m.order_id));
  if (existing === null) {
    if (m.type === 'EVIDENCE_REQUEST' || m.type === 'EVIDENCE') return { answer: refusal('no_such_record', m.msg_id, m.from, m.order_id), applied: false, message: m };
    if (m.type !== 'BOOKING_REQUEST') return { answer: refusal('WRONG_STATE', m.msg_id, m.from, m.order_id), applied: false, message: m };
    const id = orderIdentity(m);
    ledger.ensureOrder({ orderId: m.order_id, kind: id.kind, counterparty: m.from, site: id.site, at: new Date(nowMs).toISOString() });
  } else if (existing.counterparty !== m.from) {
    // An order belongs to the two agents that opened it; a third agent cannot write into it.
    return { answer: refusal(m.type === 'EVIDENCE_REQUEST' || m.type === 'EVIDENCE' ? 'not_party' : 'NOT_CONNECTED', m.msg_id, m.from, m.order_id), applied: false, message: m };
  }

  if (m.type === 'EVIDENCE_REQUEST') {
    const record = findEvidenceRecord(ledger, m.order_id, m.body.refers_to, self.id);
    const original = ledger.eventOfMessage(m.body.refers_to);
    if (!record || !original || original.orderId !== m.order_id || original.direction === 'in') {
      return { answer: refusal('no_such_record', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
    let image;
    try { image = agent.mediaStore?.get(record.sha256); } catch { image = null; }
    if (!image || evidenceHash(image.bytes) !== record.sha256) return { answer: refusal('not_kept', m.msg_id, m.from, m.order_id), applied: false, message: m };
    ledger.append({ orderId: m.order_id, direction: 'in', type: m.type, msgId: m.msg_id, body: m, at: new Date(nowMs).toISOString() });
    const answer = prepare(agent, { type: 'EVIDENCE', to: m.from, orderId: m.order_id,
      body: { refers_to: m.msg_id, items: [{ record: record.record, sha256: record.sha256, mime: image.mime, bytes: Buffer.from(image.bytes).toString('base64') }] } });
    return { answer: answer ?? refusal('not_kept', m.msg_id, m.from, m.order_id), applied: answer !== null, message: m };
  }

  if (m.type === 'EVIDENCE') {
    const request = ledger.eventOfMessage(m.body.refers_to);
    const item = m.body.items[0];
    const record = findEvidenceRecord(ledger, m.order_id, item.record, m.from);
    const bytes = evidenceBytes(item.bytes);
    if (!request || request.direction !== 'out' || request.type !== 'EVIDENCE_REQUEST' || request.orderId !== m.order_id
      || request.body.to !== m.from || request.body.body.refers_to !== item.record || !record || record.sha256 !== item.sha256
      || !bytes || evidenceHash(bytes) !== record.sha256
      || ledger.events(m.order_id).some((e) => e.type === 'EVIDENCE' && e.direction === 'in' && e.body.body.refers_to === m.body.refers_to)) {
      return { answer: refusal('BAD_BODY', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
    try {
      if (!agent.mediaStore) throw new Error('no private media store');
      agent.mediaStore.put({ bytes, mime: item.mime, sha256: item.sha256 });
    } catch {
      return { answer: refusal('not_kept', m.msg_id, m.from, m.order_id), applied: false, message: m };
    }
  }

  const stored = ledger.append({
    orderId: m.order_id, direction: 'in', type: m.type, msgId: m.msg_id, body: m, at: new Date(nowMs).toISOString(),
  });
  if (stored === null) return { answer: refusal('WRONG_STATE', m.msg_id, m.from, m.order_id), applied: false, message: m };
  return { answer: receiptFor(agent, m, stored.hash, nowMs), applied: true, message: m };
}

/**
 * @param {{self: Self, ledger: Ledger}} agent
 * @param {Message} m
 * @param {string} entryHash
 * @param {number} nowMs
 * @returns {Message}
 */
function receiptFor(agent, m, entryHash, nowMs) {
  return buildMessage({
    type: 'RECEIPT', from: agent.self.id, to: m.from, orderId: m.order_id,
    body: { receipt_for: m.msg_id, entry_hash: entryHash, chain_head: agent.ledger.chainHead() },
    privateKey: agent.self.privateKey, nowMs,
  });
}

/**
 * Prepares a message we send: built, signed and written to our own ledger first (so a crash after
 * sending cannot lose it), only if it fits the order's state. The caller then delivers it, and may
 * deliver it again on failure: the receiver answers a repeat with the same receipt.
 * @param {{self: Self, ledger: Ledger, now: () => number, mediaStore?: MediaStore}} agent
 * @param {{type: import('./messages.js').MessageType, to: string, orderId: string, body: Record<string, any>,
 *   site?: string}} o  `site` and `body.kind` are needed when this message opens the order
 * @returns {Message|null} null when it does not fit the state (nothing written)
 */
export function prepare(agent, o) {
  const nowMs = agent.now();
  const m = buildMessage({ type: o.type, from: agent.self.id, to: o.to, orderId: o.orderId, body: o.body, privateKey: agent.self.privateKey, nowMs });
  const existing = agent.ledger.order(o.orderId);
  if ((o.type === 'EVIDENCE_REQUEST' || o.type === 'EVIDENCE') && (!existing || existing.counterparty !== o.to)) return null;
  if (o.type === 'EVIDENCE_REQUEST' && o.body.order !== o.orderId) return null;
  if (agent.ledger.order(o.orderId) === null) {
    if (o.type !== 'BOOKING_REQUEST') return null;
    agent.ledger.ensureOrder({ orderId: o.orderId, kind: o.body.kind, counterparty: o.to, site: o.body.site, at: new Date(nowMs).toISOString() });
  }
  const stored = agent.ledger.append({ orderId: o.orderId, direction: 'out', type: m.type, msgId: m.msg_id, body: m, at: new Date(nowMs).toISOString() });
  return stored === null ? null : m;
}

/**
 * Records the receiver's answer to something we sent. A receipt is kept as evidence that the
 * other side wrote our message; a refusal is kept too, so the owner can be told.
 * @param {Agent} agent
 * @param {unknown} raw the RECEIPT or REFUSE we got back
 * @returns {{ok: true, kind: 'receipt'|'refuse'|'evidence', code?: string, message?: Message, applied?: boolean} | {ok: false, reason: string, answer?: Message}}
 */
export function recordAnswer(agent, raw) {
  if (raw && typeof raw === 'object' && /** @type {any} */ (raw).type === 'EVIDENCE') {
    const r = receive(agent, raw);
    return r.answer.type === 'REFUSE' ? { ok: false, reason: r.answer.body.code, answer: r.answer }
      : { ok: true, kind: 'evidence', message: r.message ?? undefined, applied: r.applied };
  }
  const nowMs = agent.now();
  const checked = checkIncoming(raw, { selfId: agent.self.id, peers: agent.peers, nowMs, seen: (id) => agent.ledger.hasMessage(id) });
  if (!checked.ok) return { ok: false, reason: checked.code };
  const m = checked.message;
  if (m.type !== 'RECEIPT' && m.type !== 'REFUSE') return { ok: false, reason: 'not an answer' };
  if (agent.ledger.hasMessage(m.msg_id)) return { ok: true, kind: m.type === 'RECEIPT' ? 'receipt' : 'refuse' };
  const refersTo = m.type === 'RECEIPT' ? m.body.receipt_for : m.body.refers_to;
  const sent = agent.ledger.eventOfMessage(refersTo);
  if (sent === null || sent.direction !== 'out' || sent.orderId !== m.order_id || sent.body.to !== m.from) return { ok: false, reason: 'answer to nothing we sent' };
  agent.ledger.append({ orderId: m.order_id, direction: 'in', type: m.type, msgId: m.msg_id, body: m, at: new Date(nowMs).toISOString() });
  return m.type === 'RECEIPT' ? { ok: true, kind: 'receipt' } : { ok: true, kind: 'refuse', code: m.body.code };
}

/** Reconstitute an already signed metadata reply for transport, without retaining bytes in history.
 * @param {Agent} agent @param {Message} stored @returns {Message|null} */
export function restoreEvidence(agent, stored) {
  try {
    const items = stored.body.items.map((/** @type {any} */ item) => {
      const image = agent.mediaStore?.get(item.sha256);
      if (!image || image.mime !== item.mime || evidenceHash(image.bytes) !== item.sha256) throw new Error('not kept');
      return { ...item, bytes: Buffer.from(image.bytes).toString('base64') };
    });
    return /** @type {Message} */ (signMessage({ ...stored, body: { ...stored.body, items, metadata_sig: stored.sig } }, agent.self.privateKey));
  } catch { return null; }
}
