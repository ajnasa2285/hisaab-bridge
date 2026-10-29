import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountPaise, parseHundredths, parseHundredthsList, parsePaise, parseTenths, parseTime, resolveDay } from '../../src/orchestrator/units.js';
import { orderRefs, pickOrder, proposeStep } from '../../src/orchestrator/orchestrator.js';

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
  // Spoken payment amounts (a voice note, live 30 Oct): words, digits with a word, a trailing "रुपये";
  // a rate stays digits only.
  assert.equal(parsePaise('पंद्रह हजार'), null);
  assert.equal(parseAmountPaise('₹7,320'), 732000);
  assert.equal(parseAmountPaise('पंद्रह हजार'), 1500000);
  assert.equal(parseAmountPaise('15 हज़ार'), 1500000);
  assert.equal(parseAmountPaise('do hazar paanch sau rupaye'), 250000);
  assert.equal(parseAmountPaise('डेढ़ हज़ार'), 150000);
  assert.equal(parseAmountPaise('15000 hazaar'), null);
  assert.equal(parseAmountPaise('kuch paise'), null);
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
  assert.deepEqual(offered, ['confirm_count', 'help', 'request_jcb', 'request_material']);
  assert.ok(f.seen[0].system.includes('Today (India) is 2026-10-29'));
});

test('a step the role may not take is refused even if the model names it', async () => {
  const f = fakeSpark([{ name: 'accept_bill', args: { order: null } }]);
  const p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'bill theek hai', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'none', key: 'common.not_allowed' });
});

test('the job is the one named, or the only one where the step fits', async () => {
  const orders = [
    { ref: 'J-1', orderId: 'o1', site: 'Shivpuri', day: '2026-10-29', state: 'billed' },
    { ref: 'J-2', orderId: 'o2', site: 'Gwalior', day: '2026-10-30', state: 'booked' },
  ];
  let f = fakeSpark([{ name: 'accept_bill', args: { order: null } }]);
  let p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'bill sahi hai', orders, nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'accept_bill', args: { orderId: 'o1' } });
  f = fakeSpark([{ name: 'accept_bill', args: { order: 'J-7' } }]);
  p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'bill sahi hai', orders, nowMs: NOW });
  assert.deepEqual(p, { kind: 'none', key: 'common.no_such_order' });
  assert.equal(pickOrder([...orders, { ref: 'J-3', orderId: 'o3', site: 'X', day: '—', state: 'billed' }], null, ['billed']), 'orchestrator.which_job');
});

test('a dispute needs exactly one figure; a model failure asks to try again', async () => {
  const orders = [{ ref: 'J-1', orderId: 'o1', site: 'S', day: '—', state: 'billed' }];
  let f = fakeSpark([{ name: 'dispute_bill', args: { order: 'J-1', their_hours: null, their_total_rupees: null, reason: 'galat' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: 'galat hai', orders, nowMs: NOW }), { kind: 'none', key: 'common.bad_args' });
  f = fakeSpark([{ name: 'dispute_bill', args: { order: 'J-1', their_hours: '5.5', their_total_rupees: null, reason: 'lunch' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: '5.5 ghante hi chali', orders, nowMs: NOW }),
    { kind: 'step', tool: 'dispute_bill', args: { orderId: 'o1', hoursTenths: 55, reason: 'lunch' } });
  const down = async () => /** @type {const} */ ({ ok: false, transient: true, reason: 'http_503' });
  assert.deepEqual(await proposeStep({ spark: down, person: person('contractor'), text: 'x', orders, nowMs: NOW }), { kind: 'none', key: 'orchestrator.try_again' });
});

test('quantities as written become hundredths in code', () => {
  assert.equal(parseHundredths('50'), 5000);
  assert.equal(parseHundredths('2.5'), 250);
  assert.equal(parseHundredths('1.25'), 125);
  assert.equal(parseHundredths(' 0 '), 0, 'whether 0 is allowed is for the caller');
  assert.equal(parseHundredths('1.255'), null);
  assert.equal(parseHundredths('50 bori'), null);
  assert.equal(parseHundredths(50), null);
  assert.deepEqual(parseHundredthsList('50, 2.5'), [5000, 250]);
  assert.deepEqual(parseHundredthsList('48'), [4800]);
  assert.deepEqual(parseHundredthsList('48 0 2'), [4800, 0, 200]);
  assert.equal(parseHundredthsList('48, do'), null);
  assert.equal(parseHundredthsList(''), null);
  assert.equal(parseHundredthsList(Array.from({ length: 21 }, () => '1').join(',')), null);
});

test('material steps: the model copies items and figures, code converts them', async () => {
  let f = fakeSpark([{ name: 'request_material', args: { site: 'Shivpuri', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }, { name: 'रेत', quantity: '2.5', unit: 'ट्रॉली' }] } }]);
  let p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'kal Shivpuri cement 50 bori, ret 2.5 trolley', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'request_material', args: { site: 'Shivpuri', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }, { name: 'रेत', qtyHundredths: 250, unit: 'ट्रॉली' }] } });
  f = fakeSpark([{ name: 'request_material', args: { site: 'S', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '0', unit: 'बोरी' }] } }]);
  // A quantity of 0 is not an order: it is asked for, not refused.
  assert.deepEqual(/** @type {any} */ (await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders: [], nowMs: NOW })).missing, ['qty:0']);

  // The supplier sees only the supplier's steps; the job list shows the items, so rates follow their order.
  const orders = [{ ref: 'P-1', orderId: 'o1', site: 'Shivpuri', day: '2026-10-30', state: 'requested', what: 'सीमेंट 50 बोरी, रेत 2.5 ट्रॉली' }];
  f = fakeSpark([{ name: 'reply_order', args: { order: null, answer: 'yes', rates_rupees: ['350', '4,000'], day: null, time: null } }]);
  p = await proposeStep({ spark: f.spark, person: person('supplier'), text: 'haan 350 aur 4000', orders, nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'reply_order', args: { orderId: 'o1', answer: 'yes', ratesPaise: [35000, 400000] } });
  assert.deepEqual(f.seen[0].tools.map((/** @type {any} */ t) => t.function.name).sort(), ['confirm_payment', 'help', 'record_received', 'reply_order', 'send_bill', 'send_correction']);
  assert.ok(f.seen[0].system.includes('items: सीमेंट 50 बोरी, रेत 2.5 ट्रॉली'));
  f = fakeSpark([{ name: 'reply_order', args: { order: null, answer: 'yes', rates_rupees: ['350', 'saadhe chaar'], day: null, time: null } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('supplier'), text: 'x', orders, nowMs: NOW }), { kind: 'none', key: 'common.bad_args' });

  // The supplier's correction and the site's count are lists of quantities; a count may be 0.
  const billed = [{ ref: 'P-1', orderId: 'o1', site: 'S', day: '—', state: 'disputed' }];
  f = fakeSpark([{ name: 'send_correction', args: { order: null, quantities: ['48'] } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('supplier'), text: '48 bori ka bhejo', orders: billed, nowMs: NOW }),
    { kind: 'step', tool: 'send_correction', args: { orderId: 'o1', qtysHundredths: [4800] } });
  const delivered = [{ ref: 'P-1', orderId: 'o1', site: 'S', day: '—', state: 'delivered' }];
  f = fakeSpark([{ name: 'confirm_count', args: { order: null, quantities: ['48', '0'] } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('supervisor'), text: '48 bori aayi, ret nahi aayi', orders: delivered, nowMs: NOW }),
    { kind: 'step', tool: 'confirm_count', args: { orderId: 'o1', qtysHundredths: [4800, 0] } });

  // A dispute may carry a quantity, still exactly one figure.
  f = fakeSpark([{ name: 'dispute_bill', args: { order: 'P-1', their_hours: null, their_quantity: '48', their_total_rupees: null, reason: 'site par 48' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: '48 hi aayi', orders: [{ ...billed[0], state: 'billed' }], nowMs: NOW }),
    { kind: 'step', tool: 'dispute_bill', args: { orderId: 'o1', qtyHundredths: 4800, reason: 'site par 48' } });
  f = fakeSpark([{ name: 'dispute_bill', args: { order: 'P-1', their_hours: null, their_quantity: '48', their_total_rupees: '16800', reason: 'x' } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders: [{ ...billed[0], state: 'billed' }], nowMs: NOW }), { kind: 'none', key: 'common.bad_args' });
});

