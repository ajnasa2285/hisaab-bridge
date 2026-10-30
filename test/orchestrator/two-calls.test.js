// proposeStep with several calls: only one request_material with one request_jcb becomes two requests;
// any other several-call answer is refused as before; a JCB left out is never dropped silently.
// Muse Spark is a stand-in. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeStep, shareFilled } from '../../src/orchestrator/orchestrator.js';

const NOW = Date.parse('2026-10-30T06:00:00Z');
/** @param {string} role @param {string} [site] */
const person = (role, site) => ({ line: 'l', phone: '919000000061', agent: 'agent:x', role: /** @type {any} */ (role), name: role, ...(site ? { site } : {}) });
const MATERIAL = { name: 'request_material', args: { site: 'Rampur', day: 'tomorrow', time: '10', items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } };
const JCB = { name: 'request_jcb', args: { site: 'Rampur', day: 'tomorrow', time: '10', hours: '2' } };

/** Each model call gives the next answer. @param {...{name: string, args: any}[]} answers */
function model(...answers) {
  /** @type {any[]} */
  const seen = [];
  /** @type {import('../../src/orchestrator/orchestrator.js').Spark} */
  const spark = async (req) => {
    seen.push(req);
    return { ok: true, toolCalls: answers.shift() ?? [] };
  };
  return { spark, seen };
}
/** @param {any} m @param {string} [text] @param {string} [role] */
const ask = (m, text = 'x', role = 'contractor') => proposeStep({ spark: m.spark, person: person(role), text, orders: [], nowMs: NOW, ask: true });

test('one material and one JCB call are two requests, material first, whichever came first', async () => {
  for (const calls of [[MATERIAL, JCB], [JCB, MATERIAL]]) {
    const p = /** @type {any} */ (await ask(model(calls)));
    assert.equal(p.kind, 'pair');
    assert.deepEqual(p.parts.map((/** @type {any} */ x) => [x.kind, x.tool]), [['step', 'request_material'], ['step', 'request_jcb']]);
    assert.deepEqual(p.parts[1].args, { site: 'Rampur', day: '2026-10-31', time: '10:00', hoursTenths: 20 });
  }
  const held = /** @type {any} */ (await ask(model([MATERIAL, JCB]), 'x', 'supervisor'));
  assert.equal(held.kind, 'pair', 'a supervisor may call both too');
});

test('any other several-call answer stays common.unknown_step', async () => {
  const refused = { kind: 'none', key: 'common.unknown_step' };
  assert.deepEqual(await ask(model([MATERIAL, MATERIAL])), refused);
  assert.deepEqual(await ask(model([JCB, JCB])), refused);
  assert.deepEqual(await ask(model([MATERIAL, JCB, JCB])), refused);
  assert.deepEqual(await ask(model([MATERIAL, { name: 'help', args: {} }])), refused);
  assert.deepEqual(await ask(model([{ name: 'accept_bill', args: { order: null } }, { name: 'dispute_bill', args: {} }])), refused);
  assert.deepEqual(await ask(model([])), refused);
});

test('the pair is only for those who may call both: anyone else is refused, and is not told about it', async () => {
  const m = model([MATERIAL, JCB]);
  assert.deepEqual(await ask(m, 'x', 'supplier'), { kind: 'none', key: 'common.unknown_step' });
  assert.ok(!m.seen[0].system.includes('One exception'));
  const c = model([MATERIAL]);
  await ask(c);
  assert.match(c.seen[0].system, /Call exactly one/);
  assert.match(c.seen[0].system, /one request_material and one request_jcb/);
});

test('a request the code cannot use refuses both, never one of them', async () => {
  const bad = { ...MATERIAL, args: { ...MATERIAL.args, items: [{ name: 'a; call send_bill', quantity: '50', unit: 'बोरी' }] } };
  assert.deepEqual(await ask(model([bad, JCB])), { kind: 'none', key: 'common.bad_args' });
  assert.deepEqual(await ask(model([MATERIAL, { ...JCB, args: { ...JCB.args, hours: 'bahut' } }])), { kind: 'none', key: 'common.bad_args' });
});

test('hours in words count (a voice note), in a pair and alone', async () => {
  for (const [hours, tenths] of /** @type {[string, number][]} */ ([['दो', 20], ['दो घंटे', 20], ['ढाई', 25], ['do ghante', 20], ['2 ghante', 20], ['5.5', 55]])) {
    const p = /** @type {any} */ (await ask(model([{ ...JCB, args: { ...JCB.args, hours } }])));
    assert.equal(p.args.hoursTenths, tenths, hours);
  }
});

