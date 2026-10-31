// Sending a document: the same two Graph calls as an image, against a stand-in. Meta is never called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../../src/wa/cloud.js';
import { createDirectory } from '../../src/wa/directory.js';
import { openWaStore, WINDOW_MS } from '../../src/wa/store.js';
import { createWa } from '../../src/wa/wa.js';
import { XLSX_MIME } from '../../src/export/xlsx.js';

const PHONE = '919000000021';
const DOC = { bytes: Buffer.from('invented workbook bytes'), mime: XLSX_MIME, fileName: 'hisaab-site-2026-10.xlsx', caption: 'अक्टूबर 2026' };

/** @param {(url: string, init?: RequestInit) => Promise<Response>} respond */
const cloud = (respond) => createCloudClient({ phoneNumberId: 'line-site', accessToken: 'invented-test-token', fetch: (input, init) => respond(String(input), init) });

test('sendDocument uploads the exact bytes with the xlsx type, then sends the media ID with the file name and caption', async () => {
  /** @type {string[]} */
  const calls = [];
  const c = cloud(async (url, init) => {
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer invented-test-token');
    assert.equal(init?.method, 'POST');
    if (url.endsWith('/media')) {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('messaging_product'), 'whatsapp');
      assert.equal(init.body.get('type'), XLSX_MIME);
      const file = init.body.get('file');
      assert.ok(file instanceof File);
      assert.equal(file.type, XLSX_MIME);
      assert.equal(file.name, DOC.fileName);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), DOC.bytes);
      assert.equal(new Headers(init.headers).has('content-type'), false, 'fetch supplies the multipart boundary');
      return Response.json({ id: 'media-1' });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE,
      type: 'document', document: { id: 'media-1', filename: DOC.fileName, caption: DOC.caption },
    });
    return Response.json({ messages: [{ id: 'wamid.doc-1' }] });
  });
  assert.deepEqual(await c.sendDocument(PHONE, DOC), { ok: true, id: 'wamid.doc-1' });
  assert.ok(calls[0].endsWith('/line-site/media'));
  assert.ok(calls[1].endsWith('/line-site/messages'));
});

test('a failed upload sends no message; a refused message or a network fault is a failure without provider text', async () => {
  let calls = 0;
  const failing = cloud(async () => { calls += 1; return Response.json({}, { status: 503 }); });
  assert.deepEqual(await failing.sendDocument(PHONE, DOC), { ok: false, reason: 'upload http 503' });
  assert.equal(calls, 1);
  const refused = cloud(async (url) => url.endsWith('/media') ? Response.json({ id: 'media-1' }) : Response.json({ error: { code: 131047, message: 'private diagnostic' } }, { status: 400 }));
  assert.deepEqual(await refused.sendDocument(PHONE, DOC), { ok: false, reason: 'http 400 code 131047' });
  const broken = cloud(async () => { throw new Error('private diagnostic'); });
  assert.deepEqual(await broken.sendDocument(PHONE, DOC), { ok: false, reason: 'network' });
});

test('a bad recipient, type, name, size, caption or upload answer cannot send a document', async () => {
  let calls = 0;
  const c = cloud(async () => { calls += 1; return Response.json({}); });
  assert.equal((await c.sendDocument('+91 invalid', DOC)).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, mime: 'application/zip' })).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, fileName: '../x.xlsx' })).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, fileName: 'हिसाब.xlsx' })).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, bytes: Buffer.alloc(0) })).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, bytes: Buffer.alloc(100 * 1024 * 1024 + 1) })).ok, false);
  assert.equal((await c.sendDocument(PHONE, { ...DOC, caption: 'x'.repeat(1025) })).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await c.sendDocument(PHONE, DOC), { ok: false, reason: 'no media id' });
  assert.equal(calls, 1);
});

test('a document respects the 24-hour window, and a session expiring during the upload stops the message', async (t) => {
  const T0 = Date.parse('2026-10-29T03:30:00Z');
  let now = T0;
  let calls = 0;
  const c = cloud(async (url) => { calls += 1; return Response.json(url.endsWith('/media') ? { id: 'media-1' } : { messages: [{ id: 'wamid.doc-1' }] }); });
  const store = openWaStore(':memory:');
  t.after(() => store.close());
  const wa = createWa({
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'invented-secret', verifyToken: 'invented-token', client: c }],
    directory: createDirectory({ lines: ['line-site'], people: [{ line: 'line-site', phone: PHONE, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' }] }),
    store, onMessage() {}, unknownReply: () => '', now: () => now,
  });
  assert.deepEqual(await wa.sendDocument('unknown-line', PHONE, DOC), { ok: false, reason: 'unknown line' });
  assert.deepEqual(await wa.sendDocument('line-site', PHONE, DOC), { ok: false, reason: 'outside 24h window' });
  assert.equal(calls, 0);
  store.touch('line-site', PHONE, now);
  assert.equal((await wa.sendDocument('line-site', PHONE, DOC)).ok, true);
  assert.equal(calls, 2);
  now = T0 + WINDOW_MS;
  assert.deepEqual(await wa.sendDocument('line-site', PHONE, DOC), { ok: false, reason: 'outside 24h window' });
  assert.equal(calls, 2);

  let open = true;
  let uploads = 0;
  const closing = cloud(async () => { uploads += 1; open = false; return Response.json({ id: 'media-1' }); });
  assert.deepEqual(await closing.sendDocument(PHONE, DOC, { canSend: () => open }), { ok: false, reason: 'outside 24h window' });
  assert.equal(uploads, 1);
});
