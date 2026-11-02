// The ledger check when each agent is its own service and no process can open another's ledger file.
// Each agent checks its own chain, then asks each agent it deals with for a view of that agent's ledger
// and runs the same comparison as ever (src/ledger/cross-check.js), both directions. So a rewrite of any
// ledger is seen by the other side from its own signed receipts, and each agent tells its own owner.
//
// The request is signed with the asking agent's key and checked against its public key, so it needs no
// shared secret and works the same between servers; without a good signature the path answers 404. The
// answer shows the asker only what it has already seen, or could: for rows of orders between the two,
// what the comparison reads (rows that came from the asker in full, since it signed them; of the others
// their kind and ids). For any other row, its number and hash alone: a chain_head may name it, and the
// contractor's ledger must not show the JCB owner anything about the supplier.
//
// Two ledgers cannot be read in one turn across processes. So `exportedAt` is taken before the rows are
// read, and the comparison leaves out a receipt no older than the other side's copy (`notYet`): a message
// in flight during the check does not look like a mismatch.

import { randomUUID } from 'node:crypto';
import { signMessage, verifyMessage } from '../protocol/keys.js';
import { crossCheck } from '../ledger/cross-check.js';
import { chainFailure, nextTurn, receiptFailure } from '../ledger/integrity.js';

const PURPOSE = 'hb-receipt-check/0.1';
const REQUEST_LIFE_MS = 5 * 60 * 1000;
const PEER_TIMEOUT_MS = 30 * 1000;

/** @typedef {import('node:crypto').KeyObject} KeyObject */
/** @typedef {Pick<import('../ledger/store.js').Ledger, 'orders' | 'events'>} Readable */

/**
 * One side's rows, in order. @param {Readable} ledger
 * @returns {import('../ledger/store.js').LedgerEvent[]}
 */
function allEvents(ledger) {
  const orders = /** @type {{order_id: string}[]} */ (/** @type {unknown} */ (ledger.orders()));
  return orders.flatMap((o) => ledger.events(o.order_id)).sort((p, q) => p.seq - q.seq);
}

/**
 * What one agent shows another. Pure.
 * @param {Readable} ledger @param {string} askerId @param {string} agentId @param {string} exportedAt taken before this call
 */
export function peerView(ledger, askerId, agentId, exportedAt) {
  const orders = /** @type {{order_id: string, counterparty: string}[]} */ (/** @type {unknown} */ (ledger.orders()));
  const between = new Set(orders.filter((o) => o.counterparty === askerId).map((o) => o.order_id));
  const events = allEvents(ledger).map((e) => {
    const bare = { seq: e.seq, hash: e.hash };
    if (!between.has(e.orderId)) return bare;
    const row = { ...bare, orderId: e.orderId, direction: e.direction, type: e.type, msgId: e.msgId, at: e.at };
    if (e.direction === 'in') return { ...row, body: e.body };
    if (e.direction === 'out') return row;
    return e.type === 'NOTE' && e.body?.kind === 'undelivered' ? { ...row, body: { kind: 'undelivered', msg_id: e.body.msg_id } } : bare;
  });
  return { v: 'hb-peer-view/0.1', agentId, exportedAt, events };
}

/**
 * The asker's signed request.
 * @param {{id: string, privateKey: KeyObject}} self @param {string} peerId @param {number} nowMs
 */
export const signedRequest = (self, peerId, nowMs) => signMessage({ purpose: PURPOSE, from: self.id, to: peerId, at: new Date(nowMs).toISOString(), nonce: randomUUID() }, self.privateKey);

/**
 * Is this a request we should answer? Returns the asker's id, or null.
 * @param {any} body @param {string} selfId @param {Map<string, {publicKey?: KeyObject}>} peers @param {number} nowMs
 */
export function askerOf(body, selfId, peers, nowMs) {
  if (typeof body !== 'object' || body === null || body.purpose !== PURPOSE || body.to !== selfId) return null;
  const key = typeof body.from === 'string' ? peers.get(body.from)?.publicKey : undefined;
  if (!key || typeof body.at !== 'string' || Math.abs(nowMs - Date.parse(body.at)) > REQUEST_LIFE_MS) return null;
  return verifyMessage(body, key) ? body.from : null;
}

/**
 * The check for one agent, in the shape of src/ledger/integrity.js: its chain, then each peer.
 * @param {{
 *   self: {name: string, id: string, privateKey: KeyObject, publicKey: KeyObject},
 *   peers: {name: string, id: string, url: string, publicKey: KeyObject}[],
 *   now: () => number,
 *   fetch?: typeof globalThis.fetch,
 *   onPeerMissed?: () => void,
 * }} o
 * @returns {typeof import('../ledger/integrity.js').checkLedgers}
 */
export function createPeerCheck(o) {
  const doFetch = o.fetch ?? globalThis.fetch;
  const nameOf = new Map([[o.self.id, o.self.name], ...o.peers.map((p) => /** @type {[string, string]} */ ([p.id, p.name]))]);
  const keyOf = new Map([[o.self.id, o.self.publicKey], ...o.peers.map((p) => /** @type {[string, KeyObject]} */ ([p.id, p.publicKey]))]);

  /** @param {(typeof o.peers)[number]} peer */
  async function viewOf(peer) {
    const res = await doFetch(`${peer.url}/receipt-check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedRequest(o.self, peer.id, o.now())), signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`peer answered ${res.status}`);
    const view = /** @type {any} */ (await res.json());
    if (view?.agentId !== peer.id || !Array.isArray(view.events) || typeof view.exportedAt !== 'string') throw new TypeError('peer answered something else');
    return view;
  }

  return async (agents, opts = {}) => {
    const me = agents[0];
    /** @type {import('../ledger/integrity.js').Failure[]} */
    const failures = [];
    let [receipts, signaturesChecked, ledgers] = [0, 0, 1];
    try {
      const chain = me.ledger.verifyChain();
      if (!chain.ok) failures.push(chainFailure(me, chain.brokenAt));
    } catch (e) { opts.onError?.(me.name, e); }
    await nextTurn();
    for (const peer of o.peers) {
      try {
        const exportedAt = new Date(o.now()).toISOString();
        const mine = { id: me.id, events: allEvents(me.ledger), exportedAt };
        const view = await viewOf(peer);
        const r = crossCheck(mine, { id: peer.id, events: view.events, exportedAt: view.exportedAt }, { verify: (e) => {
          const key = keyOf.get(e.body?.from);
          return key ? verifyMessage(e.body, key) : null;
        } });
        ledgers += 1;
        receipts += r.receipts;
        signaturesChecked += r.signaturesChecked;
        for (const m of r.mismatches) failures.push(receiptFailure(m, nameOf));
      } catch (e) {
        opts.onError?.(peer.name, e);
        o.onPeerMissed?.();
      }
      await nextTurn();
    }
    return { failures, receipts, signaturesChecked, ledgers };
  };
}
