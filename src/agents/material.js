// What both sides of a material order share: the rounding rule for a bill line, building the bill
// from the signed DELIVERY and the agreed rates, checking a bill against them, mapping what a challan
// reader saw onto the order's items, and how items, rates and lines are shown. The supplier's code
// builds a bill with these; the contractor's code checks the bill it receives with the same ones.

import { qty, rupees } from '../i18n/format.js';
import { ofType, posInt } from './common.js';

/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {{name: string, qtyHundredths: number, unit: string}} Item */
/** @typedef {{name: string, unit: string, ratePaise: number}} Rate */
/** @typedef {{what: string, qtyHundredths: number, ratePaise: number, amountPaise: number}} Line */

/**
 * One bill line's amount: quantity (hundredths of a unit) × rate (paise per unit) / 100, rounded to
 * the nearest paisa, half a paisa up (2.5 × ₹333.33 = ₹833.325 → ₹833.33). Integers only on the
 * way; a product beyond the safe integers is refused (null) rather than rounded by floating point.
 * @param {number} qtyHundredths
 * @param {number} ratePaise
 * @returns {number | null}
 */
export function lineAmountPaise(qtyHundredths, ratePaise) {
  if (!posInt(qtyHundredths) || !posInt(ratePaise)) return null;
  const product = qtyHundredths * ratePaise;
  if (!Number.isSafeInteger(product + 50)) return null;
  return Math.floor((product + 50) / 100);
}

/** @param {string} s */
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The agreed rate for an item: same name and unit as in the "yes".
 * @param {Rate[]} rates
 * @param {{name: string, unit: string}} item
 */
export function rateFor(rates, item) {
  return rates.find((r) => r.name === item.name && r.unit === item.unit)?.ratePaise ?? null;
}

/**
 * Bill lines for these quantities at the agreed rates, in the items' order; null when an item has no
 * agreed rate or an amount cannot be computed.
 * @param {Item[]} items
 * @param {Rate[]} rates
 * @returns {Line[] | null}
 */
export function billLines(items, rates) {
  /** @type {Line[]} */
  const lines = [];
  for (const it of items) {
    const ratePaise = rateFor(rates, it);
    const amountPaise = ratePaise === null ? null : lineAmountPaise(it.qtyHundredths, ratePaise);
    if (ratePaise === null || amountPaise === null) return null;
    lines.push({ what: it.name, qtyHundredths: it.qtyHundredths, ratePaise, amountPaise });
  }
  return lines;
}

/**
 * A material bill body: lines = quantities × agreed rates, the challan as evidence.
 * @param {Item[]} items
 * @param {Rate[]} rates
 * @param {{sha256: string, number: string | null, sentAt: string}} challan
 */
export function materialBillBody(items, rates, challan) {
  const lines = billLines(items, rates);
  if (lines === null) return null;
  return {
    lines,
    totalPaise: lines.reduce((s, l) => s + l.amountPaise, 0),
    evidence: [{ sha256: challan.sha256, kind: 'challan', readValue: challan.number, takenAt: null, sentAt: challan.sentAt }],
  };
}

/**
 * Does a received bill follow from the delivery and the agreed rates? Every line is the delivered item
 * in the same place, at its agreed rate, with the amount by the rounding rule. A first bill must also
 * carry the delivered quantities; a correction may change quantities (towards the site's count) only.
 * @param {{lines: any[], totalPaise: number}} body
 * @param {Item[]} delivered
 * @param {Rate[]} rates
 * @param {{sameQty: boolean}} o
 */
export function billFollows(body, delivered, rates, o) {
  if (!Array.isArray(body.lines) || body.lines.length !== delivered.length) return false;
  return body.lines.every((l, i) => {
    const it = delivered[i];
    const ratePaise = rateFor(rates, it);
    return l.what === it.name && posInt(l.qtyHundredths) && l.ratePaise === ratePaise
      && l.amountPaise === lineAmountPaise(l.qtyHundredths, /** @type {number} */ (ratePaise))
      && (!o.sameQty || l.qtyHundredths === it.qtyHundredths);
  });
}

