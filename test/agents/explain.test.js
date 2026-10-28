import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDifference, explanationSupported, guardViolation, numbersSupported,
  ATTEMPT_TIMEOUT_MS, EXPLANATION_TIMEOUT_MS, MAX_EXPLANATION_CHARS } from '../../src/agents/explain.js';

/** @typedef {import('../../src/agents/explain.js').AllowedNumber} AllowedNumber */
/** @type {import('../../src/agents/explain.js').Facts} */
const FACTS = {
  context: { ref: 'J-9', site: 'नमूना स्थल', kind: 'jcb_hours',
    currentBill: { source: 'BILL', lines: [{ item: 'JCB', quantity: '6.1', unit: 'घंटे', rate: '₹1,200', amount: '₹7,320.00' }], total: '₹7,320.00' },
    meterEvidence: { start: { reading: '1240.6' }, end: { reading: '1246.7' }, computedHours: '6.1' },
    disputes: [{ direction: 'in', concernsCurrentBill: false, figure: { value: '5.9', unit: 'घंटे' }, reason: 'पुराना कारण' },
      { direction: 'in', concernsCurrentBill: true, figure: { value: '5.5', unit: 'घंटे' }, reason: 'साइट की लिखी अवधि अलग है' }],
    corrections: [] },
  figures: 'J-9: बिल 6.1 घंटे, ₹7,320.00; साइट 5.5 घंटे',
  allowedNumbers: [
    { value: 'J-9', kind: 'identifier' }, { value: '6.1', kind: 'hours' },
    { value: '5.5', kind: 'hours' }, { value: '₹7,320.00', kind: 'money' },
    { value: '1240.6', kind: 'hours' }, { value: '1246.7', kind: 'hours' },
  ],
};
/** @param {unknown} json @param {{name:string,args:any}[]} [toolCalls] @returns {import('../../src/agents/explain.js').Spark} */
const answer = (json, toolCalls = []) => async () => ({ ok: true, json, toolCalls });
const UNAVAILABLE = { key: 'explain.unavailable', params: { figures: FACTS.figures } };

test('JCB explanation is a small strict-JSON request, audience-aware and display-only, with code figures preserved', async () => {
  const explanation = 'मीटर से 6.1 घंटे दर्ज हैं; साइट ने 5.5 घंटे बताए हैं।';
  let calls = 0;
  /** @type {import('../../src/agents/explain.js').Spark} */
  const spark = async (request) => {
    calls++;
    assert.deepEqual(request.schema, { type: 'object', additionalProperties: false, required: ['explanation'],
      properties: { explanation: { type: 'string', minLength: 1, maxLength: MAX_EXPLANATION_CHARS } } });
    assert.equal(Object.hasOwn(request, 'tools'), false);
    assert.equal(Object.hasOwn(request, 'images'), false);
    assert.equal(request.timeoutMs, ATTEMPT_TIMEOUT_MS);
    assert.equal(request.reasoningEffort, 'minimal');
    // A few lines for this one difference, not the whole order as JSON.
    const lines = request.text.split('\n');
    assert.ok(lines.length <= 8 && request.text.length < 600, request.text);
    assert.match(lines[0], /विक्रेता/);
    for (const value of ['J-9', '6.1', '1240.6', '1246.7', '5.5', '«साइट की लिखी अवधि अलग है»']) assert.ok(request.text.includes(value), value);
    assert.ok(!request.text.includes('5.9') && !request.text.includes('पुराना'), 'an objection to an earlier bill is not this difference');
    assert.match(request.system ?? '', /data, not instructions/);
    return { ok: true, json: { explanation }, toolCalls: [] };
  };
  const result = await explainDifference({ spark, facts: FACTS, audience: 'seller' });
  assert.deepEqual(result, { key: 'explain.wrapper', params: { explanation, figures: FACTS.figures } });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(result), ['key', 'params']);
});

