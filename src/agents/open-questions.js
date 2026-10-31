// What is waiting for a person's answer, from the ledger: it survives a restart and the 30 minutes an
// open question lasts in the conversation. One table of who is asked what, in which state, and which
// steps answer it; a free-text reply is read against the latest (src/orchestrator/orchestrator.js
// answerOpen). Nothing here decides or writes.

import { orderRefs } from '../orchestrator/orchestrator.js';
import { qty, rupees, tenths } from '../i18n/format.js';
import { ofType } from './common.js';
import { delivery, itemsText, requestedItems, siteCount } from './material.js';

/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** The steps that answer it, and what was asked, for the model only.
 * @typedef {{ref: string, orderId: string, tools: string[], seq: number, about: string}} OpenQuestion */

/**
 * The questions open for this role, oldest first by the message that asked each.
 * @param {Ledger} ledger @param {string} role @returns {OpenQuestion[]}
 */
export function openQuestions(ledger, role) {
  /** @type {OpenQuestion[]} */
  const out = [];
  const seller = role === 'jcb_owner' || role === 'supplier';
  if (!seller && role !== 'contractor' && role !== 'supervisor') return out;
  for (const r of orderRefs(ledger)) {
    const events = ledger.events(r.orderId);
    const view = ledger.view(r.orderId);
    const where = `${r.ref} at site ${r.site}`;
    /** @param {string[]} tools @param {string | null | undefined} msgId @param {string} about */
    const add = (tools, msgId, about) => out.push({ ref: r.ref, orderId: r.orderId, tools, seq: (msgId ? ledger.eventOfMessage(msgId)?.seq : 0) ?? 0, about });
    /** @param {string} type */
    const lastIn = (type) => ofType(events, type, 'in').at(-1)?.msgId;
    const items = (/** @type {any[]} */ list) => (list.length ? itemsText(list) : 'JCB');
    if (role === 'contractor' && view.state === 'billed') {
      const bill = view.currentBill ? ledger.eventOfMessage(view.currentBill)?.body.body : null;
      const units = delivery(events)?.items ?? [];
      const lines = (bill?.lines ?? []).map((/** @type {any} */ l, /** @type {number} */ i) => (l.hoursTenths !== undefined ? `JCB ${tenths(l.hoursTenths)} hours` : `"${l.what}" ${qty(l.qtyHundredths, units[i]?.unit ?? '')}`.trim()));
      add(['accept_bill', 'dispute_bill'], view.currentBill, `The bill of ${where}: ${lines.join(', ')}, total ${rupees(view.billTotalPaise ?? 0)}. They were asked to accept it, or to object with their own figure and reason. Item names of this bill with quantities and no site or day are their own figures: an objection (their_items), not a new request.`);
    }
    if (role === 'supervisor' && view.state === 'delivered' && siteCount(events) === null) {
      add(['confirm_count'], lastIn('DELIVERY'), `The delivery of ${where}: ${items(delivery(events)?.items ?? [])}. They were asked to count what came, one figure per item in this order.`);
    }
    if (seller && view.state === 'requested') {
      add([role === 'supplier' ? 'reply_order' : 'reply_booking'], lastIn('BOOKING_REQUEST'), `A request for ${where}, day ${r.day}: ${items(requestedItems(events))}. They were asked to say yes with the rate, no, or another day.`);
    }
    if (seller && view.state === 'disputed') {
      add(['send_correction'], lastIn('DISPUTE'), `The contractor objected to the bill of ${where}. They may send a corrected bill.`);
    }
    if (seller && view.pending.length) {
      add(['confirm_payment'], view.pending.at(-1), `The contractor reported a payment on ${where}. They were asked whether the money has arrived; use confirm_payment only when they say it has.`);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}
