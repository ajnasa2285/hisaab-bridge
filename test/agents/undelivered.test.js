// A message that can no longer reach the other agent (audit MED-05): it ends in a local note, is not
// retried, does not count in the order, and the person is told. Real agents over real HTTP; invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { createLink, undeliveredNotices } from '../../src/agents/link.js';
import { setup, person } from './helpers.js';

const contractor = person('contractor', 'agent:contractor-1');
const DAY_MS = 24 * 3600 * 1000;

/**
 * A second link on the contractor's ledger that records what it would tell, with its own way out.
 * @param {Awaited<ReturnType<typeof setup>>} s @param {(url: string, m: any) => Promise<unknown>} transport
 */
function watched(s, transport) {
  /** @type {any[]} */
  const told = [];
  const link = createLink(s.siteCore, { peerUrls: new Map([['agent:jcb-1', 'http://peer.invalid']]), transport, onUndelivered: async (m) => { told.push(m); } });
  return { link, told };
}

/** A JCB request written on the contractor's side that did not get through. @param {Awaited<ReturnType<typeof setup>>} s */
async function stuck(s) {
  s.net.up = false;
  const r = await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29' } });
  assert.equal(r.key, 'common.pending');
  s.net.up = true;
  return String(/** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id);
}

/** @param {Awaited<ReturnType<typeof setup>>} s @param {string} orderId */
const notes = (s, orderId) => s.siteCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'undelivered');

test('the peer refuses a message as EXPIRED: noted, told once, no more retries, the order is free again', async () => {
  const s = await setup();
  try {
    const orderId = await stuck(s);
    const { sendToAgent } = await import('../../src/transport/a2a.js');
    const { link, told } = watched(s, (_url, m) => sendToAgent(peerUrl(s), m));
    s.advance(DAY_MS + 60_000);
    const [d] = await link.retryPending();
    assert.deepEqual([d.ok, !d.ok && d.reason, !d.ok && 'code' in d && d.code], [false, 'refused', 'EXPIRED']);
    assert.equal(s.jcbCore.ledger.orders().length, 0, 'the peer did not take it');
    const [note] = notes(s, orderId);
    assert.equal(note.body.type, 'BOOKING_REQUEST');
    assert.equal(note.body.msg_id, told[0].msg_id);
    assert.equal(told.length, 1);
    assert.deepEqual(link.pending(), []);
    assert.deepEqual(await link.retryPending(), [], 'not tried again');
    assert.equal(told.length, 1);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'none');
  } finally {
    await s.close();
  }
});

test('past its expiry and still unreachable: one last try, then noted and told; it does not count and the order can be asked again', async () => {
  const s = await setup();
  try {
    const orderId = await stuck(s);
    let tries = 0;
    const { link, told } = watched(s, async () => { tries += 1; throw new Error('down'); });

    // Before expiry it stays pending, however often it fails.
    s.advance(DAY_MS - 60_000);
    await link.retryPending();
    assert.equal(link.pending().length, 1);
    assert.equal(told.length, 0);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'requested');

    s.advance(120_000);
    await link.retryPending();
    assert.equal(tries, 2);
    assert.equal(notes(s, orderId).length, 1);
    assert.equal(told.length, 1);
    assert.deepEqual(link.pending(), []);
    await link.retryPending();
    assert.equal(tries, 2, 'not tried again');
    assert.equal(s.siteCore.ledger.view(orderId).state, 'none', 'never happened, as with a refusal');
    assert.deepEqual(undeliveredNotices(s.siteCore.ledger), [{ key: 'common.undelivered', params: { ref: 'J-1', site: 'Shivpuri' } }]);
    assert.equal(s.siteCore.ledger.verifyChain().ok, true);

    // Not busy any more: the person's "send it again" works and reaches the other side.
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { orderId, site: 'Shivpuri', day: '2026-10-31' } })).ok, true);
    assert.equal(s.jcbCore.ledger.orders().length, 1);
  } finally {
    await s.close();
  }
});

/** The JCB agent's real address, from the helpers' own link. @param {Awaited<ReturnType<typeof setup>>} s */
function peerUrl(s) {
  return /** @type {string} */ (s.peerUrls.get('agent:jcb-1'));
}
