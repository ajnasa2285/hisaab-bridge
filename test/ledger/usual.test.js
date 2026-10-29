import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billFigures, unusual, usualFigures, usualKey, USUAL_RULES } from '../../src/ledger/usual.js';

/** @typedef {import('../../src/ledger/store.js').LedgerEvent} LedgerEvent */
let seq = 0;
/** @param {string} orderId @param {string} type @param {Record<string, any>} body @param {string} [seller] @returns {LedgerEvent} */
function message(orderId, type, body, seller = 'agent:supplier-1') {
  const fromBuyer = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM'].includes(type);
  const msgId = `m-${++seq}`;
  return { seq, orderId, type, direction: fromBuyer ? 'out' : 'in', msgId,
    body: { from: fromBuyer ? 'agent:contractor-1' : seller, to: fromBuyer ? seller : 'agent:contractor-1', body },
    at: '2026-10-29T04:30:00.000Z', prevHash: '', hash: '' };
}
/** @param {string} id @param {{rate?: number, qty?: number, gst?: number, item?: string, unit?: string, seller?: string, accept?: boolean}} [options] */
function material(id, options = {}) {
  const { rate = 38000, qty = 5000, gst = 28, item = 'सीमेंट', unit = 'बोरी', seller = 'agent:supplier-1', accept = true } = options;
  const emit = (/** @type {string} */ type, /** @type {Record<string, any>} */ body) => message(id, type, body, seller);
  const events = [
    emit('BOOKING_REQUEST', { kind: 'material', site: 'परीक्षण स्थल', items: [{ name: item, unit, qtyHundredths: qty }] }),
    emit('BOOKING_REPLY', { answer: 'yes', rates: [{ name: item, unit, ratePaise: rate, gstPercent: gst }] }),
    emit('DELIVERY', { items: [{ name: item, unit, qtyHundredths: qty }], challan: { sha256: 'a'.repeat(64) } }),
    emit('BILL', { lines: [{ what: item, qtyHundredths: qty, ratePaise: rate, gstPercent: gst, taxablePaise: 1900000, amountPaise: 2432000 }], totalPaise: 2432000 }),
  ];
  if (accept) events.push(emit('ACCEPT', { bill: events.at(-1)?.msgId }));
  return events;
}
/** @param {string} id @param {number} hours @param {number} [rate] */
function jcb(id, hours, rate = 120000) {
  const emit = (/** @type {string} */ type, /** @type {Record<string, any>} */ body) => message(id, type, body, 'agent:jcb-1');
  const events = [
    emit('BOOKING_REQUEST', { kind: 'jcb_hours', site: 'परीक्षण स्थल', hoursTenths: 80 }),
    emit('BOOKING_REPLY', { answer: 'yes', ratePaise: rate }),
    emit('BILL', { lines: [{ what: 'जेसीबी काम', hoursTenths: hours, ratePaise: rate, amountPaise: hours * rate / 10 }], totalPaise: hours * rate / 10 }),
  ];
  events.push(emit('ACCEPT', { bill: events.at(-1)?.msgId }));
  return events;
}
const cementKey = (/** @type {import('../../src/ledger/usual.js').Metric} */ metric) => usualKey('agent:supplier-1', 'सीमेंट', 'बोरी', metric);

test('fewer than three accepted orders never establish a usual figure', () => {
  assert.equal(usualFigures([]).size, 0);
  const history = [...material('p1'), ...material('p2'), ...material('p3', { accept: false })];
  const rate = usualFigures(history).get(cementKey('rate'));
  assert.equal(rate?.n, 2);
  assert.equal(unusual(380000, rate).unusual, false);
  assert.equal(unusual(380000, null).unusual, false);
});

test('one observation per accepted order uses the pre-GST rate, separate GST and quantity', () => {
  const figures = usualFigures([...material('p1', { rate: 37000 }), ...material('p2'), ...material('p3', { rate: 39000 })]);
  assert.deepEqual(figures.get(cementKey('rate')), { counterparty: 'agent:supplier-1', item: 'सीमेंट', unit: 'बोरी', metric: 'rate', n: 3, median: 38000, min: 37000, max: 39000, last: 39000 });
  assert.equal(figures.get(cementKey('gst'))?.median, 28);
  assert.equal(figures.get(cementKey('quantity'))?.median, 5000);
  assert.equal(unusual(50000, figures.get(cementKey('rate'))).pct, 32);
});

