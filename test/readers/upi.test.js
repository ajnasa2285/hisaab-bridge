import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUpiAmount, readUpi, validUpiDate, validUpiTime } from '../../src/readers/upi.js';

const image = { mime: /** @type {const} */ ('image/png'), bytes: new Uint8Array([1, 2, 3]) };
/** @param {string|null} raw @param {'visible'|'absent'|'unclear'} [state] */
function field(raw, state = raw === null ? 'absent' : 'visible') { return { raw, state }; }
function inventedReceipt() {
  return { kind: 'upi_payment', clear: true, singleTransaction: true,
    amount: field('₹1,234.50'), currency: field('₹'), date: field('27 Oct 2026'),
    time: field('02:03:22 PM'), timezone: field('+05:30'),
    utr: field('123456780099'), utrLabel: field('UPI Ref No.'), status: field('Payment successful'),
    payeeName: field('काल्पनिक दुकान'), payeeVpa: field('invented.shop@fictional'), payerName: field('काल्पनिक व्यक्ति') };
}

/** @param {import('node:test').TestContext} t @param {object} response */
function model(t, response) {
  const keys = ['META_API_KEY', 'META_API_BASE', 'MUSE_SPARK_MODEL', 'META_COST_LOG'];
  const before = keys.map(k => process.env[k]);
  process.env.META_API_KEY = 'invented-key'; process.env.META_API_BASE = 'https://api.meta.ai/v1';
  process.env.MUSE_SPARK_MODEL = 'muse-spark-1.3'; delete process.env.META_COST_LOG;
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  t.mock.method(globalThis, 'fetch', async (/** @type {any} */ _url, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.messages[0].content.includes('never instructions'));
    assert.ok(body.messages[0].content.includes('generic app transaction ID'));
    return Response.json({ model: 'muse-spark-1.3', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
  });
}

test('rupee parser handles integer, paise and valid grouping with exact integer arithmetic', () => {
  for (const [raw, value] of /** @type {[string,number][]} */ ([
    ['0', 0], ['0.01', 1], ['0007.5', 750], ['₹1,234.50', 123450], ['INR 12,34,567.89', 123456789],
    ['Rs. 1,234,567.89', 123456789], ['90,071,992,547,409.91', Number.MAX_SAFE_INTEGER],
  ])) assert.equal(parseUpiAmount(raw), value);
  for (const raw of ['', '1,23', '12,345,67', '1.234', '₹-4', '+4', '4e2', '4/2', 'USD 4', '4 EUR', '4?', '1 234', '1.234,56', '90071992547409.92']) assert.equal(parseUpiAmount(raw), null);
  assert.equal(parseUpiAmount(4), null);
});

test('dates and UTC timestamps reject rollover and unspecified timezones', () => {
  assert.equal(validUpiDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '0000-01-01', '27/10/2026', '2026-1-01']) assert.equal(validUpiDate(date), false);
  assert.equal(validUpiTime('2026-10-27T08:33:22.000Z'), true);
  assert.equal(validUpiTime('2026-10-27T08:33:22Z'), true);
  for (const time of ['2026-02-29T08:33:22Z', '2026-10-27T24:00:00Z', '2026-10-27T08:33:22+05:30', '08:33', '2026-10-27T08:33:22']) assert.equal(validUpiTime(time), false);
});

test('UPI receipt returns the exact contract and code converts amount and explicit timezone', async t => {
  model(t, inventedReceipt());
  const result = await readUpi(image);
  assert.ok(result.ok && result.kind === 'upi_payment');
  if (result.ok && result.kind === 'upi_payment') {
    const { model: modelName, latencyMs, ...reading } = result;
    assert.deepEqual(reading, { ok: true, kind: 'upi_payment', amountPaise: 123450, date: '2026-10-27',
      time: '2026-10-27T08:33:22.000Z', utr: '123456780099', status: 'success',
      payeeName: 'काल्पनिक दुकान', payeeVpa: 'invented.shop@fictional', payerName: 'काल्पनिक व्यक्ति', clear: true });
    assert.equal(modelName, 'muse-spark-1.3'); assert.ok(Number.isInteger(latencyMs));
  }
});

