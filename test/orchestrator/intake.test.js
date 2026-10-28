// Intake: a request with a value left out is kept and only that value is asked; models' "null" words
// count as null; quantities may be number words (code converts); a request without a site name is for
// the person's own site. Muse Spark is a stand-in returning the arguments a model would give.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, dayWord, parseQuantity } from '../../src/orchestrator/units.js';
import { fillStep, proposeStep, siteOf } from '../../src/orchestrator/orchestrator.js';
import { parseCommand } from '../../src/agents/office.js';
import { hi } from '../../src/i18n/hi.js';

const NOW = Date.parse('2026-10-28T06:00:00Z'); // 28 Oct 11:30 IST

/** @param {string} role @param {string} [site] */
const person = (role, site) => ({ line: 'l', phone: '919000000011', agent: 'agent:x', role: /** @type {any} */ (role), name: role, ...(site ? { site } : {}) });

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

const cement = (/** @type {string | null} */ quantity, /** @type {string | null} */ unit = 'बोरी') => ({ name: 'सीमेंट', quantity, unit });

test('a value the model wrote as "null", "none", "-" or "" is null', () => {
  for (const v of [null, undefined, '', ' ', 'null', 'NULL', ' None ', '-']) assert.equal(blank(v), true, String(v));
  for (const v of ['0', '8', 'nul', 'no']) assert.equal(blank(v), false, v);
});

test('the live case: time "null" and site "साइट" become a step on the supervisor\'s own site', async () => {
  const f = fakeSpark([{ name: 'request_material', args: { day: 'tomorrow', items: [cement('50')], site: 'साइट', time: 'null' } }]);
  const p = await proposeStep({ spark: f.spark, person: person('supervisor', 'Rampur'), text: 'कल साइट पर सीमेंट 50 बोरी चाहिए', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'step', tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } });
  // The model is told to keep number words and to call the step with nulls rather than help.
  assert.match(f.seen[0].system, /in words .* copied as those words/);
  assert.match(f.seen[0].system, /still call that step with null/);

  // Every spec's nullable fields take the same words.
  const g = fakeSpark([{ name: 'request_jcb', args: { site: 'Rampur site', day: '30-10', time: 'None', hours: '-' } }]);
  assert.deepEqual(await proposeStep({ spark: g.spark, person: person('contractor'), text: 'x', orders: [], nowMs: NOW }),
    { kind: 'step', tool: 'request_jcb', args: { site: 'Rampur', day: '2026-10-30' } });
  const orders = [{ ref: 'J-1', orderId: 'o1', site: 'Rampur', day: '2026-10-30', state: 'requested' }];
  const h = fakeSpark([{ name: 'reply_booking', args: { order: 'null', answer: 'yes', rate_rupees_per_hour: '1200', day: 'null', time: '' } }]);
  assert.deepEqual(await proposeStep({ spark: h.spark, person: person('jcb_owner'), text: 'haan 1200', orders, nowMs: NOW }),
    { kind: 'step', tool: 'reply_booking', args: { orderId: 'o1', answer: 'yes', ratePaise: 120000 } });
  const billed = [{ ref: 'J-1', orderId: 'o1', site: 'S', day: '—', state: 'billed' }];
  const d = fakeSpark([{ name: 'dispute_bill', args: { order: 'J-1', their_hours: '5.5', their_quantity: 'null', their_total_rupees: 'none', reason: 'lunch' } }]);
  assert.deepEqual(await proposeStep({ spark: d.spark, person: person('contractor'), text: 'x', orders: billed, nowMs: NOW }),
    { kind: 'step', tool: 'dispute_bill', args: { orderId: 'o1', hoursTenths: 55, reason: 'lunch' } });
});

