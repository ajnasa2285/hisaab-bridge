// A known peer's message with an order id of the right length but not a UUID still gets a signed refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeys, signMessage } from '../../src/protocol/keys.js';
import { receive } from '../../src/protocol/exchange.js';

test('a refusal to a known peer survives an order id that is 36 characters but no UUID', () => {
  const me = generateKeys();
  const peer = generateKeys();
  const nowMs = Date.parse('2026-10-31T00:00:00.000Z');
  const m = signMessage({
    v: 'hb/0.1', msg_id: '11111111-1111-4111-8111-111111111111', type: 'BOOKING_REQUEST', from: 'agent:b', to: 'agent:a',
    order_id: '-'.repeat(36), rev: 1, created_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + 1000).toISOString(),
    body: { kind: 'jcb_hours', site: 'X', day: '2026-11-01', hoursTenths: 20 },
  }, peer.privateKey);
  const agent = {
    self: { id: 'agent:a', privateKey: me.privateKey },
    peers: new Map([['agent:b', { publicKey: peer.publicKey, mayReceiveFrom: new Set(['BOOKING_REQUEST']) }]]),
    ledger: /** @type {any} */ ({ hasMessage: () => false }),
    now: () => nowMs,
  };
  const r = receive(/** @type {any} */ (agent), m);
  assert.equal(r.answer.type, 'REFUSE');
  assert.equal(r.answer.body.code, 'BAD_BODY');
  assert.equal(r.applied, false);
});