test('a disputed bill is excluded until the correction is accepted, then only corrected figures count', () => {
  const history = material('p1', { qty: 9000, accept: false });
  const first = /** @type {LedgerEvent} */ (history.at(-1));
  history.push(message('p1', 'DISPUTE', { bill: first.msgId, theirFigure: { qtyHundredths: 4800 } }));
  assert.equal(usualFigures(history).size, 0);
  const correction = message('p1', 'CORRECTION', { replaces: first.msgId, lines: [{ what: 'सीमेंट', qtyHundredths: 4800, ratePaise: 37500, amountPaise: 1800000 }], totalPaise: 1800000 });
  history.push(correction);
  assert.equal(usualFigures(history).size, 0);
  history.push(message('p1', 'ACCEPT', { bill: correction.msgId }));
  const figures = usualFigures(history);
  assert.equal(figures.get(cementKey('quantity'))?.median, 4800);
  assert.equal(figures.get(cementKey('rate'))?.median, 37500);
  assert.equal(figures.get(cementKey('rate'))?.n, 1);
});

test('only acceptance of the bill in force counts; a stale accept and a refused outgoing accept do not', () => {
  const history = material('p1', { accept: false });
  history.push(message('p1', 'ACCEPT', { bill: 'some-other-bill' }));
  assert.equal(usualFigures(history).size, 0);
  const accepted = message('p1', 'ACCEPT', { bill: history[3].msgId });
  history.push(accepted, message('p1', 'REFUSE', { refers_to: accepted.msgId, code: 'WRONG_STATE' }));
  assert.equal(usualFigures(history).size, 0);
});

test('refused outgoing correction never replaces the accepted bill in the seller ledger', () => {
  /** @type {LedgerEvent[]} */
  const history = material('p1').map((e) => ({ ...e, direction: /** @type {'in'|'out'} */ (e.direction === 'in' ? 'out' : 'in') }));
  const correction = message('p1', 'CORRECTION', { replaces: history[3].msgId, lines: [{ what: 'सीमेंट', qtyHundredths: 9000, ratePaise: 90000 }] });
  correction.direction = 'out';
  const refuse = message('p1', 'REFUSE', { refers_to: correction.msgId, code: 'WRONG_STATE' });
  history.push(correction, refuse);
  const rate = usualFigures(history).get(usualKey('agent:contractor-1', 'सीमेंट', 'बोरी', 'rate'));
  assert.equal(rate?.median, 38000);
});

test('units, counterparties and the ledger owner are kept apart', () => {
  const history = [...material('p1'), ...material('p2', { unit: 'किलो', rate: 800 }), ...material('p3', { seller: 'agent:supplier-2', rate: 42000 })];
  const figures = usualFigures(history);
  assert.equal(figures.get(cementKey('rate'))?.n, 1);
  assert.equal(figures.get(usualKey('agent:supplier-1', 'सीमेंट', 'किलो', 'rate'))?.median, 800);
  assert.equal(figures.get(usualKey('agent:supplier-2', 'सीमेंट', 'बोरी', 'rate'))?.median, 42000);
  const seller = material('p4').map((e) => ({ ...e, direction: /** @type {'in'|'out'} */ (e.direction === 'in' ? 'out' : 'in') }));
  assert.equal(usualFigures(seller).get(usualKey('agent:contractor-1', 'सीमेंट', 'बोरी', 'rate'))?.median, 38000);
});

test('last ten values use acceptance order, not order creation or later payment time', () => {
  const orders = Array.from({ length: 12 }, (_, i) => material(`p${i}`, { rate: 100 + i }));
  const firstAcceptance = /** @type {LedgerEvent} */ (orders[0].pop());
  const history = orders.flat();
  history.push(firstAcceptance);
  history.push(message('p2', 'SETTLED', { bill: orders[2][3].msgId, payment: 'invented-payment', amountPaise: 1 }));
  const rate = usualFigures(history).get(cementKey('rate'));
  assert.equal(rate?.n, USUAL_RULES.window);
  assert.deepEqual([rate?.min, rate?.max, rate?.median, rate?.last], [100, 111, 107, 100]);
});

