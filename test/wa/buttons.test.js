// A question ending "हाँ / नहीं" goes as WhatsApp reply buttons, within WhatsApp's limits; anything
// WhatsApp does not take goes as the same text. Each question's buttons name it by its token. A
// stand-in Graph API; invented numbers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../../src/wa/cloud.js';
import { createDirectory } from '../../src/wa/directory.js';
import { openWaStore } from '../../src/wa/store.js';
import { createWa, tappedButton, yesNoButtons } from '../../src/wa/wa.js';
import { parseInbound } from '../../src/wa/webhook.js';

const T0 = 1_761_530_000_000;
const PHONE = '919000000002';
const QUESTION = 'शुरू का मीटर 9989.4 दर्ज करें? हाँ / नहीं';
const TOKEN = 'invented-token-1';
const ASKED = { token: TOKEN };

/** @param {(body: any) => Response | null} [answer] what the stand-in says to one message, else a message id */
function desk(answer = () => null) {
  /** @type {any[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return answer(body) ?? Response.json({ messages: [{ id: `wamid.out${calls.length}` }] });
  };
  const store = openWaStore(':memory:');
  const wa = createWa({
    lines: [{ name: 'jcb', phoneNumberId: 'line-jcb', appSecret: 'secret-jcb', verifyToken: 'tok-jcb', client: createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 'token-jcb', fetch }) }],
    directory: createDirectory({ lines: ['line-jcb'], people: [{ line: 'line-jcb', phone: PHONE, agent: 'agent:jcb-1', role: 'operator', name: 'Operator' }] }),
    store, onMessage: () => {}, unknownReply: () => 'x', now: () => T0, log: (l) => logs.push(l),
  });
  store.touch('line-jcb', PHONE, T0);
  return { wa, store, calls, logs };
}

test('only a text that ends with "हाँ / नहीं" becomes buttons, and its body is the text before them', () => {
  assert.deepEqual(yesNoButtons(QUESTION, TOKEN), { body: 'शुरू का मीटर 9989.4 दर्ज करें?', buttons: [{ id: `yes:${TOKEN}`, title: 'हाँ' }, { id: `no:${TOKEN}`, title: 'नहीं' }] });
  assert.equal(yesNoButtons('दो माँग भेजें:\n1. सामान\nहाँ / नहीं', TOKEN)?.body, 'दो माँग भेजें:\n1. सामान');
  // Only a token of ours names a question.
  for (const bad of ['', 'short', 'has space in it', 'x'.repeat(65)]) assert.equal(yesNoButtons(QUESTION, bad), null, bad);
  for (const text of ['आ सकेंगे? हाँ / नहीं / दूसरा दिन', 'सही है? हाँ / नहीं, या सही अंक लिखें।', 'मीटर पढ़ा: 9989.4 घंटे।', 'हाँ / नहीं', '"हाँ P-1" लिखें']) {
    assert.equal(yesNoButtons(text, TOKEN), null, text);
  }
  // WhatsApp takes a body of at most 1024 characters.
  assert.ok(yesNoButtons(`${'क'.repeat(1024)} हाँ / नहीं`, TOKEN));
  assert.equal(yesNoButtons(`${'क'.repeat(1025)} हाँ / नहीं`, TOKEN), null);
});

test('a हाँ / नहीं question goes out as one message with two reply buttons', async () => {
  const d = desk();
  const r = await d.wa.send('line-jcb', PHONE, QUESTION, ASKED);
  assert.equal(r.ok, true);
  assert.equal(d.calls.length, 1);
  assert.deepEqual(d.calls[0], {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE, type: 'interactive',
    interactive: { type: 'button', body: { text: 'शुरू का मीटर 9989.4 दर्ज करें?' }, action: { buttons: [
      { type: 'reply', reply: { id: `yes:${TOKEN}`, title: 'हाँ' } }, { type: 'reply', reply: { id: `no:${TOKEN}`, title: 'नहीं' } }] } },
  });
  // Any other text goes as before, and so does a question sent without its token.
  await d.wa.send('line-jcb', PHONE, 'मीटर पढ़ा: 9989.4 घंटे।', ASKED);
  assert.deepEqual([d.calls[1].type, d.calls[1].text], ['text', { body: 'मीटर पढ़ा: 9989.4 घंटे।', preview_url: false }]);
  await d.wa.send('line-jcb', PHONE, QUESTION);
  assert.deepEqual([d.calls[2].type, d.calls[2].text.body], ['text', QUESTION]);
});

test('a question too long for buttons goes as the same text', async () => {
  const d = desk();
  const long = `${'क'.repeat(1100)} हाँ / नहीं`;
  assert.equal((await d.wa.send('line-jcb', PHONE, long, ASKED)).ok, true);
  assert.equal(d.calls.length, 1);
  assert.deepEqual([d.calls[0].type, d.calls[0].text.body], ['text', long]);
});

test('buttons WhatsApp refuses: the same text goes instead, and the log shows the last four digits only', async () => {
  for (const refuse of [
    () => Response.json({ error: { code: 131009 } }, { status: 400 }),
    () => Response.json({}, { status: 200 }),
    () => { throw new Error('down'); },
  ]) {
    const d = desk((body) => (body.type === 'interactive' ? refuse() : null));
    const r = await d.wa.send('line-jcb', PHONE, QUESTION, ASKED);
    assert.equal(r.ok, true);
    assert.deepEqual(d.calls.map((c) => c.type), ['interactive', 'text']);
    assert.equal(d.calls[1].text.body, QUESTION, 'the whole question, with its answers');
    assert.equal(d.logs.length, 1, d.logs.join(' / '));
    assert.match(d.logs[0], /^wa jcb: buttons to …0002 failed: .+; sent as text$/);
    assert.ok(!d.logs.some((l) => l.includes(PHONE)));
  }
  // Both refused: the send failed, as a text that fails today.
  const down = desk(() => Response.json({}, { status: 500 }));
  assert.deepEqual(await down.wa.send('line-jcb', PHONE, QUESTION, ASKED), { ok: false, reason: 'http 500' });
  assert.equal(down.calls.length, 2);
});

test('outside the 24-hour window nothing goes, buttons or text', async () => {
  const d = desk();
  const late = createWa({ lines: [], directory: createDirectory({ lines: [], people: [] }), store: d.store, onMessage: () => {}, unknownReply: () => 'x' });
  assert.equal((await late.send('line-jcb', PHONE, QUESTION, ASKED)).ok, false);
  d.store.touch('line-jcb', '919000000003', T0 - 25 * 60 * 60 * 1000);
  assert.deepEqual(await d.wa.send('line-jcb', '919000000003', QUESTION, ASKED), { ok: false, reason: 'outside 24h window' });
  assert.equal(d.calls.length, 0);
});

test('the client sends nothing WhatsApp would refuse: titles over 20, more than three, the same title twice, an empty body', async () => {
  /** @type {any[]} */
  const calls = [];
  const c = createCloudClient({ phoneNumberId: 'line-jcb', accessToken: 'token-jcb', fetch: async () => { calls.push(1); return Response.json({ messages: [{ id: 'x' }] }); } });
  const yes = { id: `yes:${TOKEN}`, title: 'हाँ' };
  for (const [body, buttons] of /** @type {[string, {id: string, title: string}[]][]} */ ([
    ['ठीक?', [{ id: 'yes', title: 'क'.repeat(21) }]], ['ठीक?', [yes, { id: `no:${TOKEN}`, title: 'नहीं' }, { id: `later:${TOKEN}`, title: 'बाद में' }, { id: `other:${TOKEN}`, title: 'और' }]],
    ['ठीक?', [yes, { id: `no:${TOKEN}`, title: 'हाँ' }]], ['  ', [yes]], ['क'.repeat(1025), [yes]], ['ठीक?', []], ['ठीक?', [{ id: 'yes', title: 'हाँ' }]], ['ठीक?', [{ id: 'yes:a b', title: 'हाँ' }]],
  ])) assert.equal((await c.sendButtons(PHONE, body, buttons)).ok, false, `${body.slice(0, 8)} ${JSON.stringify(buttons)}`);
  assert.equal((await c.sendButtons('+91 9000', 'ठीक?', [yes])).ok, false);
  assert.equal(calls.length, 0);
});

