// Comparing two agents' ledgers through the receipts they hold. A ledger's hash chain has no secret:
// whoever can write its file can change a row and recompute every later hash, and the chain still
// verifies. But each message delivered brings back the receiver's signed RECEIPT, kept in the
// SENDER's ledger, naming two hashes of the RECEIVER's chain. So a rewrite of the receiver's chain
// shows on the other side.
//
// What a healthy receipt says (receive and receiptFor in src/protocol/exchange.js):
//   entry_hash  the row where the receiver wrote the message: direction 'in', the same msg_id, order
//               and sender. The row of a repeated message is the first one, written once.
//   chain_head  the receiver's newest hash when the receipt was built, which is after that row was
//               written: the row itself the first time, a later row when a repeat is answered. So it
//               is never older than the entry, and a repeat's second receipt names a later head.
// A receipt is an 'in' row of the sender's ledger only: the receiver never stores the receipts it signs.
// A message that was refused or expired undelivered has a REFUSE or a local note and no receipt, the
// other side wrote nothing, and there is nothing to compare. An evidence request can have both: its
// receipt says it was written, and the owner's refusal comes later, so the receipt still counts.
//
// Pure, and no imports: the judge page runs this file in the browser (web/judge.js), the server too
// (src/ledger/integrity.js). Whether a receipt's signature is genuine is left to the caller's `verify`,
// because Node and the browser check signatures differently.

/**
 * The fields read here, as src/ledger/store.js stores them and the export carries them.
 * @typedef {{seq: number, orderId: string, direction: string, type: string, msgId: string|null, body: any, at: string, hash: string}} ChainEvent
 */
/**
 * One agent's ledger. `exportedAt` only when the two sides were read at different moments (the page's
 * live export): a receipt that came after the peer's copy was made cannot be judged from that copy.
 * @typedef {{id: string, events: ChainEvent[], exportedAt?: string}} Side
 */
/**
 * entry_missing      entry_hash is no hash in the peer's chain
 * wrong_entry        it is, but of a row that is not the record of this message
 * head_missing       chain_head is no hash in the peer's chain
 * head_before_entry  chain_head is older than the entry it should follow
 * bad_signature      the receipt row is not what the peer signed (only with `verify`)
 * @typedef {'entry_missing'|'wrong_entry'|'head_missing'|'head_before_entry'|'bad_signature'} Problem
 */
/** @typedef {{holder: string, peer: string, seq: number, orderId: string, kind: Problem}} Mismatch */
/**
 * receipts: compared. signaturesChecked: of those, how many `verify` could check. notYet: too new for
 * the peer's copy, not compared.
 * @typedef {{receipts: number, signaturesChecked: number, notYet: number, mismatches: Mismatch[]}} CrossCheck
 */

/**
 * The receipts `holder` keeps from `peer` against `peer`'s chain, one direction.
 * @param {Side} holder @param {Side} peer
 * @param {(receipt: ChainEvent) => boolean | null} [verify] is this receipt row signed by its sender? null: cannot tell
 * @returns {CrossCheck}
 */
export function checkReceipts(holder, peer, verify) {
  const byHash = new Map(peer.events.map((e) => [e.hash, e]));
  const asOf = peer.exportedAt === undefined ? NaN : Date.parse(peer.exportedAt);
  /** @type {CrossCheck} */
  const out = { receipts: 0, signaturesChecked: 0, notYet: 0, mismatches: [] };
  for (const e of holder.events) {
    if (e.direction !== 'in' || e.type !== 'RECEIPT' || e.body?.from !== peer.id) continue;
    if (Date.parse(e.at) >= asOf) { out.notYet += 1; continue; }
    out.receipts += 1;
    /** @param {Problem} kind */
    const problem = (kind) => { out.mismatches.push({ holder: holder.id, peer: peer.id, seq: e.seq, orderId: e.orderId, kind }); };
    const signed = verify ? verify(e) : null;
    if (signed !== null) out.signaturesChecked += 1;
    if (signed === false) problem('bad_signature');
    const b = e.body.body ?? {};
    const entry = byHash.get(b.entry_hash);
    const head = byHash.get(b.chain_head);
    if (!entry) problem('entry_missing');
    else if (entry.msgId !== b.receipt_for || entry.direction !== 'in' || entry.orderId !== e.orderId || entry.body?.from !== holder.id) problem('wrong_entry');
    if (!head) problem('head_missing');
    else if (entry && head.seq < entry.seq) problem('head_before_entry');
  }
  return out;
}

/**
 * Both directions between two connected agents.
 * @param {Side} a @param {Side} b
 * @param {{verify?: (receipt: ChainEvent) => boolean | null}} [o]
 * @returns {CrossCheck}
 */
export function crossCheck(a, b, o = {}) {
  const [x, y] = [checkReceipts(a, b, o.verify), checkReceipts(b, a, o.verify)];
  return { receipts: x.receipts + y.receipts, signaturesChecked: x.signaturesChecked + y.signaturesChecked, notYet: x.notYet + y.notYet, mismatches: [...x.mismatches, ...y.mismatches] };
}
