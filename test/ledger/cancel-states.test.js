// CANCEL in the order states and the message format: allowed before any work, money or bill; terminal;
// and ledgers from before it replay as they did. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { emptyView, refusedIds, replay, step } from '../../src/ledger/states.js';
import { bodyIsValid } from '../../src/protocol/messages.js';
import { openLedger } from '../../src/ledger/store.js';
import { stateOf } from '../../web/order-state.js';

/** @param {string} type @param {Record<string, any>} [body] @param {string} [id] */
const ev = (type, body = {}, id = randomUUID()) => ({ type, msg_id: id, body });
const jcb = () => [ev('BOOKING_REQUEST', { kind: 'jcb_hours' })];
const booked = () => [...jcb(), ev('BOOKING_REPLY', { answer: 'yes', ratePaise: 120000 })];
const material = () => [ev('BOOKING_REQUEST', { kind: 'material' }), ev('BOOKING_REPLY', { answer: 'yes', rates: [] })];
const meter = ev('EVIDENCE', { kind: 'meter', which: 'start', valueTenths: 1, sha256: 'a'.repeat(64) });
const bill = (/** @type {string} */ id) => ev('BILL', { totalPaise: 100, evidence: [{ kind: 'meter' }] }, id);

test('a booked, requested or offered order can be cancelled; the state is terminal', () => {
  for (const events of [booked(), jcb(), [...jcb(), ev('BOOKING_REPLY', { answer: 'other_time', day: '2026-11-02' })], material()]) {
    assert.equal(replay([...events, ev('CANCEL')]).state, 'cancelled');
  }
});

test('not after the work began, a delivery, a bill or settlement', () => {
  const b = randomUUID();
  const later = [
    [...booked(), meter],
    [...material(), ev('DELIVERY', {})],
    [...booked(), bill(b)],
    [...booked(), bill(b), ev('ACCEPT', { bill: b })],
    [...jcb(), ev('BOOKING_REPLY', { answer: 'no' })],
  ];
  for (const events of later) assert.equal(step(replay(events), ev('CANCEL')), null, replay(events).state);
});

test('money blocks it: an advance waiting or confirmed; a claim the seller denied does not', () => {
  const claim = randomUUID();
  const claimed = [...booked(), ev('PAYMENT_CLAIM', { bill: null, amountPaise: 500000 }, claim)];
  assert.equal(step(replay(claimed), ev('CANCEL')), null, 'waiting');
  const confirmed = [...claimed, ev('PAYMENT_ACK', { payment: claim, received: true, amountPaise: 500000 })];
  assert.equal(step(replay(confirmed), ev('CANCEL')), null, 'confirmed');
  assert.equal(step(replay([...booked(), ev('PAYMENT_RECEIVED', { bill: null, amountPaise: 500000 })]), ev('CANCEL')), null, 'seller recorded');
  const denied = [...claimed, ev('PAYMENT_ACK', { payment: claim, received: false, amountPaise: 500000 })];
  assert.equal(replay([...denied, ev('CANCEL')]).state, 'cancelled');
});

test('nothing moves a cancelled order: no reply, delivery, bill, payment or meter reading', () => {
  const j = replay([...booked(), ev('CANCEL')]);
  const m = replay([...material(), ev('CANCEL')]);
  for (const e of [ev('BOOKING_REQUEST', { kind: 'jcb_hours' }), ev('BOOKING_REPLY', { answer: 'yes', ratePaise: 1 }), meter, bill(randomUUID()),
    ev('PAYMENT_CLAIM', { bill: null, amountPaise: 1 }), ev('PAYMENT_RECEIVED', { bill: null, amountPaise: 1 })]) assert.equal(step(j, e), null, e.type);
  for (const e of [ev('DELIVERY', {}), ev('SITE_RECEIPT', {})]) assert.equal(step(m, e), null, e.type);
  // Both sides cancelling at once: each other's message changes nothing, and both are receipted.
  assert.equal(step(j, ev('CANCEL'))?.state, 'cancelled');
});

