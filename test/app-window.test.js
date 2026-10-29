// Notices lost outside WhatsApp's 24-hour window (live test, 29 Oct): when such a person next writes
// to the bot, they first get what is still waiting for them, rebuilt from the ledger, each item once;
// then their own message is handled. Graph API is a stand-in; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from './../src/app.js';
import { openWaStore } from '../src/wa/store.js';

const OWNER = '919000000051';
const OPERATOR = '919000000052';
const CONTRACTOR = '919000000053';

test('wa store: a missed notice is remembered by reference and key only, and taken once', () => {
  const store = openWaStore(':memory:');
  store.missed('line-jcb', OWNER, 'J-1', 'jcb.booking_request', 1);
  store.missed('line-jcb', OWNER, 'J-1', 'jcb.booking_request', 2);
  store.missed('line-jcb', OWNER, 'J-2', 'jcb.payment_claimed', 3);
  assert.deepEqual(store.takeMissed('line-jcb', OWNER), [{ ref: 'J-1', key: 'jcb.booking_request' }, { ref: 'J-2', key: 'jcb.payment_claimed' }]);
  assert.deepEqual(store.takeMissed('line-jcb', OWNER), []);
  store.close();
});

test('the JCB owner and operator, who had not written today, get their waiting notices once when they next write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-window-'));
  /** @type {{to: string, text: string}[]} */
  const sent = [];
  /** @type {typeof globalThis.fetch} */
  const fakeGraph = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ to: body.to, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** @type {{name: string, args: any}[]} */
  let nextCalls = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: nextCalls });
  /** @type {string[]} */
  const logs = [];

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
        peers: [peer('agent:contractor-1', ck.publicKey, ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'])],
        peerUrls: { 'agent:contractor-1': `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: 'agent:contractor-1', title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer('agent:jcb-1', jk.publicKey, ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'])],
        peerUrls: { 'agent:jcb-1': `${base}/agents/jcb` }, jcbAgentId: 'agent:jcb-1' },
    ],
    lines: [
      { name: 'jcb', phoneNumberId: 'line-jcb', appSecret: 'secret-jcb', verifyToken: 'v1', accessToken: 'tok-jcb' },
      { name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v2', accessToken: 'tok-site' },
    ],
    people: [
      { line: 'line-jcb', phone: OWNER, agent: 'agent:jcb-1', role: 'jcb_owner', name: 'Owner' },
      { line: 'line-jcb', phone: OPERATOR, agent: 'agent:jcb-1', role: 'operator', name: 'Operator' },
      { line: 'line-site', phone: CONTRACTOR, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' },
    ],
    waStoreFile: join(dir, 'wa.db'),
    spark,
    fetch: fakeGraph,
    log: (/** @type {string} */ l) => { logs.push(l); },
  });

  let n = 0;
  /** @param {string} name @param {string} line @param {string} secret @param {string} from @param {string} text */
  const say = async (name, line, secret, from, text) => {
    n += 1;
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: line }, messages: [{ from, id: `wamid.in${n}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    });
    const r = await fetch(`${base}/wa/${name}/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
  };
  const wait = async (/** @type {() => boolean} */ until) => { for (let i = 0; i < 100 && !until(); i += 1) await new Promise((r) => setTimeout(r, 20)); };
  const to = (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).map((s) => s.text);

  try {
    // The contractor asks for the JCB; the owner has not written today, so the notice is not sent.
    await say('site', 'line-site', 'secret-site', CONTRACTOR, 'मदद');
    nextCalls = [{ name: 'request_jcb', args: { site: 'Rampur', day: 'tomorrow', time: '8', hours: '6' } }];
    await say('site', 'line-site', 'secret-site', CONTRACTOR, 'kal 8 baje Rampur JCB 6 ghante');
    await say('site', 'line-site', 'secret-site', CONTRACTOR, 'हाँ');
    await wait(() => logs.some((l) => l.includes('not sent: outside 24h window')));
    assert.deepEqual(to(OWNER), []);

    // The owner writes anything: first the waiting request (the notice's own text), then the answer.
    await say('jcb', 'line-jcb', 'secret-jcb', OWNER, 'मदद');
    const first = to(OWNER);
    assert.equal(first.length, 2, first.join(' | '));
    assert.ok(first[0].includes('J-1') && first[0].includes('Rampur'), first[0]);
    // Never twice: the next message is only answered.
    await say('jcb', 'line-jcb', 'secret-jcb', OWNER, 'मदद');
    assert.equal(to(OWNER).length, 3);
    assert.equal(to(OWNER).filter((x) => x.includes('Rampur')).length, 1);

    // The owner says yes; the operator has not written, so the booking notice to them is lost too.
    await say('jcb', 'line-jcb', 'secret-jcb', OWNER, 'हाँ 1200');
    await wait(() => logs.filter((l) => l.includes('not sent: outside 24h window')).length >= 2);
    assert.deepEqual(to(OPERATOR), []);
    await say('jcb', 'line-jcb', 'secret-jcb', OPERATOR, 'मदद');
    assert.ok(to(OPERATOR)[0]?.includes('J-1') && to(OPERATOR)[0].includes('Rampur'), to(OPERATOR).join(' | '));
    await say('jcb', 'line-jcb', 'secret-jcb', OPERATOR, 'मदद');
    assert.equal(to(OPERATOR).filter((x) => x.includes('Rampur')).length, 1);
  } finally {
    app.close();
    await new Promise((r) => server.close(() => r(undefined)));
    rmSync(dir, { recursive: true, force: true });
  }
});
