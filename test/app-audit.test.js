// The whole app on what the audit found silent or overlapping: a failed handling gets one reply, a
// message past its expiry with no answer is told (now, or when the person next writes), and the retry timer
// never runs over itself. Graph API and the peer are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from '../src/app.js';
import { runTool } from '../src/agents/common.js';
import { t } from '../src/i18n/index.js';

const CONTRACTOR = '919000000061';
const HOUR = 3600 * 1000;
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * @param {import('node:test').TestContext} tc
 * @param {{transport?: (url: string, m: any) => Promise<unknown>, graph?: (url: string) => Response | null}} [o]
 */
async function desk(tc, o = {}) {
  // Only the retry interval is under the test's hand; everything else keeps real time.
  tc.mock.timers.enable({ apis: ['setInterval'] });
  const dir = mkdtempSync(join(tmpdir(), 'hb-audit-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {string[]} */
  const logs = [];
  let nowMs = Date.parse('2026-10-29T02:30:00Z');
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    const special = o.graph?.(String(input));
    if (special) return special;
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ to: body.to, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** @type {any} */
  let app = null;
  const server = createServer(async (req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const jk = generateKeys();
  const ck = generateKeys();
  const peer = (/** @type {string} */ id, /** @type {any} */ key, /** @type {any[]} */ types) => ({ id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) });
  app = createApp({
    baseUrl: base,
    agents: [
      { name: 'jcb', kind: 'jcb', id: 'agent:jcb-1', title: 'JCB', privateKey: jk.privateKey, ledgerFile: join(dir, 'jcb.db'),
        peers: [peer('agent:contractor-1', ck.publicKey, ['BOOKING_REQUEST', 'RECEIPT', 'REFUSE'])], peerUrls: { 'agent:contractor-1': `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: 'agent:contractor-1', title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer('agent:jcb-1', jk.publicKey, ['BOOKING_REPLY', 'RECEIPT', 'REFUSE'])], peerUrls: { 'agent:jcb-1': `${base}/agents/jcb` }, jcbAgentId: 'agent:jcb-1' },
    ],
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v', accessToken: 'tok' }],
    people: [{ line: 'line-site', phone: CONTRACTOR, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' }],
    waStoreFile: join(dir, 'wa.db'),
    spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
    fetch,
    transport: o.transport ?? (async () => { throw new Error('down'); }),
    now: () => nowMs,
    log: (/** @type {string} */ l) => { logs.push(l); },
  });
  tc.after(async () => {
    tc.mock.timers.reset();
    await new Promise((r) => server.close(() => r(undefined)));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let n = 0;
  return {
    app, sent, logs,
    advance: (/** @type {number} */ ms) => { nowMs += ms; },
    tick: async () => { tc.mock.timers.tick(60_000); await settle(); },
    /** A message from the contractor. @param {Record<string, unknown>} content */
    say: async (content) => {
      n += 1;
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
        messages: [{ from: CONTRACTOR, id: `wamid.in${n}`, timestamp: String(Math.floor(nowMs / 1000)), ...content }] } }] }] });
      const r = await globalThis.fetch(`${base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret-site').update(body).digest('hex')}` }, body });
      assert.equal(r.status, 200);
      await settle();
    },
    /** The contractor's JCB request, which cannot get through. */
    request: async () => {
      const entry = app.agent('agent:contractor-1');
      const r = await runTool(entry.agent.tools, /** @type {any} */ ({ line: 'line-site', phone: CONTRACTOR, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' }),
        { tool: 'request_jcb', args: { site: 'Rampur', day: '2026-10-30' } });
      assert.equal(r.key, 'common.pending');
    },
  };
}

const IMAGE = { type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } };

test('a photo too large to fetch gets its own reply, once', async (tc) => {
  const d = await desk(tc, { graph: (url) => (url.endsWith('/media-1') ? Response.json({ url: 'https://media.invalid/x', file_size: 11 * 1024 * 1024 }) : null) });
  await d.say(IMAGE);
  assert.deepEqual(d.sent.map((s) => s.text), [t('common.media_too_large')]);
  assert.ok(d.logs.some((l) => l.includes('media too large')));
});

test('any other failure while handling a message gets the try-again reply, once', async (tc) => {
  const d = await desk(tc, { graph: (url) => (url.endsWith('/media-1') ? new Response('', { status: 500 }) : null) });
  await d.say(IMAGE);
  assert.deepEqual(d.sent.map((s) => s.text), [t('common.try_again')]);
});

test('a message past its expiry with no answer while the person\'s window is open: told at once, once', async (tc) => {
  const d = await desk(tc);
  await d.request();
  d.advance(23 * HOUR);
  await d.say({ type: 'text', text: { body: 'मदद' } });
  const before = d.sent.length;
  d.advance(2 * HOUR);
  await d.tick();
  assert.deepEqual(d.sent.slice(before).map((s) => s.text), [t('common.delivery_unsure', { ref: 'J-1', site: 'Rampur' })]);
  assert.ok(d.logs.some((l) => l.includes('BOOKING_REQUEST past its expiry')));
  await d.tick();
  assert.equal(d.sent.length, before + 1, 'once');
});

test('the same when the window is closed: told once when the person next writes', async (tc) => {
  const d = await desk(tc);
  await d.request();
  d.advance(25 * HOUR);
  await d.tick();
  assert.equal(d.sent.length, 0, 'nothing may be sent outside the window');
  await d.say({ type: 'text', text: { body: 'मदद' } });
  const notice = t('common.delivery_unsure', { ref: 'J-1', site: 'Rampur' });
  assert.equal(d.sent[0].text, notice);
  await d.say({ type: 'text', text: { body: 'मदद' } });
  assert.equal(d.sent.filter((s) => s.text === notice).length, 1);
});

test('whatsapp1: an expectation stands only on a notice that really went; with a question open the notice says what a bare yes answers', async (tc) => {
  const d = await desk(tc);
  const entry = d.app.agent('agent:contractor-1');
  const person = /** @type {any} */ ({ line: 'line-site', phone: CONTRACTOR, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' });
  /** @param {string} msgId */
  const bill = (msgId) => ({ type: 'BILL', msg_id: msgId, order_id: '11111111-1111-4111-8111-111111111111', body: { lines: [{ what: 'JCB', hoursTenths: 10, ratePaise: 100000, amountPaise: 100000 }], totalPaise: 100000, evidence: [] } });
  // Outside the 24-hour window nothing goes, so no yes can mean it.
  await entry.agent.onApplied(bill('22222222-2222-4222-8222-222222222222'));
  assert.equal(d.sent.length, 0);
  assert.equal(entry.talk.pending(person), null);
  // Window open, nothing open: the notice as it is, and its yes means it.
  await d.say({ type: 'text', text: { body: 'मदद' } });
  const before = d.sent.length;
  await entry.agent.onApplied(bill('33333333-3333-4333-8333-333333333333'));
  assert.equal(d.sent.slice(before).length, 1);
  assert.equal(d.sent.at(-1)?.text.includes(t('common.question_waits')), false);
  assert.equal(entry.talk.pending(person).args.bill, '33333333-3333-4333-8333-333333333333');
  // A second one while that question is open keeps that question and says so.
  await entry.agent.onApplied(bill('44444444-4444-4444-8444-444444444444'));
  assert.equal(d.sent.at(-1)?.text.includes(t('common.question_waits')), true);
  assert.equal(entry.talk.pending(person).args.bill, '33333333-3333-4333-8333-333333333333');
});

test('the retry timer never overlaps itself: a slow pass makes the next tick wait', async (tc) => {
  let calls = 0;
  /** @type {() => void} */
  let release = () => {};
  const d = await desk(tc, { transport: async () => {
    calls += 1;
    if (calls === 1) throw new Error('down');
    await new Promise((r) => { release = () => r(undefined); });
    throw new Error('still down');
  } });
  await d.request();
  assert.equal(calls, 1);
  await d.tick();
  assert.equal(calls, 2, 'the pass started and hangs');
  await d.tick();
  await d.tick();
  assert.equal(calls, 2, 'no second pass while it runs');
  release();
  await settle();
  await d.tick();
  assert.equal(calls, 3, 'the next tick runs again');
  release();
  await settle();
});