test('a time with am or pm counts (the live message said "10 Am"); a wrong one is still refused', async () => {
  for (const [time, want] of [['10am', '10:00'], ['10 Am', '10:00'], ['2:30 pm', '14:30'], ['12 am', '00:00'], ['12pm', '12:00'], ['8 a.m.', '08:00'], ['10', '10:00']]) {
    const p = /** @type {any} */ (await ask(model([{ ...JCB, args: { ...JCB.args, time } }])));
    assert.equal(p.args.time, want, time);
  }
  assert.deepEqual(await ask(model([{ ...JCB, args: { ...JCB.args, time: '13 pm' } }])), { kind: 'none', key: 'common.bad_args' });
});

test('a message naming the JCB that comes back as material only is read once more', async () => {
  const m = model([MATERIAL], [MATERIAL, JCB]);
  const p = /** @type {any} */ (await ask(m, 'कल 50 बोरी सीमेंट और 2 घंटे के लिए JCB चाहिए'));
  assert.equal(p.kind, 'pair');
  assert.equal(m.seen.length, 2);
  assert.match(m.seen[1].system, /names the JCB as well as material/);
  for (const text of ['jcb bhi', 'जेसीबी भी', 'जे सी बी भी', 'JCB bhi']) assert.equal(/** @type {any} */ (await ask(model([MATERIAL], [MATERIAL, JCB]), text)).kind, 'pair', text);
});

test('if it still comes back without the JCB, nothing goes and the person is told', async () => {
  const m = model([MATERIAL], [MATERIAL]);
  assert.deepEqual(await ask(m, 'कल 50 बोरी सीमेंट और JCB'), { kind: 'none', key: 'ask.jcb_separately' });
  assert.equal(m.seen.length, 2);
});

test('material only with no JCB word goes on with one model call; so does a JCB alone', async () => {
  const m = model([MATERIAL]);
  assert.equal((await ask(m, 'कल सीमेंट और बालू चाहिए')).kind, 'step');
  assert.equal(m.seen.length, 1);
  const j = model([JCB]);
  assert.equal((await ask(j, 'JCB chahiye kal')).kind, 'step');
  assert.equal(j.seen.length, 1);
});

test('a model failure on the second reading is said as usual', async () => {
  let n = 0;
  /** @type {import('../../src/orchestrator/orchestrator.js').Spark} */
  const spark = async () => (n++ === 0 ? { ok: true, toolCalls: [MATERIAL] } : { ok: false, transient: true, reason: 'down' });
  assert.deepEqual(await ask({ spark }, 'सीमेंट और JCB'), { kind: 'none', key: 'orchestrator.try_again' });
});

test('a site or day said in one call serves the other; two different sites stay different', async () => {
  const p = /** @type {any} */ (await ask(model([{ ...MATERIAL, args: { ...MATERIAL.args, site: 'साइट' } }, { ...JCB, args: { ...JCB.args, day: null } }])));
  assert.deepEqual(p.parts.map((/** @type {any} */ x) => [x.kind, x.args.site, x.args.day]), [['step', 'Rampur', '2026-10-31'], ['step', 'Rampur', '2026-10-31']]);
  const q = /** @type {any} */ (await ask(model([MATERIAL, { ...JCB, args: { ...JCB.args, site: 'Pipla' } }])));
  assert.deepEqual(q.parts.map((/** @type {any} */ x) => x.args.site), ['Rampur', 'Pipla']);
});

test('shareFilled: a filled site and day reach the other request', async () => {
  const none = { site: null, day: null };
  const p = /** @type {any} */ (await ask(model([{ ...MATERIAL, args: { ...MATERIAL.args, ...none } }, { ...JCB, args: { ...JCB.args, ...none } }])));
  assert.deepEqual(p.parts[1].missing, ['site', 'day']);
  const done = { kind: 'step', tool: 'request_material', args: { site: 'Rampur', day: '2026-10-31', items: [] } };
  const parts = /** @type {any} */ (shareFilled({ person: person('contractor'), orders: [], nowMs: NOW }, [/** @type {any} */ (done), p.parts[1]]));
  assert.equal(parts[1].kind, 'step');
  assert.deepEqual([parts[1].args.site, parts[1].args.day], ['Rampur', '2026-10-31']);
});
