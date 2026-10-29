// Display-only comparisons with this agent's own accepted history. No writes, model calls or gates.
import { billFigures, usualFigures, usualKey, unusual, USUAL_RULES } from '../ledger/usual.js';
import { rupees, qty, tenths } from '../i18n/format.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {{counterparty: string, item: string, unit: string, metric: 'rate'|'quantity'|'hours'|'gst', value: number}} Figure */

/** @param {Ledger} ledger @param {string} [exclude] */
const ownEvents = (ledger, exclude) => ledger.orders().filter((o) => o.order_id !== exclude)
  .flatMap((o) => ledger.events(String(o.order_id))).sort((a, b) => a.seq - b.seq);

/** @param {Figure} f @param {number} value */
function display(f, value) {
  if (f.metric === 'rate') return `${rupees(value)}/${f.unit}`;
  if (f.metric === 'quantity') return qty(value, f.unit);
  if (f.metric === 'hours') return `${tenths(value)} ${t('explain.unit.hours')}`;
  return `${value}%`;
}

/** One extra line, even if several figures differ. The current order never trains its own check.
 * @param {Ledger} ledger @param {Figure[]} figures @param {string} [orderId]
 * @param {boolean} [aboveOnly]
 */
export function usualNotes(ledger, figures, orderId, aboveOnly = false) {
  const history = usualFigures(ownEvents(ledger, orderId));
  return figures.flatMap((f) => {
    const u = history.get(usualKey(f.counterparty, f.item, f.unit, f.metric));
    const check = unusual(f.value, u);
    if (!check.unusual || !u || (aboveOnly && f.value <= u.median)) return [];
    const params = { item: f.item, metric: t(`usual.metric.${f.metric}`), value: display(f, u.median), n: u.n };
    return [check.pct === null ? t('usual.changed', params)
      : t(check.pct >= 0 ? 'usual.above' : 'usual.below', { ...params, pct: Math.abs(check.pct) })];
  }).join('; ');
}

/** Preserve all receipt metadata and the original text; add no question or new step.
 * @template {{key: string, params?: Record<string, string | number>}} T
 * @param {T} said @param {string} notes @returns {T}
 */
export function withUsual(said, notes) {
  if (!notes) return said;
  return { ...said, key: 'usual.notice', params: { ...said.params, message: t(said.key, said.params), figures: notes } };
}

/** @param {Ledger} ledger @param {string} orderId @param {Record<string, any>} body */
export function billUsualNotes(ledger, orderId, body) {
  return usualNotes(ledger, billFigures(ledger.events(orderId), body), orderId);
}

/** @param {Ledger} ledger @param {string} orderId @param {{name: string, unit: string, ratePaise: number}[] | number} rates */
export function rateUsualNotes(ledger, orderId, rates) {
  const peer = ledger.order(orderId)?.counterparty;
  if (typeof peer !== 'string') return '';
  const rows = typeof rates === 'number' ? [{ name: 'JCB', unit: 'घंटे', ratePaise: rates }] : rates;
  return usualNotes(ledger, rows.map((r) => ({ counterparty: peer, item: r.name, unit: r.unit, metric: 'rate', value: r.ratePaise })), orderId);
}

/** Requests compare quantity/hours and the rate used by the existing estimate. A usual estimate is
 * computed from median quantities and pre-tax rates, never treated as an observed bill total.
 * @param {Ledger} ledger @param {string | undefined} peer
 * @param {{name: string, unit: string, quantity: number, rate: number | null}[]} items
 * @param {'quantity'|'hours'} metric @param {string} [orderId] @param {boolean} [estimate]
 */
export function requestUsualNotes(ledger, peer, items, metric, orderId, estimate = false) {
  if (!peer) return '';
  /** @type {Figure[]} */
  const figures = items.flatMap((it) => [
    { counterparty: peer, item: it.name, unit: it.unit, metric, value: it.quantity },
    ...(estimate && it.rate !== null ? [{ counterparty: peer, item: it.name, unit: it.unit, metric: /** @type {const} */ ('rate'), value: it.rate }] : []),
  ]);
  const notes = usualNotes(ledger, figures, orderId, !estimate);
  if (!estimate) return notes;
  const history = usualFigures(ownEvents(ledger, orderId));
  let total = 0n; let low = 0n; let high = 0n; let current = 0n; let n = USUAL_RULES.window;
  for (const it of items) {
    const rate = history.get(usualKey(peer, it.name, it.unit, 'rate'));
    const amount = history.get(usualKey(peer, it.name, it.unit, metric));
    if (!rate || !amount || rate.n < USUAL_RULES.minSamples || amount.n < USUAL_RULES.minSamples || it.rate === null
      || !Number.isSafeInteger(it.quantity) || !Number.isSafeInteger(it.rate)) return notes;
    const divisor = metric === 'hours' ? 10n : 100n;
    const product = (/** @type {number} */ a, /** @type {number} */ b) => (BigInt(a) * BigInt(b) + divisor / 2n) / divisor;
    total += product(rate.median, amount.median);
    low += product(rate.min, amount.min);
    high += product(rate.max, amount.max);
    current += product(it.rate, it.quantity);
    n = Math.min(n, rate.n, amount.n);
  }
  if (!items.length || [total, low, high, current].some((v) => v > BigInt(Number.MAX_SAFE_INTEGER))) return notes;
  const check = unusual(Number(current), { n, median: Number(total), min: Number(low), max: Number(high) });
  if (!notes && (!check.unusual || check.pct === null)) return '';
  const estimateNote = check.unusual && check.pct !== null
    ? t(check.pct >= 0 ? 'usual.estimate_above' : 'usual.estimate_below', { pct: Math.abs(check.pct), amount: rupees(Number(total)) })
    : t('usual.estimate', { amount: rupees(Number(total)) });
  return [notes, estimateNote].filter(Boolean).join('; ');
}