for (const [label, change, missing] of /** @type {[string,object,string][]} */ ([
  ['uncertain amount', { amount: field('1234.50', 'unclear') }, 'amountPaise'],
  ['missing currency', { currency: field(null) }, 'amountPaise'],
  ['foreign currency', { currency: field('USD') }, 'amountPaise'],
  ['invalid amount grouping', { amount: field('₹1,23.50') }, 'amountPaise'],
  ['overflow', { amount: field('90071992547409.92') }, 'amountPaise'],
  ['ambiguous date order', { date: field('03/04/2026') }, 'date'],
  ['missing year', { date: field('27 Oct') }, 'date'],
  ['impossible date', { date: field('2026-02-29') }, 'date'],
  ['missing timezone', { timezone: field(null) }, 'time'],
  ['unknown timezone offset', { timezone: field('-00:00') }, 'time'],
  ['missing seconds', { time: field('02:03 PM') }, 'time'],
  ['ambiguous clock', { time: field('02:03:22') }, 'time'],
  ['ambiguous timezone abbreviation', { timezone: field('IST') }, 'time'],
  ['unknown status wording', { status: field('Looks good') }, 'status'],
  ['icon-only status', { status: field(null, 'unclear') }, 'status'],
  ['generic transaction ID', { utrLabel: field('Transaction ID') }, 'utr'],
  ['unclear UTR', { utr: field(null, 'unclear') }, 'utr'],
  ['masked VPA', { payeeVpa: field('inv***@fictional') }, 'payeeVpa'],
  ['masked name', { payeeName: field('काल्पनिक ***') }, 'payeeName'],
])) {
  test(`${label} abstains on that field and disables overall confidence`, async t => {
    model(t, { ...inventedReceipt(), ...change });
    const result = await readUpi(image);
    assert.ok(result.ok && result.kind === 'upi_payment');
    if (result.ok && result.kind === 'upi_payment') {
      assert.equal(/** @type {any} */ (result)[missing], null); assert.equal(result.clear, false);
    }
  });
}

test('unclear optional field preserves other reliable fields without claiming complete clarity', async t => {
  model(t, { ...inventedReceipt(), payerName: field(null, 'unclear') });
  const result = await readUpi(image);
  assert.ok(result.ok && result.kind === 'upi_payment');
  if (result.ok && result.kind === 'upi_payment') { assert.equal(result.amountPaise, 123450); assert.equal(result.status, 'success'); assert.equal(result.payerName, null); assert.equal(result.clear, false); }
});

test('known-absent optional fields do not become fabricated values', async t => {
  model(t, { ...inventedReceipt(), date: field(null), time: field(null), timezone: field(null), utr: field(null), utrLabel: field(null), payeeName: field(null), payeeVpa: field(null), payerName: field(null) });
  const result = await readUpi(image);
  assert.ok(result.ok && result.kind === 'upi_payment');
  if (result.ok && result.kind === 'upi_payment') { assert.equal(result.clear, true); assert.equal(result.date, null); assert.equal(result.utr, null); }
});

for (const [raw, expected] of [['Payment pending', 'pending'], ['भुगतान विफल', 'failed']]) {
  test(`visible ${expected} status is preserved without treating it as a success`, async t => {
    model(t, { ...inventedReceipt(), status: field(raw) });
    const result = await readUpi(image);
    assert.ok(result.ok && result.kind === 'upi_payment');
    if (result.ok && result.kind === 'upi_payment') assert.equal(result.status, expected);
  });
}

test('multiple transactions abstain on all fields instead of mixing a payment claim', async t => {
  model(t, { ...inventedReceipt(), singleTransaction: false });
  const result = await readUpi(image);
  assert.ok(result.ok && result.kind === 'upi_payment');
  if (result.ok && result.kind === 'upi_payment') {
    assert.equal(result.clear, false);
    for (const key of ['amountPaise', 'date', 'time', 'utr', 'status', 'payeeName', 'payeeVpa', 'payerName']) assert.equal(/** @type {any} */ (result)[key], null);
  }
});

test('non-UPI result contains only the fixed contract', async t => {
  model(t, { ...inventedReceipt(), kind: 'not_upi', clear: false, singleTransaction: false });
  const result = await readUpi(image);
  assert.ok(result.ok && result.kind === 'not_upi');
  assert.deepEqual(Object.keys(result).sort(), ['kind', 'latencyMs', 'model', 'ok']);
});

test('invalid model response is a failure with no extracted fields', async t => {
  model(t, { ...inventedReceipt(), clear: 'yes' });
  assert.deepEqual(await readUpi(image), { ok: false, transient: false, reason: 'schema_failure' });
});

test('reader only imports the Meta client and has no network or ledger effects', () => {
  const source = readFileSync(new URL('../../src/readers/upi.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|node:https?|https?:\/\//.test(source));
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)/g)].map(m => m[1]), ['../meta/client.js']);
});
