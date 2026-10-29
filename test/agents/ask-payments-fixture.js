// Invented CONTRACTS 4.1 events. The recording branch owns the new state transitions, so this
// read-side fixture supplies an event/view adapter over real SQLite orders and reference tables.
import { openLedger } from '../../src/ledger/store.js';

export function paymentBooks() {
  const base = openLedger(':memory:');
  const at = '2026-10-29T06:00:00.000Z';
  const ids = [101, 102, 103, 104].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  /** @type {Map<string, import('../../src/ledger/store.js').LedgerEvent[]>} */
  const histories = new Map();
  let seq = 0;
  /** @param {string} orderId @param {string} type @param {Record<string, any>} body @param {'in'|'out'} [direction] */
  function put(orderId, type, body, direction = 'in') {
    const msgId = `00000000-0000-4000-8000-${String(1000 + ++seq).padStart(12, '0')}`;
    histories.get(orderId)?.push({ orderId, type, direction, msgId, at, seq, prevHash: '', hash: '', body: { body, created_at: at } });
    return msgId;
  }
  for (const [i, orderId] of ids.entries()) {
    base.ensureOrder({ orderId, kind: 'material', site: 'कल्पित साइट', counterparty: 'agent:supplier-1', at: `2026-10-${String(20 + i)}T06:00:00.000Z` });
    histories.set(orderId, []);
    put(orderId, 'BOOKING_REQUEST', { kind: 'material', site: 'कल्पित साइट', day: '2026-10-20', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 100 }] }, 'out');
    put(orderId, 'BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 1000000 }] });
  }
  put(ids[0], 'PAYMENT_RECEIVED', { method: 'cash', bill: null, amountPaise: 200000, receivedOn: '2026-10-21' });
  put(ids[2], 'PAYMENT_RECEIVED', { method: 'cash', bill: null, amountPaise: 120000, receivedOn: '2026-10-21' });
  const bills = [1000000, 800000, 100000].map((amount, i) => put(ids[i], 'BILL', { totalPaise: amount, lines: [{ what: 'सीमेंट', qtyHundredths: 100, ratePaise: amount, amountPaise: amount }] }));
  for (let i = 0; i < 3; i++) put(ids[i], 'ACCEPT', { bill: bills[i] }, 'out');
  const part = put(ids[0], 'PAYMENT_CLAIM', { bill: bills[0], amountPaise: 300000, method: 'upi', utr: 'INVENTED-PART', screenshot: { sha256: 'a'.repeat(64) }, paidOn: '2026-10-22' }, 'out');
  put(ids[0], 'PAYMENT_ACK', { payment: part, received: true, amountPaise: 300000 });
  const group = { id: '00000000-0000-4000-8000-000000003000', totalPaise: 900000, orders: ids.slice(0, 2) };
  for (const [i, amountPaise] of [500000, 400000].entries()) put(ids[i], 'PAYMENT_CLAIM', { bill: bills[i], amountPaise, method: 'upi', utr: 'INVENTED-GROUP', screenshot: { sha256: 'b'.repeat(64) }, paidOn: '2026-10-23', paidAt: '14:05', group }, 'out');
  const denied = put(ids[1], 'PAYMENT_CLAIM', { bill: bills[1], amountPaise: 100000, method: 'cash', paidOn: '2026-10-24' }, 'out');
  put(ids[1], 'PAYMENT_ACK', { payment: denied, received: false, amountPaise: 100000 });
  put(ids[3], 'PAYMENT_CLAIM', { bill: null, amountPaise: 60000, method: 'cash', paidOn: '2026-10-25' }, 'out');
  const ledger = { ...base, events: (/** @type {string} */ id) => histories.get(id) ?? [],
    view: (/** @type {string} */ id) => ({ state: id === ids[3] ? 'booked' : 'accepted', currentBill: bills[ids.indexOf(id)] ?? null }) };
  return { ledger: /** @type {import('../../src/ledger/store.js').Ledger} */ (/** @type {unknown} */ (ledger)), ids, put, close: () => base.db.close() };
}
