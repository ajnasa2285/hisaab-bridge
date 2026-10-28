// The sample export the judge page is developed on must be real: every signed message in it
// verifies with the public key it names, and all three hash chains recompute from the stored rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicKeyFromText, verifyMessage } from '../../src/protocol/keys.js';
import { canonicalize } from '../../src/protocol/canonical.js';
import { buildSample } from '../../web/sample/make-sample.js';

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
  assert.deepEqual(x.supplier.orders.map((o) => o.order_id), [matOrder.order_id]);
  // References: the contractor's J-1 and P-1, each seller's own.
  assert.deepEqual(x.contractor.refs, { [jcbOrder.order_id]: 'J-1', [matOrder.order_id]: 'P-1' });
  assert.deepEqual(x.jcb.refs, { [jcbOrder.order_id]: 'J-1' });
  assert.deepEqual(x.supplier.refs, { [matOrder.order_id]: 'P-1' });

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
  assert.deepEqual(signedIds(x.supplier.events), signedIds(mat));
  assert.deepEqual(signedIds(x.jcb.events), signedIds(jcbEvents));
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
