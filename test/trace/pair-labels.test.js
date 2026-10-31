// One message, two requests: each line of the trace carries its own order's reference, or none while
// it has none (live, 31 Oct: J-3's limit check and decision were traced with the held P-4's reference).
// Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTOR, OWNER, SUPERVISOR, SUPPLIER, startService } from './harness.js';

const LIMITS = { procurementPaise: 10000000 };
const MATERIAL = { name: 'request_material', args: { site: 'Shivpuri', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } };
const JCB = { name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } };

/** @param {Awaited<ReturnType<typeof startService>>} s @param {{name: string, args: any}} call @param {string} answer the seller's reply @param {string} seller */
async function agreed(s, call, seller, answer) {
  s.model.calls = [call];
  await s.say(CONTRACTOR, 'x');
  await s.yesIfAsked(CONTRACTOR);
  s.model.calls = [];
  await s.say(seller, answer);
}

/** The supervisor's two requests, read back and confirmed; the trace of the "हाँ" and after, by tool. @param {Awaited<ReturnType<typeof startService>>} s */
async function pair(s) {
  s.model.calls = [MATERIAL, JCB];
  await s.say(SUPERVISOR, 'kal Shivpuri cement 50 bori aur JCB 6 ghante');
  s.model.calls = [];
  const before = (await (await s.trace('site')).json()).entries.length;
  await s.say(SUPERVISOR, 'हाँ');
  const entries = (await (await s.trace('site')).json()).entries.slice(before);
  const approval = (/** @type {string} */ word) => entries.filter((/** @type {any} */ e) => e.detail.name === 'approval' && e.title.includes(word));
  const decision = (/** @type {string} */ tool) => entries.find((/** @type {any} */ e) => e.kind === 'decision' && e.detail.tool === tool);
  return { entries, approval, decision };
}

/** @param {any} e @param {string | null} ref */
const labelled = (e, ref) => assert.equal(e.ref, ref, `${e.title}: ${e.ref}`);

test('material held, JCB within the limit: the check and decision of each carry its own reference', async () => {
  const s = await startService({ limits: LIMITS });
  try {
    for (const p of [OWNER, SUPPLIER, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
    // The JCB rate is known, the supplier's is not, so only the material is held.
    await agreed(s, JCB, OWNER, 'हाँ 1200');
    const { approval, decision, entries } = await pair(s);
    labelled(approval('held for the contractor')[0], 'P-1');
    labelled(approval('runs')[0], 'J-2');
    labelled(decision('request_jcb'), 'J-2');
    assert.ok(entries.filter((/** @type {any} */ e) => e.kind === 'signed_out').every((/** @type {any} */ e) => e.ref === 'J-2'), 'the only message out is the JCB request');
    const site = s.app.agent('agent:contractor-1');
    assert.equal(approval('runs')[0].orderId, site.core.ledger.orders().at(-1).order_id);
    assert.equal(approval('held for the contractor')[0].orderId, null, 'held: no order yet');
    // Once approved, the order's own view shows the held step's check, never the JCB's lines.
    await s.say(CONTRACTOR, 'ok P-1');
    const held = (await (await s.trace('site', '?order=P-1')).json()).entries;
    assert.ok(held.some((/** @type {any} */ e) => e.detail.name === 'approval'));
    assert.ok(!held.some((/** @type {any} */ e) => e.kind === 'decision' && e.detail.tool === 'request_jcb'));
  } finally {
    await s.close();
  }
});

test('material within the limit, JCB held: the JCB\'s lines do not take the material order', async () => {
  const s = await startService({ limits: LIMITS });
  try {
    for (const p of [SUPPLIER, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
    await agreed(s, MATERIAL, SUPPLIER, 'हाँ 350');
    const { approval, decision } = await pair(s);
    labelled(approval('runs')[0], 'P-2');
    labelled(decision('request_material'), 'P-2');
    const held = approval('held for the contractor')[0];
    labelled(held, 'J-1');
    assert.equal(held.orderId, null);
  } finally {
    await s.close();
  }
});

test('both within the limit: two orders, each with its own lines', async () => {
  const s = await startService({ limits: LIMITS });
  try {
    for (const p of [OWNER, SUPPLIER, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
    await agreed(s, MATERIAL, SUPPLIER, 'हाँ 350');
    await agreed(s, JCB, OWNER, 'हाँ 1200');
    const { entries, decision } = await pair(s);
    labelled(decision('request_material'), 'P-2');
    labelled(decision('request_jcb'), 'J-2');
    const outs = entries.filter((/** @type {any} */ e) => e.kind === 'signed_out');
    assert.deepEqual(outs.map((/** @type {any} */ e) => e.ref).sort(), ['J-2', 'P-2']);
    // What belongs to both (the "हाँ" itself) carries neither.
    labelled(entries.find((/** @type {any} */ e) => e.kind === 'received'), null);
  } finally {
    await s.close();
  }
});
