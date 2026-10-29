import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../../src/wa/cloud.js';
import { createDirectory } from '../../src/wa/directory.js';
import { openWaStore, WINDOW_MS } from '../../src/wa/store.js';
import { createWa } from '../../src/wa/wa.js';

const PHONE = '919000000011';
const PHOTO = { bytes: Buffer.from('invented verified JPEG bytes'), mime: 'image/jpeg', caption: 'फ़ोटो वही है जो दर्ज हुई थी' };

/** @param {(url: string, init?: RequestInit) => Promise<Response>} respond */
function cloud(respond) {
  return createCloudClient({ phoneNumberId: 'line-site', accessToken: 'invented-test-token', fetch: (input, init) => respond(String(input), init) });
}

test('sendImage uploads exact bytes as multipart before sending the image ID and caption', async () => {
  /** @type {string[]} */
  const calls = [];
  const c = cloud(async (url, init) => {
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer invented-test-token');
    assert.equal(init?.method, 'POST');
    if (url.endsWith('/media')) {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('messaging_product'), 'whatsapp');
      assert.equal(init.body.get('type'), 'image/jpeg');
      const file = init.body.get('file');
      assert.ok(file instanceof File);
      assert.equal(file.type, PHOTO.mime);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), PHOTO.bytes);
      assert.equal(new Headers(init.headers).has('content-type'), false, 'fetch supplies the multipart boundary');
      return Response.json({ id: 'media-1' });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE,
      type: 'image', image: { id: 'media-1', caption: PHOTO.caption },
    });
    return Response.json({ messages: [{ id: 'wamid.evidence-1' }] });
  });
  assert.deepEqual(await c.sendImage(PHONE, PHOTO), { ok: true, id: 'wamid.evidence-1' });
  assert.ok(calls[0].endsWith('/line-site/media'));
  assert.ok(calls[1].endsWith('/line-site/messages'));
});

test('upload failure never sends a message and returns a text-fallback result', async () => {
  let calls = 0;
  const c = cloud(async () => { calls += 1; return Response.json({}, { status: 503 }); });
  assert.deepEqual(await c.sendImage(PHONE, PHOTO), { ok: false, reason: 'upload http 503' });
  assert.equal(calls, 1);
});

test('a failed image send or network returns failure without exposing provider text', async () => {
  const c = cloud(async (url) => url.endsWith('/media') ? Response.json({ id: 'media-1' }) : Response.json({ error: { code: 131047, message: 'private diagnostic' } }, { status: 400 }));
  assert.deepEqual(await c.sendImage(PHONE, PHOTO), { ok: false, reason: 'http 400 code 131047' });
  const broken = cloud(async () => { throw new Error('private diagnostic'); });
  assert.deepEqual(await broken.sendImage(PHONE, PHOTO), { ok: false, reason: 'network' });
});

test('a session expiring during upload prevents the image message', async () => {
  let open = true;
  let calls = 0;
  const c = cloud(async () => { calls += 1; open = false; return Response.json({ id: 'media-1' }); });
  assert.deepEqual(await c.sendImage(PHONE, PHOTO, { canSend: () => open }), { ok: false, reason: 'outside 24h window' });
  assert.equal(calls, 1);
});

test('invalid recipient, size, MIME, caption and missing upload ID cannot send an image', async () => {
  let calls = 0;
  const c = cloud(async () => { calls += 1; return Response.json({}); });
  assert.equal((await c.sendImage('+91 invalid', PHOTO)).ok, false);
  assert.equal((await c.sendImage(PHONE, { ...PHOTO, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).ok, false);
  assert.equal((await c.sendImage(PHONE, { ...PHOTO, mime: 'image/webp' })).ok, false);
  assert.equal((await c.sendImage(PHONE, { ...PHOTO, caption: 'x'.repeat(1025) })).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await c.sendImage(PHONE, PHOTO), { ok: false, reason: 'no media id' });
  assert.equal(calls, 1);
});

test('WA image sending respects the same 24-hour window, with no upload outside it', async (t) => {
  const T0 = Date.parse('2026-10-29T03:30:00Z');
  let now = T0;
  let calls = 0;
  const c = cloud(async (url) => { calls += 1; return Response.json(url.endsWith('/media') ? { id: 'media-1' } : { messages: [{ id: 'wamid.image-1' }] }); });
  const store = openWaStore(':memory:');
  t.after(() => store.close());
  const wa = createWa({
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'invented-secret', verifyToken: 'invented-token', client: c }],
    directory: createDirectory({ lines: ['line-site'], people: [{ line: 'line-site', phone: PHONE, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' }] }),
    store, onMessage() {}, unknownReply: () => '', now: () => now,
  });
  assert.deepEqual(await wa.sendImage('unknown-line', PHONE, PHOTO), { ok: false, reason: 'unknown line' });
  assert.deepEqual(await wa.sendImage('line-site', PHONE, PHOTO), { ok: false, reason: 'outside 24h window' });
  assert.equal(calls, 0);
  store.touch('line-site', PHONE, now);
  assert.equal((await wa.sendImage('line-site', PHONE, PHOTO)).ok, true);
  assert.equal(calls, 2);
  now = T0 + WINDOW_MS;
  assert.deepEqual(await wa.sendImage('line-site', PHONE, PHOTO), { ok: false, reason: 'outside 24h window' });
  assert.equal(calls, 2);
});
