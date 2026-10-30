// One agent's own accepted figures, pure and shared with the judge page. No records are written,
// no figures are changed, and no model decides whether a figure is outside the usual range.

/** @typedef {import('./store.js').LedgerEvent} LedgerEvent */
/** @typedef {'rate' | 'quantity' | 'hours' | 'gst'} Metric */
/** @typedef {{counterparty: string, item: string, unit: string, metric: Metric, value: number}} Figure */
/** @typedef {{counterparty: string, item: string, unit: string, metric: Metric, n: number, median: number, min: number, max: number, last: number}} UsualFigure */

export const USUAL_RULES = Object.freeze({
  minSamples: 3, window: 10, medianPercent: 25,
  minNumerator: 1, minDenominator: 2, maxNumerator: 3, maxDenominator: 2,
});

/** @param {unknown} value @returns {value is number} */
const nonNegative = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** @param {unknown} value @returns {value is number} */
const positive = (value) => nonNegative(value) && value > 0;
/** @param {unknown} value @returns {value is string} */
const named = (value) => typeof value === 'string' && value.trim().length > 0;
/** @param {string} value */
const normal = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');
/** @param {LedgerEvent} event */
const bodyOf = (event) => event.direction === 'local' ? event.body : event.body?.body ?? {};

/** Stable keys keep different counterparties and units apart. @param {string} counterparty @param {string} item @param {string} unit @param {Metric} metric */
export function usualKey(counterparty, item, unit, metric) {
  return JSON.stringify([counterparty, normal(item), normal(unit), metric]);
}

/** Refused outgoing records remain in the ledger but never become remembered figures. @param {LedgerEvent[]} events */
function usable(events) {
  const refused = new Set(events.filter((e) => e.type === 'REFUSE' && e.direction === 'in').map((e) => bodyOf(e).refers_to));
  for (const e of events) if (e.direction === 'local' && e.type === 'NOTE' && e.body?.kind === 'undelivered') refused.add(e.body.msg_id);
  return events.filter((e) => !(e.direction === 'out' && refused.has(e.msgId)));
}

/** @param {LedgerEvent[]} events */
function identity(events) {
  const request = events.find((e) => e.type === 'BOOKING_REQUEST' && e.direction !== 'local');
  if (!request) return null;
  const counterparty = request.direction === 'out' ? request.body.to : request.body.from;
  const kind = bodyOf(request).kind;
  return named(counterparty) && (kind === 'material' || kind === 'jcb_hours') ? { counterparty, kind } : null;
}

/** @param {LedgerEvent[]} events @param {string} type */
const lastBody = (events, type) => {
  const last = events.findLast((e) => e.type === type);
  return last ? bodyOf(last) : null;
};

/**
 * Figures on a bill, with units from this order's own request/delivery. An explicit body is useful
 * when a bill is being checked; omitted means the latest bill/correction in these order events.
 * Bill quantities and hours take precedence over earlier readings, so an accepted correction is
 * the value remembered. Missing fields may use the confirmed count/delivery, yes or local meters.
 * Duplicate identical item/unit lines contribute one summed quantity, and a rate only if uniform.
 * @param {LedgerEvent[]} orderEvents
 * @param {Record<string, any>} [billBody]
 * @returns {Figure[]}
 */
export function billFigures(orderEvents, billBody) {
  const events = usable(orderEvents);
  const who = identity(events);
  const latest = events.findLast((e) => e.type === 'BILL' || e.type === 'CORRECTION');
  const bill = billBody ?? (latest ? bodyOf(latest) : null);
  if (!who || !bill || !Array.isArray(bill.lines)) return [];
  const counterparty = who.counterparty;
  const yesEvent = events.findLast((e) => e.type === 'BOOKING_REPLY' && bodyOf(e).answer === 'yes');
  const yes = yesEvent ? bodyOf(yesEvent) : {};
  /** @type {Map<string, Figure | null>} */
  const figures = new Map();
  /** @param {string} item @param {string} unit @param {Metric} metric @param {unknown} value */
  function add(item, unit, metric, value) {
    if (!nonNegative(value) || (metric !== 'gst' && value === 0)) return;
    const key = usualKey(counterparty, item, unit, metric);
    const old = figures.get(key);
    if (old === null) return;
    if (old && (metric === 'quantity' || metric === 'hours')) {
      const total = old.value + value;
      figures.set(key, Number.isSafeInteger(total) ? { ...old, value: total } : null);
    } else if (old && old.value !== value) {
      // There is no single rate/GST for this key on this order; never choose one arbitrarily.
      figures.set(key, null);
    } else {
      figures.set(key, { counterparty, item, unit, metric, value });
    }
  }
  if (who.kind === 'jcb_hours') {
    for (const line of bill.lines) {
      add('JCB', 'घंटे', 'rate', line.ratePaise ?? yes.ratePaise);
      add('JCB', 'घंटे', 'hours', line.hoursTenths);
    }
    if (!bill.lines.some((/** @type {any} */ line) => positive(line.hoursTenths))) {
      const meters = events.filter((e) => e.direction === 'local' && e.type === 'EVIDENCE' && e.body.kind === 'meter');
      const start = meters.findLast((e) => e.body.which === 'start')?.body.valueTenths;
      const end = meters.findLast((e) => e.body.which === 'end')?.body.valueTenths;
      if (nonNegative(start) && nonNegative(end)) add('JCB', 'घंटे', 'hours', end - start);
    }
  } else {
    const request = lastBody(events, 'BOOKING_REQUEST');
    const delivered = lastBody(events, 'DELIVERY');
    const items = Array.isArray(delivered?.items) ? delivered.items : request?.items ?? [];
    const countEvent = events.findLast((e) => (e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'site_count') || e.type === 'SITE_RECEIPT');
    const count = countEvent ? bodyOf(countEvent).items : [];
    const rates = Array.isArray(yes.rates) ? yes.rates : [];
    for (const [i, line] of bill.lines.entries()) {
      // Position is part of the material bill contract. A unique name is the only safe fallback.
      const matches = items.filter((/** @type {any} */ item) => named(item.name) && named(line.what) && normal(item.name) === normal(line.what));
      const item = items[i] && named(line.what) && named(items[i].name) && normal(items[i].name) === normal(line.what)
        ? items[i] : matches.length === 1 ? matches[0] : null;
      if (!item || !named(item.name) || !named(item.unit)) continue;
      const same = (/** @type {any} */ x) => named(x.name) && named(x.unit) && normal(x.name) === normal(item.name) && normal(x.unit) === normal(item.unit);
      const rate = rates.find(same);
      const counted = Array.isArray(count) ? count.find(same) : null;
      add(item.name, item.unit, 'rate', line.ratePaise ?? rate?.ratePaise);
      add(item.name, item.unit, 'quantity', line.qtyHundredths ?? counted?.qtyHundredths ?? item.qtyHundredths);
      add(item.name, item.unit, 'gst', line.gstPercent ?? rate?.gstPercent ?? item.gstPercent);
    }
  }
  return [...figures.values()].filter((f) => f !== null);
}

