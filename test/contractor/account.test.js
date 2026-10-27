import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../../src/ledger/store.js';
import { siteAccount, accountText } from '../../src/contractor/account.js';

const AT = '2026-10-29T03:30:00.000Z';
const SHA = 'e'.repeat(64);
const SITE = 'शिवपुरी';

/** @param {string} type @param {Record<string, any>} body */
function msg(type, body) {
  return { msgId: randomUUID(), body: { type, body } };
}

/** @param {ReturnType<typeof openLedger>} L @param {string} orderId @param {'in'|'out'} direction @param {{msgId: string, body: {type: string, body: Record<string, any>}}} m */
function put(L, orderId, direction, m) {
  const e = L.append({ orderId, direction, type: m.body.type, msgId: m.msgId, body: m.body, at: AT });
  assert.ok(e, `${m.body.type} must fit`);
  return m;
}

const meterEvidence = { sha256: 'd'.repeat(64), kind: 'meter', readValue: '3677.7', takenAt: null, sentAt: AT };

/** The contractor's ledger: it sends requests, receives bills. @param {ReturnType<typeof openLedger>} L */
function jcbOrder(L, site = SITE) {
  const orderId = randomUUID();
  L.ensureOrder({ orderId, kind: 'jcb_hours', counterparty: 'agent:jcb-1', site, at: AT });
  put(L, orderId, 'out', msg('BOOKING_REQUEST', { kind: 'jcb_hours', site, day: '2026-10-29' }));
  put(L, orderId, 'in', msg('BOOKING_REPLY', { answer: 'yes' }));
  return orderId;
}

/** @param {ReturnType<typeof openLedger>} L @param {string} orderId @param {number} hoursTenths @param {number} ratePaise */
function billJcb(L, orderId, hoursTenths, ratePaise) {
  const amountPaise = hoursTenths * ratePaise / 10;
  return put(L, orderId, 'in', msg('BILL', { lines: [{ what: 'JCB', hoursTenths, ratePaise, amountPaise }], totalPaise: amountPaise, evidence: [meterEvidence] }));
}

test('an empty ledger, or a site without orders, shows nothing and invents nothing', () => {
  const bare = new DatabaseSync(':memory:');
  const a = siteAccount(bare, { site: SITE });
  assert.deepEqual(a, { site: SITE, jcbHoursTenths: 0, jcbBilled: false, materials: [], billedPaise: 0, paidPaise: 0, pendingPaise: 0, openDisputes: 0, lines: [] });
  assert.equal(accountText(a), `${SITE} के लिए अभी कुछ दर्ज नहीं।`);
  const L = openLedger(':memory:');
  jcbOrder(L, 'गुना');
  assert.deepEqual(siteAccount(L, { site: SITE }).lines, []);
});

test('a booked JCB without a bill: a line with no amount, shown as a dash', () => {
  const L = openLedger(':memory:');
  const orderId = jcbOrder(L);
  const a = siteAccount(L, { site: SITE });
  assert.deepEqual(a.lines, [{ orderId, kind: 'jcb_hours', what: 'JCB', amountPaise: null, state: 'booked', evidenceCount: 0 }]);
  assert.equal(a.jcbBilled, false);
  const text = accountText(a);
  assert.match(text, /JCB: —/);
  assert.match(text, /बिल: —/);
  assert.match(text, /JCB — — — तय — सबूत 0/);
});

