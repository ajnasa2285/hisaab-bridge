// Delivering our signed messages to the other agent and keeping its answers. A message is written
// to our ledger before it leaves (prepare); if the other side cannot be reached it stays pending and
// is delivered again later, unchanged: the receiver answers a repeat with the same receipt.

import { prepare, recordAnswer } from '../protocol/exchange.js';
import { sendToAgent } from '../transport/a2a.js';

/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {Parameters<typeof recordAnswer>[0]} Agent */
/**
 * @typedef {{ok: true, message: Message} | {ok: false, reason: 'wrong_state' | 'busy'} |
 *   {ok: false, reason: 'unreachable' | 'bad_answer' | 'no_address', message: Message} |
 *   {ok: false, reason: 'refused', code: string, message: Message}} Delivery
 */

/**
 * @param {Agent} agent
 * @param {{peerUrls: Map<string, string>, transport?: (baseUrl: string, m: Message) => Promise<unknown>}} o
 */
export function createLink(agent, o) {
  const transport = o.transport ?? sendToAgent;

  /** @param {Message} m @returns {Promise<Delivery>} */
  async function deliver(m) {
    const url = o.peerUrls.get(m.to);
    if (!url) return { ok: false, reason: 'no_address', message: m };
    let answer;
    try {
      answer = await transport(url, m);
    } catch {
      return { ok: false, reason: 'unreachable', message: m };
    }
    const r = recordAnswer(agent, answer);
    if (!r.ok) return { ok: false, reason: 'bad_answer', message: m };
    return r.kind === 'receipt' ? { ok: true, message: m } : { ok: false, reason: 'refused', code: r.code ?? 'UNSUPPORTED', message: m };
  }

  /** Our sent messages the other side has not answered yet, oldest first. @returns {Message[]} */
  function pending() {
    /** @type {Message[]} */
    const out = [];
    for (const order of /** @type {{order_id: string}[]} */ (agent.ledger.orders())) {
      const events = agent.ledger.events(order.order_id);
      const answered = new Set(events
        .filter((e) => e.direction === 'in' && (e.type === 'RECEIPT' || e.type === 'REFUSE'))
        .map((e) => (e.type === 'RECEIPT' ? e.body.body.receipt_for : e.body.body.refers_to)));
      for (const e of events) if (e.direction === 'out' && !answered.has(e.msgId)) out.push(/** @type {Message} */ (e.body));
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