test('a tapped "हाँ" arrives as the same words as a typed "हाँ", with the token of its question', () => {
  const at = String(T0 / 1000);
  const payload = (/** @type {any} */ m) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-jcb' }, messages: [{ from: PHONE, id: 'wamid.in', timestamp: at, ...m }] } }] }] });
  const [typed] = parseInbound(payload({ type: 'text', text: { body: 'हाँ' } }));
  const tap = (/** @type {string} */ id, /** @type {string} */ title) => parseInbound(payload({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }))[0];
  const tapped = tap(`yes:${TOKEN}`, 'हाँ');
  assert.deepEqual([tapped.kind, tapped.text, tapped.replyId], ['button', 'हाँ', `yes:${TOKEN}`]);
  assert.equal(tapped.text, typed.text);
  assert.deepEqual(tappedButton(tapped), { answer: 'yes', token: TOKEN });
  assert.deepEqual(tappedButton(tap(`no:${TOKEN}`, 'नहीं')), { answer: 'no', token: TOKEN });
  // Not one of our buttons: read as the words it carries, as before.
  assert.equal(tappedButton(typed), null);
  for (const id of ['yes', 'maybe:invented-token-1', 'yes:bad token']) assert.equal(tappedButton(tap(id, 'हाँ')), null, id);
});
