import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addRequest, listRequests, decideRequest, advanceRequest, requestHistory, approvalLimitPaise, RequestError } from '../../src/contractor/requests.js';
import { openLedger } from '../../src/ledger/store.js';

const AT = '2026-10-28T04:00:00.000Z';
const LIMIT = 500000; // ₹5,000

function fresh() {
  return new DatabaseSync(':memory:');
}

/** @param {Parameters<typeof addRequest>[0]} db @param {Partial<Parameters<typeof addRequest>[1]>} [over] */
function cement(db, over = {}) {
  return addRequest(db, { site: 'शिवपुरी', what: 'सीमेंट', kind: 'material', qtyHundredths: 5000, unit: 'बोरी', neededOn: '2026-10-30', by: 'sup:mohan', estimatePaise: 1800000, limitPaise: LIMIT, at: AT, ...over });
}

test('a request above the limit waits for the contractor; the contractor approves it', () => {
  const db = fresh();
  const r = cement(db);
  assert.deepEqual(r, {
    id: 1, site: 'शिवपुरी', what: 'सीमेंट', kind: 'material', qtyHundredths: 5000, unit: 'बोरी', neededOn: '2026-10-30',
    status: 'requested', approvedBy: null, orderId: null, by: 'sup:mohan', estimatePaise: 1800000,
  });
  const a = decideRequest(db, { id: 1, approve: true, by: 'con:ramesh', at: AT });
  assert.equal(a.status, 'approved');
  assert.equal(a.approvedBy, 'con:ramesh');
  assert.equal(listRequests(db).length, 1);
});

test('a request within the limit is approved at once, with nobody named', () => {
  const db = fresh();
  const r = cement(db, { estimatePaise: 400000 });
  assert.equal(r.status, 'approved');
  assert.equal(r.approvedBy, null);
  const r2 = cement(db, { estimatePaise: LIMIT });
  assert.equal(r2.status, 'approved', 'at the limit is within it');
});

test('an unknown value is never guessed: it goes to the contractor', () => {
  const db = fresh();
  const r = addRequest(db, { site: 'शिवपुरी', what: 'मिस्त्री के लिए पानी की टंकी', kind: 'note', by: 'sup:mohan', limitPaise: LIMIT, at: AT });
  assert.equal(r.status, 'requested');
  assert.equal(r.estimatePaise, null);
  assert.deepEqual([r.qtyHundredths, r.unit, r.neededOn], [null, null, null]);
});

test('a supervisor never approves his own request; declining it is refused the same way', () => {
  const db = fresh();
  cement(db);
  assert.throws(() => decideRequest(db, { id: 1, approve: true, by: 'sup:mohan' }), (/** @type {any} */ e) => e instanceof RequestError && e.code === 'OWN_REQUEST');
  assert.throws(() => decideRequest(db, { id: 1, approve: false, by: 'sup:mohan' }), (/** @type {any} */ e) => e.code === 'OWN_REQUEST');
  assert.equal(listRequests(db)[0].status, 'requested');
  assert.equal(requestHistory(db, 1).length, 1, 'a refused decision writes nothing');
});

test('a decision happens once; a declined request stays declined', () => {
  const db = fresh();
  cement(db);
  const d = decideRequest(db, { id: 1, approve: false, by: 'con:ramesh', at: AT });
  assert.equal(d.status, 'declined');
  assert.equal(d.approvedBy, null);
  assert.throws(() => decideRequest(db, { id: 1, approve: true, by: 'con:ramesh' }), (/** @type {any} */ e) => e.code === 'WRONG_STATE');
  assert.throws(() => decideRequest(db, { id: 9, approve: true, by: 'con:ramesh' }), (/** @type {any} */ e) => e.code === 'NOT_FOUND');
});