test('bill, dispute, correction, acceptance, settlement: figures follow the bill in force and SETTLED only', () => {
  const L = openLedger(':memory:');
  const o1 = jcbOrder(L);
  const b1 = billJcb(L, o1, 61, 120000); // ₹7,320
  let a = siteAccount(L, { site: SITE });
  assert.deepEqual([a.jcbHoursTenths, a.billedPaise, a.paidPaise, a.pendingPaise, a.openDisputes], [61, 732000, 0, 732000, 0]);
  assert.equal(a.lines[0].evidenceCount, 1, 'the meter evidence in the bill');

  put(L, o1, 'out', msg('DISPUTE', { bill: b1.msgId, theirFigure: { hoursTenths: 55 }, reason: 'मीटर 3677.1 पर था' }));
  a = siteAccount(L, { site: SITE });
  assert.equal(a.openDisputes, 1);
  assert.equal(a.lines[0].state, 'disputed');

  const b2 = put(L, o1, 'in', msg('CORRECTION', { lines: [{ what: 'JCB', hoursTenths: 55, ratePaise: 120000, amountPaise: 660000 }], totalPaise: 660000, evidence: [meterEvidence, { ...meterEvidence, readValue: '3671.6' }], replaces: b1.msgId }));
  a = siteAccount(L, { site: SITE });
  assert.deepEqual([a.jcbHoursTenths, a.billedPaise, a.openDisputes, a.lines[0].evidenceCount], [55, 660000, 0, 2], 'the correction replaces the bill');

  put(L, o1, 'out', msg('ACCEPT', { bill: b2.msgId }));
  const p = put(L, o1, 'out', msg('PAYMENT_CLAIM', { bill: b2.msgId, amountPaise: 660000, utr: '123456789012', paidOn: '2026-10-30', screenshot: { sha256: SHA } }));
  a = siteAccount(L, { site: SITE });
  assert.equal(a.paidPaise, 0, 'a claim settles nothing');
  assert.equal(a.lines[0].state, 'payment_claimed');

  put(L, o1, 'in', msg('SETTLED', { bill: b2.msgId, payment: p.msgId, amountPaise: 660000 }));
  a = siteAccount(L, { site: SITE });
  assert.deepEqual([a.paidPaise, a.pendingPaise, a.lines[0].state], [660000, 0, 'settled']);
  const text = accountText(a);
  assert.match(text, /JCB: 5\.5 घंटे/);
  assert.match(text, /बिल: ₹6,600/);
  assert.match(text, /दिया: ₹6,600/);
  assert.match(text, /बाक़ी: ₹0/);
  assert.match(text, /JCB — ₹6,600 — हिसाब पूरा — सबूत 2/);
});

test('materials come from signed deliveries, added up by name and unit', () => {
  const L = openLedger(':memory:');
  const orderId = randomUUID();
  L.ensureOrder({ orderId, kind: 'material', counterparty: 'agent:supplier-1', site: SITE, at: AT });
  put(L, orderId, 'out', msg('BOOKING_REQUEST', { kind: 'material', site: SITE, day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] }));
  put(L, orderId, 'in', msg('BOOKING_REPLY', { answer: 'yes' }));
  let a = siteAccount(L, { site: SITE });
  assert.deepEqual(a.materials, [], 'nothing received yet');
  assert.equal(a.lines[0].what, 'सीमेंट');
  put(L, orderId, 'in', msg('DELIVERY', { items: [{ name: 'सीमेंट', qtyHundredths: 3000, unit: 'बोरी' }], challan: { sha256: SHA }, deliveredAt: AT }));
  a = siteAccount(L, { site: SITE });
  assert.deepEqual(a.materials, [{ name: 'सीमेंट', qtyHundredths: 3000, unit: 'बोरी' }]);
  assert.deepEqual([a.lines[0].state, a.lines[0].evidenceCount, a.lines[0].amountPaise], ['delivered', 1, null]);
  assert.match(accountText(a), /सामान: सीमेंट 30 बोरी/);

  const o2 = jcbOrder(L);
  billJcb(L, o2, 60, 120000);
  a = siteAccount(L, { site: SITE });
  assert.equal(a.lines.length, 2);
  assert.deepEqual([a.billedPaise, a.jcbHoursTenths], [720000, 60]);
});

test('reading the account writes nothing', () => {
  const L = openLedger(':memory:');
  billJcb(L, jcbOrder(L), 61, 120000);
  const before = L.chainHead();
  siteAccount(L, { site: SITE });
  siteAccount(L.db, { site: 'गुना' });
  assert.equal(L.chainHead(), before);
  assert.deepEqual(L.verifyChain(), { ok: true, events: 3 });
  assert.throws(() => siteAccount(L, { site: '' }), /non-empty/);
});