test('integer median rounds even samples half up and remains exact at safe integer limits', () => {
  const rates = [Number.MAX_SAFE_INTEGER - 3, Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
  const figures = usualFigures(rates.flatMap((rate, i) => material(`p${i}`, { rate })));
  assert.equal(figures.get(cementKey('rate'))?.median, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(unusual(Number.MAX_SAFE_INTEGER, { n: 3, median: Number.MAX_SAFE_INTEGER, min: 1, max: Number.MAX_SAFE_INTEGER }).unusual, false);
});

test('JCB remembers per-job tenths and hourly paise, including a corrected bill', () => {
  const history = [...jcb('j1', 60), ...jcb('j2', 70), ...jcb('j3', 80)];
  const figures = usualFigures(history);
  const hours = figures.get(usualKey('agent:jcb-1', 'JCB', 'घंटे', 'hours'));
  assert.equal(hours?.median, 70);
  assert.equal(unusual(100, hours).unusual, true);
  assert.equal(figures.get(usualKey('agent:jcb-1', 'JCB', 'घंटे', 'rate'))?.median, 120000);
  const corrected = jcb('j4', 150);
  corrected.pop();
  const correction = message('j4', 'CORRECTION', { replaces: corrected[2].msgId, lines: [{ what: 'जेसीबी काम', hoursTenths: 65, ratePaise: 120000 }] }, 'agent:jcb-1');
  corrected.push(correction, message('j4', 'ACCEPT', { bill: correction.msgId }, 'agent:jcb-1'));
  assert.equal(usualFigures(corrected).get(usualKey('agent:jcb-1', 'JCB', 'घंटे', 'hours'))?.median, 65);
});

test('fallbacks use confirmed local counts, agreed rates and local meter readings only when bill fields are absent', () => {
  const history = material('p1');
  const local = message('p1', 'NOTE', {});
  local.direction = 'local';
  local.body = { kind: 'site_count', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 4800 }] };
  history.splice(3, 0, local);
  history[4].body.body.lines = [{ what: 'सीमेंट', amountPaise: 1 }];
  const values = billFigures(history);
  assert.equal(values.find((v) => v.metric === 'quantity')?.value, 4800);
  assert.equal(values.find((v) => v.metric === 'rate')?.value, 38000);
  const meterEvents = jcb('j1', 60);
  meterEvents[2].body.body.lines = [{ what: 'जेसीबी काम' }];
  for (const [which, valueTenths] of [['start', 36000], ['end', 36065]]) {
    const e = message('j1', 'EVIDENCE', {});
    e.direction = 'local';
    e.body = { kind: 'meter', which, valueTenths };
    meterEvents.splice(2, 0, e);
  }
  assert.equal(billFigures(meterEvents).find((v) => v.metric === 'hours')?.value, 65);
});

test('thresholds are strict; decisions use exact cross-products, not rounded percent', () => {
  const usual = { n: 5, median: 10000, min: 9000, max: 11000 };
  assert.equal(unusual(12500, usual).unusual, false);
  assert.equal(unusual(7500, usual).unusual, false);
  assert.deepEqual([unusual(12501, usual).unusual, unusual(12501, usual).pct], [true, 25]);
  assert.deepEqual([unusual(7499, usual).unusual, unusual(7499, usual).pct], [true, -25]);
  assert.equal(unusual(42000, { n: 5, median: 38000, min: 37000, max: 39000 }).pct, 11);
  assert.equal(unusual(0, { n: 3, median: 0, min: 0, max: 0 }).unusual, false);
  assert.deepEqual([unusual(5, { n: 3, median: 0, min: 0, max: 0 }).unusual, unusual(5, { n: 3, median: 0, min: 0, max: 0 }).pct], [true, null]);
});

test('malformed values are never classified, no mutation, missing units are not invented', () => {
  const usual = { n: 3, median: 100, min: 90, max: 110 };
  for (const value of [NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.equal(unusual(value, usual).unusual, false);
  const history = material('p1');
  const before = JSON.stringify(history);
  usualFigures(history);
  assert.equal(JSON.stringify(history), before);
  history[2].body.body.items[0].unit = null;
  assert.equal(billFigures(history).length, 0);
  assert.equal(usualKey('agent:a', ' Cement ', ' BAG ', 'rate'), usualKey('agent:a', 'cement', 'bag', 'rate'));
});