/**
 * Last ten accepted orders per counterparty/item/unit/metric, one observation per order. The
 * acceptance must name the bill in force. Pending/disputed/unaccepted corrections never count.
 * Input is one agent's ledger events in sequence; payment activity does not change sample age.
 * Even-length medians round the two middle integer values half up, without floating arithmetic.
 * @param {LedgerEvent[]} events
 * @returns {Map<string, UsualFigure>}
 */
export function usualFigures(events) {
  /** @type {Map<string, {events: LedgerEvent[], current: LedgerEvent | null, accepted: number | null}>} */
  const orders = new Map();
  for (const [index, event] of usable(events).entries()) {
    let order = orders.get(event.orderId);
    if (!order) {
      order = { events: [], current: null, accepted: null };
      orders.set(event.orderId, order);
    }
    order.events.push(event);
    const body = bodyOf(event);
    if (named(event.msgId) && (event.type === 'BILL' || (event.type === 'CORRECTION' && order.current?.msgId === body.replaces))) {
      order.current = event;
      order.accepted = null;
    } else if (event.type === 'DISPUTE' && body.bill === order.current?.msgId) {
      order.accepted = null;
    } else if ((event.type === 'ACCEPT' || event.type === 'SETTLED') && order.current && body.bill === order.current.msgId) {
      order.accepted ??= index;
    }
  }
  /** @type {Map<string, {figure: Figure, values: number[]}>} */
  const samples = new Map();
  const accepted = [...orders.values()].filter((o) => o.accepted !== null).sort((a, b) => /** @type {number} */ (a.accepted) - /** @type {number} */ (b.accepted));
  for (const order of accepted) {
    for (const figure of billFigures(order.events, bodyOf(/** @type {LedgerEvent} */ (order.current)))) {
      const key = usualKey(figure.counterparty, figure.item, figure.unit, figure.metric);
      const sample = samples.get(key) ?? { figure, values: [] };
      sample.figure = figure;
      sample.values.push(figure.value);
      if (sample.values.length > USUAL_RULES.window) sample.values.shift();
      samples.set(key, sample);
    }
  }
  /** @type {Map<string, UsualFigure>} */
  const result = new Map();
  for (const [key, { figure, values }] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const middle = Math.floor(n / 2);
    const median = n % 2 ? sorted[middle] : Number((BigInt(sorted[middle - 1]) + BigInt(sorted[middle]) + 1n) / 2n);
    result.set(key, { counterparty: figure.counterparty, item: figure.item, unit: figure.unit, metric: figure.metric,
      n, median, min: sorted[0], max: sorted[n - 1], last: values[n - 1] });
  }
  return result;
}

/**
 * More than 25% from the median OR outside half the min to one-and-a-half the max. Bounds are
 * strict and tested by integer cross-products, independent of the rounded display percentage.
 * Zero median (for GST) has no finite percentage; pct is null while the range still decides.
 * @param {number} value
 * @param {{n: number, median: number, min: number, max: number} | null | undefined} usual
 * @returns {{unusual: boolean, usualValue: number | null, usualPaise: number | null, n: number, pct: number | null}}
 */
export function unusual(value, usual) {
  const n = usual && nonNegative(usual.n) ? usual.n : 0;
  const valid = usual && nonNegative(usual.median) && nonNegative(usual.min) && nonNegative(usual.max) && usual.min <= usual.median && usual.median <= usual.max;
  const median = valid ? usual.median : null;
  const result = { unusual: false, usualValue: median, usualPaise: median, n, pct: /** @type {number | null} */ (null) };
  if (!valid || !nonNegative(value) || n < USUAL_RULES.minSamples) return result;
  const v = BigInt(value);
  const m = BigInt(usual.median);
  const diff = v - m;
  const distance = diff < 0n ? -diff : diff;
  const ratio = m === 0n ? null : (distance * 200n + m) / (m * 2n);
  result.pct = ratio === null || ratio > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(diff < 0n ? -ratio : ratio);
  result.unusual = distance * 100n > m * BigInt(USUAL_RULES.medianPercent)
    || v * BigInt(USUAL_RULES.minDenominator) < BigInt(usual.min) * BigInt(USUAL_RULES.minNumerator)
    || v * BigInt(USUAL_RULES.maxDenominator) > BigInt(usual.max) * BigInt(USUAL_RULES.maxNumerator);
  return result;
}
