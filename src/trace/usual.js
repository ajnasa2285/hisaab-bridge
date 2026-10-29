// Audit comparisons only. A check never changes a state, asks a question or holds an order.
import { billFigures, usualFigures, usualKey, unusual, USUAL_RULES } from '../ledger/usual.js';
import { hours, qty, rupees } from '../i18n/format.js';

/** @typedef {import('../ledger/store.js').LedgerEvent} Ev */
/** @typedef {{counterparty: string, item: string, unit: string, metric: 'rate'|'quantity'|'hours'|'gst', value: number}} Figure */

/** Candidates in the event being recorded, with names and units from this order only. @param {Ev} event @param {Ev[]} events @returns {Figure[]} */
function figuresOf(event, events) {
  const order = events.filter((e) => e.orderId === event.orderId);
  if (event.type === 'BILL' || event.type === 'CORRECTION') return billFigures(order, event.body.body);
  const request = order.find((e) => e.type === 'BOOKING_REQUEST');
  if (!request) return [];
  const counterparty = request.direction === 'out' ? request.body.to : request.body.from;
  if (typeof counterparty !== 'string') return [];
  const body = event.body.body;
  /** @type {Figure[]} */
  const figures = [];
  /** @param {string} item @param {string} unit @param {Figure['metric']} metric @param {number} value */
  const add = (item, unit, metric, value) => {
    if (typeof item === 'string' && typeof unit === 'string' && Number.isSafeInteger(value) && value >= 0) figures.push({ counterparty, item, unit, metric, value });
  };
  if (event.type === 'BOOKING_REQUEST') {
    if (body.kind === 'jcb_hours') add('JCB', 'घंटे', 'hours', body.hoursTenths);
    else for (const it of body.items ?? []) add(it.name, it.unit, 'quantity', it.qtyHundredths);
  } else if (event.type === 'BOOKING_REPLY' && body.answer === 'yes') {
    if (request.body.body.kind === 'jcb_hours') add('JCB', 'घंटे', 'rate', body.ratePaise);
    else for (const rate of body.rates ?? []) {
      add(rate.name, rate.unit, 'rate', rate.ratePaise);
      add(rate.name, rate.unit, 'gst', rate.gstPercent);
    }
  }
  return figures;
}

/** @param {Figure} figure @param {number} value */
function display(figure, value) {
  if (figure.metric === 'rate') return rupees(value);
  if (figure.metric === 'hours') return hours(value);
  if (figure.metric === 'gst') return `${value}%`;
  return qty(value, figure.unit);
}

/**
 * History is from this agent only, before this append, without this order. Refused outgoing
 * messages are excluded by the ledger calculator. Fewer than three observations has no check.
 * @param {Ev} event @param {Ev[]} events
 */
export function usualChecks(event, events) {
  if (!['BOOKING_REQUEST', 'BOOKING_REPLY', 'BILL', 'CORRECTION'].includes(event.type)) return [];
  // traceLedger gathers histories by order; restore ledger sequence before taking the last ten.
  const before = events.filter((e) => e.seq <= event.seq).sort((a, b) => a.seq - b.seq);
  const summaries = usualFigures(before.filter((e) => e.orderId !== event.orderId));
  return figuresOf(event, before).flatMap((figure) => {
    const summary = summaries.get(usualKey(figure.counterparty, figure.item, figure.unit, figure.metric));
    if (!summary || summary.n < USUAL_RULES.minSamples) return [];
    const checked = unusual(figure.value, summary);
    const change = checked.pct === null ? 'from zero' : `${checked.pct}%`;
    return [{ orderId: event.orderId,
      title: `${figure.metric} vs usual: ${display(figure, figure.value)} vs median ${display(figure, summary.median)} over ${summary.n} orders → ${change} (${checked.unusual ? 'unusual, flagged' : 'usual'})`,
      detail: { name: 'usual', pass: !checked.unusual, ...figure, median: summary.median, min: summary.min, max: summary.max,
        n: summary.n, pct: checked.pct, unusual: checked.unusual, flagged: checked.unusual } }];
  });
}
