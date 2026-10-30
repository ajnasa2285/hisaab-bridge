// Delivering our signed messages to the other agent and keeping its answers. A message is written
// to our ledger before it leaves (prepare); if the other side cannot be reached it stays pending and
// is delivered again later, unchanged: the receiver answers a repeat with the same receipt.

import { randomUUID } from 'node:crypto';
import { openRefs } from '../ledger/refs.js';
import { consentOf, prepare, recordAnswer, restoreEvidence } from '../protocol/exchange.js';
import { sendToAgent } from '../transport/a2a.js';

/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {Parameters<typeof recordAnswer>[0]} Agent */
/**
 * @typedef {{ok: true, message: Message, evidence?: Message} | {ok: false, reason: 'wrong_state' | 'busy'} |
 *   {ok: false, reason: 'unreachable' | 'bad_answer' | 'no_address', message: Message} |
 *   {ok: false, reason: 'refused', code: string, message: Message}} Delivery
 */

/** @param {{direction: string, type: string, body: any}} e */
const isUndelivered = (e) => e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'undelivered';

/**
 * What the person is told about an order with a message that expired undelivered.
 * @param {Agent['ledger']} ledger @param {string} orderId
 * @returns {{key: string, params: Record<string, string | number>}}
 */
export function undeliveredNotice(ledger, orderId) {
  return { key: 'common.undelivered', params: { ref: openRefs(ledger).refOf(orderId) ?? '—', site: String(ledger.order(orderId)?.site ?? '') } };
}

/**
 * The same notices for every such order, for someone whose 24-hour window was closed when it happened.
 * @param {Agent['ledger']} ledger
 */
export function undeliveredNotices(ledger) {
  return /** @type {{order_id: string}[]} */ (ledger.orders())
    .filter((order) => ledger.events(order.order_id).some(isUndelivered))
    .map((order) => undeliveredNotice(ledger, order.order_id));
}

/**
 * @param {Agent} agent
 * @param {{peerUrls: Map<string, string>, transport?: (baseUrl: string, m: Message) => Promise<unknown>, onEvidence?: (m: Message) => Promise<void>,
 *   onUndelivered?: (m: Message) => Promise<void>}} o
 */
export function createLink(agent, o) {
  const transport = o.transport ?? sendToAgent;

  /**
   * A message that can no longer arrive: the other side refused it as expired, or it is past its
   * expiry and still gets no answer. Our own note ends it (no more retries; it does not count, see
   * refusedIds in src/ledger/states.js), and the people who may have asked are told.
   * @param {Message} m
   */
  async function giveUp(m) {
    if (agent.ledger.events(m.order_id).some((e) => isUndelivered(e) && e.body.msg_id === m.msg_id)) return;
    agent.ledger.append({ orderId: m.order_id, direction: 'local', type: 'NOTE', msgId: randomUUID(), at: new Date(agent.now()).toISOString(),
      body: { kind: 'undelivered', msg_id: m.msg_id, type: m.type } });
    if (o.onUndelivered) { try { await o.onUndelivered(m); } catch { /* The note stands; the notice is best effort. */ } }
  }

  /** @param {Message} m @returns {Promise<Delivery>} */
  async function deliver(m) {
    const url = o.peerUrls.get(m.to);
    if (!url) return { ok: false, reason: 'no_address', message: m };
    // Our EVIDENCE is kept without bytes; a re-delivery takes them from the private store again.
    if (m.type === 'EVIDENCE' && m.body.items.some((/** @type {any} */ i) => i.bytes === undefined)) {
      const full = restoreEvidence(agent, m);
      if (!full) return { ok: false, reason: 'unreachable', message: m };
      m = full;
    }
    let answer;
    try {
      answer = await transport(url, m);
    } catch {
      return { ok: false, reason: 'unreachable', message: m };
    }
    const reply = /** @type {any} */ (answer);
    const answers = reply?.type === 'RECEIPT' ? reply?.body?.receipt_for : reply?.body?.refers_to;
    if (answers !== m.msg_id) return { ok: false, reason: 'bad_answer', message: m };
    const r = recordAnswer(agent, answer);
    if (!r.ok) {
      if (r.answer) { try { await transport(url, r.answer); } catch { /* Refusal is already signed; never display the rejected image. */ } }
      return { ok: false, reason: 'bad_answer', message: m };
    }
    if (r.kind === 'evidence' && r.message) {
      if (r.applied && o.onEvidence) { try { await o.onEvidence(r.message); } catch { /* Notice failure does not undo verified evidence. */ } }
      return { ok: true, message: m, evidence: r.message };
    }
    if (r.kind === 'refuse' && r.code === 'EXPIRED') await giveUp(m);
    return r.kind === 'receipt' ? { ok: true, message: m } : { ok: false, reason: 'refused', code: r.code ?? 'UNSUPPORTED', message: m };
  }

  /** Our sent messages the other side has not answered yet and we have not given up on, oldest first. @returns {Message[]} */
  function pending() {
    /** @type {Message[]} */
    const out = [];
    for (const order of /** @type {{order_id: string}[]} */ (agent.ledger.orders())) {
      const events = agent.ledger.events(order.order_id);
      const answered = new Set(events
        .filter((e) => e.direction === 'in' && (e.type === 'RECEIPT' || e.type === 'REFUSE' || e.type === 'EVIDENCE'))
        .map((e) => (e.type === 'RECEIPT' ? e.body.body.receipt_for : e.body.body.refers_to)));
      for (const e of events) if (isUndelivered(e)) answered.add(e.body.msg_id);
      // EVIDENCE sent after the owner's yes waits for its receipt like any message (an older one
      // was the direct answer to the request and is never sent again).
      const owed = (/** @type {any} */ e) => e.type !== 'EVIDENCE' || consentOf(agent.ledger, order.order_id, e.body.body.refers_to) === 'yes';
      for (const e of events) if (e.direction === 'out' && owed(e) && !answered.has(e.msgId)) out.push(/** @type {Message} */ (e.body));
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  return {
    deliver,
    pending,
    /**
     * Prepares (state check, sign, write) and delivers one message.
     * @param {Parameters<typeof prepare>[1]} msg
     * @returns {Promise<Delivery>}
     */
    async send(msg) {
      // One message in flight per order: nothing new is signed on top of a message the other side
      // has not answered yet, so a later refusal can never leave our history out of order.
      if (pending().some((p) => p.order_id === msg.orderId)) return { ok: false, reason: 'busy' };
      const m = prepare(agent, msg);
      if (m === null) return { ok: false, reason: 'wrong_state' };
      return deliver(m);
    },
    /**
     * Delivers every pending message again. One past its expiry gets this last try (a reachable peer
     * answers with a signed EXPIRED) and is then given up on.
     * @returns {Promise<Delivery[]>}
     */
    async retryPending() {
      /** @type {Delivery[]} */
      const results = [];
      for (const m of pending()) {
        const d = await deliver(m);
        results.push(d);
        if (!d.ok && d.reason !== 'refused' && Date.parse(m.expires_at) <= agent.now()) await giveUp(m);
      }
      return results;
    },
  };
}
