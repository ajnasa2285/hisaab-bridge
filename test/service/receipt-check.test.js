// What one agent shows another for the ledger check, and who it answers. Pure; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeys, signMessage } from '../../src/protocol/keys.js';
import { askerOf, peerView, signedRequest } from '../../src/service/receipt-check.js';

const JCB = 'agent:jcb-1';
const SUP = 'agent:supplier-1';
const SITE = 'agent:contractor-1';
const AT = '2026-10-30T02:30:00.000Z';

/** The contractor's ledger: one order with the JCB agent, one with the supplier. */
const ledger = () => {
  const row = (/** @type {number} */ seq, /** @type {string} */ orderId, /** @type {any} */ e) => ({ seq, orderId, at: AT, prevHash: 'p', hash: `h${seq}`, msgId: `m${seq}`, body: {}, type: 'NOTE', direction: 'local', ...e });
  const events = [
    row(1, 'o-jcb', { direction: 'out', type: 'BOOKING_REQUEST', body: { from: SITE, to: JCB, body: { site: 'SecretSite' } } }),
    row(2, 'o-jcb', { direction: 'in', type: 'RECEIPT', body: { from: JCB, to: SITE, body: { entry_hash: 'x', chain_head: 'x' } } }),
    row(3, 'o-sup', { direction: 'out', type: 'BOOKING_REQUEST', body: { from: SITE, to: SUP, body: { site: 'SupplierSite', items: ['सीमेंट'] } } }),
    row(4, 'o-sup', { direction: 'in', type: 'RECEIPT', body: { from: SUP, to: SITE, body: {} } }),
    row(5, 'o-jcb', { direction: 'local', type: 'NOTE', body: { kind: 'undelivered', msg_id: 'm1', type: 'BOOKING_REQUEST' } }),
    row(6, 'o-jcb', { direction: 'local', type: 'NOTE', body: { kind: 'private_thought', text: 'not for the other side' } }),
  ];
  return {
    orders: () => /** @type {any} */ ([{ order_id: 'o-jcb', counterparty: JCB }, { order_id: 'o-sup', counterparty: SUP }]),
    events: (/** @type {string} */ id) => /** @type {any} */ (events.filter((e) => e.orderId === id)),
  };
};

test('the view shows the JCB agent its own rows, a bare hash of everything else, and nothing about the supplier', () => {
  const view = peerView(ledger(), JCB, SITE, AT);
  assert.deepEqual(view.events.map((/** @type {any} */ e) => e.seq), [1, 2, 3, 4, 5, 6], 'every row, in order: a chain head may name any of them');
  assert.deepEqual(view.events[2], { seq: 3, hash: 'h3' });
  assert.deepEqual(view.events[3], { seq: 4, hash: 'h4' });
  assert.deepEqual(view.events[5], { seq: 6, hash: 'h6' }, 'a local note is not the other side\'s business');
  assert.equal(/** @type {any} */ (view.events[0]).direction, 'out');
  assert.equal(/** @type {any} */ (view.events[0]).body, undefined, 'a message of ours: its ids, not its words');
  assert.equal(/** @type {any} */ (view.events[1]).body.from, JCB, 'a receipt the asker signed, in full');
  assert.deepEqual(/** @type {any} */ (view.events[4]).body, { kind: 'undelivered', msg_id: 'm1' });
  const text = JSON.stringify(view);
  for (const hidden of [SUP, 'SupplierSite', 'सीमेंट', 'SecretSite', 'private_thought', 'o-sup']) assert.ok(!text.includes(hidden), hidden);
});

test('only a fresh request signed by an agent it deals with, addressed to it, is answered', () => {
  const [jcb, other] = [generateKeys(), generateKeys()];
  const peers = new Map([[JCB, { publicKey: jcb.publicKey }]]);
  const now = Date.parse(AT);
  const self = { id: JCB, privateKey: jcb.privateKey };
  assert.equal(askerOf(signedRequest(self, SITE, now), SITE, peers, now), JCB);
  assert.equal(askerOf(signedRequest(self, SITE, now - 10 * 60 * 1000), SITE, peers, now), null, 'too old');
  assert.equal(askerOf(signedRequest(self, SUP, now), SITE, peers, now), null, 'for someone else');
  assert.equal(askerOf(signedRequest({ id: JCB, privateKey: other.privateKey }, SITE, now), SITE, peers, now), null, 'the right name, another key');
  assert.equal(askerOf(signedRequest({ id: SUP, privateKey: other.privateKey }, SITE, now), SITE, peers, now), null, 'nobody it deals with');
  assert.equal(askerOf(signMessage({ purpose: 'other', from: JCB, to: SITE, at: AT }, jcb.privateKey), SITE, peers, now), null, 'signed for another purpose');
  const changed = { ...signedRequest(self, SITE, now), nonce: 'changed' };
  assert.equal(askerOf(changed, SITE, peers, now), null, 'changed after signing');
  for (const junk of [null, 'x', 1, {}, []]) assert.equal(askerOf(junk, SITE, peers, now), null);
});
