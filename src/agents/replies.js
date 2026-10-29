// Exact replies, read by code before the model (docs/BUILD2.md "Fewer steps"). A person's own exact
// answer to a request that is open for them is their decision: it runs at once, and they get one
// receipt. Everything here is parsed by code from the words and the ledger's open orders; the model
// never sees these messages. What does not fit exactly (other words, a wrong number of rates, two
// open orders and no reference) is either asked for (only what is missing) or left to the model.

import { orderRefs, pickOrder } from '../orchestrator/orchestrator.js';
import { dayWord, parsePaise, parseTenths, parseHundredths, parseTime, resolveDay } from '../orchestrator/units.js';
import { parseRef } from '../ledger/refs.js';
import { itemsText, requestedItems } from './material.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/**
 * @typedef {{kind: 'step', tool: string, args: Record<string, any>} |
 *   {kind: 'ask', key: string, params?: Record<string, string | number>}} Exact
 */

/** @param {string[]} w */
const words = (w) => new Set(w.map((x) => x.normalize('NFC')));
const YES_WORDS = words(['हाँ', 'हां', 'हा', 'हाँजी', 'हांजी', 'जी', 'ठीक', 'सही', 'चलेगा', 'बिल्कुल', 'han', 'haan', 'ha', 'haa', 'haanji', 'ji', 'yes', 'y', 'ok', 'okay', 'ओके', 'theek', 'thik', 'sahi', 'chalega', 'bilkul', '👍', '✅']);
const NO_WORDS = words(['नहीं', 'नही', 'ना', 'न', 'गलत', 'ग़लत', 'मत', 'nahi', 'nahin', 'nhi', 'na', 'no', 'n', 'galat', 'mat', 'cancel', '❌']);
// Words that may stand beside a yes or a no without changing it ("हाँ जी", "ठीक है भेजो", "नहीं चाहिए",
// "हाँ आ गया"). Anything else in the message makes it more than a yes or a no.
const FILLER = words([
  'है', 'हैं', 'जी', 'भेज', 'भेजो', 'भेजें', 'भेजिए', 'दो', 'दें', 'दीजिए', 'कर', 'करो', 'करें', 'अभी', 'चाहिए', 'भाई', 'सर', 'साहब',
  'आ', 'गया', 'गए', 'गई', 'मिल', 'मिला', 'मिले', 'आया', 'आए', 'हो', 'please', 'plz', 'pls', 'hai', 'bhej', 'bhejo', 'do', 'de', 'kar', 'karo',
  'abhi', 'chahiye', 'chaiye', 'bhai', 'sir', 'sahab', 'aa', 'gaya', 'gaye', 'mil', 'mila', 'aaya', 'ho',
]);
const BILL_WORDS = words(['बिल', 'bill']);
// Words that may follow a rate ("हाँ 1200 घंटा", "हाँ ₹380 रुपये").
const RATE_FILLER = words(['रुपये', 'रुपए', 'रु', 'rs', 'rupaye', 'rupees', 'rupay', '₹', 'घंटा', 'घंटे', 'ghanta', 'ghante', 'प्रति', 'per', 'बोरी', 'bori']);
const TIME_FILLER = words(['बजे', 'baje', 'बजे से', 'से', 'se', 'तक', 'tak']);
const HOURS_UNIT = words(['घंटे', 'घंटा', 'ghante', 'ghanta', 'h', 'hr', 'hrs', 'hours']);
const RUPEE_UNIT = words(['रुपये', 'रुपए', 'रु', 'rs', 'rupaye', 'rupees', '₹']);

/**
 * The words of a message as typed or spoken: lower case, punctuation a voice transcript adds
 * (",", "।", "?", "!") taken away, one space between words.
 * @param {string} text @returns {string[]}
 */
