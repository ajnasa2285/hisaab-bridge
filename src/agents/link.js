// Delivering our signed messages to the other agent and keeping its answers. A message is written
// to our ledger before it leaves (prepare); if the other side cannot be reached it stays pending and
// is delivered again later, unchanged: the receiver answers a repeat with the same receipt.

import { consentOf, prepare, recordAnswer, restoreEvidence } from '../protocol/exchange.js';
import { sendToAgent } from '../transport/a2a.js';

/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {Parameters<typeof recordAnswer>[0]} Agent */
/**
 * @typedef {{ok: true, message: Message, evidence?: Message} | {ok: false, reason: 'wrong_state' | 'busy'} |
 *   {ok: false, reason: 'unreachable' | 'bad_answer' | 'no_address', message: Message} |
 *   {ok: false, reason: 'refused', code: string, message: Message}} Delivery
 */

/**
 * @param {Agent} agent
 * @param {{peerUrls: Map<string, string>, transport?: (baseUrl: string, m: Message) => Promise<unknown>, onEvidence?: (m: Message) => Promise<void>}} o
 */
export function createLink(agent, o) {
  const transport = o.transport ?? sendToAgent;

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
    return r.kind === 'receipt' ? { ok: true, message: m } : { ok: false, reason: 'refused', code: r.code ?? 'UNSUPPORTED', message: m };
  }

  /** Our sent messages the other side has not answered yet, oldest first. @returns {Message[]} */
  function pending() {
    /** @type {Message[]} */
    const out = [];
    for (const order of /** @type {{order_id: string}[]} */ (agent.ledger.orders())) {
      const events = agent.ledger.events(order.order_id);
      const answered = new Set(events
        .filter((e) => e.direction === 'in' && (e.type === 'RECEIPT' || e.type === 'REFUSE' || e.type === 'EVIDENCE'))
        .map((e) => (e.type === 'RECEIPT' ? e.body.body.receipt_for : e.body.body.refers_to)));
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
    /** Delivers every pending message again. @returns {Promise<Delivery[]>} */
    async retryPending() {
      /** @type {Delivery[]} */
      const results = [];
      for (const m of pending()) results.push(await deliver(m));
      return results;
    },
  };
}
