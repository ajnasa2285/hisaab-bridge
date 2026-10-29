import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateOf } from '../../web/order-state.js';

/** @param {string} type @param {Record<string, any>} body @param {string} [msgId] */
const ev = (type, body, msgId = type) => ({ type, msgId, body: { body }, seq: 1, orderId: 'invented-order',
  direction: /** @type {const} */ ('in'), at: '', hash: '', prevHash: '' });

test('judge replay keeps signed evidence, its request and site receipts informational after settlement', () => {
  const booked = [ev('BOOKING_REQUEST', { kind: 'material' }), ev('BOOKING_REPLY', { answer: 'yes', rates: [] })];
  const history = [...booked, ev('DELIVERY', { items: [] }), ev('BILL', { totalPaise: 10000 }), ev('ACCEPT', { bill: 'BILL' }),
    ev('PAYMENT_RECEIVED', { bill: 'BILL', amountPaise: 10000, method: 'cash', receivedOn: '2026-10-29' }),
    ev('SETTLED', { bill: 'BILL', amountPaise: 10000, payments: ['PAYMENT_RECEIVED'] })];
  const settled = stateOf(history);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.fits, true);
  const informational = [ev('SITE_RECEIPT', { delivery: 'DELIVERY', items: [] }), ev('EVIDENCE_REQUEST', { refers_to: 'DELIVERY' }),
    ev('EVIDENCE', { items: [{ record: 'DELIVERY', sha256: 'a'.repeat(64) }] })];
  assert.deepEqual(stateOf([...history, ...informational]), settled);
  assert.equal(stateOf([...booked, informational[0]]).fits, false, 'a site receipt still requires delivery');
  assert.equal(stateOf([informational[1]]).fits, false, 'an evidence request still needs an order');
  assert.equal(stateOf([...history, ev('EVIDENCE', { kind: 'meter' })]).fits, false, 'a new local meter reading is not a signed evidence exchange');
});