export function tokens(text) {
  return text.normalize('NFC').toLowerCase().replace(/[,।?!|;]+/gu, ' ').replace(/\.(?!\d)/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

/**
 * A short spoken or typed yes or no to an open yes/no question: at most 4 words, only yes words (or
 * only no words) and the little words beside them, no digits, never both. "हाँ जी", "जी हाँ",
 * "ok bhej do", "ठीक है भेजो", "नहीं चाहिए", "nahi abhi nahi" → yes / no; "हाँ 50 बोरी", "हाँ नहीं" → null.
 * @param {string} text @returns {'yes' | 'no' | null}
 */
export function yesNo(text) {
  const w = tokens(text);
  if (w.length === 0 || w.length > 4 || w.some((x) => /\d/.test(x))) return null;
  const yes = w.some((x) => YES_WORDS.has(x) && x !== 'जी' && x !== 'ji') || (w.length === 1 && (w[0] === 'जी' || w[0] === 'ji'));
  const no = w.some((x) => NO_WORDS.has(x));
  if (yes === no) return null;
  return w.every((x) => YES_WORDS.has(x) || NO_WORDS.has(x) || FILLER.has(x)) ? (yes ? 'yes' : 'no') : null;
}

/** "380", "₹380", "380/-", "1,200" → paise; null when it is not a rate. @param {string} w */
const rateOf = (w) => {
  const s = w.replace(/^₹/u, '').replace(/\/-$/u, '');
  return s && /^[\d,]+(?:\.\d{1,2})?$/.test(s) ? parsePaise(s) : null;
};

/**
 * A reference written first or last ("P-2 हाँ 380", "हाँ 380 P-2"), taken out of the words.
 * @param {string[]} w @returns {{ref: string | null, rest: string[]}}
 */
function takeRef(w) {
  if (w.length > 1 && parseRef(w[0]) !== null) return { ref: parseRef(w[0]), rest: w.slice(1) };
  if (w.length > 1 && parseRef(/** @type {string} */ (w.at(-1))) !== null) return { ref: parseRef(/** @type {string} */ (w.at(-1))), rest: w.slice(0, -1) };
  return { ref: null, rest: w };
}

/** Leading yes words taken off: "जी हाँ 380" → ["380"]; null when the message does not start with yes. @param {string[]} w */
function afterYes(w) {
  let i = 0;
  while (i < w.length && (YES_WORDS.has(w[i]) || w[i] === 'जी' || w[i] === 'ji')) i += 1;
  return i > 0 && w.slice(0, i).some((x) => YES_WORDS.has(x) && x !== 'जी' && x !== 'ji') ? w.slice(i) : null;
}

/**
 * The step a seller's exact reply means (JCB owner or supplier): "हाँ 1200" / "हाँ 350 4000", "नहीं",
 * a day ("30-10", "कल", "30-10 8 बजे"), "बिल", or a bare "हाँ" for a reported payment. A reference
 * picks the order when several are open.
 * @param {{ledger: ReturnType<typeof import('../ledger/store.js').openLedger>, person: Person, text: string, nowMs: number}} o
 * @returns {Exact | null}
 */
export function exactReply(o) {
  const role = o.person.role;
  if (role === 'jcb_owner' || role === 'supplier') return sellerReply(o);
  if (role === 'contractor') return disputeReply(o);
  return null;
}

/** @param {{ledger: any, person: Person, text: string, nowMs: number}} o @returns {Exact | null} */
function sellerReply(o) {
  const supplier = o.person.role === 'supplier';
  const answerTool = supplier ? 'reply_order' : 'reply_booking';
  const orders = orderRefs(o.ledger);
  const { ref, rest } = takeRef(tokens(o.text));
  if (rest.length === 0) return null;
  /** The one order in these states (or the one named), or what to ask. @param {string[]} states */
  const pick = (states) => {
    if (ref !== null) {
      const named = orders.find((r) => r.ref === ref);
      return named && states.includes(named.state) ? named : null;
    }
    return pickOrder(orders, null, states);
  };
  /** @param {string[]} states @returns {Exact} */
  const which = (states) => whichOrder(orders.filter((r) => states.includes(r.state)).map((r) => r.ref));

  // "बिल" / "बिल भेजो": the bill of the one order that is ready for it.
  if (rest.some((x) => BILL_WORDS.has(x)) && rest.every((x) => BILL_WORDS.has(x) || FILLER.has(x)) && rest.length <= 3) {
    const states = supplier ? ['delivered'] : ['booked', 'working'];
    const p = pick(states);
    if (p === 'orchestrator.which_job') return which(states);
    if (p === null || typeof p === 'string') return null;
    return { kind: 'step', tool: 'send_bill', args: { orderId: p.orderId } };
  }

  // A plain yes or no.
  const yn = yesNo(rest.join(' '));
  if (yn === 'no') {
    const p = pick(['requested']);
    if (p === 'orchestrator.which_job') return which(['requested']);
    if (p === null || typeof p === 'string') return null;
    return { kind: 'step', tool: answerTool, args: { orderId: p.orderId, answer: 'no' } };
  }
  if (yn === 'yes') {
    // A reported payment, when it is the only thing waiting for a yes; an order needs its rate first.
    const claimed = orders.filter((r) => r.state === 'payment_claimed' && (ref === null || r.ref === ref));
    const requested = orders.filter((r) => r.state === 'requested' && (ref === null || r.ref === ref));
    if (claimed.length === 1 && requested.length === 0) return { kind: 'step', tool: 'confirm_payment', args: { orderId: claimed[0].orderId } };
    if (requested.length === 1 && claimed.length === 0) return ratesNeeded(o, requested[0].orderId, supplier);
    if (requested.length > 1 && claimed.length === 0) return which(['requested']);
    return null;
  }

  // "हाँ 380" / "हाँ 350, 4000" / "हाँ 1200 घंटा": yes with the rates.
  const after = afterYes(rest);
  if (after !== null) {
    const rates = after.filter((x) => !RATE_FILLER.has(x));
    const paise = rates.map(rateOf);
    if (rates.length === 0 || paise.some((p) => p === null)) return null;
    const p = pick(['requested']);
    if (p === 'orchestrator.which_job') return which(['requested']);
    if (p === null || typeof p === 'string') return null;
    if (!supplier) return paise.length === 1 ? { kind: 'step', tool: answerTool, args: { orderId: p.orderId, answer: 'yes', ratePaise: paise[0] } } : { kind: 'ask', key: 'jcb.rate_needed' };
    if (paise.length !== requestedItems(o.ledger.events(p.orderId)).length) return ratesNeeded(o, p.orderId, true);
    return { kind: 'step', tool: answerTool, args: { orderId: p.orderId, answer: 'yes', ratesPaise: paise } };
  }

  // Another day: "30-10", "कल", "30-10 8 बजे".
  const day = dayWord(rest[0]);
  if (day !== null) {
    const times = rest.slice(1).filter((x) => !TIME_FILLER.has(x));
    if (times.length > 1) return null;
    const time = times.length === 1 ? parseTime(times[0]) : null;
    if (times.length === 1 && time === null) return null;
    const resolved = resolveDay(day, o.nowMs);
    if (resolved === null) return null;
    const p = pick(['requested']);
    if (p === 'orchestrator.which_job') return which(['requested']);
    if (p === null || typeof p === 'string') return null;
    return { kind: 'step', tool: answerTool, args: { orderId: p.orderId, answer: 'other_time', day: resolved, ...(time ? { time } : {}) } };
  }
  return null;
}

/** Several open orders fit: which one? The reply form names the first. @param {string[]} refs @returns {Exact} */
const whichOrder = (refs) => {
  // J-n before P-n, each by number ("P-2" before "P-10").
  const sorted = [...refs].sort((x, y) => (x[0] === y[0] ? Number(x.slice(2)) - Number(y.slice(2)) : x.localeCompare(y)));
  return { kind: 'ask', key: 'reply.which_order', params: { refs: sorted.join(', '), ref: sorted[0] } };
};

/** @param {{ledger: any}} o @param {string} orderId @param {boolean} supplier @returns {Exact} */
function ratesNeeded(o, orderId, supplier) {
  if (!supplier) return { kind: 'ask', key: 'jcb.rate_needed' };
  return { kind: 'ask', key: 'supplier.rates_needed', params: { items: itemsText(requestedItems(o.ledger.events(orderId))) } };
}

/**
 * The contractor's objection to a bill, written as "नहीं <figure> <reason>": "नहीं 5.5 घंटे मशीन
 * देर से आई", "नहीं 45 बोरी कम आई", "नहीं ₹16000 दर ज़्यादा". The figure is hours on a JCB bill, a
 * quantity on a one-line material bill, or a total in rupees (₹ or "रुपये"). Without a reason only the
 * reason is asked.
 * @param {{ledger: any, person: Person, text: string}} o @returns {Exact | null}
 */
function disputeReply(o) {
  const { ref, rest } = takeRef(tokens(o.text));
  if (rest.length < 2 || !NO_WORDS.has(rest[0])) return null;
  const orders = orderRefs(o.ledger);
  const p = ref !== null ? orders.find((r) => r.ref === ref && r.state === 'billed') ?? null : pickOrder(orders, null, ['billed']);
  if (p === 'orchestrator.which_job') return whichOrder(orders.filter((r) => r.state === 'billed').map((r) => r.ref));
  if (p === null || typeof p === 'string') return null;
  const material = /** @type {{kind: string} | null} */ (o.ledger.order(p.orderId))?.kind === 'material';
  let i = 1;
  const rupee = rest[i].startsWith('₹') || RUPEE_UNIT.has(rest[i + 1] ?? '');
  const figure = rest[i].replace(/^₹/u, '').replace(/\/-$/u, '');
  if (!/^[\d,]+(?:\.\d+)?$/.test(figure)) return null;
  i += 1;
  /** @type {Record<string, any>} */
  const args = { orderId: p.orderId };
  if (rupee) {
    const paise = parsePaise(figure);
    if (paise === null || paise === 0) return null;
    args.totalPaise = paise;
    if (RUPEE_UNIT.has(rest[i] ?? '')) i += 1;
  } else if (material) {
    const q = parseHundredths(figure);
    if (q === null || q === 0) return null;
    args.qtyHundredths = q;
    const units = new Set(requestedItems(o.ledger.events(p.orderId)).map((it) => it.unit.normalize('NFC').toLowerCase()));
    if (units.has(rest[i] ?? '')) i += 1;
  } else {
    const h = parseTenths(figure);
    if (h === null || h === 0) return null;
    args.hoursTenths = h;
    if (HOURS_UNIT.has(rest[i] ?? '')) i += 1;
  }
  // The reason in the person's own words, as they wrote it (after the figure).
  const reason = reasonAfter(o.text, (ref !== null && parseRef(tokens(o.text)[0]) !== null ? 1 : 0) + i, ref !== null && parseRef(tokens(o.text)[0]) === null);
  if (!reason) return { kind: 'ask', key: 'site.reason_needed' };
  return { kind: 'step', tool: 'dispute_bill', args: { ...args, reason } };
}

/**
 * The reason as written: the original text from its first word on (a reference written last left
 * out), punctuation at the end dropped.
 * @param {string} text @param {number} start index of the reason's first word @param {boolean} refLast
 */
function reasonAfter(text, start, refLast) {
  const all = tokens(text);
  const end = refLast ? all.length - 1 : all.length;
  if (start >= end) return '';
  const original = text.normalize('NFC');
  const lower = original.toLowerCase();
  // Walk past the words before the reason, so a reason word that also appears earlier is not mistaken.
  let at = 0;
  for (const w of all.slice(0, start)) {
    const k = lower.indexOf(w, at);
    if (k >= 0) at = k + w.length;
  }
  let raw = original.slice(at);
  if (refLast) {
    const k = raw.toLowerCase().lastIndexOf(/** @type {string} */ (all.at(-1)));
    if (k >= 0) raw = raw.slice(0, k);
  }
  return raw.replace(/^[\s,।.!?|;]+|[\s,।.!?|;]+$/gu, '').trim().slice(0, 300);
}