/** The items asked for in the order's request. @param {LedgerEvent[]} events @returns {Item[]} */
export function requestedItems(events) {
  return ofType(events, 'BOOKING_REQUEST').at(-1)?.body.body.items ?? [];
}

/** The rates of the "yes" the order was booked on, or null. @param {LedgerEvent[]} events @returns {Rate[] | null} */
export function agreedRates(events) {
  const yes = ofType(events, 'BOOKING_REPLY').filter((e) => e.body.body.answer === 'yes').at(-1);
  return yes && Array.isArray(yes.body.body.rates) ? yes.body.body.rates : null;
}

/**
 * The signed delivery of the order, or null.
 * @param {LedgerEvent[]} events
 * @returns {{items: Item[], sha256: string, number: string | null, at: string, msgId: string} | null}
 */
export function delivery(events) {
  const d = ofType(events, 'DELIVERY').at(-1);
  if (!d) return null;
  const b = d.body.body;
  return { items: b.items, sha256: b.challan.sha256, number: b.challan.number ?? null, at: d.body.created_at, msgId: /** @type {string} */ (d.msgId) };
}

/** The site's own count in force (the latest), or null. @param {LedgerEvent[]} events @returns {Item[] | null} */
export function siteCount(events) {
  const n = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
  return n ? n.body.items : null;
}

/** Same items with the same quantities, in the same order. @param {Item[]} a @param {Item[]} b */
export function sameItems(a, b) {
  return a.length === b.length && a.every((x, i) => x.name === b[i].name && x.unit === b[i].unit && x.qtyHundredths === b[i].qtyHundredths);
}

/**
 * The quantity a challan shows for each of the order's items (null where unclear or not found):
 * matched by name, or by position when the challan lists exactly as many items as the order.
 * The person always sees the result read back before anything is sent.
 * @param {{name: string, unit: string}[]} orderItems
 * @param {{name: string, qtyHundredths: number | null}[]} seen
 * @returns {(number | null)[]}
 */
export function challanQuantities(orderItems, seen) {
  return orderItems.map((it, i) => {
    const byName = seen.find((s) => typeof s.name === 'string' && norm(s.name) === norm(it.name));
    const s = byName ?? (seen.length === orderItems.length ? seen[i] : undefined);
    return s && posInt(s.qtyHundredths) ? s.qtyHundredths : null;
  });
}

/** "सीमेंट 50 बोरी, रेत 2 ट्रॉली" @param {Item[]} items */
export function itemsText(items) {
  return items.map((i) => `${i.name} ${qty(i.qtyHundredths, i.unit)}`).join(', ');
}

/** "सीमेंट ₹350/बोरी, रेत ₹4,000/ट्रॉली" @param {Rate[]} rates */
export function ratesText(rates) {
  return rates.map((r) => `${r.name} ${rupees(r.ratePaise)}/${r.unit}`).join(', ');
}

/**
 * "सीमेंट 50 बोरी × ₹350 = ₹17,500" per line; the unit comes from the delivered item in the same place.
 * @param {{what: string, qtyHundredths?: number, ratePaise: number, amountPaise: number}[]} lines
 * @param {{unit: string}[]} units
 */
export function linesText(lines, units) {
  return lines.map((l, i) => `${l.what} ${posInt(l.qtyHundredths) ? qty(l.qtyHundredths, units[i]?.unit ?? '').trim() : '—'} × ${rupees(l.ratePaise)} = ${rupees(l.amountPaise)}`).join(', ');
}

/**
 * Items as a person confirmed them: 1 to 20, each a short name, a positive quantity and a unit.
 * @param {unknown} items
 * @returns {items is Item[]}
 */
export function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.length <= 20 && items.every((it) => it && typeof it === 'object'
    && typeof it.name === 'string' && it.name.trim().length > 0 && it.name.length <= 80
    && posInt(it.qtyHundredths) && typeof it.unit === 'string' && it.unit.trim().length > 0 && it.unit.length <= 20);
}
