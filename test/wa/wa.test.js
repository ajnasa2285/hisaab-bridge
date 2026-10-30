import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createCloudClient } from '../../src/wa/cloud.js';
import { createDirectory } from '../../src/wa/directory.js';
import { openWaStore, WINDOW_MS } from '../../src/wa/store.js';
import { createWa } from '../../src/wa/wa.js';

const T0 = 1_761_530_000_000;

/**
 * A stand-in for graph.facebook.com that records what was sent.
 * @param {Record<string, {status?: number, json?: unknown, bytes?: Buffer}>} [routes]
 */
function fakeGraph(routes = {}) {
  /** @type {{url: string, body: any, auth: string | null}[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') });
    // The longest matching suffix wins, so ".../media-1" on the download host is not the lookup route.
    const r = Object.entries(routes).filter(([k]) => url.endsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (r?.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status ?? 200 });
    if (r) return Response.json(r.json ?? {}, { status: r.status ?? 200 });
    return Response.json({ messages: [{ id: `wamid.out${calls.length}` }] });
  };
  return { fetch, calls };
}

/** @param {{now?: () => number, onMessage?: (m: any, p: any) => void, failureReply?: (e: unknown) => string}} [o] */
async function setup(o = {}) {
  const jcbGraph = fakeGraph();
  const siteGraph = fakeGraph();
  const store = openWaStore(':memory:');
  /** @type {string[]} */
  const logs = [];
  /** @type {[any, any][]} */
  const got = [];
  const wa = createWa({
    lines: [
      { name: 'jcb', phoneNumberId: 'line-jcb', appSecret: 'secret-jcb', verifyToken: 'tok-jcb', client: createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 'token-jcb', fetch: jcbGraph.fetch }) },
      { name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'tok-site', client: createCloudClient({ phoneNumberId: 'line-site', accessToken: 'token-site', fetch: siteGraph.fetch }) },
    ],
    directory: createDirectory({
      lines: ['line-jcb', 'line-site'],
      people: [
        { line: 'line-jcb', phone: '919000000002', agent: 'agent:jcb-1', role: 'operator', name: 'Operator' },
        { line: 'line-site', phone: '919000000011', agent: 'agent:contractor-1', role: 'supervisor', name: 'Supervisor' },
      ],
    }),
    store,
    onMessage: o.onMessage ?? ((m, p) => { got.push([m, p]); }),
    unknownReply: () => 'माफ़ कीजिए, यह नंबर आपके लिए नहीं है।',
    failureReply: o.failureReply,
    now: o.now ?? (() => T0),
    log: (l) => logs.push(l),
  });
  const server = createServer(async (req, res) => {
    if (!(await wa.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { wa, store, logs, got, jcbGraph, siteGraph, base, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

/** @param {string} line @param {any[]} messages */
const payload = (line, messages) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: line }, messages } }] }],
});
const textMsg = (/** @type {string} */ from, /** @type {string} */ id, /** @type {string} */ body) => ({ from, id, timestamp: String(T0 / 1000), type: 'text', text: { body } });