test('quantities in number words are converted by code, exactly or not at all', () => {
  /** @type {[string, number][]} */
  const ok = [
    ['50', 5000], ['2.5', 250], ['पचास', 5000], ['pachaas', 5000], ['Pachas', 5000], ['ek', 100], ['दस', 1000],
    ['सौ', 10000], ['sau', 10000], ['दो सौ', 20000], ['do sau pachaas', 25000], ['dhai sau', 25000], ['ढाई', 250],
    ['dedh', 150], ['saadhe teen', 350], ['sawa sau', 12500], ['paune do', 175], ['2 सौ', 20000], ['do hazar paanch sau', 250000],
    ['दो हज़ार', 200000], ['hazar', 100000], ['saadhe teen sau', 35000],
  ];
  for (const [s, n] of ok) assert.equal(parseQuantity(s), n, s);
  for (const s of ['', 'kuch', 'do teen', 'pachaas do', 'sau sau', 'saadhe', 'saadhe dhai', '50 bori', 'do-teen', '0 sau', 'teen sau hazar hazar', 'bahut']) {
    assert.equal(parseQuantity(s), null, s);
  }
  assert.equal(parseQuantity('0'), 0, 'the digit 0 is a figure; whether it is allowed is for the caller');
  assert.equal(dayWord('कल'), 'tomorrow');
  assert.equal(dayWord('Parso'), 'day_after');
  assert.equal(dayWord('30-10'), '30-10');
  assert.equal(dayWord('kal subah'), null);
});

test('the site: a name as written, else the person\'s own, else the only one among the open jobs', () => {
  const ctx = { nowMs: NOW, defaultSite: 'Rampur', sites: ['Rampur', 'Green Park'] };
  assert.equal(siteOf('साइट', ctx), 'Rampur');
  for (const w of ['site', 'side', 'साइड', 'yahan', 'यहाँ', 'साइट पर', 'site pe', 'null', null]) assert.equal(siteOf(w, ctx), 'Rampur', String(w));
  assert.equal(siteOf('green park', ctx), 'Green Park', 'a known site whatever the case');
  assert.equal(siteOf('Shivpuri site pe', ctx), 'Shivpuri');
  assert.equal(siteOf('साइट', { nowMs: NOW }), null);
});

test('only the missing values are asked; one open job\'s site or the person\'s own is used', async () => {
  // No site anywhere: asked.
  let f = fakeSpark([{ name: 'request_material', args: { site: 'साइड', day: 'tomorrow', time: null, items: [cement('pachaas')] } }]);
  let p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'Kal side pass cement pachaas bori chahiye', orders: [], nowMs: NOW });
  assert.deepEqual(p, {
    kind: 'missing', tool: 'request_material', missing: ['site'],
    args: { site: null, day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] },
    raw: { site: 'साइड', day: 'tomorrow', time: null, items: [cement('pachaas')] },
  });
  // Exactly one site among the open jobs: that one. Two: asked.
  const one = [{ ref: 'J-1', orderId: 'o1', site: 'Green Park', day: '2026-10-30', state: 'booked' }];
  p = await proposeStep({ spark: f.spark, person: person('supervisor'), text: 'x', orders: one, nowMs: NOW });
  assert.equal(p.kind === 'step' && p.args.site, 'Green Park');
  const two = [...one, { ref: 'P-1', orderId: 'o2', site: 'Rampur', day: '2026-10-30', state: 'booked' }];
  p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders: two, nowMs: NOW });
  assert.deepEqual(p.kind === 'missing' && p.missing, ['site']);
  // Day, quantity and unit left out; a day that is not understood is asked too.
  f = fakeSpark([{ name: 'request_material', args: { site: 'Rampur', day: 'kabhi', time: null, items: [cement(null, null), { name: 'रेत', quantity: 'kuch', unit: 'ट्रॉली' }] } }]);
  p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders: [], nowMs: NOW });
  assert.deepEqual(p.kind === 'missing' && p.missing, ['day', 'qty:0', 'unit:0', 'qty:1']);
  // JCB: site and day only.
  f = fakeSpark([{ name: 'request_jcb', args: { site: null, day: null, time: '8', hours: '6' } }]);
  p = await proposeStep({ spark: f.spark, person: person('contractor'), text: 'JCB chahiye 8 baje 6 ghante', orders: [], nowMs: NOW });
  assert.deepEqual(p, { kind: 'missing', tool: 'request_jcb', missing: ['site', 'day'], args: { site: null, day: null, time: '08:00', hoursTenths: 60 }, raw: { site: null, day: null, time: '8', hours: '6' } });
  // Truly unusable stays bad_args: no item name, a time that is no time.
  f = fakeSpark([{ name: 'request_material', args: { site: 'Rampur', day: 'tomorrow', time: '25', items: [cement('50')] } }]);
  assert.deepEqual(await proposeStep({ spark: f.spark, person: person('contractor'), text: 'x', orders: [], nowMs: NOW }), { kind: 'none', key: 'common.bad_args' });
});

