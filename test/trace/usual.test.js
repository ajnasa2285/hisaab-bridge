import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usualChecks } from '../../src/trace/usual.js';
import { traceLedger } from '../../src/trace/hooks.js';
import { openTrace } from '../../src/trace/trace.js';
import { event, usualHistory } from './usual-fixture.js';

/** @param {number} rate */
function currentBill(rate) {
  const events = usualHistory();
  events.push(event(16, 'current', 'BOOKING_REQUEST', { kind: 'material', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }] }));
  const bill = event(17, 'current', 'BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: rate, amountPaise: rate * 50 }], totalPaise: rate * 50 });
  return { events: [...events, bill], bill };
}

test('trace prints integer comparisons for usual and unusual rates', () => {
  for (const [rate, pct, flagged] of [[42000, 11, false], [50000, 32, true]]) {
    const { events, bill } = currentBill(/** @type {number} */ (rate));
    const check = usualChecks(bill, events).find((x) => x.detail.metric === 'rate');
    assert.ok(check);
    assert.equal(check.title, `rate vs usual: ₹${rate === 42000 ? 420 : 500} vs median ₹380 over 3 orders → ${pct}% (${flagged ? 'unusual, flagged' : 'usual'})`);
    assert.equal(check.detail.flagged, flagged);
    assert.equal(check.detail.pass, !flagged);
  }
});

test('trace excludes current order, future accepted records, and sparse histories', () => {
  const { events, bill } = currentBill(50000);
  const two = events.filter((e) => !e.orderId.endsWith('-2'));
  assert.equal(usualChecks(bill, two).length, 0);
  const after = [...two, ...usualHistory(1, 'agent:supplier-1').map((e) => ({ ...e, seq: e.seq + 100, orderId: 'future' }))];
  assert.equal(usualChecks(bill, after).length, 0);
  const accepted = [...events, event(18, 'current', 'ACCEPT', { bill: bill.msgId })];
  assert.equal(usualChecks(bill, accepted).find((x) => x.detail.metric === 'rate')?.detail.n, 3);
});

test('booking quantity and yes rate checks keep the same counterparty and units', () => {
  const history = usualHistory();
  const request = event(16, 'current', 'BOOKING_REQUEST', { kind: 'material', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 10000 }] });
  const reply = event(17, 'current', 'BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 380000 }] });
  const events = [...history, request, reply];
  assert.equal(usualChecks(request, events)[0].detail.unusual, true);
  assert.equal(usualChecks(reply, events)[0].detail.pct, 900);
  const other = { ...request, body: { ...request.body, to: 'agent:supplier-2' } };
  assert.deepEqual(usualChecks(other, [...history, other]), []);
  const unit = { ...request, body: { ...request.body, body: { ...request.body.body, items: [{ name: 'सीमेंट', unit: 'किलो', qtyHundredths: 10000 }] } } };
  assert.deepEqual(usualChecks(unit, [...history, unit]), []);
});

test('trace remembers the last ten acceptances even when histories arrive grouped by creation', () => {
  const history = usualHistory(12);
  // The first-created order is accepted last. Its small rate must enter the last ten, replacing
  // order 2's rate; a flat concatenation by order would drop it and keep the wrong sample window.
  for (const e of history) {
    const index = Number(e.orderId.split('-').at(-1));
    if (e.type === 'BILL') e.body.body.lines[0].ratePaise = 10000 + index * 1000;
    if (e.type === 'ACCEPT' && index === 0) e.seq = 61;
  }
  const request = event(62, 'current', 'BOOKING_REQUEST', { kind: 'material', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }] });
  const bill = event(63, 'current', 'BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 20000, amountPaise: 1000000 }], totalPaise: 1000000 });
  const check = usualChecks(bill, [...history, request, bill]).find((x) => x.detail.metric === 'rate');
  assert.ok(check);
  assert.deepEqual([check.detail.n, check.detail.min, check.detail.max, check.detail.median], [10, 10000, 21000, 16500]);
  assert.equal(check.detail.pct, 21);
  assert.equal(check.detail.unusual, false);
});

test('ledger append records usual checks without changing append or failing when recorder is closed', () => {
  const { events, bill } = currentBill(50000);
  const rec = openTrace({ agent: 'site' });
  /** @type {any} */
  const ledger = { append: () => bill, ensureOrder: () => {}, order: () => ({ counterparty: 'agent:supplier-1' }),
    orders: () => [...new Set(events.map((e) => e.orderId))].map((order_id) => ({ order_id, counterparty: 'agent:supplier-1' })),
    events: (/** @type {string} */ id) => events.filter((e) => e.orderId === id) };
  try {
    traceLedger(ledger, rec);
    assert.equal(ledger.append({}), bill);
    assert.equal(rec.list().find((x) => x.detail.name === 'usual' && x.detail.metric === 'rate')?.detail.unusual, true);
    rec.close();
    assert.equal(ledger.append({}), bill);
  } finally { rec.close(); }
});
