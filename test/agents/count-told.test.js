// A supervisor's count equal to the challan proves nobody counted. The contractor is told each one,
// with how it was entered, and nothing is asked; the entry stays on record for "what happened on P-1".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { runTool } from '../../src/agents/common.js';
import { siteCountEntry } from '../../src/agents/material.js';
import { setup, person, SHA_A, SHA_C } from './helpers.js';

const supplier = person('supplier', 'agent:supplier-1');
const contractor = person('contractor', 'agent:contractor-1');
const supervisor = person('supervisor', 'agent:contractor-1');
const settle = () => new Promise((r) => setImmediate(r));
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };

/** An order delivered by the supplier, waiting for the site's count. */
async function delivered() {
  const s = await setup({});
  await runTool(s.site.tools, supervisor, { tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-29', items: [CEMENT] } });
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } });
  await settle();
  await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [CEMENT], sha256: SHA_A, challanNo: '412' } });
  await settle();
  return { s, orderId };
}

/** @param {any} s */
const toldCount = (s) => s.told.filter((/** @type {any[]} */ [a, role, key]) => a === 'site' && role === 'contractor' && String(key).startsWith('site.count_told_')).map((/** @type {any[]} */ x) => x[2]);

test('typed figures equal to the challan: the contractor is told they came with no photo', async () => {
  const { s, orderId } = await delivered();
  try {
    const r = await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000] } });
    assert.deepEqual([r.ok, r.key], [true, 'site.count_matches']);
    assert.deepEqual(toldCount(s), ['site.count_told_typed']);
  } finally { await s.close(); }
});

test('a challan photo equal to the delivery: the contractor is told it came from the photo', async () => {
  const { s, orderId } = await delivered();
  try {
    const r = await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000], challan: { sha256: SHA_C, number: '412' } } });
    assert.equal(r.ok, true);
    assert.deepEqual(toldCount(s), ['site.count_told_photo']);
  } finally { await s.close(); }
});

test("the contractor's own count is not told back to them", async () => {
  const { s, orderId } = await delivered();
  try {
    const r = await runTool(s.site.tools, contractor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000], sameAsChallan: true } });
    assert.deepEqual([r.ok, r.key], [true, 'site.count_matches']);
    assert.deepEqual(toldCount(s), []);
  } finally { await s.close(); }
});

test('a count from before this was kept has no entry to show', () => {
  const note = (/** @type {Record<string, any>} */ body) => /** @type {any} */ ({ direction: 'local', type: 'NOTE', body });
  assert.equal(siteCountEntry([note({ kind: 'site_count', items: [CEMENT] })]), null);
  assert.deepEqual(siteCountEntry([note({ kind: 'site_count', items: [CEMENT], by: 'supervisor', how: 'typed' })]), { by: 'supervisor', how: 'typed' });
});

test('the order lookup says who entered the count and how', async () => {
  const { s, orderId } = await delivered();
  try {
    await runTool(s.site.tools, supervisor, { tool: 'confirm_count', args: { orderId, qtysHundredths: [5000], sameAsChallan: true } });
    const ledger = s.siteCore.ledger;
    const ctx = { ledger, facts: orderFacts(ledger), side: /** @type {const} */ ('buyer'), nowMs: s.siteCore.now() };
    const shown = JSON.stringify(runLookup('order_detail', { ref: 'P-1' }, ctx));
    assert.ok(shown.includes('सुपरवाइज़र'), shown);
    assert.ok(shown.includes('फ़ोटो नहीं'), shown);
    assert.equal(ctx.facts[0]?.countEntry?.how, 'yes');
  } finally { await s.close(); }
});