test('list filters by site and requester, in id order, with the current status of each', () => {
  const db = fresh();
  cement(db);
  cement(db, { site: 'गुना', what: 'रेत', unit: 'ट्रॉली', qtyHundredths: 200, by: 'sup:sita' });
  cement(db, { what: 'JCB', kind: 'jcb', qtyHundredths: 60, unit: 'घंटे', estimatePaise: 720000 });
  decideRequest(db, { id: 3, approve: true, by: 'con:ramesh', at: AT });
  assert.deepEqual(listRequests(db).map((r) => [r.id, r.site, r.status]), [[1, 'शिवपुरी', 'requested'], [2, 'गुना', 'requested'], [3, 'शिवपुरी', 'approved']]);
  assert.deepEqual(listRequests(db, { site: 'शिवपुरी' }).map((r) => r.id), [1, 3]);
  assert.deepEqual(listRequests(db, { by: 'sup:sita' }).map((r) => r.id), [2]);
  assert.deepEqual(listRequests(db, { site: 'गुना', by: 'sup:mohan' }), []);
});

test('approved -> sent (with its order) -> done, one event each, never out of order', () => {
  const db = fresh();
  cement(db);
  assert.throws(() => advanceRequest(db, { id: 1, status: 'sent', orderId: 'o-1', by: 'agent' }), (/** @type {any} */ e) => e.code === 'WRONG_STATE');
  decideRequest(db, { id: 1, approve: true, by: 'con:ramesh', at: AT });
  assert.throws(() => advanceRequest(db, { id: 1, status: 'done', by: 'agent' }), (/** @type {any} */ e) => e.code === 'WRONG_STATE');
  const s = advanceRequest(db, { id: 1, status: 'sent', orderId: 'o-1', by: 'agent', at: AT });
  assert.deepEqual([s.status, s.orderId, s.approvedBy], ['sent', 'o-1', 'con:ramesh']);
  const d = advanceRequest(db, { id: 1, status: 'done', by: 'agent', at: AT });
  assert.equal(d.status, 'done');
  assert.deepEqual(requestHistory(db, 1).map((e) => e.type), ['REQUESTED', 'APPROVED', 'SENT', 'DONE']);
});

test('history cannot be changed or deleted', () => {
  const db = fresh();
  cement(db);
  assert.throws(() => db.exec(`UPDATE request_events SET actor = 'x'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM request_events'), /append-only/);
});

test('bad input writes nothing', () => {
  const db = fresh();
  const bad = (/** @type {any} */ over) => assert.throws(() => cement(db, over), (/** @type {any} */ e) => e.code === 'BAD_INPUT');
  bad({ site: '' });
  bad({ kind: 'cement' });
  bad({ qtyHundredths: 50.5 });
  bad({ qtyHundredths: 5000, unit: null });
  bad({ neededOn: '30-10-2026' });
  bad({ estimatePaise: -1 });
  bad({ by: ' ' });
  assert.deepEqual(listRequests(db), []);
});

test('works inside the contractor ledger file too, beside the ledger tables', () => {
  const L = openLedger(':memory:');
  const r = cement(L);
  assert.equal(r.id, 1);
  assert.equal(listRequests(L.db).length, 1);
  assert.deepEqual(L.verifyChain(), { ok: true, events: 0 }, 'the ledger chain is untouched');
});

test('the approval limit comes from the environment; unset means everything waits', () => {
  assert.equal(approvalLimitPaise({}), 0);
  assert.equal(approvalLimitPaise({ CONTRACTOR_APPROVAL_LIMIT_PAISE: '500000' }), 500000);
  assert.equal(approvalLimitPaise({ CONTRACTOR_APPROVAL_LIMIT_PAISE: 'five' }), 0);
  const db = fresh();
  const r = addRequest(db, { site: 'शिवपुरी', what: 'रेत', kind: 'material', qtyHundredths: 100, unit: 'ट्रॉली', by: 'sup:mohan', estimatePaise: 1, limitPaise: approvalLimitPaise({}) });
  assert.equal(r.status, 'requested');
});
