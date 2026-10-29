import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpiAnswer, validUpiAnswer } from '../../eval/upi-answers.js';
import { summarizeUpi } from '../../eval/upi-metrics.js';

/** Entirely invented values; no private files are read by these tests.
 * @param {Partial<import('../../eval/upi-answers.js').UpiAnswerInput>} [changes] */
function input(changes = {}) {
  return {
    kind: /** @type {const} */ ('upi_payment'), amount: '₹1,234.50', date: '2026-10-20',
    time: '2026-10-20T04:30:00.000Z', utr: '123456789012', status: 'success',
    payeeName: 'काल्पनिक दुकान', payeeVpa: 'example.shop@bank', payerName: 'काल्पनिक ग्राहक', clear: true,
    ...changes,
  };
}

/** @param {Partial<Extract<import('../../eval/upi-metrics.js').UpiReading,{kind:'upi_payment'}>>} [changes]
 * @returns {import('../../eval/upi-metrics.js').UpiReading} */
function reading(changes = {}) {
  return {
    ok: true, kind: 'upi_payment', amountPaise: 123450, date: '2026-10-20',
    time: '2026-10-20T04:30:00.000Z', clock: null, utr: '123456789012', status: 'success',
    payeeName: 'काल्पनिक दुकान', payeeVpa: 'example.shop@bank', payerName: 'काल्पनिक ग्राहक', clear: true,
    model: 'muse-spark-1.3', latencyMs: 100, ...changes,
  };
}

test('UPI human key preserves known fields and calculates paise by code', () => {
  const key = buildUpiAnswer(input());
  assert.ok(key && key.kind === 'upi_payment');
  if (key?.kind === 'upi_payment') {
    assert.equal(key.amountPaise, 123450);
    assert.equal(key.payeeName, 'काल्पनिक दुकान');
    assert.equal(key.utr, '123456789012');
    assert.equal(key.confirmedBy, 'human');
    assert.equal(key.clear, true);
  }
  assert.equal(validUpiAnswer({ ...key, confirmedBy: 'model' }), false);
  assert.equal(validUpiAnswer({ ...key, confirmedBy: undefined }), false);
});

test('blank or uncertain fields are null and uncertainty overrides confidence', () => {
  const key = buildUpiAnswer(input({ payeeName: '', payerName: '?', time: '', clear: true }));
  assert.ok(key && key.kind === 'upi_payment');
  if (key?.kind === 'upi_payment') {
    assert.equal(key.payeeName, null); assert.equal(key.payerName, null);
    assert.equal(key.time, null); assert.equal(key.clear, false);
  }
  const absentOptional = buildUpiAnswer(input({ payeeName: '', time: '' }));
  assert.ok(absentOptional?.kind === 'upi_payment' && absentOptional.clear);
  const unreadable = buildUpiAnswer(input({ amount: '?', status: '?' }));
  assert.ok(unreadable?.kind === 'upi_payment' && unreadable.amountPaise === null && unreadable.status === null && !unreadable.clear);
});

test('malformed or inferred key values are rejected, not silently repaired', () => {
  for (const change of [
    { amount: '1,23' }, { amount: '1.234' }, { amount: '-1' }, { amount: '900719925474099.99' },
    { date: '2026-02-30' }, { date: '20/10' }, { time: '10:00' },
    { time: '2026-10-20T10:00:00+05:30' }, { payeeVpa: 'shop at bank' },
    { time: '2026-10-20T10:00:00-00:00' },
    { utr: '1234****9012' }, { payeeName: ' Unknown ' }, { status: 'settled' },
    { payeeName: 'काल्पनिक...' }, { payerName: 'काल्पनिक…' },
    { amount: '', clear: true }, { status: '', clear: true },
  ]) assert.equal(buildUpiAnswer(input(change)), null);
  const key = buildUpiAnswer(input());
  assert.equal(validUpiAnswer({ ...key, amountPaise: 1.5 }), false);
  assert.equal(validUpiAnswer({ ...key, payerName: undefined }), false);
  assert.equal(validUpiAnswer({ ...key, payeeName: 'bad\nname' }), false);
});

