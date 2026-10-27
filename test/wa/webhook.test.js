import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handshake, maskPhone, parseFailedStatuses, parseInbound, signatureIsValid } from '../../src/wa/webhook.js';
import { createDirectory } from '../../src/wa/directory.js';
import { openWaStore, WINDOW_MS } from '../../src/wa/store.js';

const sign = (/** @type {string} */ body, /** @type {string} */ secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('the signature must be the HMAC of the exact raw bytes', () => {
  const body = '{"object":"whatsapp_business_account"}';
  assert.equal(signatureIsValid(body, sign(body, 'app-secret-a'), 'app-secret-a'), true);
  assert.equal(signatureIsValid(body, sign(body, 'app-secret-b'), 'app-secret-a'), false);
  assert.equal(signatureIsValid(`${body} `, sign(body, 'app-secret-a'), 'app-secret-a'), false);
  assert.equal(signatureIsValid(body, undefined, 'app-secret-a'), false);
  assert.equal(signatureIsValid(body, 'sha256=zz', 'app-secret-a'), false);
  assert.equal(signatureIsValid(body, sign(body, ''), ''), false);
});

test('the handshake echoes the challenge only for the right token', () => {
  const q = (/** @type {string} */ token) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' });
  assert.equal(handshake(q('tok'), 'tok'), '12345');
  assert.equal(handshake(q('other'), 'tok'), null);
  assert.equal(handshake(q(''), ''), null);
});

test('a payload is flattened into messages; statuses and broken messages are dropped', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'line-jcb' },
          statuses: [{ id: 'wamid.s', status: 'delivered' }],
          messages: [
            { from: '919000000001', id: 'wamid.1', timestamp: '1761530000', type: 'text', text: { body: 'kal 8 baje' } },
            { from: '919000000002', id: 'wamid.2', timestamp: '1761530001', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'meter' } },
            { from: '919000000002', id: 'wamid.3', timestamp: '1761530002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'accept', title: 'मंज़ूर' } } },
            { from: '919000000002', id: 'wamid.4', timestamp: '1761530003', type: 'sticker', sticker: { id: 'x' } },
            { id: 'wamid.5', type: 'text', text: { body: 'no sender' } },
          ],
        },
      }],
    }],
  };
  const msgs = parseInbound(payload);
  assert.deepEqual(msgs.map((m) => [m.msgId, m.kind]), [['wamid.1', 'text'], ['wamid.2', 'image'], ['wamid.3', 'button'], ['wamid.4', 'other']]);
  assert.equal(msgs[0].text, 'kal 8 baje');
  assert.equal(msgs[0].atMs, 1761530000000);
  assert.deepEqual([msgs[1].mediaId, msgs[1].mimeType, msgs[1].caption], ['media-1', 'image/jpeg', 'meter']);
  assert.equal(msgs[2].replyId, 'accept');
  assert.ok(msgs.every((m) => m.phoneNumberId === 'line-jcb'));
  assert.deepEqual(parseInbound({ object: 'page' }), []);
  assert.deepEqual(parseInbound(null), []);
});

test('logs show only the last four digits of a phone', () => {
  assert.equal(maskPhone('919000000042'), '…0042');
});

test('the directory routes by line and sender, and refuses bad entries', () => {
  const dir = createDirectory({
    lines: ['line-jcb', 'line-site'],
    people: [
      { line: 'line-jcb', phone: '919000000001', agent: 'agent:jcb-1', role: 'jcb_owner', name: 'Owner' },
      { line: 'line-jcb', phone: '919000000002', agent: 'agent:jcb-1', role: 'operator', name: 'Operator' },
      { line: 'line-jcb', phone: '919000000003', agent: 'agent:supplier-1', role: 'supplier', name: 'Supplier' },
      { line: 'line-site', phone: '919000000001', agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' },
    ],
  });
  assert.equal(dir.route('line-jcb', '919000000002')?.role, 'operator');
  assert.equal(dir.route('line-jcb', '919000000003')?.agent, 'agent:supplier-1');
  // The same phone on the other line is a different person-in-role.
  assert.equal(dir.route('line-site', '919000000001')?.role, 'contractor');
  assert.equal(dir.route('line-site', '919000000002'), null);
  assert.equal(dir.route('line-other', '919000000001'), null);
  assert.deepEqual(dir.people('agent:jcb-1', 'operator').map((p) => p.phone), ['919000000002']);

  const one = { line: 'line-jcb', phone: '919000000001', agent: 'agent:jcb-1', role: /** @type {const} */ ('jcb_owner'), name: 'A' };
  assert.throws(() => createDirectory({ lines: ['line-jcb'], people: [one, { ...one, role: 'operator' }] }), /twice/);
  assert.throws(() => createDirectory({ lines: ['line-jcb'], people: [{ ...one, phone: '+91 90000' }] }), /digits/);
  assert.throws(() => createDirectory({ lines: ['line-jcb'], people: [{ ...one, line: 'nope' }] }), /unknown line/);
  assert.throws(() => createDirectory({ lines: ['line-jcb'], people: [{ ...one, role: /** @type {any} */ ('boss') }] }), /role/);
});

test('the store handles each message id once and keeps the 24-hour window', () => {
  const s = openWaStore(':memory:');
  assert.equal(s.firstTime('wamid.1', 1), true);
  assert.equal(s.firstTime('wamid.1', 2), false);
  const t0 = 1_761_530_000_000;
  assert.equal(s.windowOpen('line-jcb', '919000000001', t0), false);
  s.touch('line-jcb', '919000000001', t0);
  s.touch('line-jcb', '919000000001', t0 - 1000); // an older message arriving late does not shrink the window
  assert.equal(s.lastInbound('line-jcb', '919000000001'), t0);
  assert.equal(s.windowOpen('line-jcb', '919000000001', t0 + WINDOW_MS - 1), true);
  assert.equal(s.windowOpen('line-jcb', '919000000001', t0 + WINDOW_MS), false);
  assert.equal(s.windowOpen('line-site', '919000000001', t0), false);
  s.close();
});

test('failed delivery notices are kept with Meta\'s code; other statuses are ignored', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { statuses: [
      { status: 'sent', recipient_id: '919000000001' },
      { status: 'failed', recipient_id: '919000000001', errors: [{ code: 131042, title: 'Business eligibility payment issue' }] },
      { status: 'failed', recipient_id: '919000000002' },
    ] } }] }],
  };
  assert.deepEqual(parseFailedStatuses(payload), [
    { recipient: '919000000001', code: 131042, title: 'Business eligibility payment issue' },
    { recipient: '919000000002', code: null, title: 'unknown' },
  ]);
  assert.deepEqual(parseFailedStatuses({ object: 'page' }), []);
});
