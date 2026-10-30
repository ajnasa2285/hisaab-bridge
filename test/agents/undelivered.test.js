// A message past its expiry (audit MED-05, red-team a2a2). Only a signed answer decides: EXPIRED from a
// peer that never saw it ends it in a local note (not retried, does not count, the person is told); a
// receipt means it counts. With no answer it may have been applied, so it keeps counting and goes on at
// a slower pace, and the person is told once. Real agents over real HTTP; invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { createLink, undeliveredNotices, unsureNotices, UNSURE_RETRY_MS } from '../../src/agents/link.js';
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
  /** @type {any[]} */
  const unsure = [];
  const link = createLink(s.siteCore, { peerUrls: new Map([['agent:jcb-1', 'http://peer.invalid']]), transport,
    onUndelivered: async (m) => { told.push(m); }, onUnsure: async (m) => { unsure.push(m); } });
  return { link, told, unsure };
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
/** @param {Awaited<ReturnType<typeof setup>>} s @param {string} orderId */
const unsureNotes = (s, orderId) => s.siteCore.ledger.events(orderId).filter((e) => e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'delivery_unsure');

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

test('past its expiry and unreachable: it may have been applied, so it still counts; told once, tried on at a slower pace', async () => {
  const s = await setup();
  try {
    const orderId = await stuck(s);
    let tries = 0;
    const { link, told, unsure } = watched(s, async () => { tries += 1; throw new Error('down'); });

    // Before expiry it stays pending, however often it fails.
    s.advance(DAY_MS - 60_000);
    await link.retryPending();
    assert.equal(link.pending().length, 1);
    assert.equal(unsure.length, 0);

    s.advance(120_000);
    await link.retryPending();
    assert.equal(tries, 2);
    assert.equal(notes(s, orderId).length, 0, 'never counted as undelivered without a signed answer');
    assert.equal(told.length, 0);
    assert.equal(unsure.length, 1);
    assert.equal(link.pending().length, 1);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'requested', 'still counts');
    assert.deepEqual(unsureNotices(s.siteCore.ledger), [{ key: 'common.delivery_unsure', params: { ref: 'J-1', site: 'Shivpuri' } }]);

    // A slower pace, and the person is not told again.
    await link.retryPending();
    assert.equal(tries, 2, 'not tried again at once');
    s.advance(UNSURE_RETRY_MS + 1000);
    await link.retryPending();
    assert.equal(tries, 3);
    assert.equal(unsure.length, 1);
    assert.equal(unsureNotes(s, orderId).length, 1);
    assert.equal(s.siteCore.ledger.verifyChain().ok, true);

    // Still in flight: nothing new is signed on top of it.
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { orderId, site: 'Shivpuri', day: '2026-10-31' } })).key, 'common.busy');
  } finally {
    await s.close();
  }
});

test('the peer had applied it and only the receipt was lost: the late try brings the receipt, and both ledgers agree', async () => {
  const s = await setup();
  try {
    const { sendToAgent } = await import('../../src/transport/a2a.js');
    let lose = true;
    const { link, told, unsure } = watched(s, async (_url, m) => {
      const answer = await sendToAgent(peerUrl(s), m);
      if (lose) throw new Error('answer lost');
      return answer;
    });
    const orderId = '11111111-1111-4111-8111-111111111111';
    const sent = await link.send({ type: 'BOOKING_REQUEST', to: 'agent:jcb-1', orderId, body: { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-30' } });
    assert.equal(!sent.ok && sent.reason, 'unreachable');
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'requested', 'the peer applied it');

    s.advance(DAY_MS + 60_000);
    await link.retryPending();
    assert.equal(unsure.length, 1);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'requested');

    lose = false;
    s.advance(UNSURE_RETRY_MS + 1000);
    const [d] = await link.retryPending();
    assert.equal(d.ok, true);
    assert.deepEqual(link.pending(), []);
    assert.equal(told.length, 0);
    assert.deepEqual(unsureNotices(s.siteCore.ledger), [], 'decided: nothing more to tell');
    assert.equal(s.siteCore.ledger.view(orderId).state, s.jcbCore.ledger.view(orderId).state);
  } finally {
    await s.close();
  }
});

test('the peer never saw it and came back: its signed EXPIRED decides, and the order can be asked again', async () => {
  const s = await setup();
  try {
    const orderId = await stuck(s);
    const { sendToAgent } = await import('../../src/transport/a2a.js');
    let up = false;
    const { link, told, unsure } = watched(s, async (_url, m) => { if (!up) throw new Error('down'); return sendToAgent(peerUrl(s), m); });
    s.advance(DAY_MS + 60_000);
    await link.retryPending();
    assert.equal(unsure.length, 1);
    up = true;
    s.advance(UNSURE_RETRY_MS + 1000);
    await link.retryPending();
    assert.equal(notes(s, orderId).length, 1);
    assert.equal(told.length, 1);
    assert.deepEqual(link.pending(), []);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'none', 'never happened, as with a refusal');
    assert.deepEqual(undeliveredNotices(s.siteCore.ledger), [{ key: 'common.undelivered', params: { ref: 'J-1', site: 'Shivpuri' } }]);
    assert.deepEqual(unsureNotices(s.siteCore.ledger), []);
    // Not busy any more: the person's "send it again" works and reaches the other side.
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { orderId, site: 'Shivpuri', day: '2026-10-31' } })).ok, true);
    assert.equal(s.jcbCore.ledger.orders().length, 1);
  } finally {
    await s.close();
  }
});

test('an unsigned error is no answer: the message stays pending and nothing is recorded', async () => {
  const s = await setup();
  try {
    const orderId = await stuck(s);
    const { link } = watched(s, async () => ({ type: 'ERROR', code: 'BAD_SIGNATURE' }));
    const [d] = await link.retryPending();
    assert.equal(!d.ok && d.reason, 'bad_answer');
    assert.equal(link.pending().length, 1);
    assert.equal(s.siteCore.ledger.view(orderId).state, 'requested');
  } finally {
    await s.close();
  }
});

/** The JCB agent's real address, from the helpers' own link. @param {Awaited<ReturnType<typeof setup>>} s */
function peerUrl(s) {
  return /** @type {string} */ (s.peerUrls.get('agent:jcb-1'));
}
