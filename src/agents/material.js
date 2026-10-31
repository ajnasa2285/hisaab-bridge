// What both sides of a material order share: the rounding rule for a bill line, building the bill
// from the signed DELIVERY and the agreed rates, checking a bill against them, mapping what a challan
// reader saw onto the order's items, and how items, rates and lines are shown. The supplier's code
// builds a bill with these; the contractor's code checks the bill it receives with the same ones.

import { qty, rupees } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { nonNegInt, ofType, posInt } from './common.js';
import { refusedIds } from '../ledger/states.js';
import { MAX_UNIT, safeName } from '../protocol/names.js';
import { parseQuantity } from '../orchestrator/units.js';
import { canonicalUnit } from '../readers/challan.js';

/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {{name: string, qtyHundredths: number, unit: string, gstPercent?: number}} Item */
/** @typedef {{name: string, unit: string, ratePaise: number, gstPercent?: number}} Rate */
/**
 * A bill line. Without GST `amountPaise` is quantity × rate. With GST known it also carries
 * `taxablePaise` (quantity × rate), `gstPercent` and `gstPaise`, and `amountPaise` is taxable + GST, so
 * a bill's `totalPaise` (the sum of the amounts) is always what is to be paid.
 * @typedef {{what: string, qtyHundredths: number, ratePaise: number, amountPaise: number,
 *   taxablePaise?: number, gstPercent?: number, gstPaise?: number}} Line
 */

/** The GST rates a rate or an invoice line may carry, in whole percent (the slabs, and 0 for exempt). */
export const GST_PERCENTS = Object.freeze([0, 5, 12, 18, 28, 40]);
/** @param {unknown} n @returns {n is number} */
export const isGstPercent = (n) => typeof n === 'number' && GST_PERCENTS.includes(n);

/**
 * GST on a taxable value, the way a tax invoice prints it: CGST and SGST are each half the rate, each
 * half rounded to the nearest paisa (half a paisa up), and GST is the two halves together
 * (₹19,000 at 28% → 2 × ₹2,660 = ₹5,320). Integers only; null beyond the safe integers.
 * @param {number} taxablePaise
 * @param {number} gstPercent
 * @returns {number | null}
 */
export function gstPaise(taxablePaise, gstPercent) {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0 || !isGstPercent(gstPercent)) return null;
  const product = taxablePaise * gstPercent;
  if (!Number.isSafeInteger(product + 100)) return null;
  return 2 * Math.floor((product + 100) / 200);
}

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
 * The GST rate of an item: the one the supplier wrote in their "yes", else the one read from the tax
 * invoice and carried on the delivered item (`delivered`, by name and unit, for a count that is not
 * the delivery itself), else null (no GST known).
 * @param {Rate[]} rates
 * @param {{name: string, unit: string, gstPercent?: number}} item
 * @param {Item[]} [delivered]
 * @returns {number | null}
 */
export function gstFor(rates, item, delivered = []) {
  const fromYes = rates.find((r) => r.name === item.name && r.unit === item.unit)?.gstPercent;
  if (isGstPercent(fromYes)) return fromYes;
  if (isGstPercent(item.gstPercent)) return item.gstPercent;
  const fromInvoice = delivered.find((d) => d.name === item.name && d.unit === item.unit)?.gstPercent;
  return isGstPercent(fromInvoice) ? fromInvoice : null;
}

/**
 * One bill line for an item at its agreed rate, with GST when its rate is known; null when the item
 * has no agreed rate or an amount cannot be computed. A correction may put an item at 0 (it never came):
 * the line stays, in its place, and comes to nothing.
 * @param {{name: string, qtyHundredths: number, unit: string, gstPercent?: number}} it
 * @param {Rate[]} rates
 * @param {Item[]} [delivered]
 * @returns {Line | null}
 */
export function billLine(it, rates, delivered) {
  const ratePaise = rateFor(rates, it);
  const taxablePaise = ratePaise === null ? null : it.qtyHundredths === 0 ? 0 : lineAmountPaise(it.qtyHundredths, ratePaise);
  if (ratePaise === null || taxablePaise === null) return null;
  const gstPercent = gstFor(rates, it, delivered);
  if (gstPercent === null) return { what: it.name, qtyHundredths: it.qtyHundredths, ratePaise, amountPaise: taxablePaise };
  const gst = /** @type {number} */ (gstPaise(taxablePaise, gstPercent));
  if (!Number.isSafeInteger(taxablePaise + gst)) return null;
  return { what: it.name, qtyHundredths: it.qtyHundredths, ratePaise, taxablePaise, gstPercent, gstPaise: gst, amountPaise: taxablePaise + gst };
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
    const line = billLine(it, rates);
    if (line === null) return null;
    lines.push(line);
  }
  return lines;
}

