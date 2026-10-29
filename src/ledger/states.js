// Order states (docs/CONTRACTS.md section 5), pure. A state is never stored: it is derived from
// the order's events in sequence, so the history is the only truth. A message that does not fit
// the current state is refused with WRONG_STATE before anything is written.

/** @typedef {'none'|'requested'|'offered'|'declined'|'booked'|'working'|'delivered'|'billed'|'disputed'|'accepted'|'payment_claimed'|'part_paid'|'settled'} OrderState */

/**
 * What an order looks like after its events: the state, plus the ids later messages must refer to.
 * Payments (CONTRACTS 4.1) are kept with the balance code works out; `paid` is every payment by
 * msg_id, which an answer or a settlement must match.
 * @typedef {object} OrderView
 * @property {OrderState} state
 * @property {'jcb_hours'|'material'|null} kind
 * @property {string|null} currentBill   msg_id of the bill or correction in force
 * @property {number} billRev            how many bills/corrections so far
 * @property {string|null} payment       msg_id of the latest payment claim
 * @property {number|null} billTotalPaise the total of the bill in force (null before a bill)
 * @property {number} confirmedPaise     claims the seller confirmed + money he recorded himself
 * @property {string[]} pending          claims not answered yet, in order
 * @property {Record<string, {amountPaise: number, status: 'waiting'|'confirmed'|'denied'}>} paid
 */

/** @typedef {{type: string, msg_id: string|null, body: Record<string, any>}} StepEvent */

/** @returns {OrderView} */
export function emptyView() {
  return { state: 'none', kind: null, currentBill: null, billRev: 0, payment: null, billTotalPaise: null, confirmedPaise: 0, pending: [], paid: {} };
}

// A payment fits from the booking on and until the order is settled.
const PAYABLE = ['booked', 'working', 'delivered', 'billed', 'disputed', 'accepted', 'payment_claimed', 'part_paid'];
// After ACCEPT the state follows the payments; before it, payments never move it.
const AFTER_ACCEPT = ['accepted', 'payment_claimed', 'part_paid'];

/**
 * The view with one payment's status set, the balance worked out again and, once the bill is
 * accepted, the state that follows: a claim waiting → payment_claimed; else anything confirmed →
 * part_paid (also when it covers the bill: SETTLED is the seller's own message); else accepted.
 * @param {OrderView} v @param {Record<string, {amountPaise: number, status: 'waiting'|'confirmed'|'denied'}>} paid
 * @returns {OrderView}
 */
function withPayments(v, paid) {
  const all = Object.entries(paid);
  const pending = all.filter(([, p]) => p.status === 'waiting').map(([id]) => id);
  const confirmedPaise = all.filter(([, p]) => p.status === 'confirmed').reduce((a, [, p]) => a + p.amountPaise, 0);
  /** @type {OrderState} */
  let state = v.state;
  if (AFTER_ACCEPT.includes(v.state)) state = pending.length ? 'payment_claimed' : confirmedPaise > 0 ? 'part_paid' : 'accepted';
  return { ...v, state, paid, pending, confirmedPaise };
}

/** A claim or a seller's record must name the bill in force; before any bill it is an advance. @param {OrderView} v @param {any} bill */
const namesBill = (v, bill) => (v.currentBill === null ? bill === null : bill === v.currentBill);

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
      // Signed photo exchanges carry items; they are informational even after settlement.
      if (Array.isArray(b.items)) return v.state === 'none' ? null : v;
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
      return { ...v, state: 'billed', currentBill: e.msg_id, billRev: v.billRev + 1, billTotalPaise: b.totalPaise ?? null };
    }
    case 'CORRECTION':
      // A correction changes what is billed, never the payments.
      if ((v.state !== 'billed' && v.state !== 'disputed') || b.replaces !== v.currentBill || e.msg_id === null) return null;
      return { ...v, state: 'billed', currentBill: e.msg_id, billRev: v.billRev + 1, billTotalPaise: b.totalPaise ?? null };
    case 'ACCEPT':
      if ((v.state !== 'billed' && v.state !== 'disputed') || b.bill !== v.currentBill) return null;
      // Advances already paid count at once.
      return withPayments({ ...v, state: 'accepted' }, v.paid);
    case 'DISPUTE':
      if (v.state !== 'billed' || b.bill !== v.currentBill) return null;
      return { ...v, state: 'disputed' };
    case 'PAYMENT_CLAIM':
    case 'PAYMENT_RECEIVED': {
      // Any amount, several per order, from the booking on; an advance before any bill.
      if (!PAYABLE.includes(v.state) || e.msg_id === null || Object.hasOwn(v.paid, e.msg_id) || !namesBill(v, b.bill ?? null)) return null;
      const status = e.type === 'PAYMENT_RECEIVED' ? 'confirmed' : 'waiting';
      const next = withPayments(v, { ...v.paid, [e.msg_id]: { amountPaise: b.amountPaise, status } });
      return e.type === 'PAYMENT_CLAIM' ? { ...next, payment: e.msg_id } : next;
    }
    case 'PAYMENT_ACK': {
      // The seller's own answer to one claim, once, for the claim's own amount.
      const p = Object.hasOwn(v.paid, b.payment) ? v.paid[b.payment] : undefined;
      if (!PAYABLE.includes(v.state) || !p || p.status !== 'waiting' || !v.pending.includes(b.payment) || p.amountPaise !== b.amountPaise) return null;
      return withPayments(v, { ...v.paid, [b.payment]: { ...p, status: b.received === true ? 'confirmed' : 'denied' } });
    }
    case 'SETTLED': {
      if (b.payments === undefined) {
        // The old form: the seller's one "yes" to the latest claim (ledgers from before 30 Oct).
        if (v.state !== 'payment_claimed' || b.bill !== v.currentBill || b.payment !== v.payment) return null;
        const p = v.paid[b.payment];
        return { ...withPayments(v, { ...v.paid, [b.payment]: { ...p, status: 'confirmed' } }), state: 'settled' };
      }
      // The new form: accepted, nothing waiting, everything confirmed counted and covering the bill.
      const confirmed = Object.entries(v.paid).filter(([, p]) => p.status === 'confirmed').map(([id]) => id);
      if ((v.state !== 'accepted' && v.state !== 'part_paid') || v.pending.length || b.bill !== v.currentBill
        || v.billTotalPaise === null || v.confirmedPaise < v.billTotalPaise || b.amountPaise !== v.confirmedPaise
        || b.payments.length !== confirmed.length || !b.payments.every((/** @type {string} */ id) => confirmed.includes(id))) return null;
      return { ...v, state: 'settled' };
    }
    case 'SITE_RECEIPT':
      // The site's signed copy follows a delivery and never changes the state.
      return v.kind === 'material' && !['none', 'requested', 'offered', 'declined', 'booked'].includes(v.state) ? v : null;
    case 'EVIDENCE_REQUEST':
      return v.state === 'none' ? null : v;
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
