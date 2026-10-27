import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeys, publicKeyText, publicKeyFromText, signMessage, verifyMessage } from '../../src/protocol/keys.js';
import { buildMessage, checkIncoming, bodyIsValid } from '../../src/protocol/messages.js';

const NOW = Date.parse('2026-10-28T03:30:00Z');
const jcb = generateKeys();
const contractor = generateKeys();
const stranger = generateKeys();
const ORDER = randomUUID();

/** @param {import('../../src/protocol/messages.js').MessageType[]} types */
function peers(types) {
  return new Map([['agent:contractor-1', {
    id: 'agent:contractor-1',
    publicKey: publicKeyFromText(publicKeyText(contractor.publicKey)),
    mayReceiveFrom: new Set(types),
  }]]);
}

const bookingBody = { kind: 'jcb_hours', site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 };

/** @param {Partial<Parameters<typeof buildMessage>[0]>} [o] */
function booking(o = {}) {
  return buildMessage({
    type: 'BOOKING_REQUEST', from: 'agent:contractor-1', to: 'agent:jcb-1', orderId: ORDER,
    body: bookingBody, privateKey: contractor.privateKey, nowMs: NOW, ...o,
  });
}

/** @param {object} [o] */
const ctx = (o = {}) => ({ selfId: 'agent:jcb-1', peers: peers(['BOOKING_REQUEST', 'ACCEPT']), nowMs: NOW + 60_000, seen: () => false, ...o });

test('a public key survives the trip through its text form', () => {
  const text = publicKeyText(jcb.privateKey);
  assert.match(text, /^ed25519:[A-Za-z0-9+/]{43}=$/);
  assert.equal(publicKeyText(publicKeyFromText(text)), text);
  assert.throws(() => publicKeyFromText('ed25519:short'), TypeError);
});

test('a signature covers every field: changing any one breaks it', () => {
  const m = booking();
  assert.equal(verifyMessage(m, contractor.publicKey), true);
  for (const change of [
    { body: { ...bookingBody, hoursTenths: 61 } }, { to: 'agent:jcb-2' }, { order_id: randomUUID() },
    { expires_at: '2030-01-01T00:00:00.000Z' }, { rev: 2 },
  ]) {
    assert.equal(verifyMessage({ ...m, ...change }, contractor.publicKey), false, JSON.stringify(change));
  }
  assert.equal(verifyMessage(m, jcb.publicKey), false, 'another key');
  assert.equal(verifyMessage({ ...m, sig: 'ed25519:xyz' }, contractor.publicKey), false, 'garbage signature');
});

test('signing again with a sig present replaces it rather than signing over it', () => {
  const m = booking();
  const again = signMessage(m, contractor.privateKey);
  assert.equal(verifyMessage(again, contractor.publicKey), true);
});

test('a good message from a connected peer passes', () => {
  const r = checkIncoming(booking(), ctx());
  assert.equal(r.ok, true);
});

test('the checks run in the fixed order and refuse with a code only', () => {
  const good = booking();
  const cases = [
    [{ ...good, v: 'hb/9' }, ctx(), 'UNSUPPORTED'],
    [{ ...good, type: 'PAY_ME' }, ctx(), 'UNSUPPORTED'],
    [booking({ privateKey: stranger.privateKey, from: 'agent:stranger' }), ctx(), 'NOT_CONNECTED'],
    [booking({ privateKey: stranger.privateKey }), ctx(), 'BAD_SIGNATURE'],
    [booking({ to: 'agent:jcb-2' }), ctx(), 'NOT_FOR_ME'],
    [good, ctx({ nowMs: NOW + 25 * 3600 * 1000 }), 'EXPIRED'],
    [good, ctx({ peers: peers(['ACCEPT']) }), 'NOT_CONNECTED'],
  ];
  for (const [msg, c, code] of /** @type {[any, any, string][]} */ (cases)) {
    const r = checkIncoming(msg, c);
    assert.equal(r.ok, false, code);
    if (!r.ok) assert.equal(r.code, code);
  }
});

test('a repeat passes the identity checks and is handed back for the stored answer', () => {
  const m = booking();
  const r = checkIncoming(m, ctx({ seen: (/** @type {string} */ id) => id === m.msg_id }));
  assert.equal(r.ok, true);
});

test('a signed but malformed body is refused as BAD_BODY', () => {
  // Signed directly, bypassing buildMessage's own check, as a buggy or hostile peer could.
  const m = signMessage({ ...booking(), body: { ...bookingBody, hoursTenths: 6.5 } }, contractor.privateKey);
  const r = checkIncoming(m, ctx());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'BAD_BODY');
});

test('buildMessage refuses a malformed body, a bad id or a bad order', () => {
  assert.throws(() => booking({ body: { ...bookingBody, day: '29/10/2026' } }), TypeError);
  assert.throws(() => booking({ from: 'Contractor One' }), TypeError);
  assert.throws(() => booking({ orderId: 'order-1' }), TypeError);
});

test('body rules: integers only, totals must add up, a correction names what it replaces', () => {
  const ev = { sha256: 'a'.repeat(64), kind: 'meter', readValue: '3677.7', takenAt: null, sentAt: '2026-10-29T12:00:00Z' };
  const bill = { lines: [{ what: 'JCB', hoursTenths: 61, ratePaise: 120000, amountPaise: 732000 }], totalPaise: 732000, evidence: [ev] };
  assert.equal(bodyIsValid('BILL', bill), true);
  assert.equal(bodyIsValid('BILL', { ...bill, totalPaise: 732001 }), false, 'total must equal the lines');
  assert.equal(bodyIsValid('BILL', { ...bill, lines: [{ ...bill.lines[0], amountPaise: 7320.5 }], totalPaise: 7320.5 }), false);
  assert.equal(bodyIsValid('BILL', { ...bill, replaces: randomUUID() }), false, 'a bill never replaces');
  assert.equal(bodyIsValid('CORRECTION', bill), false, 'a correction must name what it replaces');
  assert.equal(bodyIsValid('CORRECTION', { ...bill, replaces: randomUUID() }), true);
  assert.equal(bodyIsValid('BOOKING_REQUEST', { kind: 'material', site: 'S', day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] }), true);
  assert.equal(bodyIsValid('BOOKING_REQUEST', { kind: 'material', site: 'S', day: '2026-10-29' }), false, 'material needs items');
  assert.equal(bodyIsValid('BOOKING_REPLY', { answer: 'other_time' }), false, 'another time needs a day');
  assert.equal(bodyIsValid('DISPUTE', { bill: randomUUID(), reason: 'diary says 5.5', theirFigure: { hoursTenths: 55 } }), true);
  assert.equal(bodyIsValid('DISPUTE', { bill: randomUUID(), reason: 'x', theirFigure: {} }), false);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', { bill: randomUUID(), amountPaise: 732000, utr: '4321', paidOn: '2026-10-30', screenshot: { sha256: 'b'.repeat(64) } }), true);
});
