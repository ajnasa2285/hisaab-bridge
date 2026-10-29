// Invented accepted orders in one local ledger, with the signed-message envelope used at runtime.
import { openLedger } from '../../src/ledger/store.js';
import assert from 'node:assert/strict';

export function usualBooks() {
  const ledger = openLedger(':memory:');
  const at = '2026-10-29T06:00:00.000Z';
  let id = 0;
  let message = 0;
  /** @param {{kind?: 'material'|'jcb_hours', rate?: number, quantity?: number, hours?: number,
   * unit?: string, site?: string, peer?: string, accepted?: boolean, seller?: boolean}} [o] */
  function add(o = {}) {
    const kind = o.kind ?? 'material';
    const orderId = `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
    const site = o.site ?? 'कल्पित साइट';
    const peer = o.peer ?? (o.seller ? 'agent:contractor-1' : kind === 'material' ? 'agent:supplier-1' : 'agent:jcb-1');
    const local = o.seller ? 'agent:supplier-1' : 'agent:contractor-1';
    const unit = o.unit ?? 'बोरी';
    const item = { name: 'सीमेंट', unit, qtyHundredths: o.quantity ?? 5000 };
    const rate = o.rate ?? (kind === 'material' ? 38000 : 120000);
    ledger.ensureOrder({ orderId, kind, site, counterparty: peer, at });
    /** @param {string} type @param {Record<string, any>} body @param {'in'|'out'} direction */
    function put(type, body, direction) {
      const msgId = `00000000-0000-4000-9000-${String(++message).padStart(12, '0')}`;
      assert.ok(ledger.append({ orderId, type, direction, msgId, at, body: { from: direction === 'out' ? local : peer,
        to: direction === 'out' ? peer : local, msg_id: msgId, order_id: orderId, created_at: at, body } }), `${type} must fit`);
      return msgId;
    }
    const buy = o.seller ? 'in' : 'out';
    const sell = o.seller ? 'out' : 'in';
    put('BOOKING_REQUEST', { kind, site, day: '2026-10-29', ...(kind === 'material' ? { items: [item] } : { hoursTenths: o.hours ?? 70 }) }, buy);
    put('BOOKING_REPLY', { answer: 'yes', ...(kind === 'material' ? { rates: [{ name: item.name, unit, ratePaise: rate, gstPercent: 28 }] } : { ratePaise: rate }) }, sell);
    if (kind === 'material') put('DELIVERY', { items: [item], challan: { sha256: 'a'.repeat(64) }, deliveredAt: at }, sell);
    const taxable = kind === 'material' ? Math.floor((item.qtyHundredths * rate + 50) / 100) : Math.floor(((o.hours ?? 70) * rate + 5) / 10);
    const gst = kind === 'material' ? 2 * Math.floor((taxable * 28 + 100) / 200) : 0;
    const line = { what: kind === 'material' ? item.name : 'JCB', ratePaise: rate, amountPaise: taxable + gst,
      ...(kind === 'material' ? { qtyHundredths: item.qtyHundredths, taxablePaise: taxable, gstPercent: 28, gstPaise: gst } : { hoursTenths: o.hours ?? 70 }) };
    const evidence = kind === 'jcb_hours' ? [{ kind: 'meter', readValue: '100.0', sha256: 'a'.repeat(64), takenAt: null, sentAt: at },
      { kind: 'meter', readValue: `${Math.floor((1000 + (o.hours ?? 70)) / 10)}.${(o.hours ?? 70) % 10}`, sha256: 'b'.repeat(64), takenAt: null, sentAt: at }] : [];
    const bill = put('BILL', { lines: [line], totalPaise: line.amountPaise, evidence }, sell);
    if (o.accepted !== false) put('ACCEPT', { bill }, buy);
    return { orderId, bill, put, buy, sell };
  }
  return { ledger, add, close: () => ledger.db.close() };
}