/**
 * What an item list comes to at the agreed rates with GST (an item at 0 adds nothing; an item without
 * an agreed rate adds nothing, as the site's count may list items the order did not have).
 * @param {Item[]} items @param {Rate[]} rates @param {Item[]} [delivered]
 */
export function itemsTotalPaise(items, rates, delivered) {
  return items.reduce((s, it) => s + (it.qtyHundredths === 0 ? 0 : billLine(it, rates, delivered)?.amountPaise ?? 0), 0);
}

/**
 * A person's figures for some items of a bill: each said item takes the figure, the others keep what is
 * billed, and code works out the total at the agreed rates and GST. Null when a figure cannot be tied to
 * one item: a name not on the bill, an item twice, no figure, or a figure not in the person's own words.
 * @param {{what: string, qtyHundredths: number}[]} lines the bill in force
 * @param {Item[]} delivered in the bill's order @param {Rate[]} rates
 * @param {{item: unknown, quantity: unknown}[]} said as the model copied them @param {string} text the person's message
 * @returns {{items: Item[], totalPaise: number} | null}
 */
export function disputedItems(lines, delivered, rates, said, text) {
  const digits = (/** @type {string} */ s) => s.normalize('NFC').toLowerCase().replace(/[०-९]/gu, (d) => String(d.charCodeAt(0) - 0x0966));
  const words = digits(text);
  const items = lines.map((l, i) => ({ ...delivered[i], name: l.what, qtyHundredths: l.qtyHundredths }));
  const seen = new Set();
  for (const s of said) {
    const at = items.findIndex((it) => typeof s.item === 'string' && norm(it.name) === norm(s.item));
    const copied = typeof s.quantity === 'string' ? digits(s.quantity).trim() : '';
    const q = copied ? parseQuantity(copied) : null;
    const written = copied && new RegExp(`(?<!\\d|\\d\\.)${copied.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d|\\.\\d)`, 'u').test(words);
    if (at < 0 || seen.has(at) || q === null || !written) return null;
    seen.add(at);
    items[at].qtyHundredths = q;
  }
  if (seen.size === 0 || items.some((it) => !it.unit || rateFor(rates, it) === null)) return null;
  return { items, totalPaise: itemsTotalPaise(items, rates, delivered) };
}

/**
 * The tax invoice's grand total against the bill's total: 'match' when equal, or when the invoice is
 * rounded off to whole rupees and equals the bill's total rounded to the nearest rupee (half up);
 * 'differs' otherwise; null when the delivery carried no grand total.
 * @param {number | null | undefined} invoicePaise
 * @param {number} totalPaise
 * @returns {'match' | 'differs' | null}
 */
