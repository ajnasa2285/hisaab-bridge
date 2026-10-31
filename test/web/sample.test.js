// The sample export the judge page is developed on must be real: every signed message in it
// verifies with the public key it names, and all three hash chains recompute from the stored rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicKeyFromText, verifyMessage } from '../../src/protocol/keys.js';
import { canonicalize } from '../../src/protocol/canonical.js';
import { buildSample } from '../../web/sample/make-sample.js';
import { paymentSummary } from '../../src/ledger/payments.js';
import { stateOf } from '../../web/order-state.js';
import { crossCheck } from '../../src/ledger/cross-check.js';

/** @typedef {import('../../web/sample/make-sample.js').Export} Export */

const GENESIS = '0'.repeat(64);

/** @param {Export} x */
function checkExport(x) {
  assert.equal(x.v, 'hb-export/0.1');
  const sides = [x.jcb, x.contractor, x.supplier];
  const keys = new Map(sides.map((s) => [s.agentId, publicKeyFromText(s.publicKey)]));
  assert.equal(keys.size, 3, 'three distinct agents');
  for (const side of sides) {
    assert.deepEqual(side.chain, { ok: true, events: side.events.length });
    let prev = GENESIS;
    let signed = 0;
    for (const e of side.events) {
      // The chain, recomputed the way src/ledger/store.js computes it.
      const content = canonicalize({ seq: e.seq, order_id: e.orderId, direction: e.direction, type: e.type, msg_id: e.msgId, body: e.body, at: e.at });
      assert.equal(e.prevHash, prev, `${side.agentId} seq ${e.seq} prev_hash`);
      assert.equal(e.hash, createHash('sha256').update(prev).update(content).digest('hex'), `${side.agentId} seq ${e.seq} hash`);
      prev = e.hash;
      if (e.direction === 'local') continue;
      const key = keys.get(e.body.from);
      assert.ok(key, `${side.agentId} seq ${e.seq}: unknown sender ${e.body.from}`);
      assert.equal(verifyMessage(e.body, key), true, `${side.agentId} seq ${e.seq} ${e.type} signature`);
      signed += 1;
    }
    assert.ok(signed >= 10, `${side.agentId}: only ${signed} signed messages`);
  }
  // Two orders on the contractor's side, one with each seller; each seller sees only its own.
  const jcbOrder = x.contractor.orders.find((o) => o.kind === 'jcb_hours');
  const matOrder = x.contractor.orders.find((o) => o.kind === 'material');
  assert.ok(jcbOrder && matOrder);
  assert.deepEqual([jcbOrder.counterparty, matOrder.counterparty], [x.jcb.agentId, x.supplier.agentId]);
  assert.deepEqual(x.jcb.orders.map((o) => o.order_id), [jcbOrder.order_id]);
  assert.equal(x.supplier.orders.length, 7);
  assert.equal(x.supplier.orders[0].order_id, matOrder.order_id);
  // References: the contractor's J-1 and P-1, each seller's own.
  assert.equal(x.contractor.refs?.[jcbOrder.order_id], 'J-1');
  assert.equal(x.contractor.refs?.[matOrder.order_id], 'P-1');
  assert.deepEqual(x.jcb.refs, { [jcbOrder.order_id]: 'J-1' });
  assert.equal(x.supplier.refs?.[matOrder.order_id], 'P-1');

  // The JCB story: dispute, correction naming the first bill, payment claim, settled.
  const jcbEvents = x.contractor.events.filter((e) => e.orderId === jcbOrder.order_id);
  const types = jcbEvents.map((e) => e.type);
  for (const t of ['BOOKING_REQUEST', 'BOOKING_REPLY', 'BILL', 'DISPUTE', 'CORRECTION', 'ACCEPT', 'PAYMENT_CLAIM', 'SETTLED', 'RECEIPT']) assert.ok(types.includes(t), t);
  const bill = jcbEvents.find((e) => e.type === 'BILL');
  const correction = jcbEvents.find((e) => e.type === 'CORRECTION');
  assert.ok(bill && correction);
  assert.equal(correction.body.body.replaces, bill.msgId);
  assert.equal(bill.body.body.evidence.length, 2, 'both meter photos on the bill');

  // The material story: rates per item, delivery with a challan, the site's count differing (a
  // local NOTE on the contractor's side only), a quantity dispute, correction, accept, settled.
  const mat = x.contractor.events.filter((e) => e.orderId === matOrder.order_id);
  const mtypes = mat.map((e) => e.type);
  for (const t of ['BOOKING_REQUEST', 'BOOKING_REPLY', 'DELIVERY', 'NOTE', 'BILL', 'DISPUTE', 'CORRECTION', 'ACCEPT', 'PAYMENT_CLAIM', 'SETTLED']) assert.ok(mtypes.includes(t), `material ${t}`);
  const reply = mat.find((e) => e.type === 'BOOKING_REPLY');
  assert.deepEqual(reply?.body.body.rates, [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }]);
  const delivery = mat.find((e) => e.type === 'DELIVERY');
  assert.deepEqual([delivery?.body.body.challan.number, delivery?.body.body.items[0].qtyHundredths], ['412', 5000]);
  assert.match(delivery?.body.body.challan.sha256, /^[0-9a-f]{64}$/);
  const note = mat.find((e) => e.type === 'NOTE');
  assert.deepEqual([note?.direction, note?.body.kind, note?.body.items[0].qtyHundredths], ['local', 'site_count', 4800]);
  assert.equal(x.supplier.events.filter((e) => e.type === 'NOTE').length, 0, 'the site count never leaves the contractor');
  const mbill = mat.find((e) => e.type === 'BILL');
  assert.deepEqual(mbill?.body.body.lines, [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 }]);
  assert.deepEqual(mbill?.body.body.evidence.map((/** @type {any} */ e) => [e.kind, e.readValue]), [['challan', '412']]);
  const mdispute = mat.find((e) => e.type === 'DISPUTE');
  assert.deepEqual(mdispute?.body.body.theirFigure, { qtyHundredths: 4800 });
  const mcorr = mat.find((e) => e.type === 'CORRECTION');
  assert.deepEqual([mcorr?.body.body.replaces, mcorr?.body.body.totalPaise], [mbill?.msgId, 1680000]);
  assert.equal(mat.find((e) => e.type === 'SETTLED')?.body.body.amountPaise, 1680000);
  // The same signed messages on both sides of each order.
  const signedIds = (/** @type {any[]} */ evs) => evs.filter((e) => e.direction !== 'local' && e.type !== 'RECEIPT').map((e) => e.msgId).sort();
  assert.deepEqual(signedIds(x.supplier.events.filter((e) => e.orderId === matOrder.order_id)), signedIds(mat));
  assert.deepEqual(signedIds(x.jcb.events), signedIds(jcbEvents));

  // The new signed contract example: cash advance and partial payment, two UPI shares, waiting,
  // denied and credited money. Both sides must compute exactly the same per-order summary.
  const p2 = x.supplier.orders[1].order_id, p3 = x.supplier.orders[2].order_id;
  for (const id of [p2, p3]) assert.deepEqual(paymentSummary(x.contractor.events.filter((e) => e.orderId === id)), paymentSummary(x.supplier.events.filter((e) => e.orderId === id)));
  const second = paymentSummary(x.contractor.events.filter((e) => e.orderId === p2));
  const third = paymentSummary(x.contractor.events.filter((e) => e.orderId === p3));
  assert.equal(second.payments[0].advance, true);
  assert.equal(second.payments[0].method, 'cash');
  assert.deepEqual([second.confirmedPaise, second.duePaise, second.settled], [100000, 0, true]);
  assert.deepEqual([third.confirmedPaise, third.waitingPaise, third.duePaise, third.creditPaise], [85000, 5000, 0, 5000]);
  assert.ok(third.payments.some((p) => p.status === 'denied'));
  const shares = [...second.payments, ...third.payments].filter((p) => p.group);
  assert.equal(shares.length, 2);
  assert.equal(shares[0].group?.id, shares[1].group?.id);
  assert.equal(shares.reduce((sum, p) => sum + p.amountPaise, 0), shares[0].group?.totalPaise);
  for (const name of ['payment_balance', 'payment_shares', 'payment_utr']) assert.ok(x.supplier.trace?.some((e) => e.detail.name === name && e.detail.pass === true), name);
  for (const side of sides) for (const order of side.orders) assert.equal(stateOf(side.events.filter((e) => e.orderId === order.order_id)).fits, true, `${side.agentId}: ${side.refs?.[order.order_id]} display replay`);
  assert.equal(stateOf(x.contractor.events.filter((e) => e.orderId === p2)).state, 'settled');
  assert.equal(stateOf(x.contractor.events.filter((e) => e.orderId === p3)).state, 'payment_claimed');
  const unusualOrder = x.supplier.orders[6].order_id;
  assert.equal(stateOf(x.contractor.events.filter((e) => e.orderId === unusualOrder)).state, 'billed', 'unusual figure does not hold or accept');
  for (const side of [x.contractor, x.supplier]) {
    const check = side.trace?.find((e) => e.orderId === unusualOrder && e.detail.name === 'usual' && e.detail.metric === 'rate');
    assert.ok(check);
    assert.deepEqual([check.detail.value, check.detail.median, check.detail.n, check.detail.pct, check.detail.unusual], [50000, 38000, 4, 32, true]);
  }
}

test('the committed sample export verifies: signatures and all three chains', () => {
  const x = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  checkExport(x);
  const text = JSON.stringify(x);
  assert.doesNotMatch(text, /\b91[6-9]\d{9}\b(?<!9190000000\d\d)/, 'no real-looking phone number');
  assert.doesNotMatch(text, /PRIVATE KEY/);
});

test('make-sample builds a fresh export that verifies too', async () => {
  checkExport(await buildSample());
});

test('the committed sample passes the receipts cross-check, for every pair and each signature', () => {
  const x = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  for (const seller of [x.jcb, x.supplier]) {
    const keys = new Map([x.contractor, seller].map((s) => [s.agentId, publicKeyFromText(s.publicKey)]));
    const r = crossCheck({ id: x.contractor.agentId, events: x.contractor.events }, { id: seller.agentId, events: seller.events }, { verify: (e) => verifyMessage(e.body, /** @type {any} */ (keys.get(e.body.from))) });
    assert.deepEqual(r.mismatches, []);
    assert.ok(r.receipts > 0);
    assert.equal(r.signaturesChecked, r.receipts);
  }
});
