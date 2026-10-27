// The sample export the judge page is developed on must be real: every signed message in it
// verifies with the public key it names, and both hash chains recompute from the stored rows.

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
  const keys = new Map([[x.jcb.agentId, publicKeyFromText(x.jcb.publicKey)], [x.contractor.agentId, publicKeyFromText(x.contractor.publicKey)]]);
  for (const side of [x.jcb, x.contractor]) {
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
  // The story the page tells: dispute, correction naming the first bill, payment claim, settled.
  const types = x.contractor.events.map((e) => e.type);
  for (const t of ['BOOKING_REQUEST', 'BOOKING_REPLY', 'BILL', 'DISPUTE', 'CORRECTION', 'ACCEPT', 'PAYMENT_CLAIM', 'SETTLED', 'RECEIPT']) assert.ok(types.includes(t), t);
  const bill = x.contractor.events.find((e) => e.type === 'BILL');
  const correction = x.contractor.events.find((e) => e.type === 'CORRECTION');
  assert.ok(bill && correction);
  assert.equal(correction.body.body.replaces, bill.msgId);
  assert.equal(bill.body.body.evidence.length, 2, 'both meter photos on the bill');
}

test('the committed sample export verifies: signatures and both chains', () => {
  const x = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  checkExport(x);
  const text = JSON.stringify(x);
  assert.doesNotMatch(text, /\b91[6-9]\d{9}\b(?<!9190000000\d\d)/, 'no real-looking phone number');
  assert.doesNotMatch(text, /PRIVATE KEY/);
});

test('make-sample builds a fresh export that verifies too', async () => {
  checkExport(await buildSample());
});
