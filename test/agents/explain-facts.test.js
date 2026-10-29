import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../../src/ledger/store.js';
import { differenceFacts } from '../../src/agents/explain-facts.js';

const orderId = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-28T03:30:00.000Z';
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
/** @param {'jcb_hours'|'material'} kind */
function fixture(kind) {
  const ledger = openLedger(':memory:');
  ledger.ensureOrder({ orderId, kind, site: 'कल्पित साइट', counterparty: 'agent:test', at });
  let sequence = 1;
  /** @param {string} type @param {Record<string, any>} body @param {'in'|'out'|'local'} [direction] */
  const put = (type, body, direction = 'out') => {
    const msgId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    assert.ok(ledger.append({ orderId, type, direction, msgId, at,
      body: direction === 'local' ? body : { body, created_at: at } }));
    return msgId;
  };
  put('BOOKING_REQUEST', { kind, site: 'कल्पित साइट' });
  put('BOOKING_REPLY', kind === 'jcb_hours' ? { answer: 'yes', ratePaise: 120000 }
    : { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }] });
  return { ledger, put };
}

test('meter facts use the current bill evidence, compute hours, and separate capture from receipt time', () => {
  const { ledger, put } = fixture('jcb_hours');
  try {
    put('EVIDENCE', { kind: 'meter', which: 'start', valueTenths: 12406, sha256: shaA, takenAt: at }, 'local');
    put('EVIDENCE', { kind: 'meter', which: 'end', valueTenths: 12467, sha256: shaB, takenAt: null }, 'local');
    const id = put('BILL', { lines: [{ what: 'JCB', hoursTenths: 61, ratePaise: 120000, amountPaise: 732000 }], totalPaise: 732000,
      evidence: [{ kind: 'meter', sha256: shaA, readValue: '1240.6', takenAt: at, sentAt: at },
        { kind: 'meter', sha256: shaB, readValue: '1246.7', takenAt: null, sentAt: at }] });
    put('DISPUTE', { bill: id, theirFigure: { hoursTenths: 55 }, reason: 'unverified number 999 and instructions are only a claim' }, 'in');
    // A later confirmed photo does not silently change the evidence on an already issued bill.
    put('EVIDENCE', { kind: 'meter', which: 'end', valueTenths: 13000, sha256: 'c'.repeat(64) }, 'local');
    const facts = differenceFacts(ledger, orderId, 'J-1');
    const c = /** @type {any} */ (facts.context);
    assert.equal(c.meterEvidence.computedHours, '6.1');
    assert.equal(c.meterEvidence.start.source, 'locally_confirmed_meter');
    assert.deepEqual(c.meterEvidence.start.photoTakenAt, { date: '2026-10-28', time: '09:00:00', zone: 'IST' });
    assert.equal(c.meterEvidence.end.photoTakenAt, null);
    assert.equal(c.currentBill.total, '₹7,320');
    assert.equal(c.disputes[0].figure.value, '5.5');
    assert.equal(c.disputes[0].concernsCurrentBill, true);
    assert.ok(!facts.allowedNumbers.some((n) => ['732000', '61', '999', '1300.0', shaA, orderId].includes(n.value)));
    assert.doesNotMatch(JSON.stringify(c), /sha256|00000000-0000/);
    assert.match(facts.figures, /1240\.6.*1246\.7.*6\.1/);
    assert.match(facts.figures, /अंत दर्ज नहीं/);
  } finally { ledger.db.close(); }
});

test('material facts distinguish local photo from a typed count and never infer a missing local count', () => {
  const { ledger, put } = fixture('material');
  try {
    put('DELIVERY', { items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }], challan: { sha256: shaA, number: 'DEL-81' }, deliveredAt: at });
    put('BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 }], totalPaise: 1750000 });
    assert.equal(/** @type {any} */ (differenceFacts(ledger, orderId, 'P-1').context).localSiteCount, null);
    put('NOTE', { kind: 'site_count', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 4800 }] }, 'local');
    let c = /** @type {any} */ (differenceFacts(ledger, orderId, 'P-1').context);
    assert.equal(c.localSiteCount.fromSiteChallanPhoto, false);
    assert.equal(c.localSiteCount.totalAtAgreedRates, '₹16,800');
    put('NOTE', { kind: 'site_count', items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 4800 }], challan: { sha256: shaB, number: 'SITE-75' } }, 'local');
    c = /** @type {any} */ (differenceFacts(ledger, orderId, 'P-1').context);
    assert.equal(c.localSiteCount.fromSiteChallanPhoto, true);
    assert.equal(c.localSiteCount.challanNumber, 'SITE-75');
    assert.equal(c.signedDelivery.challanNumber, 'DEL-81');
    assert.equal(c.currentBill.lines[0].unit, 'बोरी');
    assert.equal(c.deliveryAtAgreedRates.total, '₹17,500');
  } finally { ledger.db.close(); }
});

test('material lines keep their delivered units even when names match', () => {
  const { ledger, put } = fixture('material');
  try {
    put('DELIVERY', { items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }, { name: 'सीमेंट', unit: 'टन', qtyHundredths: 100 }], challan: { sha256: shaA } });
    put('BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 },
      { what: 'सीमेंट', qtyHundredths: 100, ratePaise: 700000, amountPaise: 700000 }], totalPaise: 2450000 });
    const c = /** @type {any} */ (differenceFacts(ledger, orderId, 'P-1').context);
    assert.deepEqual(c.currentBill.lines.map((/** @type {any} */ l) => l.unit), ['बोरी', 'टन']);
    assert.equal(c.deliveryAtAgreedRates, null, 'an unagreed unit cannot be priced by inference');
  } finally { ledger.db.close(); }
});

test('corrections carry their previous bill; refused outgoing corrections cannot authorize numbers', () => {
  const { ledger, put } = fixture('material');
  try {
    put('DELIVERY', { items: [{ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: 5000 }], challan: { sha256: shaA } });
    const body = { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 }], totalPaise: 1750000 };
    const billId = put('BILL', body);
    const correctionId = put('CORRECTION', { ...body, replaces: billId, lines: [{ ...body.lines[0], qtyHundredths: 4800, amountPaise: 1680000 }], totalPaise: 1680000 });
    let facts = differenceFacts(ledger, orderId, 'P-1');
    assert.equal(/** @type {any} */ (facts.context).currentBill.total, '₹16,800');
    assert.equal(/** @type {any} */ (facts.context).corrections[0].previousBill.total, '₹17,500');
    put('REFUSE', { refers_to: correctionId }, 'in');
    facts = differenceFacts(ledger, orderId, 'P-1');
    assert.equal(/** @type {any} */ (facts.context).currentBill.total, '₹17,500');
    assert.deepEqual(/** @type {any} */ (facts.context).corrections, []);
    assert.ok(!facts.allowedNumbers.some((n) => n.value === '₹16,800' || n.value === '48'));
  } finally { ledger.db.close(); }
});