test('the reply fills the missing value: by code when it is plainly that value, else through the model', async () => {
  const pending = (/** @type {string[]} */ missing, /** @type {Record<string, any>} */ raw) => ({ tool: 'request_material', raw, missing, said: 'kal cement chahiye' });
  const raw = { site: null, day: 'tomorrow', time: null, items: [cement('50')] };
  const never = fakeSpark([]);
  const fill = (/** @type {string} */ text, /** @type {any} */ p, spark = never.spark, role = 'supervisor') =>
    fillStep({ spark, person: person(role), text, orders: [], nowMs: NOW, pending: p });

  // Site by code; the rest stays as first understood.
  assert.deepEqual(await fill('Rampur', pending(['site'], raw)),
    { kind: 'step', tool: 'request_material', args: { site: 'Rampur', day: '2026-10-29', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } });
  // Day, quantity (digits, words, with a unit), unit.
  let p = await fill('परसों', pending(['day'], { ...raw, site: 'Rampur', day: null }));
  assert.equal(p?.kind === 'step' && p.args.day, '2026-10-30');
  p = await fill('पचास', pending(['qty:0'], { ...raw, site: 'Rampur', items: [cement(null)] }));
  assert.deepEqual(p?.kind === 'step' && p.args.items, [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }]);
  p = await fill('60 bag', pending(['qty:0'], { ...raw, site: 'Rampur', items: [cement(null)] }));
  assert.deepEqual(p?.kind === 'step' && p.args.items, [{ name: 'सीमेंट', qtyHundredths: 6000, unit: 'bag' }]);
  p = await fill('ट्रॉली', pending(['unit:0'], { ...raw, site: 'Rampur', items: [cement('2', null)] }));
  assert.deepEqual(p?.kind === 'step' && p.args.items, [{ name: 'सीमेंट', qtyHundredths: 200, unit: 'ट्रॉली' }]);
  assert.equal(never.seen.length, 0, 'no model call for a plain answer');

  // Two values asked: the model reads the reply; only the missing ones are taken from it.
  const f = fakeSpark([{ name: 'request_material', args: { site: 'Green Park', day: 'day_after', time: '9', items: [cement('70')] } }]);
  p = await fill('Green Park parso', pending(['site', 'day'], { ...raw, day: null }), f.spark);
  assert.deepEqual(p, { kind: 'step', tool: 'request_material', args: { site: 'Green Park', day: '2026-10-30', items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }] } });
  assert.deepEqual(f.seen[0].tools.map((/** @type {any} */ t) => t.function.name), ['request_material', 'help']);
  assert.match(f.seen[0].system, /kal cement chahiye/);
  // Partly answered: the rest is asked again.
  const g = fakeSpark([{ name: 'request_material', args: { site: 'Green Park', day: null, time: null, items: [cement('50')] } }]);
  p = await fill('Green Park', pending(['site', 'day'], { ...raw, day: null }), g.spark);
  assert.deepEqual(p?.kind === 'missing' && [p.missing, p.args.site], [['day'], 'Green Park']);

  // Not an answer: null (read as a new message). A site reply that is a request goes to the model.
  const help = fakeSpark([{ name: 'help', args: {} }]);
  assert.equal(await fill('JCB chahiye kal', pending(['site'], raw), help.spark), null);
  assert.equal(help.seen.length, 1);
  assert.equal(await fill('साइट', pending(['site'], raw)), null, 'a generic word fills nothing');
  // The model down: try again, the question stays.
  const down = async () => /** @type {const} */ ({ ok: false, transient: true, reason: 'http_503' });
  assert.deepEqual(await fill('Green Park parso', pending(['site', 'day'], { ...raw, day: null }), down), { kind: 'none', key: 'orchestrator.try_again' });
  // A role that may not take the step gets nothing filled.
  assert.equal(await fill('Rampur', pending(['site'], raw), never.spark, 'supplier'), null);
});