test('jobs carry their stable references; a reference is picked however it is written', async () => {
  const { openLedger } = await import('../../src/ledger/store.js');
  const ledger = openLedger(':memory:');
  const id = (/** @type {number} */ n) => `00000000-0000-4000-8000-00000000000${n}`;
  const request = (/** @type {number} */ n, /** @type {'jcb_hours' | 'material'} */ kind, /** @type {string} */ site) => {
    ledger.ensureOrder({ orderId: id(n), kind, counterparty: 'agent:jcb-1', site, at: `2026-10-29T0${n}:00:00Z` });
    ledger.append({ orderId: id(n), direction: 'out', type: 'BOOKING_REQUEST', msgId: `m${n}`, body: { body: { kind, site, day: '2026-10-30' } }, at: `2026-10-29T0${n}:00:00Z` });
  };
  request(1, 'jcb_hours', 'Shivpuri');
  request(2, 'material', 'Gwalior');
  request(3, 'jcb_hours', 'Datia');
  const orders = orderRefs(ledger);
  assert.deepEqual(orders.map((r) => [r.ref, r.site, r.state]), [['J-1', 'Shivpuri', 'requested'], ['P-1', 'Gwalior', 'requested'], ['J-2', 'Datia', 'requested']]);
  for (const written of ['J-2', 'j2', 'J 2', ' j - 2 ']) assert.equal(/** @type {any} */ (pickOrder(orders, written, [])).orderId, id(3), written);
  assert.equal(/** @type {any} */ (pickOrder(orders, 'p1', [])).orderId, id(2));
  assert.equal(pickOrder(orders, '#1', []), 'common.no_such_order');
  assert.equal(pickOrder(orders, 'J-9', []), 'common.no_such_order');
  assert.equal(pickOrder(orders, null, ['requested']), 'orchestrator.which_job');
  // The model is shown the references.
  const f = fakeSpark([{ name: 'help', args: {} }]);
  await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders, nowMs: NOW });
  assert.match(f.seen[0].system, /J-1 \| site: Shivpuri/);
  assert.match(f.seen[0].system, /P-1 \| site: Gwalior/);
  ledger.close();
});

test('a cash payment understood without its order is kept for the choice, not dropped (live, 30 Oct)', async () => {
  const orders = [
    { ref: 'P-1', orderId: 'o1', site: 'A', day: '2026-10-29', state: 'accepted' },
    { ref: 'P-2', orderId: 'o2', site: 'B', day: '2026-10-29', state: 'accepted' },
  ];
  const f = fakeSpark([{ name: 'claim_payment', args: { order: 'null', amount_rupees: 'पंद्रह हजार' } }]);
  const p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'पंद्रह हजार आज नगद दिया', orders, nowMs: NOW });
  assert.equal(p.kind, 'step');
  assert.equal(/** @type {any} */ (p).tool, 'claim_payment');
  assert.equal(/** @type {any} */ (p).args.amountPaise, 1500000);
  assert.equal(/** @type {any} */ (p).args.orderId, undefined);
});