/** @param {string} base @param {string} name @param {string} body @param {string} secret */
const post = (base, name, body, secret) => fetch(`${base}/wa/${name}/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
  body,
});

test('the handshake works per line with that line\'s token', async () => {
  const s = await setup();
  try {
    const ok = await fetch(`${s.base}/wa/jcb/webhook?hub.mode=subscribe&hub.verify_token=tok-jcb&hub.challenge=777`);
    assert.deepEqual([ok.status, await ok.text()], [200, '777']);
    const wrong = await fetch(`${s.base}/wa/site/webhook?hub.mode=subscribe&hub.verify_token=tok-jcb&hub.challenge=777`);
    assert.equal(wrong.status, 403);
    assert.equal((await fetch(`${s.base}/wa/nope/webhook`)).status, 404);
  } finally {
    await s.close();
  }
});

test('a known sender is routed once, even when Meta delivers the webhook twice', async () => {
  const s = await setup();
  try {
    const body = payload('line-jcb', [textMsg('919000000002', 'wamid.1', '6.1 ghante')]);
    assert.equal((await post(s.base, 'jcb', body, 'secret-jcb')).status, 200);
    assert.equal((await post(s.base, 'jcb', body, 'secret-jcb')).status, 200);
    assert.equal(s.got.length, 1);
    const [msg, person] = s.got[0];
    assert.deepEqual([msg.text, person.agent, person.role], ['6.1 ghante', 'agent:jcb-1', 'operator']);
    assert.equal(s.store.lastInbound('line-jcb', '919000000002'), T0);
  } finally {
    await s.close();
  }
});

test('a wrong signature, or one from the other line\'s app, is refused and nothing is handled', async () => {
  const s = await setup();
  try {
    const body = payload('line-jcb', [textMsg('919000000002', 'wamid.1', 'x')]);
    assert.equal((await post(s.base, 'jcb', body, 'secret-site')).status, 401);
    assert.equal((await post(s.base, 'jcb', body, 'guess')).status, 401);
    // Correctly signed by the site app, but the messages claim the JCB line: ignored.
    assert.equal((await post(s.base, 'site', body, 'secret-site')).status, 200);
    assert.equal(s.got.length, 0);
    assert.equal(s.store.firstTime('wamid.1', T0), true, 'the refused message id was never recorded');
  } finally {
    await s.close();
  }
});

test('an unknown sender gets one polite reply, and nothing about them is stored', async () => {
  const s = await setup();
  try {
    await post(s.base, 'site', payload('line-site', [textMsg('919000000099', 'wamid.u1', 'hello')]), 'secret-site');
    await post(s.base, 'site', payload('line-site', [textMsg('919000000099', 'wamid.u2', 'hello?')]), 'secret-site');
    assert.equal(s.got.length, 0);
    assert.equal(s.siteGraph.calls.length, 1);
    assert.equal(s.siteGraph.calls[0].body.to, '919000000099');
    assert.equal(s.siteGraph.calls[0].body.text.body, 'माफ़ कीजिए, यह नंबर आपके लिए नहीं है।');
    assert.equal(s.store.lastInbound('line-site', '919000000099'), null);
    assert.equal(s.store.firstTime('wamid.u1', T0), true);
    assert.ok(s.logs.every((l) => !l.includes('919000000099')), 'logs never hold the full number');
  } finally {
    await s.close();
  }
});

test('replies go out on the right line only inside the 24-hour window', async () => {
  let now = T0;
  const s = await setup({ now: () => now });
  try {
    assert.deepEqual(await s.wa.send('line-site', '919000000011', 'नमस्ते'), { ok: false, reason: 'outside 24h window' });
    await post(s.base, 'site', payload('line-site', [textMsg('919000000011', 'wamid.s1', 'cement chahiye')]), 'secret-site');
    const r = await s.wa.send('line-site', '919000000011', 'नमस्ते');
    assert.equal(r.ok, true);
    const call = s.siteGraph.calls.at(-1);
    assert.ok(call);
    assert.ok(call.url.endsWith('/line-site/messages'));
    assert.equal(call.auth, 'Bearer token-site');
    assert.deepEqual([call.body.messaging_product, call.body.type, call.body.to], ['whatsapp', 'text', '919000000011']);
    assert.equal(s.jcbGraph.calls.length, 0);
    now = T0 + WINDOW_MS;
    assert.deepEqual(await s.wa.send('line-site', '919000000011', 'नमस्ते'), { ok: false, reason: 'outside 24h window' });
  } finally {
    await s.close();
  }
});

test('a failure inside an agent is logged and does not stop the next message', async () => {
  /** @type {string[]} */
  const seen = [];
  const s = await setup({
    onMessage: (m) => {
      seen.push(m.msgId);
      if (m.msgId === 'wamid.bad') throw new Error('boom');
    },
  });
  try {
    await post(s.base, 'jcb', payload('line-jcb', [textMsg('919000000002', 'wamid.bad', 'a'), textMsg('919000000002', 'wamid.ok', 'b')]), 'secret-jcb');
    assert.deepEqual(seen, ['wamid.bad', 'wamid.ok']);
    assert.ok(s.logs.some((l) => l.includes('failed: boom') && l.includes('…0002')));
  } finally {
    await s.close();
  }
});

test('a message whose handling throws gets exactly one reply, and the next message goes on as usual', async () => {
  const s = await setup({
    failureReply: (e) => `reply for ${e instanceof Error ? e.message : ''}`,
    onMessage: (m) => { if (m.msgId === 'wamid.bad') throw new Error('boom'); },
  });
  try {
    await post(s.base, 'jcb', payload('line-jcb', [textMsg('919000000002', 'wamid.bad', 'a'), textMsg('919000000002', 'wamid.ok', 'b')]), 'secret-jcb');
    assert.equal(s.jcbGraph.calls.length, 1);
    assert.equal(s.jcbGraph.calls[0].body.to, '919000000002');
    assert.equal(s.jcbGraph.calls[0].body.text.body, 'reply for boom');
  } finally {
    await s.close();
  }
});

test('media is fetched with the token and refused when its bytes do not match', async () => {
  const bytes = Buffer.from('fake jpeg bytes');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const graph = fakeGraph({
    '/media-1': { json: { url: 'https://lookaside.example/media-1', mime_type: 'image/jpeg', sha256: sha, file_size: bytes.length } },
    'lookaside.example/media-1': { bytes },
    '/media-2': { json: { url: 'https://lookaside.example/media-2', mime_type: 'image/jpeg', sha256: sha, file_size: 5 } },
    'lookaside.example/media-2': { bytes: Buffer.from('other') },
    '/media-3': { json: { url: 'https://lookaside.example/media-3', file_size: 50_000_000 } },
  });
  const c = createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 'token-jcb', fetch: graph.fetch });
  const got = await c.fetchMedia('media-1');
  assert.deepEqual([got.bytes.toString(), got.mimeType, got.sha256], ['fake jpeg bytes', 'image/jpeg', sha]);
  assert.ok(graph.calls.every((x) => x.auth === 'Bearer token-jcb'));
  await assert.rejects(c.fetchMedia('media-2'), /do not match/);
  await assert.rejects(c.fetchMedia('media-3'), /too large/);
  await assert.rejects(c.fetchMedia('../etc'), /bad media id/);
});

test('sendText refuses bad recipients and over-long texts without calling Meta', async () => {
  const graph = fakeGraph();
  const c = createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 't', fetch: graph.fetch });
  assert.equal((await c.sendText('+91 9000', 'x')).ok, false);
  assert.equal((await c.sendText('919000000002', 'x'.repeat(4097))).ok, false);
  assert.equal(graph.calls.length, 0);
  const failing = fakeGraph({ '/messages': { status: 400, json: { error: { code: 131047 } } } });
  const c2 = createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 't', fetch: failing.fetch });
  assert.deepEqual(await c2.sendText('919000000002', 'x'), { ok: false, reason: 'http 400 code 131047' });
});
