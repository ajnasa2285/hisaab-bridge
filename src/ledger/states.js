// Order states (docs/CONTRACTS.md section 5), pure. A state is never stored: it is derived from
// the order's events in sequence, so the history is the only truth. A message that does not fit
// the current state is refused with WRONG_STATE before anything is written.

/** @typedef {'none'|'requested'|'offered'|'declined'|'booked'|'working'|'delivered'|'billed'|'disputed'|'accepted'|'payment_claimed'|'settled'} OrderState */

/**
 * What an order looks like after its events: the state, plus the ids later messages must refer to.
 * @typedef {object} OrderView
 * @property {OrderState} state
 * @property {'jcb_hours'|'material'|null} kind
 * @property {string|null} currentBill   msg_id of the bill or correction in force
 * @property {number} billRev            how many bills/corrections so far
 * @property {string|null} payment       msg_id of the latest payment claim
 */

/** @typedef {{type: string, msg_id: string|null, body: Record<string, any>}} StepEvent */

/** @returns {OrderView} */
export function emptyView() {
  return { state: 'none', kind: null, currentBill: null, billRev: 0, payment: null };
}

/**
 * Applies one event to the view. Returns null when the event does not fit (the caller refuses it).
 * Local events (EVIDENCE, NOTE), RECEIPT/REFUSE and SITE_RECEIPT never change the state.
 * @param {OrderView} v
 * @param {StepEvent} e
 * @returns {OrderView|null}
 */
export function step(v, e) {
  const b = e.body ?? {};
  switch (e.type) {
    case 'BOOKING_REQUEST':
      if (v.state !== 'none' && v.state !== 'offered') return null;
      return { ...v, state: 'requested', kind: b.kind };
    case 'BOOKING_REPLY':
      if (v.state !== 'requested') return null;
      // A material "yes" carries the rates the bill will be built from; a JCB "yes" never does.
      if (b.answer === 'yes' && (v.kind === 'material') !== Array.isArray(b.rates)) return null;
      if (b.answer === 'yes') return { ...v, state: 'booked' };
      if (b.answer === 'no') return { ...v, state: 'declined' };
      return { ...v, state: 'offered' };
    case 'EVIDENCE':
      // The JCB side records meter photos locally; the first one means work has started.
      if (v.state === 'booked' && v.kind === 'jcb_hours') return { ...v, state: 'working' };
      return v.state === 'none' || v.state === 'declined' || v.state === 'settled' ? null : v;
    case 'DELIVERY':
      if (v.state !== 'booked' || v.kind !== 'material') return null;
      return { ...v, state: 'delivered' };
    case 'BILL': {
      // A JCB bill must carry its meter evidence, so both ledgers can check it: the buyer's ledger
      // never sees the seller's local photos. A material bill follows the signed DELIVERY.
      const hasMeterEvidence = Array.isArray(b.evidence) && b.evidence.some((/** @type {any} */ x) => x && x.kind === 'meter');
      const ready = v.kind === 'jcb_hours'
        ? (v.state === 'booked' || v.state === 'working') && hasMeterEvidence
        : v.state === 'delivered';
      if (!ready || e.msg_id === null) return null;
      return { ...v, state: 'billed', currentBill: e.msg_id, billRev: v.billRev + 1 };
    }
    case 'CORRECTION':
      if ((v.state !== 'billed' && v.state !== 'disputed') || b.replaces !== v.currentBill || e.msg_id === null) return null;
      return { ...v, state: 'billed', currentBill: e.msg_id, billRev: v.billRev + 1 };
    case 'ACCEPT':
      if ((v.state !== 'billed' && v.state !== 'disputed') || b.bill !== v.currentBill) return null;
      return { ...v, state: 'accepted' };
    case 'DISPUTE':
      if (v.state !== 'billed' || b.bill !== v.currentBill) return null;
      return { ...v, state: 'disputed' };
    case 'PAYMENT_CLAIM':
      // A second claim (a corrected screenshot) replaces the first while unsettled.
      if ((v.state !== 'accepted' && v.state !== 'payment_claimed') || b.bill !== v.currentBill || e.msg_id === null) return null;
      return { ...v, state: 'payment_claimed', payment: e.msg_id };
    case 'SETTLED':
      if (v.state !== 'payment_claimed' || b.bill !== v.currentBill || b.payment !== v.payment) return null;
      return { ...v, state: 'settled' };
    case 'SITE_RECEIPT':
      // The site's signed copy follows a delivery and never changes the state.
      return v.kind === 'material' && !['none', 'requested', 'offered', 'declined', 'booked'].includes(v.state) ? v : null;
    case 'RECEIPT':
    case 'REFUSE':
    case 'NOTE':
      return v;
    default:
      return null;
  }
}

/**
 * @param {StepEvent[]} events in sequence
 * @returns {OrderView} the view after every event that fits (events that did not fit were never stored)
 */
export function replay(events) {
  let v = emptyView();
  for (const e of events) {
    const next = step(v, e);
    if (next === null) throw new Error(`ledger history does not fit the states at ${e.type}`);
    v = next;
  }
  return v;
}