test('equivalent UTC timestamp spellings do not create false errors', () => {
  const key = buildUpiAnswer(input({ time: '2026-10-20T04:30:00Z' }));
  assert.ok(key?.kind === 'upi_payment');
  if (key?.kind === 'upi_payment') assert.equal(key.time, '2026-10-20T04:30:00.000Z');
  const manualKey = { ...key, time: '2026-10-20T04:30:00Z' };
  assert.equal(validUpiAnswer(manualKey), true);
  const result = summarizeUpi([{ prediction: reading(), expected: manualKey, elapsedMs: 100 }]);
  assert.equal(result.exactAccuracy.numerator, 1);
  assert.equal(result.fieldAccuracy.time.numerator, 1);
  assert.equal(result.incorrectFieldClaims, 0);
  assert.equal(result.wrongButConfidentCount, 0);
});

test('human-readable formats remain measurable when the conservative reader abstains', () => {
  const key = buildUpiAnswer(input({ utr: 'AB 1234', payeeVpa: 'example.shop@123bank' }));
  assert.ok(key?.kind === 'upi_payment');
  const result = summarizeUpi([{ prediction: reading({ utr: null, payeeVpa: null, clear: false }), expected: key, elapsedMs: 100 }]);
  assert.equal(result.fieldAccuracy.utr.denominator, 1);
  assert.equal(result.fieldAccuracy.utr.numerator, 0);
  assert.equal(result.fieldAccuracy.payeeVpa.denominator, 1);
  assert.equal(result.fieldAccuracy.payeeVpa.numerator, 0);
  assert.equal(result.exactAccuracy.denominator, 1);
});

test('non-UPI human key has the minimal expected shape', () => {
  assert.deepEqual(buildUpiAnswer(input({ kind: 'not_upi' })), { kind: 'not_upi', confirmedBy: 'human' });
  assert.equal(validUpiAnswer({ kind: 'not_upi' }), false);
});

test('unlabeled UPI output never produces measured accuracy or zero confident errors', () => {
  const result = summarizeUpi([{ prediction: reading(), elapsedMs: 100 }]);
  assert.equal(result.exactAccuracy.basisPoints, null);
  assert.equal(result.wrongButConfidentCount, null);
  assert.equal(result.incorrectButConfidentCount, null);
  assert.equal(result.labeled, 0); assert.equal(result.unlabeled, 1);
  assert.equal(result.assessedConfident, 0); assert.equal(result.unassessedConfident, 1);
  assert.equal(result.unassessedFieldClaims, 8);
});

test('exact and field denominators retain abstentions, errors and misclassification', () => {
  const key = buildUpiAnswer(input());
  /** @type {import('../../eval/upi-metrics.js').UpiReading[]} */
  const predictions = [
    reading(), reading({ amountPaise: 123451 }), reading({ amountPaise: null, clear: false }),
    { ok: false, transient: true, reason: 'timeout' },
    { ok: true, kind: 'not_upi', model: 'muse-spark-1.3', latencyMs: 100 },
  ];
  const result = summarizeUpi(predictions.map(prediction => ({ prediction, expected: key, elapsedMs: 100 })));
  assert.deepEqual(result.exactAccuracy, { numerator: 1, denominator: 5, basisPoints: 2000 });
  assert.deepEqual(result.fieldAccuracy.amountPaise, { numerator: 1, denominator: 5, basisPoints: 2000 });
  assert.equal(result.wrongButConfidentCount, 1);
  assert.equal(result.unclear, 1); assert.equal(result.failures, 1); assert.equal(result.notUpi, 1);
  assert.deepEqual(result.classificationAccuracy, { numerator: 3, denominator: 5, basisPoints: 6000 });
});

test('null expected fields never inflate per-field accuracy and nonnull claims are unsupported', () => {
  const key = buildUpiAnswer(input({ time: '', utr: '?' }));
  const result = summarizeUpi([{ prediction: reading(), expected: key, elapsedMs: 100 }]);
  assert.deepEqual(result.fieldAccuracy.time, { numerator: 0, denominator: 0, basisPoints: null });
  assert.deepEqual(result.fieldAccuracy.utr, { numerator: 0, denominator: 0, basisPoints: null });
  assert.equal(result.exactAccuracy.denominator, 0);
  assert.equal(result.unsupportedFieldClaims, 2);
  assert.equal(result.incorrectFieldClaims, 0);
  assert.equal(result.wrongButConfidentCount, 1);
  assert.equal(result.incorrectButConfidentCount, 0);
  assert.equal(result.unsupportedButConfidentCount, 1);
});

