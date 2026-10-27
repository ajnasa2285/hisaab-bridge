// The whole service over HTTP: WhatsApp webhooks in, Graph API sends out (a stand-in), both agents
// talking over their real A2A endpoints in the same process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../src/protocol/keys.js';
import { createApp } from './../src/app.js';

const OWNER = '919000000001';
const SUPERVISOR = '919000000011';

test('a supervisor\'s WhatsApp message reaches the JCB owner through both agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-app-'));
  /** @type {{to: string, line: string, text: string}[]} */
  const sent = [];
  /** @type {typeof globalThis.fetch} */
  const fakeGraph = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const line = /\/(line-[a-z]+)\/messages$/.exec(url)?.[1] ?? '?';
    sent.push({ to: body.to, line, text: body.text?.body });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** @type {{name: string, args: any}[]} */
  let nextCalls = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: nextCalls });

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
      { line: 'line-site', phone: SUPERVISOR, agent: 'agent:contractor-1', role: 'supervisor', name: 'Supervisor' },
    ],
    waStoreFile: join(dir, 'wa.db'),
    spark,
    fetch: fakeGraph,
    exportToken: 'test-export-token',
    log: () => {},
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

  try {
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
    const card = await (await fetch(`${base}/agents/jcb/.well-known/agent-card.json`)).json();
    assert.equal(card.supportedInterfaces[0].url, `${base}/agents/jcb/a2a`);

    // The owner has written today, so notices can reach them.
    await say('jcb', 'line-jcb', 'secret-jcb', OWNER, 'मदद');
    assert.equal(sent.at(-1)?.to, OWNER);

    nextCalls = [{ name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }];
    await say('site', 'line-site', 'secret-site', SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
    assert.deepEqual([sent.at(-1)?.to, sent.at(-1)?.line], [SUPERVISOR, 'line-site']);
    assert.ok(sent.at(-1)?.text.includes('हाँ / नहीं'));
    await say('site', 'line-site', 'secret-site', SUPERVISOR, 'हाँ');
    await wait(() => sent.some((s) => s.to === OWNER && s.text?.includes('Shivpuri')) && sent.some((s) => s.to === SUPERVISOR && s.text?.includes('JCB की माँग भेजी')));
    const toOwner = sent.filter((s) => s.to === OWNER && s.line === 'line-jcb').at(-1);
    assert.ok(toOwner?.text.includes('Shivpuri'), 'the JCB owner is told on the JCB line');
    assert.ok(sent.some((s) => s.to === SUPERVISOR && s.text.includes('JCB की माँग भेजी')));
    const site = app.agent('agent:contractor-1');
    const jcb = app.agent('agent:jcb-1');
    const orderId = site.core.ledger.orders()[0].order_id;
    assert.equal(jcb.core.ledger.view(orderId).state, 'requested');

    // The export for the judge page needs the token.
    assert.equal((await fetch(`${base}/agents/jcb/export`)).status, 404);
    assert.equal((await fetch(`${base}/agents/jcb/export`, { headers: { authorization: 'Bearer wrong' } })).status, 404);
    const side = await (await fetch(`${base}/agents/jcb/export`, { headers: { authorization: 'Bearer test-export-token' } })).json();
    assert.deepEqual([side.agentId, side.chain.ok, side.events[0].type], ['agent:jcb-1', true, 'BOOKING_REQUEST']);
  } finally {
    app.close();
    await new Promise((r) => server.close(() => r(undefined)));
    rmSync(dir, { recursive: true, force: true });
  }
});