export function invoiceCheck(invoicePaise, totalPaise) {
  if (!posInt(invoicePaise)) return null;
  if (invoicePaise === totalPaise) return 'match';
  if (invoicePaise % 100 === 0 && invoicePaise === Math.floor((totalPaise + 50) / 100) * 100) return 'match';
  return 'differs';
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
 * carry the delivered quantities; a correction may change quantities (towards the site's count) only,
 * an item at 0 included, as long as something is still billed: a ₹0 bill could never be settled.
 * @param {{lines: any[], totalPaise: number}} body
 * @param {Item[]} delivered
 * @param {Rate[]} rates
 * @param {{sameQty: boolean}} o
 */
export function billFollows(body, delivered, rates, o) {
  if (!Array.isArray(body.lines) || body.lines.length !== delivered.length || !body.lines.some((l) => posInt(l.qtyHundredths))) return false;
  return body.lines.every((l, i) => {
    const it = delivered[i];
    if (!(posInt(l.qtyHundredths) || (l.qtyHundredths === 0 && !o.sameQty)) || (o.sameQty && l.qtyHundredths !== it.qtyHundredths)) return false;
    // The same line this side would build: rate, taxable, GST (rate and amount) and the line's total.
    const want = billLine({ ...it, qtyHundredths: l.qtyHundredths }, rates);
    return want !== null && l.what === want.what && l.ratePaise === want.ratePaise && l.amountPaise === want.amountPaise
      && l.taxablePaise === want.taxablePaise && l.gstPercent === want.gstPercent && l.gstPaise === want.gstPaise;
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
 * `grandTotalPaise` is the tax invoice's grand total as read and carried on the DELIVERY, else null.
 * @returns {{items: Item[], sha256: string, number: string | null, at: string, msgId: string, grandTotalPaise: number | null} | null}
 */
export function delivery(events) {
  const d = ofType(events, 'DELIVERY').at(-1);
  if (!d) return null;
  const b = d.body.body;
  return { items: b.items, sha256: b.challan.sha256, number: b.challan.number ?? null, at: d.body.created_at, msgId: /** @type {string} */ (d.msgId),
    grandTotalPaise: posInt(b.grandTotalPaise) ? b.grandTotalPaise : null };
}

/** The site's own count in force (the latest), or null. @param {LedgerEvent[]} events @returns {Item[] | null} */
export function siteCount(events) {
  const n = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
  return n ? n.body.items : null;
}

/** Who entered the site's count in force and how, or null on a count from before this was kept. @param {LedgerEvent[]} events @returns {{by: string, how: string} | null} */
export function siteCountEntry(events) {
  const n = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
  return n && typeof n.body.by === 'string' && typeof n.body.how === 'string' ? { by: n.body.by, how: n.body.how } : null;
}

/** The hours the site recorded for a JCB job and who entered them (a local NOTE, once), or null. @param {LedgerEvent[]} events @returns {{hoursTenths: number, by: string} | null} */
export function siteHours(events) {
  const n = ofType(events, 'NOTE', 'local').find((e) => e.body.kind === 'site_hours');
  return n ? { hoursTenths: n.body.hoursTenths, by: n.body.by } : null;
}

/** The challan the site's count in force was read from (its photo), or null. @param {LedgerEvent[]} events @returns {{sha256: string, number: string | null} | null} */
export function siteChallan(events) {
  const n = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
  return n && n.body.challan ? n.body.challan : null;
}

/**
 * Where the site's count and the delivery differ, item by item (same name and unit); an item missing
 * on one side counts as 0 there. Delivered items first, in their order, then items only the site has.
 * @param {Item[]} count
 * @param {Item[]} delivered
 * @returns {{name: string, unit: string, count: number, delivered: number}[]}
 */
export function countDifferences(count, delivered) {
  const key = (/** @type {Item} */ it) => `${norm(it.name)}\u0000${norm(it.unit)}`;
  /** @type {Map<string, {name: string, unit: string, count: number, delivered: number}>} */
  const rows = new Map();
  for (const it of delivered) rows.set(key(it), { name: it.name, unit: it.unit, count: 0, delivered: it.qtyHundredths });
  for (const it of count) {
    const r = rows.get(key(it));
    if (r) r.count += it.qtyHundredths;
    else rows.set(key(it), { name: it.name, unit: it.unit, count: it.qtyHundredths, delivered: 0 });
  }
  return [...rows.values()].filter((r) => r.count !== r.delivered);
}

/**
 * The site's signed copy of the challan as last told to the supplier (a SITE_RECEIPT, received on the
 * supplier's ledger, sent on the contractor's; one the other side refused is left out), or null.
 * @param {LedgerEvent[]} events
 * @returns {{items: Item[], number: string | null, signed: boolean | null, delivery: string} | null}
 */
export function siteReceipt(events) {
  const refused = refusedIds(events);
  const r = ofType(events, 'SITE_RECEIPT').filter((e) => e.direction === 'in' || !refused.has(e.msgId)).at(-1);
  if (!r) return null;
  const b = r.body.body;
  return { items: b.items, number: b.challan.number ?? null, signed: typeof b.signed === 'boolean' ? b.signed : null, delivery: b.delivery };
}

/** "yes", "no" or "unsure": the text-key suffix for whether the receiver's mark was seen. @param {boolean | null} signed */
export const signedWord = (signed) => (signed === true ? 'yes' : signed === false ? 'no' : 'unsure');

/** Two challan numbers name the same paper (ignoring case, spaces and leading zeros). @param {string} a @param {string} b */
export function sameChallanNo(a, b) {
  const n = (/** @type {string} */ s) => s.toLowerCase().replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  return n(a) === n(b);
}

/** Same items with the same quantities, in the same order; an item at 0 is an item not there. @param {Item[]} a @param {Item[]} b */
export function sameItems(a, b) {
  const [x, y] = [a, b].map((list) => list.filter((it) => it.qtyHundredths !== 0));
  return x.length === y.length && x.every((it, i) => it.name === y[i].name && it.unit === y[i].unit && it.qtyHundredths === y[i].qtyHundredths);
}

/**
 * The quantity a challan shows for each of the order's items (null where unclear, not found, or in
 * another unit): matched by name, never by position, and never carried across units.
 * @param {{name: string, unit: string}[]} orderItems
 * @param {{name: string, qtyHundredths: number | null, unit?: string | null}[]} seen
 * @returns {(number | null)[]}
 */
export function challanQuantities(orderItems, seen) {
  return challanMatches(orderItems, seen).map((s, i) => (s && posInt(s.qtyHundredths) && !unitsDiffer(s.unit, orderItems[i].unit) ? s.qtyHundredths : null));
}

/** The challan's unit and the order's are both known and not the same: 40 cft is not 40 tons. @param {unknown} a @param {unknown} b */
function unitsDiffer(a, b) {
  const [x, y] = [canonicalUnit(a), canonicalUnit(b)];
  return x !== null && y !== null && x !== y;
}

// Orders are often in Hindi and printed challans in English: the same material under its usual names.
/** @type {Record<string, string>} */
const SAME_MATERIAL = {
  'सीमेंट': 'cement', opc: 'cement', ppc: 'cement', 'रेत': 'sand', 'बालू': 'sand', 'रेता': 'sand', balu: 'sand', baalu: 'sand', ret: 'sand', reta: 'sand',
  'गिट्टी': 'gitti', 'ईंट': 'brick', 'ईंटें': 'brick', bricks: 'brick', 'सरिया': 'steel', sariya: 'steel',
};

/** Do these two names (normalised) say the same material, by their words? @param {string} a @param {string} b */
function sameMaterial(a, b) {
  const words = (/** @type {string} */ s) => s.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).map((w) => SAME_MATERIAL[w] ?? w);
  const [x, y] = [words(a), words(b)];
  return x.length > 0 && y.length > 0 && (y.every((w) => x.includes(w)) || x.every((w) => y.includes(w)));
}

/**
 * The one bill line this name says ("Cement" is the line "सीमेंट"), or null when none or several.
 * @template {{what: string}} L
 * @param {L[]} lines @param {unknown} name @returns {L | null}
 */
export function billLineNamed(lines, name) {
  if (typeof name !== 'string') return null;
  const hits = lines.filter((l) => sameMaterial(norm(l.what), norm(name)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The challan line read for each of the order's items (undefined where none), each line used once: by
 * name, then by the words of the name ("ACC Cement (Bags)" is the order's "cement"). An item no line
 * names is not guessed by position: a challan may list items in another order (live, 31 Oct: its sand
 * line became 40 bags of cement on a signed delivery). The person is asked instead.
 * @template {{name: string}} T
 * @param {{name: string}[]} orderItems
 * @param {T[]} seen
 * @returns {(T | undefined)[]}
 */
export function challanMatches(orderItems, seen) {
  /** @type {(T | undefined)[]} */
  const found = orderItems.map(() => undefined);
  const free = new Set(seen);
  /** @param {(a: string, b: string) => boolean} same */
  const pass = (same) => orderItems.forEach((it, i) => {
    if (found[i]) return;
    const hits = [...free].filter((s) => typeof s.name === 'string' && same(norm(s.name), norm(it.name)));
    // A line that fits two of the order's items, or two lines that fit one item, is not this item's.
    if (hits.length !== 1 || orderItems.some((o, j) => j !== i && !found[j] && same(norm(/** @type {any} */ (hits[0]).name), norm(o.name)))) return;
    found[i] = hits[0];
    free.delete(hits[0]);
  });
  pass((a, b) => a === b);
  pass(sameMaterial);
  return found;
}

/**
 * A reading whose only gap is a missing unit counts as clear when it is the order's one item with the
 * order's quantity: the unit is the order's. Real cash memos have no unit column. Anything else is asked.
 * @param {{name: string, qtyHundredths: number}[]} ordered
 * @param {{onlyUnitMissing?: boolean, items: {name: string, qtyHundredths: number | null}[]}} read
 */
export function unitFromOrder(ordered, read) {
  if (read.onlyUnitMissing !== true || ordered.length !== 1 || read.items.length !== 1) return false;
  const seen = read.items[0];
  return typeof seen.name === 'string' && norm(seen.name) === norm(ordered[0].name) && seen.qtyHundredths === ordered[0].qtyHundredths;
}

/**
 * What a tax invoice printed for the order's items (GST rate, rate, taxable value per item, in the
 * order's order) and its grand total, from a challan reading; null when it printed none of these.
 * Carried on the DELIVERY as read; the bill is still computed by code and compared with the total.
 * @param {{name: string}[]} orderItems
 * @param {{items: {name: string, ratePaise?: number | null, taxablePaise?: number | null, gstPercent?: number | null}[], grandTotalPaise?: number | null}} read
 * @returns {{lines: {gstPercent: number | null, ratePaise: number | null, taxablePaise: number | null}[], grandTotalPaise: number | null} | null}
 */
export function invoiceFromReading(orderItems, read) {
  const lines = challanMatches(orderItems, read.items).map((s) => ({
    gstPercent: isGstPercent(s?.gstPercent) ? s.gstPercent : null,
    ratePaise: posInt(s?.ratePaise) ? s.ratePaise : null,
    taxablePaise: posInt(s?.taxablePaise) ? s.taxablePaise : null,
  }));
  const grandTotalPaise = posInt(read.grandTotalPaise) ? read.grandTotalPaise : null;
  if (grandTotalPaise === null && lines.every((l) => l.gstPercent === null && l.ratePaise === null && l.taxablePaise === null)) return null;
  return { lines, grandTotalPaise };
}

/** "सीमेंट 50 बोरी, रेत 2 ट्रॉली" @param {Item[]} items */
export function itemsText(items) {
  return items.map((i) => `${i.name} ${qty(i.qtyHundredths, i.unit)}`).join(', ');
}

/** "सीमेंट ₹350/बोरी + GST 28%, रेत ₹4,000/ट्रॉली" @param {Rate[]} rates */
export function ratesText(rates) {
  return rates.map((r) => `${r.name} ${rupees(r.ratePaise)}/${r.unit}${isGstPercent(r.gstPercent) ? ` ${t('bill.rate_gst', { percent: r.gstPercent })}` : ''}`).join(', ');
}

/**
 * "सीमेंट 50 बोरी × ₹350 = ₹17,500" per line, and with GST "… = ₹19,000 + GST 28% ₹5,320 = ₹24,320";
 * the unit comes from the delivered item in the same place.
 * @param {{what: string, qtyHundredths?: number, ratePaise: number, amountPaise: number, taxablePaise?: number, gstPercent?: number, gstPaise?: number}[]} lines
 * @param {{unit: string}[]} units
 */
export function linesText(lines, units) {
  return lines.map((l, i) => {
    const head = `${l.what} ${nonNegInt(l.qtyHundredths) ? qty(l.qtyHundredths, units[i]?.unit ?? '').trim() : '—'} × ${rupees(l.ratePaise)}`;
    if (isGstPercent(l.gstPercent) && Number.isSafeInteger(l.taxablePaise) && Number.isSafeInteger(l.gstPaise)) {
      return `${head} = ${rupees(/** @type {number} */ (l.taxablePaise))} ${t('bill.line_gst', { percent: l.gstPercent, gst: rupees(/** @type {number} */ (l.gstPaise)), amount: rupees(l.amountPaise) })}`;
    }
    return `${head} = ${rupees(l.amountPaise)}`;
  }).join(', ');
}

/**
 * Items as a person confirmed them: 1 to 20, each a short safe name, a positive quantity and a unit.
 * @param {unknown} items
 * @returns {items is Item[]}
 */
export function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.length <= 20 && items.every((it) => it && typeof it === 'object'
    && safeName(it.name) && posInt(it.qtyHundredths) && safeName(it.unit, MAX_UNIT));
}
