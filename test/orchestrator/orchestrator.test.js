import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaise, parseTenths, parseTime, resolveDay } from '../../src/orchestrator/units.js';
import { pickOrder, proposeStep } from '../../src/orchestrator/orchestrator.js';

const NOW = Date.parse('2026-10-28T20:00:00Z'); // 29 Oct 01:30 IST

test('figures as written become integers in code', () => {
  assert.equal(parseTenths('6.1'), 61);
  assert.equal(parseTenths('6'), 60);
  assert.equal(parseTenths('6.15'), null);
  assert.equal(parseTenths('six'), null);
  assert.equal(parsePaise('1200'), 120000);
  assert.equal(parsePaise('₹7,320.50'), 732050);
  assert.equal(parsePaise('7,32,000'), 73200000);
  assert.equal(parsePaise('0'), null);
  assert.equal(parsePaise('12.345'), null);
  assert.equal(parseTime('8'), '08:00');
  assert.equal(parseTime('8:30'), '08:30');
  assert.equal(parseTime('25'), null);
});

test('days are resolved in India time by code', () => {
  assert.equal(resolveDay('today', NOW), '2026-10-29');
  assert.equal(resolveDay('tomorrow', NOW), '2026-10-30');
  assert.equal(resolveDay('day_after', NOW), '2026-10-31');
  assert.equal(resolveDay('30-10', NOW), '2026-10-30');
  assert.equal(resolveDay('5/1', NOW), '2027-01-05', 'more than 60 days back means next year');
  assert.equal(resolveDay('31-02', NOW), null);
  assert.equal(resolveDay('kal', NOW), null);
});

/** @param {string} role */
const person = (role) => ({ line: 'l', phone: '919000000001', agent: 'agent:x', role: /** @type {any} */ (role), name: role });

/** @param {{name: string, args: any}[]} calls */
function fakeSpark(calls) {
  /** @type {any[]} */
  const seen = [];
  /** @type {import('../../src/orchestrator/orchestrator.js').Spark} */
  const spark = async (req) => {
    seen.push(req);
    return { ok: true, toolCalls: calls };
  };
  return { spark, seen };
}

test('the model sees only the steps the role allows, and code converts its copy of the figures', async () => {
  const f = fakeSpark([{ name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }]);
  const p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'kal subah 8 baje Shivpuri JCB 6 ghante', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-30', time: '08:00', hoursTenths: 60 } });
  const offered = f.seen[0].tools.map((/** @type {any} */ t) => t.function.name).sort();
  assert.deepEqual(offered, ['help', 'request_jcb']);
  assert.ok(f.seen[0].system.includes('Today (India) is 2026-10-29'));
});

test('a step the role may not take is refused even if the model names it', async () => {
  const f = fakeSpark([{ name: 'accept_bill', args: { order: null } }]);
  const p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'bill theek hai', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'none', key: 'common.not_allowed' });
});

test('the job is the one named, or the only one where the step fits', async () => {
  const orders = [
    { ref: '#1', orderId: 'o1', site: 'Shivpuri', day: '2026-10-29', state: 'billed' },
    { ref: '#2', orderId: 'o2', site: 'Gwalior', day: '2026-10-30', state: 'booked' },
  ];
  let f = fakeSpark([{ name: 'accept_bill', args: { order: null } }]);
  let p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'bill sahi hai', orders, nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'accept_bill', args: { orderId: 'o1' } });
  f = fakeSpark([{ name: 'accept_bill', args: { order: '#7' } }]);
  p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'bill sahi hai', orders, nowMs: NOW });
  assert.deepEqual(p, { kind: 'none', key: 'common.no_such_order' });
  assert.equal(pickOrder([...orders, { ref: '#3', orderId: 'o3', site: 'X', day: '—', state: 'billed' }], null, ['billed']), 'orchestrator.which_job');
});

test('a dispute needs exactly one figure; a model failure asks to try again', async () => {
  const orders = [{ ref: '#1', orderId: 'o1', site: 'S', day: '—', state: 'billed' }];
  let f = fakeSpark([{ name: 'dispute_bill', args: { order: '#1', their_hours: null, their_total_rupees: null, reason: 'galat' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: 'galat hai', orders, nowMs: NOW }), { kind: 'none', key: 'common.bad_args' });
  f = fakeSpark([{ name: 'dispute_bill', args: { order: '#1', their_hours: '5.5', their_total_rupees: null, reason: 'lunch' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: '5.5 ghante hi chali', orders, nowMs: NOW }),
    { kind: 'step', tool: 'dispute_bill', args: { orderId: 'o1', hoursTenths: 55, reason: 'lunch' } });
  const down = async () => /** @type {const} */ ({ ok: false, transient: true, reason: 'http_503' });
  assert.deepEqual(await proposeStep({ spark: down, person: person('contractor'), text: 'x', orders, nowMs: NOW }), { kind: 'none', key: 'orchestrator.try_again' });
});
