import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDifference, explanationSupported, numbersSupported, EXPLANATION_TIMEOUT_MS } from '../../src/agents/explain.js';

/** @typedef {import('../../src/agents/explain.js').AllowedNumber} AllowedNumber */
/** @type {import('../../src/agents/explain.js').Facts} */
const FACTS = {
  context: { ref: 'J-9', site: 'नमूना स्थल', kind: 'jcb_hours',
    currentBill: { hours: '6.1', amount: '₹7,320.00' }, dispute: { hours: '5.5', reason: 'साइट की लिखी अवधि अलग है' } },
  figures: 'J-9: बिल 6.1 घंटे, ₹7,320.00; साइट 5.5 घंटे',
  allowedNumbers: [
    { value: 'J-9', kind: 'identifier' }, { value: '6.1', kind: 'hours' },
    { value: '5.5', kind: 'hours' }, { value: '₹7,320.00', kind: 'money' },
  ],
};
/** @param {unknown} json @param {{name:string,args:any}[]} [toolCalls] @returns {import('../../src/agents/explain.js').Spark} */
const answer = (json, toolCalls = []) => async () => ({ ok: true, json, toolCalls });
const UNAVAILABLE = { key: 'explain.unavailable', params: { figures: FACTS.figures } };

test('JCB explanation is strict JSON, audience-aware and display-only, with code figures preserved', async () => {
  const explanation = 'मीटर से 6.1 घंटे दर्ज हैं; साइट ने 5.5 घंटे बताए हैं।';
  let calls = 0;
  /** @type {import('../../src/agents/explain.js').Spark} */
  const spark = async (request) => {
    calls++;
    assert.deepEqual(request.schema, { type: 'object', additionalProperties: false, required: ['explanation'],
      properties: { explanation: { type: 'string', minLength: 1, maxLength: 500 } } });
    assert.equal(Object.hasOwn(request, 'tools'), false);
    assert.equal(request.timeoutMs, 30000);
    const prompt = JSON.parse(request.text);
    assert.equal(prompt.audience, 'seller');
    assert.deepEqual(prompt.facts, FACTS.context);
    assert.deepEqual(prompt.allowedNumbers, FACTS.allowedNumbers);
    assert.match(request.system ?? '', /untrusted quoted data/);
    return { ok: true, json: { explanation }, toolCalls: [] };
  };
  const result = await explainDifference({ spark, facts: FACTS, audience: 'seller' });
  assert.deepEqual(result, { key: 'explain.wrapper', params: { explanation, figures: FACTS.figures } });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(result), ['key', 'params']);
});

test('material explanation uses signed delivery and attributed site challan count', async () => {
  /** @type {import('../../src/agents/explain.js').Facts} */
  const facts = { context: { signedDelivery: { quantity: '50', challan: 'D-17' },
    localSiteCount: { quantity: '48', challan: 'S-18', fromSiteChallanPhoto: true } },
  figures: 'चालान D-17: 50 बोरी; साइट चालान S-18: 48 बोरी',
  allowedNumbers: [{ value: '50', kind: 'quantity' }, { value: '48', kind: 'quantity' },
    { value: 'D-17', kind: 'identifier' }, { value: 'S-18', kind: 'identifier' }] };
  const explanation = 'चालान D-17 में 50 बोरी दर्ज हैं; साइट के चालान S-18 में 48 बोरी दर्ज हैं।';
  assert.equal((await explainDifference({ spark: answer({ explanation }), facts, audience: 'buyer' })).key, 'explain.wrapper');
});

test('normalizes Hindi/Latin digits, Indian and western commas, money, hours and zero exactly', () => {
  /** @type {AllowedNumber[]} */
  const allowed = [...FACTS.allowedNumbers, { value: '0.00', kind: 'quantity' }, { value: '₹1234567.00', kind: 'money' }];
  for (const text of ['६.१० घंटे और ५.५ h; ₹७,३२०.००', '6.1h; 7320 रुपये', '० बोरी',
    '₹12,34,567 और ₹1,234,567.00', 'शुरू में 0.000 बोरी दर्ज हैं।']) {
    assert.equal(numbersSupported(text, allowed), true, text);
  }
  for (const text of ['₹7,32,0', '६.११ घंटे', '₹7320.01', '61 घंटे', '732000 रुपये', '0.01 बोरी']) {
    assert.equal(numbersSupported(text, allowed), false, text);
  }
});

test('never rounds or compares only a numeric substring, including values beyond safe integer precision', () => {
  /** @type {AllowedNumber[]} */
  const allowed = [{ value: '9007199254740992', kind: 'quantity' }, { value: '0', kind: 'quantity' }, { value: '6', kind: 'hours' }];
  assert.equal(numbersSupported('9007199254740992 बोरी', allowed), true);
  for (const text of ['9007199254740993 बोरी', '6.01 घंटे', '16 घंटे', '.6 घंटे', '6.0.0 घंटे']) {
    assert.equal(numbersSupported(text, allowed), false, text);
  }
});

test('explicit units must match the authorized number kind', () => {
  for (const text of ['₹6.1', '7320 घंटे', '6.1 बोरी', '₹6.1 घंटे']) {
    assert.equal(numbersSupported(text, FACTS.allowedNumbers), false, text);
  }
});

