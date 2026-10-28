// Invented disputes through the real agents and signed A2A exchange. The explanation is a notice,
// never a new instruction, tool invocation, ledger event, or a view into another agent's notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = person('operator', 'agent:jcb-1');
const supplier = person('supplier', 'agent:supplier-1');
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000021' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000022' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** @typedef {{side: string, role: string, key: string, params: any, expect: any}} Notice */

/** Wait for an actual notice, not an assumed number of event-loop turns. */
function notices() {
  /** @type {Notice[]} */
  const all = [];
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    all,
    /** @param {string} side @param {string} role @param {string} key @param {any} params @param {any} expect */
    onTell(side, role, key, params, expect) {
      all.push({ side, role, key, params, expect });
      for (const listener of listeners) listener();
    },
    /** @param {string} side @param {string} key @param {number} [after] @returns {Promise<Notice>} */
    waitFor(side, key, after = 0) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${side}: ${key}`)); }, 3000);
        const check = () => {
          const found = all.slice(after).find((n) => n.side === side && n.key === key);
          if (found) { clearTimeout(timer); listeners.delete(check); resolve(found); }
        };
        listeners.add(check);
        check();
      });
    },
  };
}

/** @param {string} explanation */
const modelAnswer = (explanation) => ({ ok: true, json: { explanation }, toolCalls: [] });

/** @param {Awaited<ReturnType<typeof setup>>} s */
async function billedJcb(s) {
  assert.equal((await runTool(s.site.tools, supervisor, { tool: 'request_jcb', args: { site: 'Demo yard', day: '2026-10-29', hoursTenths: 60 } })).ok, true);
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } })).ok, true);
  assert.equal((await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_A, takenAt: '2026-10-29T02:35:00Z' } })).ok, true);
  s.advance(6 * 60 * 60 * 1000);
  assert.equal((await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B, takenAt: '2026-10-29T08:35:00Z' } })).ok, true);
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } })).ok, true);
  return orderId;
}

/** @param {Awaited<ReturnType<typeof setup>>} s */
async function bookedMaterial(s) {
  assert.equal((await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Demo yard', day: '2026-10-29', items: [CEMENT] } })).ok, true);
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } })).ok, true);
  return orderId;
}

test('JCB dispute explains after the original notice; prose changes no ledger, tool, or confirmation', async () => {
  const n = notices();
  /** @type {any[]} */
  const requests = [];
  /** @type {(answer: any) => void} */
  let finish = () => {};
  const answer = new Promise((resolve) => { finish = resolve; });
  const s = await setup({ onTell: n.onTell, spark: async (req) => { requests.push(req); return answer; } });
  try {
    const orderId = await billedJcb(s);
    const keys = [s.jcb, s.site, s.sup].map((a) => Object.keys(a.tools));
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 55, reason: 'साइट की दर्ज अवधि अलग है।' } })).ok, true);
    await n.waitFor('jcb', 'jcb.bill_disputed');
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'disputed');
    const before = [s.jcbCore, s.siteCore, s.supCore].map((core) => core.ledger.events(orderId));
    const explanation = 'मीटर से 6.1 घंटे दर्ज हैं; साइट ने 5.5 घंटे बताए हैं।';
    finish(modelAnswer(explanation));
    const said = await n.waitFor('jcb', 'explain.wrapper');
    assert.equal(said.role, 'jcb_owner');
    assert.equal(said.params.explanation, explanation);
    assert.equal(said.expect, undefined, 'an explanation never proposes a step');
    assert.match(said.params.figures, /6\.1/);
    assert.match(said.params.figures, /5\.5/);
    assert.ok(n.all.findIndex((x) => x.key === 'jcb.bill_disputed') < n.all.indexOf(said));
    assert.deepEqual([s.jcbCore, s.siteCore, s.supCore].map((core) => core.ledger.events(orderId)), before);
    assert.deepEqual([s.jcb, s.site, s.sup].map((a) => Object.keys(a.tools)), keys);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined, 'no model tools are offered');
    assert.ok(requests[0].schema, 'the helper requests structured JSON');
    assert.match(requests[0].text, /seller/);
    const firstFacts = JSON.parse(requests[0].text).facts;
    assert.equal(firstFacts.currentBill.lines[0].quantity, '6.1');
    assert.equal(firstFacts.meterEvidence.computedHours, '6.1');
    assert.equal(firstFacts.meterEvidence.start.source, 'locally_confirmed_meter');
    assert.equal(firstFacts.disputes.at(-1).figure.value, '5.5');
    for (const value of ['1234.5', '1240.6', '6.1', '5.5']) assert.ok(requests[0].text.includes(value), value);
    assert.ok(!requests[0].text.includes(SHA_A) && !requests[0].text.includes(orderId), 'fingerprints and internal ids are not numerical evidence');

    // A later dispute must use the correction now in force while preserving its meter evidence.
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 55 } })).ok, true);
    const after = n.all.length;
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 50, reason: 'दर्ज अवधि फिर अलग है।' } })).ok, true);
    await n.waitFor('jcb', 'explain.wrapper', after);
    assert.equal(requests.length, 2);
    assert.match(requests[1].text, /CORRECTION|correction/);
    const correctedFacts = JSON.parse(requests[1].text).facts;
    assert.equal(correctedFacts.currentBill.lines[0].quantity, '5.5');
    assert.equal(correctedFacts.currentBill.source, 'CORRECTION');
    assert.equal(correctedFacts.corrections.at(-1).isCurrent, true);
    assert.equal(correctedFacts.disputes.at(-1).concernsCurrentBill, true);
    assert.ok(requests[1].text.includes('6,600') || requests[1].text.includes('6600'), 'current corrected amount is supplied');
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'disputed');
    assert.equal(s.jcbCore.ledger.view(orderId).billRev, 2);
  } finally {
    finish({ ok: false, transient: true, reason: 'test cleanup' });
    await s.close();
  }
});

test('material explanations keep the buyer site challan separate from the seller signed delivery', async () => {
  const n = notices();
  /** @type {any[]} */
  const requests = [];
  const explanation = 'बिल में 50 बोरी दर्ज हैं; साइट ने 48 बोरी बताई हैं।';
  const s = await setup({ onTell: n.onTell, spark: async (req) => { requests.push(req); return modelAnswer(explanation); } });
  try {
    const orderId = await bookedMaterial(s);
    assert.equal((await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [4800], challan: { sha256: SHA_B, number: 'SITE-75' } } })).ok, true);
    assert.equal((await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A, challanNo: 'DEL-81' } })).ok, true);
    assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
    const buyer = await n.waitFor('site', 'explain.wrapper');
    assert.equal(buyer.role, 'contractor');
    assert.equal(buyer.expect, undefined);
    assert.ok(n.all.findIndex((x) => x.key === 'site.material_bill_count_differs') < n.all.indexOf(buyer));
    assert.equal(s.siteCore.ledger.view(orderId).state, 'billed', 'no automatic dispute or acceptance');
    assert.match(requests[0].text, /buyer/);
    const buyerFacts = JSON.parse(requests[0].text).facts;
    assert.equal(buyerFacts.localSiteCount.fromSiteChallanPhoto, true);
    assert.equal(buyerFacts.localSiteCount.items[0].quantity, '48');
    assert.equal(buyerFacts.signedDelivery.items[0].quantity, '50');
    assert.equal(buyerFacts.signedDelivery.challanNumber, 'DEL-81');
    for (const value of ['SITE-75', 'DEL-81', '48', '50']) assert.ok(requests[0].text.includes(value), value);

    assert.equal((await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, qtyHundredths: 4800, reason: 'साइट की गिनती अलग है।' } })).ok, true);
    const seller = await n.waitFor('supplier', 'explain.wrapper');
    assert.equal(seller.role, 'supplier');
    assert.equal(seller.expect, undefined);
    assert.ok(n.all.findIndex((x) => x.key === 'supplier.bill_disputed') < n.all.indexOf(seller));
    assert.equal(requests.length, 2);
    assert.match(requests[1].text, /seller/);
    const sellerFacts = JSON.parse(requests[1].text).facts;
    assert.equal(sellerFacts.localSiteCount, null, 'site photo provenance is unknown to the seller');
    assert.equal(sellerFacts.disputes.at(-1).figure.value, '48');
    assert.ok(requests[1].text.includes('DEL-81'));
    assert.ok(!requests[1].text.includes('SITE-75'), 'a seller cannot see the site-only challan number');
    assert.ok(!requests[1].text.includes(SHA_B), 'a seller cannot see the site-only photo fingerprint');
    assert.equal(s.supCore.ledger.events(orderId).filter((e) => e.type === 'NOTE').length, 0);
    for (const core of [s.siteCore, s.supCore]) {
      assert.ok(!JSON.stringify(core.ledger.events(orderId)).includes(explanation), 'model prose stays out of the ledger');
      assert.equal(core.ledger.verifyChain().ok, true);
      assert.equal(core.ledger.view(orderId).state, 'disputed');
    }
  } finally { await s.close(); }
});

for (const [name, result] of /** @type {const} */ ([
  ['unknown number', modelAnswer('बिल में 999 बोरी दर्ज हैं।')],
  ['model timeout', { ok: false, transient: true, reason: 'timeout' }],
])) {
  test(`material bill rate mismatch keeps its original notice and plain figures on ${name}`, async () => {
    const n = notices();
    const s = await setup({ onTell: n.onTell, spark: async () => result });
    try {
      const orderId = await bookedMaterial(s);
      assert.equal((await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A, challanNo: 'DEL-81' } })).ok, true);
      // A signed, arithmetically valid bill using a rate different from the agreed ₹350.
      assert.equal((await s.supLink.send({ type: 'BILL', to: 'agent:contractor-1', orderId, body: {
        lines: [{ what: CEMENT.name, qtyHundredths: 5000, ratePaise: 35100, amountPaise: 1755000 }],
        totalPaise: 1755000,
        evidence: [{ sha256: SHA_A, kind: 'challan', readValue: 'DEL-81', takenAt: null, sentAt: '2026-10-29T02:30:00Z' }],
      } })).ok, true);
      const said = await n.waitFor('site', 'explain.unavailable');
      assert.ok(n.all.findIndex((x) => x.key === 'site.material_bill_mismatch') < n.all.indexOf(said));
      assert.equal(said.expect, undefined);
      assert.equal(said.params.explanation, undefined, 'unsafe model prose is discarded');
      assert.ok(!said.params.figures.includes('999'));
      assert.ok(said.params.figures.includes('17,550') || said.params.figures.includes('17550'));
      assert.equal(s.siteCore.ledger.view(orderId).state, 'billed');
      assert.ok(!n.all.some((x) => x.key === 'explain.wrapper'));
    } finally { await s.close(); }
  });
}