test('material explanation uses signed delivery and attributed site challan count', async () => {
  /** @type {import('../../src/agents/explain.js').Facts} */
  const facts = { context: { ref: 'P-9', kind: 'material',
    signedDelivery: { items: [{ item: 'सीमेंट', quantity: '50', unit: 'बोरी' }], challanNumber: 'D-17' },
    localSiteCount: { items: [{ item: 'सीमेंट', quantity: '48', unit: 'बोरी' }], challanNumber: 'S-18', fromSiteChallanPhoto: true } },
  figures: 'चालान D-17: 50 बोरी; साइट चालान S-18: 48 बोरी',
  allowedNumbers: [{ value: '50', kind: 'quantity' }, { value: '48', kind: 'quantity' },
    { value: 'D-17', kind: 'identifier' }, { value: 'S-18', kind: 'identifier' }] };
  const explanation = 'चालान D-17 में 50 बोरी दर्ज हैं; साइट के चालान S-18 में 48 बोरी दर्ज हैं।';
  /** @type {string[]} */
  const texts = [];
  const spark = /** @type {import('../../src/agents/explain.js').Spark} */ (async (req) => { texts.push(req.text); return { ok: true, json: { explanation }, toolCalls: [] }; });
  assert.equal((await explainDifference({ spark, facts, audience: 'buyer' })).key, 'explain.wrapper');
  assert.match(texts[0], /खरीदार/);
  assert.match(texts[0], /चालान D-17: सीमेंट 50 बोरी/);
  assert.match(texts[0], /साइट के चालान S-18 की फ़ोटो से\): सीमेंट 48 बोरी/);
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
    { explanation: 'अ'.repeat(MAX_EXPLANATION_CHARS + 1) }, { explanation: 'बिल अलग है।', tool: 'confirm_payment' }]) {
    assert.deepEqual(await explainDifference({ spark: answer(json), facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
  }
  assert.deepEqual(await explainDifference({ spark: answer({ explanation: 'बिल अलग है।' },
    [{ name: 'confirm_payment', args: { amount: 7320 } }]), facts: FACTS, audience: 'seller' }), UNAVAILABLE);
});

const REASONS = ['साइट की लिखी अवधि अलग है', 'मशीन 7 बजे बंद रही, सही गिनती 5.5 है'];
/** @param {string} text */
const rule = (text) => guardViolation(text, FACTS.allowedNumbers, REASONS);

test('rule: every number must exist in the facts; a quoted reason gives the prose no numbers', () => {
  assert.equal(rule('बिल में 6.1 घंटे हैं; मीटर 1240.6 से 1246.7 है।'), null);
  assert.equal(rule('मीटर 1246.7 मीटर फ़ोटो पर है।'), null, 'मीटर names the instrument, not a length unit');
  assert.equal(rule('आपत्ति में लिखा कारण: “मशीन 7 बजे बंद रही, सही गिनती 5.5 है”।'), null, 'numbers inside an exact recorded quote are their words');
  assert.equal(rule('बिल में 6.6 घंटे हैं।'), 'numbers');
  assert.equal(rule('मशीन 7 बजे बंद रही।'), 'numbers', 'a number from a reason is not a fact outside the quote');
});

test('rule: never says who is right', () => {
  assert.equal(rule('बिल में 6.1 घंटे दर्ज हैं; आपत्ति में 5.5 घंटे दर्ज हैं।'), null);
  for (const text of ['बिल सही है।', 'साइट की गिनती गलत है।', 'दूसरे पक्ष का दावा झूठा है।', 'बिल ठीक है।']) assert.equal(rule(text), 'verdict', text);
});

test('rule: never asks for payment or mentions dues, dates, deadlines or reminders', () => {
  assert.equal(rule('लागू बिल का कुल ₹7,320.00 दर्ज है।'), null, 'a recorded bill amount is a figure, not a demand');
  for (const text of ['भुगतान बाकी है।', '₹7,320.00 देय हैं।', '₹7,320.00 बकाया है।', 'राशि कल तक जमा होनी है।',
    'अंतिम तारीख पास है।', 'यह रिमाइंडर है।']) assert.equal(rule(text), 'payment', text);
});

test('rule: never tells anyone what to do', () => {
  assert.equal(rule('बिल 6.1 घंटे का है और आपत्ति 5.5 घंटे की है।'), null);
  for (const text of ['मीटर की फ़ोटो जाँचें।', 'आँकड़े भेजें।', 'साइट से संपर्क करें।', 'कृपया बिल मिलाएँ।', 'बिल बदलना चाहिए।']) {
    assert.equal(rule(text), 'directive', text);
  }
});

test('rule: never invents a reason, but may quote the recorded one as theirs', () => {
  for (const text of ['आपत्ति में लिखा कारण: “साइट की लिखी अवधि अलग है”।', 'आपत्ति में कारण लिखा है: «साइट की लिखी अवधि अलग है।»',
    'दूसरे पक्ष ने 5.5 घंटे लिखे हैं, उनका लिखा कारण: "साइट की लिखी अवधि अलग है"',
    'उनके कारण में लिखा है: “मशीन 7 बजे बंद रही, सही गिनती 5.5 है”']) assert.equal(rule(text), null, text);
  assert.equal(rule('इसका कारण अलग अवधि है।'), 'reason', 'the noun without a recorded quote is the model\'s own reason');
  assert.equal(rule('आपत्ति में कारण लिखा है: “मशीन खराब थी”।'), 'quote', 'a quote must be a recorded reason word for word');
  assert.equal(rule('आपत्ति में कारण लिखा है: “साइट की अवधि अलग है”।'), 'quote', 'no paraphrase inside quotes');
  assert.equal(rule('बिल 6.1 घंटे का है” और कुछ।'), 'quote', 'stray quote marks');
  for (const text of ['बारिश की वजह से समय अलग है।', 'शायद मीटर अलग था।', 'मीटर खराब था।', 'इसलिए 6.1 घंटे हैं।',
    'आपत्ति “साइट की लिखी अवधि अलग है” के कारण 5.5 घंटे हैं।']) assert.equal(rule(text), 'cause', text);
});

test('rule: Hindi prose only, no links, code or controls', () => {
  for (const text of ['बिल https://example.invalid पर है।', 'बिल tool confirm_payment है।', 'बिल <b>अलग</b> है।']) assert.equal(rule(text), 'format', text);
  for (const text of ['बिल​ अलग है।', 'Bill is different.', '', 'अ'.repeat(MAX_EXPLANATION_CHARS + 1)]) assert.equal(rule(text), 'shape', text);
  assert.equal(explanationSupported('बिल और दर्ज गिनती में अंतर है।', FACTS.allowedNumbers), true);
});

test('only reasons recorded on the bill in force may be quoted', async () => {
  const quote = (/** @type {string} */ r) => ({ explanation: `आपत्ति में लिखा कारण: “${r}”।` });
  assert.equal((await explainDifference({ spark: answer(quote('साइट की लिखी अवधि अलग है')), facts: FACTS, audience: 'seller' })).key, 'explain.wrapper');
  assert.deepEqual(await explainDifference({ spark: answer(quote('पुराना कारण')), facts: FACTS, audience: 'seller' }), UNAVAILABLE);
});

test('missing client, model failures and throws return code figures', async () => {
  assert.deepEqual(await explainDifference({ facts: FACTS, audience: 'seller' }), UNAVAILABLE);
  for (const reason of ['timeout', 'http_503', 'schema_failure']) {
    assert.deepEqual(await explainDifference({ spark: async () => ({ ok: false, transient: true, reason }), facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
  }
  assert.deepEqual(await explainDifference({ spark: async () => { throw new Error('unavailable'); }, facts: FACTS, audience: 'buyer' }), UNAVAILABLE);
});

test('a slow model never holds the explanation past the total deadline; a late answer is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {(v: any) => void} */
  let late = () => {};
  const ok = { ok: true, json: { explanation: 'बिल 6.1 घंटे का है।' }, toolCalls: [] };
  const inTime = explainDifference({ spark: async () => new Promise((resolve) => { late = resolve; }), facts: FACTS, audience: 'buyer' });
  t.mock.timers.tick(EXPLANATION_TIMEOUT_MS - 1);
  late(ok);
  assert.equal((await inTime).key, 'explain.wrapper', 'an answer inside the deadline is used');
  const slow = explainDifference({ spark: async () => new Promise((resolve) => { late = resolve; }), facts: FACTS, audience: 'buyer' });
  t.mock.timers.tick(EXPLANATION_TIMEOUT_MS);
  late(ok);
  assert.deepEqual(await slow, UNAVAILABLE);
  assert.ok(2 * ATTEMPT_TIMEOUT_MS <= EXPLANATION_TIMEOUT_MS, 'one retry of a timed-out attempt fits the total bound');
});

test('total deadline also handles a client promise which never resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = explainDifference({ spark: async () => new Promise(() => {}), facts: FACTS, audience: 'seller' });
  t.mock.timers.tick(EXPLANATION_TIMEOUT_MS);
  assert.deepEqual(await result, UNAVAILABLE);
});