test('wrong nonnull claims remain visible when the overall result is unclear', () => {
  const key = buildUpiAnswer(input({ payerName: '?' }));
  const result = summarizeUpi([{ prediction: reading({ amountPaise: 123451, clear: false }), expected: key, elapsedMs: 100 }]);
  assert.equal(result.confident, 0); assert.equal(result.unclear, 1);
  assert.equal(result.wrongButConfidentCount, 0);
  assert.equal(result.incorrectFieldClaims, 1); assert.equal(result.unsupportedFieldClaims, 1);
  assert.equal(result.unsafeFieldClaims, 2);
  assert.equal(result.fieldClaims.amountPaise.incorrect, 1);
  assert.equal(result.fieldClaims.payerName.unsupported, 1);
});

test('human-confirmed partial evidence can score known fields without claiming exact accuracy', () => {
  const key = buildUpiAnswer(input({ payerName: '?', time: '' }));
  const result = summarizeUpi([{ prediction: reading({ payerName: null, time: null, clear: false }), expected: key, elapsedMs: 100 }]);
  assert.equal(result.exactAccuracy.denominator, 0);
  assert.deepEqual(result.fieldAccuracy.amountPaise, { numerator: 1, denominator: 1, basisPoints: 10000 });
  assert.equal(result.fieldAccuracy.payerName.denominator, 0);
  assert.equal(result.unsafeFieldClaims, 0);
});

test('UPI data extracted from negative evidence is counted unsafe, not a valid payment', () => {
  const key = buildUpiAnswer(input({ kind: 'not_upi' }));
  const result = summarizeUpi([{ prediction: reading(), expected: key, elapsedMs: 100 }]);
  assert.equal(result.exactAccuracy.denominator, 0);
  assert.equal(result.classificationAccuracy.numerator, 0);
  assert.equal(result.wrongButConfidentCount, 1);
  assert.equal(result.incorrectFieldClaims, 8);
});

test('only aggregate counts, fixed field keys and integer rates escape', () => {
  const key = buildUpiAnswer(input());
  const result = summarizeUpi([{ prediction: reading(), expected: key, elapsedMs: 121 }]);
  const json = JSON.stringify(result);
  for (const value of ['123456789012', 'example.shop@bank', 'काल्पनिक दुकान', 'काल्पनिक ग्राहक', '2026-10-20', '123450']) assert.ok(!json.includes(value));
  assert.ok(!/"model"|"file"|"sha256"|"confirmedBy"/.test(json));
  assert.equal(result.latencyMs.p50, 121);
  assert.equal(result.latencyMs.p95, 121);
  assert.equal(result.exactAccuracy.basisPoints, 10000);
});

test('empty evaluations and malformed keys cannot masquerade as accurate', () => {
  const empty = summarizeUpi([]);
  assert.equal(empty.exactAccuracy.basisPoints, null);
  assert.equal(empty.wrongButConfidentCount, null);
  assert.equal(empty.latencyMs.p50, null);
  const badKey = { ...buildUpiAnswer(input()), amountPaise: '123450' };
  const unscored = summarizeUpi([{ prediction: reading(), expected: badKey, elapsedMs: 100 }]);
  assert.equal(unscored.labeled, 0);
  assert.equal(unscored.wrongButConfidentCount, null);
});

test('a name printed in capitals and in the bank line matches either way; other fields stay exact', () => {
  const key = buildUpiAnswer(input({ payeeName: 'Example Shop S/O Owner', payeeVpa: 'Example.Shop@bank' }));
  const same = summarizeUpi([{ prediction: reading({ payeeName: 'EXAMPLE  SHOP S/O OWNER', payeeVpa: 'example.shop@bank' }), expected: key, elapsedMs: 100 }]);
  assert.equal(same.fieldAccuracy.payeeName.numerator, 1);
  assert.equal(same.fieldAccuracy.payeeVpa.numerator, 1);
  assert.equal(same.wrongButConfidentCount, 0);
  const other = summarizeUpi([{ prediction: reading({ payeeName: 'Example Shops S/O Owner', utr: '123456789013' }), expected: key, elapsedMs: 100 }]);
  assert.equal(other.fieldAccuracy.payeeName.numerator, 0);
  assert.equal(other.fieldAccuracy.utr.numerator, 0);
});
