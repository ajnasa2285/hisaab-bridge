// One agent's side of the conversation: how a received message becomes a ledger event and a signed
// answer, and how a message we send is checked against our own ledger before it leaves.
// Receiving: checkIncoming (identity, signature, expiry, type) -> repeat? answer as before ->
// register the order -> the ledger checks the state and appends -> signed RECEIPT (or REFUSE).
// The answer to a repeat is rebuilt from the stored event, so a retry never changes anything.

import { buildMessage, checkIncoming } from './messages.js';

/** @typedef {import('./messages.js').Message} Message */
/** @typedef {import('./messages.js').Peer} Peer */
/** @typedef {import('../ledger/store.js').Ledger} Ledger */

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
 * @param {{self: Self, peers: Map<string, Peer>, ledger: Ledger, now: () => number}} agent
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
    return { answer: receiptFor(agent, m, earlier.hash, nowMs), applied: false, message: m };
  }

  const existing = /** @type {{counterparty: string}|null} */ (ledger.order(m.order_id));
  if (existing === null) {
    if (m.type !== 'BOOKING_REQUEST') return { answer: refusal('WRONG_STATE', m.msg_id, m.from, m.order_id), applied: false, message: m };
    const id = orderIdentity(m);
    ledger.ensureOrder({ orderId: m.order_id, kind: id.kind, counterparty: m.from, site: id.site, at: new Date(nowMs).toISOString() });
  } else if (existing.counterparty !== m.from) {
    // An order belongs to the two agents that opened it; a third agent cannot write into it.
    return { answer: refusal('NOT_CONNECTED', m.msg_id, m.from, m.order_id), applied: false, message: m };
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
 * @param {{self: Self, ledger: Ledger, now: () => number}} agent
 * @param {{type: import('./messages.js').MessageType, to: string, orderId: string, body: Record<string, any>,
 *   site?: string}} o  `site` and `body.kind` are needed when this message opens the order
 * @returns {Message|null} null when it does not fit the state (nothing written)
 */
export function prepare(agent, o) {
  const nowMs = agent.now();
  const m = buildMessage({ type: o.type, from: agent.self.id, to: o.to, orderId: o.orderId, body: o.body, privateKey: agent.self.privateKey, nowMs });
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
 * @param {{self: Self, peers: Map<string, Peer>, ledger: Ledger, now: () => number}} agent
 * @param {unknown} raw the RECEIPT or REFUSE we got back
 * @returns {{ok: true, kind: 'receipt'|'refuse', code?: string} | {ok: false, reason: string}}
 */
export function recordAnswer(agent, raw) {
  const nowMs = agent.now();
  const checked = checkIncoming(raw, { selfId: agent.self.id, peers: agent.peers, nowMs, seen: (id) => agent.ledger.hasMessage(id) });
  if (!checked.ok) return { ok: false, reason: checked.code };
  const m = checked.message;
  if (m.type !== 'RECEIPT' && m.type !== 'REFUSE') return { ok: false, reason: 'not an answer' };
  if (agent.ledger.hasMessage(m.msg_id)) return { ok: true, kind: m.type === 'RECEIPT' ? 'receipt' : 'refuse' };
  const refersTo = m.type === 'RECEIPT' ? m.body.receipt_for : m.body.refers_to;
  const sent = agent.ledger.eventOfMessage(refersTo);
  if (sent === null || sent.direction !== 'out' || sent.orderId !== m.order_id) return { ok: false, reason: 'answer to nothing we sent' };
  agent.ledger.append({ orderId: m.order_id, direction: 'in', type: m.type, msgId: m.msg_id, body: m, at: new Date(nowMs).toISOString() });
  return m.type === 'RECEIPT' ? { ok: true, kind: 'receipt' } : { ok: true, kind: 'refuse', code: m.body.code };
}