/**
 * Each request example in the help texts, with the arguments a model would give for it and the jobs
 * open at the time. Commands and the bare yes/no are answered by code and need no entry. A question
 * about the records goes to the read-only ask route (src/agents/ask.js).
 * @type {Record<string, Record<string, {call: {name: string, args: any}, orders?: any[], site?: string, kind?: string}>>}
 */
const QUESTION = { call: { name: 'ask_records', args: {} }, kind: 'ask' };
const HELP_EXAMPLES = {
  supervisor: {
    'इस हफ़्ते कितने घंटे JCB का बिल आया?': QUESTION,
    'JCB चाहिए कल 8 बजे': { site: 'Rampur', call: { name: 'request_jcb', args: { site: null, day: 'tomorrow', time: '8', hours: null } } },
    'सीमेंट 50 बोरी कल': { site: 'Rampur', call: { name: 'request_material', args: { site: null, day: 'tomorrow', time: null, items: [cement('50')] } } },
  },
  contractor: {
    'इस महीने शिवपुरी पर कितना सीमेंट आया?': QUESTION,
    'JCB चाहिए 30-10 शिवपुरी': { call: { name: 'request_jcb', args: { site: 'शिवपुरी', day: '30-10', time: null, hours: null } } },
    'सीमेंट 50 बोरी 30-10 शिवपुरी': { call: { name: 'request_material', args: { site: 'शिवपुरी', day: '30-10', time: null, items: [cement('50')] } } },
  },
  jcb_owner: {
    'इस महीने कितने घंटे का बिल गया?': QUESTION,
    '30-10': { orders: [{ ref: 'J-1', orderId: 'o1', site: 'S', day: '2026-10-29', state: 'requested' }], call: { name: 'reply_booking', args: { order: null, answer: 'other_time', rate_rupees_per_hour: null, day: '30-10', time: null } } },
    'बिल': { orders: [{ ref: 'J-1', orderId: 'o1', site: 'S', day: '2026-10-29', state: 'working' }], call: { name: 'send_bill', args: { order: null } } },
  },
  supplier: {
    'पिछले हफ़्ते कितना भुगतान आया?': QUESTION,
    'हाँ 350': { orders: [{ ref: 'P-1', orderId: 'o1', site: 'S', day: '2026-10-29', state: 'requested', what: 'सीमेंट 50 बोरी' }], call: { name: 'reply_order', args: { order: null, answer: 'yes', rates_rupees: ['350'], day: null, time: null } } },
    '30-10': { orders: [{ ref: 'P-1', orderId: 'o1', site: 'S', day: '2026-10-29', state: 'requested' }], call: { name: 'reply_order', args: { order: null, answer: 'other_time', rates_rupees: null, day: '30-10', time: null } } },
    'बिल': { orders: [{ ref: 'P-1', orderId: 'o1', site: 'S', day: '2026-10-29', state: 'delivered' }], call: { name: 'send_bill', args: { order: null } } },
  },
};

test('every example in the help texts works', async () => {
  for (const role of ['contractor', 'supervisor', 'jcb_owner', 'supplier', 'operator']) {
    const examples = [...hi[`help.${role}`].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const ex of examples) {
      if (ex === 'हाँ' || ex === 'नहीं' || parseCommand(ex)) continue;
      const want = HELP_EXAMPLES[role]?.[ex];
      assert.ok(want, `help.${role}: "${ex}" has no expected reading here; add one`);
      const f = fakeSpark([want.call]);
      const p = await proposeStep({ spark: f.spark, person: person(role, want.site), text: ex, orders: want.orders ?? [], nowMs: NOW, ask: true });
      assert.equal(p.kind, want.kind ?? 'step', `help.${role}: "${ex}" gave ${JSON.stringify(p)}`);
    }
  }
  // The text sent when a message cannot be used shows examples that work too.
  for (const ex of [...hi['common.bad_args'].matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
    if (ex === 'मदद') continue;
    const want = HELP_EXAMPLES.supervisor[ex];
    assert.ok(want, `common.bad_args: "${ex}" has no expected reading`);
  }
});
