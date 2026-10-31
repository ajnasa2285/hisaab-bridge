// The check on the server, and on copies of ledgers (src/ledger/check-files.js): each ledger's own
// chain, then the receipts between connected agents (src/ledger/cross-check.js). It reads and never
// writes. Each step runs in its own turn of the event loop, so messages keep moving between them.

import { verifyMessage } from '../protocol/keys.js';
import { crossCheck } from './cross-check.js';

/**
 * @typedef {{name: string, id: string, ledger: Pick<import('./store.js').Ledger, 'verifyChain' | 'orders' | 'events'>,
 *   peers: Map<string, {publicKey?: import('node:crypto').KeyObject}>}} CheckedAgent
 */
/**
 * One thing found. `id` stays the same from one check to the next, so a failure is told once; `text`
 * names only agents, row numbers and the kind of problem, never a row's contents.
 * @typedef {{id: string, agents: string[], seq: number, orderId: string|null, kind: string, text: string}} Failure
 */

const nextTurn = () => new Promise((r) => { setImmediate(r); });

/**
 * @param {CheckedAgent[]} agents
 * @param {{onError?: (name: string, e: unknown) => void}} [o] a part that could not be checked: told here, not a failure of the records
 * @returns {Promise<{failures: Failure[], receipts: number, signaturesChecked: number}>}
 */
export async function checkLedgers(agents, o = {}) {
  /** @type {Failure[]} */
  const failures = [];
  let receipts = 0;
  let signaturesChecked = 0;
  for (const a of agents) {
    try {
      const chain = a.ledger.verifyChain();
      if (!chain.ok) failures.push({ id: `chain:${a.name}:${chain.brokenAt}`, agents: [a.id], seq: chain.brokenAt, orderId: null, kind: 'chain_broken', text: `${a.name}: chain broken at seq ${chain.brokenAt}` });
    } catch (e) { o.onError?.(a.name, e); }
    await nextTurn();
  }
  // All ledgers are read in one turn: a receipt seen here is never newer than the other ledger read
  // here, so a message in flight during the check cannot look like a mismatch.
  /** @type {Map<string, {id: string, events: import('./store.js').LedgerEvent[]}>} */
  const sides = new Map();
  for (const a of agents) {
    try {
      const orders = /** @type {{order_id: string}[]} */ (/** @type {unknown} */ (a.ledger.orders()));
      sides.set(a.id, { id: a.id, events: orders.flatMap((x) => a.ledger.events(x.order_id)).sort((p, q) => p.seq - q.seq) });
    } catch (e) { o.onError?.(a.name, e); }
  }
  await nextTurn();
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  for (const [i, a] of agents.entries()) {
    for (const b of agents.slice(i + 1)) {
      const [sa, sb] = [sides.get(a.id), sides.get(b.id)];
      if (!sa || !sb || !(a.peers.has(b.id) || b.peers.has(a.id))) continue;
      try {
        const r = crossCheck(sa, sb, { verify: (e) => {
          const key = (e.body.from === a.id ? b : a).peers.get(e.body.from)?.publicKey;
          return key ? verifyMessage(e.body, key) : null;
        } });
        receipts += r.receipts;
        signaturesChecked += r.signaturesChecked;
        for (const m of r.mismatches) {
          const [holder, peer] = [nameOf.get(m.holder), nameOf.get(m.peer)];
          failures.push({ id: `receipt:${holder}:${m.seq}:${m.kind}`, agents: [m.holder, m.peer], seq: m.seq, orderId: m.orderId, kind: m.kind, text: `${holder} seq ${m.seq}, receipt from ${peer}: ${m.kind}` });
        }
      } catch (e) { o.onError?.(`${a.name}/${b.name}`, e); }
      await nextTurn();
    }
  }
  return { failures, receipts, signaturesChecked };
}
