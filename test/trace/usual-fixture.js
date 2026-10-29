/** @typedef {import('../../src/ledger/store.js').LedgerEvent} Ev */

/** Invented accepted material history. @param {number} [count] @param {string} [counterparty] */
export function usualHistory(count = 3, counterparty = 'agent:supplier-1') {
  /** @type {Ev[]} */
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const orderId = `past-${counterparty}-${i}`;
    events.push(event(events.length + 1, orderId, 'BOOKING_REQUEST', { kind: 'material', site: 'नमूना साइट', day: '2026-10-28', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }] }, counterparty));
    events.push(event(events.length + 1, orderId, 'BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 38000, gstPercent: 28 }] }, counterparty));
    events.push(event(events.length + 1, orderId, 'DELIVERY', { items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }] }, counterparty));
    const bill = event(events.length + 1, orderId, 'BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 38000, amountPaise: 2432000, taxablePaise: 1900000, gstPercent: 28, gstPaise: 532000 }], totalPaise: 2432000 }, counterparty);
    events.push(bill, event(events.length + 2, orderId, 'ACCEPT', { bill: bill.msgId }, counterparty));
  }
  return events;
}

/** @param {number} seq @param {string} orderId @param {string} type @param {Record<string, any>} body @param {string} [counterparty] @returns {Ev} */
export function event(seq, orderId, type, body, counterparty = 'agent:supplier-1') {
  const out = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE'].includes(type);
  const msgId = `${orderId}-${type}-${seq}`;
  return { seq, orderId, type, msgId, direction: out ? 'out' : 'in', at: '2026-10-28T04:00:00Z', hash: '', prevHash: '',
    body: { from: out ? 'agent:contractor-1' : counterparty, to: out ? counterparty : 'agent:contractor-1', order_id: orderId, msg_id: msgId, body } };
}
