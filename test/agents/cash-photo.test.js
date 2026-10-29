import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { openLedger } from '../../src/ledger/store.js';
import { createApp } from '../../src/app.js';
import { generateKeys } from '../../src/protocol/keys.js';
import { t } from '../../src/i18n/index.js';

/** @type {import('../../src/wa/directory.js').Person} */
const contractor = { line: 'site', phone: '919000000031', agent: 'agent:contractor-1', role: 'contractor', name: 'काल्पनिक ठेकेदार' };
const supervisor = { ...contractor, role: /** @type {const} */ ('supervisor'), phone: '919000000032' };
const photo = { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
/** @returns {import('../../src/readers/cash-receipt.js').CashReceiptReading} */
const reading = () => ({ ok: true, kind: 'cash_receipt', amountRaw: 'Rs. 1,234.50', amountPaise: 123450,
  dateRaw: '27 Oct 2026', date: '2026-10-27', receiverName: 'काल्पनिक प्राप्तकर्ता', receiverMark: true,
  reference: 'C-099', clear: true, model: 'stand-in', latencyMs: 1 });

/** @param {import('node:test').TestContext} ctx
 * @param {{clear?: boolean, kind?: 'other'|'upi', result?: import('../../src/readers/cash-receipt.js').CashReceiptReading, throws?: boolean, reader?: boolean}} [options] */
function setup(ctx, options = {}) {
  const ledger = openLedger(':memory:');
  ctx.after(() => ledger.close());
  let now = Date.parse('2026-10-29T08:00:00Z');
  const calls = { classify: 0, read: 0, payment: 0, persist: 0 };
  /** @type {{key:string, text:string}[]} */
  const said = [];
  /** @type {Record<string, import('../../src/agents/common.js').Tool>} */
  const tools = { claim_payment: { roles: ['contractor'], commits: true,
    run: () => { calls.payment++; return { ok: true, key: 'step.cancelled' }; } },
    confirm_count: { roles: ['supervisor', 'contractor'], commits: true,
      run: () => { throw new Error('not a challan'); } } };
  const talk = createConversation({ ledger, tools, now: () => now,
    spark: async () => ({ ok: true, toolCalls: [] }),
    classifyPhoto: async () => { calls.classify++; return { ok: true, kind: options.kind ?? 'other', clear: options.clear ?? true, model: 'stand-in', latencyMs: 1 }; },
    readChallan: async () => ({ ok: true, kind: 'not_challan' }),
    ...(options.reader === false ? {} : { readCashReceipt: async () => {
      calls.read++;
      if (options.throws) throw new Error('reader failed');
      return options.result ?? reading();
    } }),
    mediaStore: /** @type {any} */ ({ put: () => { calls.persist++; throw new Error('cash preview cannot retain a photo'); } }),
    reply: (_person, key, params) => { said.push({ key, text: t(key, params) }); },
  });
  return { talk, ledger, calls, last: () => said.at(-1), advance: () => { now += 31 * 60 * 1000; } };
}

for (const clear of [true, false]) test(`${clear ? 'clear other' : 'uncertain'} classification asks for an explicit cash kind before reading`, async ctx => {
  const s = setup(ctx, { clear });
  await s.talk.onImage(contractor, photo);
  assert.equal(s.last()?.key, 'photo.ask_kind');
  assert.match(s.last()?.text ?? '', /"नकद पर्ची"/);
  assert.equal(s.calls.read, 0);
  await s.talk.onText(contractor, 'नकद पर्ची');
  assert.equal(s.calls.read, 1); assert.equal(s.calls.classify, 1);
  assert.equal(s.last()?.key, 'cash_receipt.preview');
  for (const value of ['Rs. 1,234.50', '₹1,234.50', '27 Oct 2026', '27 अक्टूबर 2026', 'काल्पनिक प्राप्तकर्ता', 'C-099', 'निशान दिखा']) assert.ok(s.last()?.text.includes(value), value);
  assert.doesNotMatch(s.last()?.text ?? '', /—|हाँ \/ नहीं/);
  assert.equal(s.talk.pending(contractor), null);
  assert.equal(s.calls.payment + s.calls.persist, 0);
  assert.deepEqual(s.ledger.verifyChain(), { ok: true, events: 0 });
  await s.talk.onText(contractor, 'हाँ');
  assert.equal(s.calls.payment, 0, 'preview creates no confirmation to commit later');
});

test('unknown fields are omitted, uncertainty stays visible, and no placeholder is invented', async ctx => {
  const s = setup(ctx, { result: { ok: true, kind: 'cash_receipt', amountRaw: null, amountPaise: null,
    dateRaw: '03/04/2026', date: null, receiverName: null, receiverMark: null, reference: null, clear: false,
    model: 'stand-in', latencyMs: 1 } });
  await s.talk.onImage(contractor, photo);
  await s.talk.onText(contractor, 'नकद रसीद');
  assert.equal(s.last()?.key, 'cash_receipt.preview_unclear');
  assert.match(s.last()?.text ?? '', /03\/04\/2026/);
  assert.match(s.last()?.text ?? '', /निशान साफ़ नहीं/);
  assert.doesNotMatch(s.last()?.text ?? '', /—|रक़म:|प्राप्तकर्ता का नाम:|पर्ची क्रमांक:/);
  assert.equal(s.calls.payment + s.calls.persist, 0);
});

test('an absent receiver mark is shown as absent, never as a signature', async ctx => {
  const r = reading(); assert.ok(r.ok && r.kind === 'cash_receipt');
  if (!r.ok || r.kind !== 'cash_receipt') return;
  const s = setup(ctx, { result: { ...r, receiverMark: false } });
  await s.talk.onImage(contractor, photo);
  await s.talk.onText(contractor, 'cash receipt');
  assert.match(s.last()?.text ?? '', /निशान नहीं दिखा/);
});

for (const [label, options, key] of /** @type {[string, Parameters<typeof setup>[1], string][]} */ ([
  ['reader failure', { result: { ok: false, transient: true, reason: 'timeout' } }, 'cash_receipt.unavailable'],
  ['reader exception', { throws: true }, 'cash_receipt.unavailable'],
  ['another document', { result: { ok: true, kind: 'not_cash_receipt', model: 'stand-in', latencyMs: 1 } }, 'cash_receipt.not_receipt'],
])) test(`${label} leaves no pending step or ledger entry`, async ctx => {
  const s = setup(ctx, options);
  await s.talk.onImage(contractor, photo);
  await s.talk.onText(contractor, 'नकद पर्ची');
  assert.equal(s.last()?.key, key);
  assert.equal(s.talk.pending(contractor), null);
  assert.equal(s.calls.payment + s.calls.persist, 0);
  assert.deepEqual(s.ledger.verifyChain(), { ok: true, events: 0 });
});

test('supervisors are not offered cash receipts and cannot select that reader', async ctx => {
  const s = setup(ctx, { clear: false });
  await s.talk.onImage(supervisor, photo);
  assert.equal(s.last()?.key, 'photo.ask_kind');
  assert.doesNotMatch(s.last()?.text ?? '', /नकद/);
  await s.talk.onText(supervisor, 'नकद पर्ची');
  assert.equal(s.last()?.key, 'photo.sent_by_cash_receipt');
  assert.equal(s.calls.read, 0);
});

test('cancellation and expiry discard the unclassified cash photo', async ctx => {
  const s = setup(ctx);
  await s.talk.onImage(contractor, photo);
  await s.talk.onText(contractor, 'नहीं');
  assert.equal(s.talk.pending(contractor), null);
  await s.talk.onText(contractor, 'नकद पर्ची');
  assert.equal(s.calls.read, 0);
  await s.talk.onImage(contractor, photo);
  s.advance();
  await s.talk.onText(contractor, 'नकद पर्ची');
  assert.equal(s.calls.read, 0);
});

test('without an injected cash reader the established other-photo behaviour stays the same', async ctx => {
  const s = setup(ctx, { reader: false });
  await s.talk.onImage(contractor, photo);
  assert.equal(s.last()?.key, 'photo.other');
  assert.doesNotMatch(s.last()?.text ?? '', /नकद/);
});

for (const inject of [true, false]) test(`app wires ${inject ? 'an injected' : 'the default'} cash reader into the contractor photo conversation`, async () => {
  let reads = 0;
  const key = generateKeys().privateKey;
  const app = createApp({ baseUrl: 'http://localhost', agents: [{ name: 'site', kind: 'contractor',
    id: contractor.agent, title: 'काल्पनिक साइट', privateKey: key, ledgerFile: ':memory:',
    peers: [], peerUrls: {}, jcbAgentId: 'agent:jcb-1' }], lines: [], people: [], waStoreFile: ':memory:',
    spark: async () => ({ ok: true, toolCalls: [] }),
    classifyPhoto: async () => ({ ok: true, kind: 'other', clear: true, model: 'stand-in', latencyMs: 1 }),
    ...(inject ? { readCashReceipt: async () => { reads++; return reading(); } } : {}), log: () => {},
  });
  try {
    const agent = app.agent(contractor.agent); assert.ok(agent);
    if (!agent) return;
    await agent.talk.onImage(contractor, photo);
    assert.equal(agent.talk.pending(contractor)?.kind, 'photo_kind');
    // The default is available in the real app; cancelling here avoids a real model call in tests.
    await agent.talk.onText(contractor, inject ? 'नकद पर्ची' : 'नहीं');
    assert.equal(reads, inject ? 1 : 0);
    assert.equal(agent.talk.pending(contractor), null);
    assert.deepEqual(agent.core.ledger.verifyChain(), { ok: true, events: 0 });
  } finally { app.close(); }
});