test('the message: an empty signed body, nothing else', () => {
  assert.equal(bodyIsValid('CANCEL', {}), true);
  assert.equal(bodyIsValid('CANCEL', { amountPaise: 1 }), false);
});

test('a CANCEL the other side refused never happened; the chain still verifies', () => {
  const ledger = openLedger(':memory:');
  const orderId = randomUUID();
  const at = '2026-10-31T00:00:00.000Z';
  ledger.ensureOrder({ orderId, kind: 'jcb_hours', counterparty: 'agent:jcb-1', site: 'Invented', at });
  const msg = (/** @type {string} */ type, /** @type {any} */ body, /** @type {'in'|'out'} */ direction = 'out', id = randomUUID()) => ledger.append({ orderId, direction, type, msgId: id, at, body: { body } });
  msg('BOOKING_REQUEST', { kind: 'jcb_hours' });
  msg('BOOKING_REPLY', { answer: 'yes', ratePaise: 1 }, 'in');
  const cancel = msg('CANCEL', {});
  assert.equal(ledger.view(orderId).state, 'cancelled');
  msg('REFUSE', { refers_to: cancel?.msgId, code: 'WRONG_STATE' }, 'in');
  assert.equal(ledger.view(orderId).state, 'booked');
  assert.equal(msg('CANCEL', {}) !== null, true);
  assert.equal(ledger.view(orderId).state, 'cancelled');
  assert.equal(ledger.verifyChain().ok, true);
  ledger.db.close();
});

test('old chains: the sample ledgers (no CANCEL anywhere) replay to the same states on both replays', () => {
  const sample = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  let orders = 0;
  for (const side of [sample.jcb, sample.contractor, sample.supplier]) {
    /** @type {Map<string, any[]>} */
    const byOrder = new Map();
    for (const e of side.events) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) ?? []), e]);
    assert.ok(!side.events.some((/** @type {any} */ e) => e.type === 'CANCEL'));
    for (const events of byOrder.values()) {
      const refused = refusedIds(events);
      const counted = events.filter((e) => e.direction !== 'out' || !refused.has(e.msgId));
      const v = replay(counted.map((e) => ({ type: e.type, msg_id: e.msgId, body: e.direction === 'local' ? e.body : e.body.body })));
      const web = stateOf(events);
      assert.notEqual(v.state, 'cancelled');
      assert.equal(web.fits, true);
      assert.equal(web.state, v.state);
      orders += 1;
    }
  }
  assert.ok(orders > 0);
  assert.deepEqual(emptyView().state, 'none');
});

test('the judge page replays a cancelled order, and flags one cancelled after the work began', () => {
  const at = '2026-10-31T00:00:00.000Z';
  /** @param {string} type @param {any} body @param {'in'|'out'|'local'} [direction] */
  const e = (type, body, direction = 'out') => /** @type {any} */ ({ orderId: 'o', direction, type, msgId: randomUUID(), at, body: direction === 'local' ? body : { body } });
  const book = [e('BOOKING_REQUEST', { kind: 'jcb_hours' }), e('BOOKING_REPLY', { answer: 'yes', ratePaise: 1 }, 'in')];
  const good = stateOf([...book, e('CANCEL', {})]);
  assert.deepEqual([good.state, good.fits], ['cancelled', true]);
  assert.equal(stateOf([...book, e('EVIDENCE', { kind: 'meter' }, 'local'), e('CANCEL', {})]).fits, false);
  assert.equal(stateOf([...book, e('CANCEL', {}), e('EVIDENCE', { kind: 'meter' }, 'local')]).fits, false);
  assert.equal(stateOf([...book, e('PAYMENT_RECEIVED', { bill: null, amountPaise: 100, method: 'cash', receivedOn: '2026-10-31' }, 'in'), e('CANCEL', {})]).fits, false);
});