test('complete dates, times and references are allowed without authorizing their fragments', () => {
  /** @type {AllowedNumber[]} */
  const allowed = [{ value: 'J-9', kind: 'identifier' }, { value: '2026-10-28', kind: 'date' },
    { value: '09:30:00', kind: 'time' }, { value: '123', kind: 'identifier' }];
  assert.equal(numbersSupported('J-९ का फोटो २०२६-१०-२८ को ०९:३०:०० पर दर्ज है; चालान १२३ है।', allowed), true);
  for (const text of ['9 घंटे', '28 बोरी', '123 बोरी', '123', '09:30:01', '2026-10-29',
    'J-9-1', 'J-90', 'J-9 घंटे', '2026-10-28T09:30:00Z']) {
    assert.equal(numbersSupported(text, allowed), false, text);
  }
});

test('fractions, ranges, powers, unknown numeric scripts and spelled figures cannot bypass checks', () => {
  /** @type {AllowedNumber[]} */
  const allowed = [0, 1, 2, 3, 10, 100].map(n => ({ value: String(n), kind: 'hours' }));
  for (const text of ['1/2 घंटे', '1–2 घंटे', '1-2 घंटे', '1e2 घंटे', '1E+2 घंटे', '10² घंटे',
    '½ घंटे', '१⁄२ घंटे', '١ घंटे', '1 000 घंटे', '1. 2 घंटे', '1٫2 घंटे', '1·2 घंटे', '1…2 घंटे',
    '1×2 घंटे', '-1 घंटे', '−1 घंटे', '+1 घंटे',
    '100%', '100％', 'दस घंटे', 'डेढ़ घंटे', 'ढाई घंटे', 'पचहत्तर घंटे', 'one hour', 'लगभग 1 घंटे']) {
    assert.equal(numbersSupported(text, allowed), false, text);
  }
  assert.equal(numbersSupported('दोनों पक्षों की दर्ज अवधि अलग है।', allowed), true);
});

test('unknown number drops the whole explanation; raw scaled values and free text are not numeric authority', async () => {
  for (const explanation of ['बिल में 6.2 घंटे हैं।', 'मीटर में 61 घंटे हैं।', 'अंतर ₹182 है।']) {
    assert.deepEqual(await explainDifference({ spark: answer({ explanation }), facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
  }
  const facts = { ...FACTS, context: { site: 'साइट 182', reason: '182 लिखना', rawPaise: 182 }, figures: '182' };
  assert.equal((await explainDifference({ spark: answer({ explanation: 'बिल में 182 हैं।' }), facts, audience: 'buyer' })).key, 'explain.unavailable');
});

test('malformed JSON, excess fields, empty/long text and model tool calls never become an explanation', async () => {
  for (const json of [null, [], 'बिल अलग है।', { explanation: 6.1 }, {}, { explanation: '' },
    { explanation: 'अ'.repeat(501) }, { explanation: 'बिल अलग है।', tool: 'confirm_payment' }]) {
    assert.deepEqual(await explainDifference({ spark: answer(json), facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
  }
  assert.deepEqual(await explainDifference({ spark: answer({ explanation: 'बिल अलग है।' },
    [{ name: 'confirm_payment', args: { amount: 7320 } }]), facts: FACTS, audience: 'seller' }), UNAVAILABLE);
});

test('payment demands, judgments, invented causal explanations, commands and controls fail closed', () => {
  for (const text of ['बिल सही है।', 'साइट गलत है।', 'भुगतान करें।', '₹7320 देय हैं।',
    '₹7320 दें।', 'राशि कल तक जमा होनी चाहिए।', 'मीटर खराब था।',
    'बारिश की वजह से समय अलग है।', 'इसलिए 6.1 घंटे हैं।', 'मीटर जाँचें।', 'आँकड़े भेजें।',
    'बिल https://example.invalid पर है।', 'बिल tool confirm_payment है।', 'बिल\u200b अलग है।', 'Bill is different.']) {
    assert.equal(explanationSupported(text, FACTS.allowedNumbers), false, text);
  }
  assert.equal(explanationSupported('बिल और दर्ज गिनती में अंतर है।', FACTS.allowedNumbers), true);
  assert.equal(explanationSupported('मीटर से 6.1 घंटे दर्ज हैं; साइट ने 5.5 घंटे बताए हैं।', FACTS.allowedNumbers), true);
});

test('missing client, model failures and throws return code figures', async () => {
  assert.deepEqual(await explainDifference({ facts: FACTS, audience: 'seller' }), UNAVAILABLE);
  for (const reason of ['timeout', 'http_503', 'schema_failure']) {
    assert.deepEqual(await explainDifference({ spark: async () => ({ ok: false, transient: true, reason }), facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
  }
  assert.deepEqual(await explainDifference({ spark: async () => { throw new Error('unavailable'); }, facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
});

test('total deadline also handles a client promise which never resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = explainDifference({ spark: async () => new Promise(() => {}), facts: FACTS, audience: 'seller' });
  t.mock.timers.tick(EXPLANATION_TIMEOUT_MS);
  assert.deepEqual(await result, UNAVAILABLE);
});
