// Display-only order replay for the judge page, including CONTRACTS 4.1 payments.
import { paymentSummary } from '../src/ledger/payments.js';
/** @typedef {import('../src/ledger/store.js').LedgerEvent} Ev */
/** @param {Ev[]} events */
export function stateOf(events) {
  const refused = new Set(events.filter((e) => e.direction === 'in' && e.type === 'REFUSE').map((e) => e.body.body?.refers_to));
  for (const e of events) if (e.direction === 'local' && e.type === 'NOTE' && e.body?.kind === 'undelivered') refused.add(e.body.msg_id);
  let state = 'none';
  /** @type {string|null} */
  let kind = null;
  /** @type {string|null} */
  let currentBill = null;
  /** @type {string|null} */
  let payment = null;
  let billRev = 0;
  let fits = true;
  /** @type {Ev[]} */
  const counted = [];
  for (const e of events) {
    if (e.direction === 'out' && refused.has(e.msgId)) continue;
    counted.push(e);
    const b = e.direction === 'local' ? e.body ?? {} : e.body.body ?? {};
    switch (e.type) {
      case 'BOOKING_REQUEST':
        if (state !== 'none' && state !== 'offered') fits = false;
        state = 'requested'; kind = b.kind ?? null; break;
      case 'BOOKING_REPLY':
        if (state !== 'requested') fits = false;
        if (b.answer === 'yes' && (kind === 'material') !== Array.isArray(b.rates)) fits = false;
        state = b.answer === 'yes' ? 'booked' : b.answer === 'no' ? 'declined' : 'offered'; break;
      case 'EVIDENCE':
        if (Array.isArray(b.items)) {
          if (state === 'none') fits = false;
          break; // Signed photo exchanges are informational, including after settlement.
        }
        if (state === 'booked' && kind === 'jcb_hours') state = 'working';
        else if (state === 'none' || state === 'declined' || state === 'settled' || state === 'cancelled') fits = false;
        break;
      case 'DELIVERY':
        if (state !== 'booked' || kind !== 'material') fits = false;
        state = 'delivered'; break;
      case 'BILL': {
        const meter = Array.isArray(b.evidence) && b.evidence.some((/** @type {any} */ x) => x && x.kind === 'meter');
        const ready = kind === 'jcb_hours' ? (state === 'booked' || state === 'working') && meter : state === 'delivered';
        if (!ready) fits = false;
        state = 'billed'; currentBill = e.msgId; billRev += 1; break;
      }
      case 'CORRECTION':
        if ((state !== 'billed' && state !== 'disputed') || b.replaces !== currentBill) fits = false;
        state = 'billed'; currentBill = e.msgId; billRev += 1; break;
      case 'ACCEPT':
        if ((state !== 'billed' && state !== 'disputed') || b.bill !== currentBill) fits = false;
        state = 'accepted'; break;
      case 'DISPUTE':
        if (state !== 'billed' || b.bill !== currentBill) fits = false;
        state = 'disputed'; break;
      case 'PAYMENT_CLAIM':
      case 'PAYMENT_RECEIVED':
        if (['none', 'requested', 'offered', 'declined', 'settled', 'cancelled'].includes(state) || b.bill !== currentBill) fits = false;
        payment = e.msgId; break;
      case 'PAYMENT_ACK':
        if (!paymentSummary(counted.slice(0, -1)).pending.includes(b.payment)) fits = false;
        break;
      case 'SETTLED': {
        const s = paymentSummary(counted);
        if (!['accepted', 'part_paid', 'payment_claimed'].includes(state) || b.bill !== currentBill
          || s.duePaise !== 0 || s.waitingPaise !== 0) fits = false;
        if (!Array.isArray(b.payments) && b.payment !== payment) fits = false;
        state = 'settled'; break;
      }
      case 'CANCEL':
        if (state !== 'cancelled' && (!['requested', 'offered', 'booked'].includes(state)
          || paymentSummary(counted.slice(0, -1)).payments.some((p) => p.status !== 'denied'))) fits = false;
        state = 'cancelled'; break;
      case 'RECEIPT': case 'REFUSE': break;
      case 'SITE_RECEIPT':
        if (kind !== 'material' || ['none', 'requested', 'offered', 'declined', 'booked', 'cancelled'].includes(state)) fits = false;
        break;
      case 'EVIDENCE_REQUEST':
        if (state === 'none') fits = false;
        break;
      case 'NOTE': break; // the site's own count stays local and never moves the state
      default: fits = false;
    }
    if (['accepted', 'part_paid', 'payment_claimed'].includes(state)) {
      const s = paymentSummary(counted);
      state = s.pending.length ? 'payment_claimed' : s.confirmedPaise > 0 && s.duePaise !== null && s.duePaise > 0 ? 'part_paid' : 'accepted';
    }
  }
  return { state, kind, currentBill, billRev, fits };
}

