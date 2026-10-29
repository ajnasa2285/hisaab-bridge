// One agent's remembered figures, grouped by counterparty. The pure ledger calculation is shared
// with the agents; this view never combines the contractor's and seller's exported histories.
import { usualFigures, USUAL_RULES } from '../src/ledger/usual.js';
import { paymentMoney } from './payments-view.js';

/** @typedef {import('../src/ledger/store.js').LedgerEvent} Ev */
/** @typedef {typeof import('./texts.js').TEXTS['hi']} Texts */

/** @param {number} value @param {number} scale */
function decimal(value, scale) {
  const whole = Math.trunc(value / scale);
  const fraction = value % scale;
  return fraction ? `${whole}.${String(fraction).padStart(scale === 100 ? 2 : 1, '0').replace(/0$/, '')}` : String(whole);
}

/** @param {{metric: string, unit: string}} figure @param {number} value @param {Texts} t */
export function usualValue(figure, value, t) {
  if (figure.metric === 'rate') return `${paymentMoney(value)}/${figure.unit}`;
  if (figure.metric === 'gst') return `${value}%`;
  if (figure.metric === 'hours') return `${decimal(value, 10)} ${t.hours}`;
  return `${decimal(value, 100)} ${figure.unit}`;
}

/** Pure display data; all words and identifiers go through textContent in the page. @param {Ev[]} events @param {Texts} t */
export function usualPanels(events, t) {
  /** @type {Map<string, {counterparty: string, rows: {item: string, metric: string, median: string, min: string, max: string, last: string, n: number}[]}>} */
  const panels = new Map();
  for (const figure of usualFigures(events).values()) {
    if (figure.n < USUAL_RULES.minSamples) continue;
    let panel = panels.get(figure.counterparty);
    if (!panel) {
      panel = { counterparty: figure.counterparty, rows: [] };
      panels.set(figure.counterparty, panel);
    }
    panel.rows.push({ item: figure.item, metric: t.usual_metrics[figure.metric],
      median: usualValue(figure, figure.median, t), min: usualValue(figure, figure.min, t),
      max: usualValue(figure, figure.max, t), last: usualValue(figure, figure.last, t), n: figure.n });
  }
  return [...panels.values()];
}
