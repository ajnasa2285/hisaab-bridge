import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openLedger } from '../../src/ledger/store.js';
import { cleanEvidenceReading, readEvidence } from '../../src/agents/evidence-readings.js';
import { differenceFacts } from '../../src/agents/explain-facts.js';
import { brief, explainDifference, numbersSupported } from '../../src/agents/explain.js';

const at = '2026-10-29T03:30:00.000Z';
const now = () => Date.parse(at);
const buyer = 'agent:contractor-test';
const seller = 'agent:supplier-test';
const bytes = new Uint8Array([137, 80, 78, 71, 48]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
/** @param {number} qtyHundredths */
const item = (qtyHundredths) => ({ name: 'सीमेंट', qtyHundredths, unit: 'बोरी' });

function fixture() {
  const ledger = openLedger(':memory:');
  const orderId = randomUUID();
  ledger.ensureOrder({ orderId, kind: 'material', site: 'कल्पित साइट', counterparty: buyer, at });
  /** @param {string} type @param {Record<string,any>} body @param {'in'|'out'|'local'} [direction] */
  const put = (type, body, direction = 'out') => {
    const msgId = randomUUID();
    assert.ok(ledger.append({ orderId, type, direction, msgId, at,
      body: direction === 'local' ? body : { from: direction === 'in' ? buyer : seller,
        to: direction === 'in' ? seller : buyer, msg_id: msgId, created_at: at, body } }));
    return msgId;
  };
  put('BOOKING_REQUEST', { kind: 'material', site: 'कल्पित साइट', items: [item(5000)] }, 'in');
  put('BOOKING_REPLY', { answer: 'yes', rates: [{ name: 'सीमेंट', unit: 'बोरी', ratePaise: 35000 }] });
  put('DELIVERY', { items: [item(5000)], challan: { sha256: 'a'.repeat(64), number: 'D-7' }, deliveredAt: at });
  const bill = put('BILL', { lines: [{ what: 'सीमेंट', qtyHundredths: 5000, ratePaise: 35000, amountPaise: 1750000 }], totalPaise: 1750000 });
  const record = { record: randomUUID(), sha256, kind: 'site_count', owner: buyer, at };
  put('DISPUTE', { bill, theirFigure: { qtyHundredths: 4800 }, reason: 'साइट की गिनती अलग है',
    siteCount: { record: record.record, sha256, number: 'S-8', items: [item(4800)], at } }, 'in');
  const wireItem = { record: record.record, sha256, mime: 'image/png' };
  const received = () => put('EVIDENCE', { refers_to: randomUUID(), items: [wireItem] }, 'in');
  return { ledger, orderId, put, record, wireItem, received };
}

test('a received site photo runs only its matching reader and both sides enter checked explanation facts', async () => {
  const f = fixture();
  try {
    f.received();
    let calls = 0;
    const note = await readEvidence({ ...f, item: { ...f.wireItem, bytes }, now,
      readMeter: async () => { throw new Error('wrong reader'); },
      readChallan: async (image) => {
        calls++;
        assert.deepEqual(image.bytes, bytes);
        return { ok: true, kind: 'challan', clear: true, challanNo: 'S-8', date: null,
          items: [{ ...item(4800), raw: 'discarded arbitrary text 999' }], model: 'test', latencyMs: 0 };
      } });
    assert.ok(note);
    assert.deepEqual(note.body.reading, { challanNo: 'S-8', items: [item(4800)] });
    assert.doesNotMatch(JSON.stringify(note), /discarded|999|bytes|base64/);
    assert.equal(f.ledger.view(f.orderId).state, 'disputed');
    const facts = differenceFacts(f.ledger, f.orderId, 'P-1');
    const context = /** @type {any} */ (facts.context);
    assert.equal(context.peerSiteCount.items[0].quantity, '48');
    assert.equal(context.receivedEvidence[0].items[0].quantity, '48');
    const prompt = brief(facts.context, 'seller');
    assert.match(prompt, /डिलीवरी.*50 बोरी/);
    assert.match(prompt, /साइट की मिली फ़ोटो.*48 बोरी/);
    assert.doesNotMatch(prompt, /sha256|00000000|999/);
    const explanation = 'सप्लायर के चालान में 50 बोरी और साइट की मिली फ़ोटो में 48 बोरी दर्ज हैं।';
    assert.equal(numbersSupported(explanation, facts.allowedNumbers), true);
    /** @param {string} text */
    const answer = async (text) => explainDifference({ facts, audience: 'seller',
      spark: async () => ({ ok: true, json: { explanation: text }, toolCalls: [] }) });
    assert.equal((await answer(explanation)).key, 'explain.wrapper');
    assert.equal((await answer(explanation.replace('48', '49'))).key, 'explain.unavailable');
    // A second explicit request displays again without charging for the same reading again.
    assert.equal((await readEvidence({ ...f, item: { ...f.wireItem, bytes }, now,
      readChallan: async () => { calls++; throw new Error('must not reread'); } }))?.msgId, note.msgId);
    assert.equal(calls, 1);
  } finally { f.ledger.close(); }
});

test('tampered bytes or no accepted response never reach a reader or authorize observed numbers', async () => {
  const f = fixture();
  try {
    let calls = 0;
    /** @type {import('../../src/agents/conversation.js').ChallanReader} */
    const readChallan = async () => { calls++; return { ok: true, kind: 'challan', clear: true,
      challanNo: null, date: null, items: [{ ...item(4900), raw: 'invented' }] }; };
    assert.equal(await readEvidence({ ...f, item: { ...f.wireItem, bytes }, readChallan, now }), null);
    f.received();
    assert.equal(await readEvidence({ ...f, item: { ...f.wireItem, bytes: new Uint8Array([1]) }, readChallan, now }), null);
    assert.equal(calls, 0);
    f.put('NOTE', { kind: 'evidence_reading', record: randomUUID(), sha256, source: buyer,
      sourceKind: 'site_count', reading: { challanNo: null, items: [item(4900)] } }, 'local');
    const facts = differenceFacts(f.ledger, f.orderId, 'P-1');
    assert.deepEqual(/** @type {any} */ (facts.context).receivedEvidence, []);
    assert.equal(numbersSupported('49 बोरी', facts.allowedNumbers), false);
  } finally { f.ledger.close(); }
});

test('unclear photos, fractional stored values and mismatched reader kinds supply no numeric facts', () => {
  for (const result of [
    { ok: false }, { ok: true, clear: false, kind: 'challan', items: [item(5000)] },
    { ok: true, clear: true, kind: 'challan', items: [item(1.5)] },
    { ok: true, clear: true, kind: 'not_challan', items: [item(5000)] },
  ]) assert.equal(cleanEvidenceReading('challan', result), null);
  assert.deepEqual(cleanEvidenceReading('meter', { ok: true, clear: true, kind: 'hour_meter', valueTenths: 12467, raw: '1246.7' }), { valueTenths: 12467 });
  assert.equal(cleanEvidenceReading('meter', { ok: true, clear: true, kind: 'hour_meter', valueTenths: 1246.7 }), null);
  assert.deepEqual(cleanEvidenceReading('upi', { ok: true, clear: true, kind: 'upi_payment', amountPaise: 120000, payeeName: 'discard' }), { amountPaise: 120000 });
});
