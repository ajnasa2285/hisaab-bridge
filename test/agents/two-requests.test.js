// One message, two requests: one read-back, one "हाँ", two orders, each through the office's gate.
// And a site name the agent does not know is asked about once, and remembered for the whole agent.
// Muse Spark is a stand-in returning the calls a model would give. Invented data only.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversation } from '../../src/agents/conversation.js';
import { createOffice } from '../../src/agents/office.js';
import { openSiteNames } from '../../src/agents/site-names.js';
import { t } from '../../src/i18n/index.js';
import { setup, person } from './helpers.js';

const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000051' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000052' };
const second = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000053' };

const material = (/** @type {any} */ over = {}) => ({ name: 'request_material', args: { site: 'Rampur', day: '30-10', time: '10', items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }, { name: 'बालू', quantity: '40', unit: 'टन' }], ...over } });
const jcb = (/** @type {any} */ over = {}) => ({ name: 'request_jcb', args: { site: 'Rampur', day: '30-10', time: '10', hours: '2', ...over } });

/** @type {(() => Promise<unknown>)[]} */
const closers = [];
after(() => Promise.all(closers.map((close) => close())));

/**
 * The contractor's desk on the real agents, with the office and the site names.
 * @param {{limits?: any, tools?: (tools: Record<string, any>) => Record<string, any>, names?: boolean, spark?: any}} [o]
 */
async function desk(o = {}) {
  /** @type {[string, string, string][]} [to, key, text] */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  /** @type {any[]} */
  const calls = [];
  let modelCalls = 0;
  const spark = o.spark ?? (async () => { modelCalls += 1; return { ok: /** @type {const} */ (true), toolCalls: calls.splice(0) }; });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.phone, key, t(key, params)]); };
  const tell = (/** @type {string} */ role, /** @type {string} */ key, /** @type {any} */ params) => { said.push([`all:${role}`, key, t(key, params)]); };
  const tools = o.tools ? o.tools(s.site.tools) : s.site.tools;
  const office = createOffice({ ledger: s.siteCore.ledger, tools, kind: 'contractor', limits: o.limits, tell, reply, now: s.siteCore.now });
  const siteNames = openSiteNames({ now: s.siteCore.now });
  closers.push(s.close, async () => siteNames.close());
  const talk = createConversation({ ledger: s.siteCore.ledger, tools, spark, reply, now: s.siteCore.now, office, ...(o.names === false ? {} : { siteNames }) });
  /** @param {any} who @param {string} text @param {...any} next the model's calls for this message */
  const say = async (who, text, ...next) => { calls.push(...next); await talk.onText(who, text); };
  const last = (/** @type {any} */ who) => /** @type {[string, string, string]} */ (said.filter((x) => x[0] === who.phone).at(-1));
  const orders = () => /** @type {any[]} */ (s.siteCore.ledger.orders());
  return { s, said, say, talk, last, orders, office, siteNames, models: () => modelCalls };
}

/** A contractor's single order on the books, so that its site is known. @param {any} d @param {string} site */
async function known(d, site) {
  await d.say(contractor, 'x', jcb({ site }));
  await d.say(contractor, 'हाँ');
}

test('both requests are read back together; हाँ makes two orders with two references', async () => {
  const d = await desk();
  await d.say(contractor, '50 bags cement, 40 tons sand and jcb for 2 hours tomorrow at Rampur', jcb(), material());
  const [, key, text] = d.last(contractor);
  assert.equal(key, 'step.two_requests');
  for (const part of ['Rampur', 'सीमेंट 50 बोरी', 'बालू 40 टन', 'JCB', '2.0 घंटे', 'हाँ / नहीं']) assert.ok(text.includes(part), `${part} in: ${text}`);
  assert.ok(text.indexOf('सीमेंट') < text.indexOf('JCB'), 'material first, whichever call came first');
  assert.equal(d.orders().length, 0, 'nothing sent before the yes');
  await d.say(contractor, 'हाँ');
  const kinds = d.orders().map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['jcb_hours', 'material'], 'two orders');
  const done = d.last(contractor);
  assert.equal(done[1], 'site.two_requests_done');
  assert.ok(done[2].includes('P-1') && done[2].includes('J-1'), done[2]);
  assert.equal(d.talk.pending(contractor), null, 'no question left');
  for (const x of d.orders()) assert.equal(d.s.siteCore.ledger.events(x.order_id).filter((/** @type {any} */ e) => e.type === 'BOOKING_REQUEST').length, 1, 'each its own signed message');
});

test('नहीं cancels both; another message lapses the question and nothing is sent', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material(), jcb());
  await d.say(contractor, 'नहीं');
  assert.equal(d.last(contractor)[1], 'step.cancelled');
  assert.equal(d.orders().length, 0);
  await d.say(contractor, 'x', material(), jcb());
  await d.say(contractor, 'मदद');
  assert.equal(d.orders().length, 0);
  assert.equal(d.talk.pending(contractor), null);
});

test('a yes older than the read-back is not its answer: asked again, nothing sent', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material(), jcb());
  await d.talk.onText(contractor, 'हाँ', { atMs: d.s.siteCore.now() - 60_000 });
  assert.equal(d.last(contractor)[1], 'step.two_requests');
  assert.equal(d.orders().length, 0);
  await d.say(contractor, 'हाँ');
  assert.equal(d.orders().length, 2);
});

test('the limit is checked per order: one is held for the contractor while the other goes', async () => {
  const d = await desk({
    limits: { procurementPaise: 100000 },
    // The JCB's estimate is within the limit; the material's rate is not known, so it cannot be estimated.
    tools: (tools) => ({ ...tools, request_jcb: { ...tools.request_jcb, hold: { ...tools.request_jcb.hold, estimatePaise: () => 5000 } } }),
  });
  await d.say(supervisor, 'x', material(), jcb());
  assert.equal(d.last(supervisor)[1], 'step.two_requests', 'one read-back, even for a supervisor');
  await d.say(supervisor, 'हाँ');
  assert.deepEqual(d.orders().map((x) => x.kind), ['jcb_hours'], 'only the JCB went');
  assert.deepEqual(d.office.held().map((h) => [h.tool, h.ref]), [['request_material', 'P-1']]);
  const [, , text] = d.last(supervisor);
  assert.ok(text.includes('P-1') && text.includes('मंज़ूरी') && text.includes('J-1') && text.includes('JCB की माँग भेजी'), text);
  assert.ok(d.said.some(([to, key]) => to === 'all:contractor' && key.startsWith('office.approval_needed')), 'the contractor is asked about the held one');
});

test('both held: the contractor gets two approvals, and each decides on its own', async () => {
  const d = await desk({ limits: { procurementPaise: 100 } });
  await d.say(supervisor, 'x', material(), jcb());
  await d.say(supervisor, 'हाँ');
  assert.equal(d.orders().length, 0);
  assert.deepEqual(d.office.held().map((h) => h.ref), ['P-1', 'J-1']);
  await d.say(contractor, 'ok J-1');
  assert.deepEqual(d.orders().map((x) => x.kind), ['jcb_hours']);
  await d.say(contractor, 'no P-1 अभी नहीं');
  assert.equal(d.orders().length, 1);
});

test('one lacking a value asks for it, then continues; nothing is sent until both are confirmed', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material({ items: [{ name: 'सीमेंट', quantity: null, unit: 'बोरी' }] }), jcb());
  assert.equal(d.last(contractor)[1], 'ask.missing');
  assert.ok(d.last(contractor)[2].includes('सीमेंट'));
  assert.equal(d.orders().length, 0);
  await d.say(contractor, '50');
  assert.equal(d.last(contractor)[1], 'step.two_requests');
  assert.ok(d.last(contractor)[2].includes('सीमेंट 50 बोरी') && d.last(contractor)[2].includes('JCB'));
  await d.say(contractor, 'हाँ');
  assert.equal(d.orders().length, 2);
});

test('a site missing from both is asked once; a site or day in one call serves the other', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material({ site: null, day: null }), jcb({ site: 'साइट', day: null }));
  assert.equal(d.last(contractor)[1], 'ask.missing');
  // Two values asked at once: Muse Spark reads the answer, for the material; the JCB shares it.
  await d.say(contractor, 'Rampur, कल', material());
  assert.equal(d.last(contractor)[1], 'step.two_requests', 'no second question for the JCB');
  assert.equal(d.said.filter(([, key]) => key === 'ask.missing').length, 1);
  assert.equal(d.last(contractor)[2].split('Rampur').length, 3);

  const one = await desk();
  await one.say(contractor, 'x', material({ site: null }), jcb({ site: null }));
  await one.say(contractor, 'Rampur');
  assert.equal(one.last(contractor)[1], 'step.two_requests', 'one value: read by code, shared');
  assert.equal(one.last(contractor)[2].split('Rampur').length, 3);

  const e = await desk();
  await e.say(contractor, 'x', material({ site: null }), jcb({ day: null }));
  assert.equal(e.last(contractor)[1], 'step.two_requests', 'nothing asked: both values were said once');
  assert.equal(e.last(contractor)[2].split('Rampur').length, 3);
});

test('नहीं to the missing value cancels both', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material({ site: null }), jcb({ site: null }));
  assert.equal(d.last(contractor)[1], 'ask.missing');
  await d.say(contractor, 'नहीं');
  assert.equal(d.last(contractor)[1], 'step.cancelled');
  assert.equal(d.orders().length, 0);
});

test('a failure on one: the other still stands and the person is told both', async () => {
  const refused = await desk({ tools: (tools) => ({ ...tools, request_material: { ...tools.request_material, run: async () => ({ ok: false, key: 'common.refused' }) } }) });
  await refused.say(contractor, 'x', material(), jcb());
  await refused.say(contractor, 'हाँ');
  assert.deepEqual(refused.orders().map((x) => x.kind), ['jcb_hours']);
  const [, , text] = refused.last(contractor);
  assert.ok(text.includes(t('common.refused')) && text.includes('सीमेंट') && text.includes('J-1'), text);

  const thrown = await desk({ tools: (tools) => ({ ...tools, request_jcb: { ...tools.request_jcb, run: async () => { throw new Error('down'); } } }) });
  await thrown.say(contractor, 'x', material(), jcb());
  await thrown.say(contractor, 'हाँ');
  assert.deepEqual(thrown.orders().map((x) => x.kind), ['material']);
  const out = thrown.last(contractor)[2];
  assert.ok(out.includes('P-1') && out.includes('JCB') && out.includes(t('common.try_again')), out);
});

test('a notice while the read-back is open waits; the yes answers the read-back', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material(), jcb());
  d.talk.expect(contractor, 'request_jcb', { site: 'Rampur', day: '2026-10-30' }, undefined, { key: 'common.question_waits' });
  await d.say(contractor, 'हाँ');
  assert.equal(d.orders().length, 2, 'the two requests, not the waiting question');
  assert.equal(d.last(contractor)[1], 'common.question_waits', 'then the waiting one is asked');
});

test('a single request is unchanged: its own read-back, its own receipt', async () => {
  const d = await desk();
  await d.say(contractor, 'x', material());
  assert.equal(d.last(contractor)[1], 'step.request_material');
  await d.say(contractor, 'हाँ');
  assert.equal(d.last(contractor)[1], 'site.material_requested');
  await d.say(contractor, 'x', jcb());
  assert.equal(d.last(contractor)[1], 'step.request_jcb');
});

test('unknown site: asked once before the read-back; a number picks the known site; never asked again, for anyone', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(contractor, 'x', jcb({ site: 'NDUAT' }));
  const [, key, text] = d.last(contractor);
  assert.equal(key, 'site.which_site');
  assert.ok(text.startsWith('NDUAT') && text.includes('1. Rampur') && text.includes('2. नई साइट'), text);
  await d.say(contractor, '1');
  assert.equal(d.last(contractor)[1], 'step.request_jcb');
  assert.ok(d.last(contractor)[2].includes('Rampur') && !d.last(contractor)[2].includes('NDUAT'));
  await d.say(contractor, 'हाँ');
  assert.deepEqual(d.orders().map((x) => x.site), ['Rampur', 'Rampur'], 'recorded under the full name');
  // The same name again, any case, and a supervisor's short name for the contractor too.
  await d.say(contractor, 'x', material({ site: ' nduat ' }));
  assert.equal(d.last(contractor)[1], 'step.request_material');
  assert.ok(d.last(contractor)[2].includes('Rampur'));
  await d.say(supervisor, 'x', jcb({ site: 'NDUAT' }));
  assert.ok(!d.said.some(([to, k]) => to === supervisor.phone && k === 'site.which_site'), 'another person on the agent is not asked');
});

test('a supervisor\'s short name stays usable by the contractor', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(supervisor, 'x', jcb({ site: 'NDUAT' }));
  assert.equal(d.last(supervisor)[1], 'site.which_site');
  await d.say(supervisor, '1');
  await d.say(contractor, 'x', jcb({ site: 'NDUAT' }));
  assert.equal(d.last(contractor)[1], 'step.request_jcb');
  assert.ok(d.last(contractor)[2].includes('Rampur'));
});

test('new site: the last number or "नई साइट" saves the name; it is a known site from then on', async () => {
  for (const answer of ['2', 'नई साइट', 'NEW SITE']) {
    const d = await desk();
    await known(d, 'Rampur');
    await d.say(contractor, 'x', jcb({ site: 'Pipla' }));
    await d.say(contractor, answer);
    assert.equal(d.last(contractor)[1], 'step.request_jcb', answer);
    assert.ok(d.last(contractor)[2].includes('Pipla'));
    await d.say(contractor, 'नहीं');
    // Refused and said again: the name was still told, so not asked twice, and it is offered to others.
    await d.say(second, 'x', jcb({ site: 'pipla' }));
    assert.ok(!d.said.some(([to, k]) => to === second.phone && k === 'site.which_site'));
    await d.say(contractor, 'x', jcb({ site: 'Other' }));
    assert.ok(d.last(contractor)[2].includes('Pipla') && d.last(contractor)[2].includes('Rampur'), d.last(contractor)[2]);
  }
});

test('no known sites: not asked; a person\'s own site works as before and counts as known', async () => {
  const d = await desk();
  await d.say(contractor, 'x', jcb({ site: 'Rampur' }));
  assert.equal(d.last(contractor)[1], 'step.request_jcb', 'no question with nothing on the books');
  const own = { ...supervisor, site: 'Own Site' };
  const e = await desk();
  await e.say(own, 'x', jcb({ site: null }));
  assert.ok(!e.said.some(([, k]) => k === 'site.which_site'), 'the default site needs no question');
  await e.say(contractor, 'नहीं');
  await e.say(own, 'x', jcb({ site: 'Far' }));
  assert.equal(e.last(own)[1], 'site.which_site');
  assert.ok(e.last(own)[2].includes('1. Own Site'), e.last(own)[2]);
});

test('exact match only: a similar name is asked about, and Muse Spark is not asked which one it is', async () => {
  const d = await desk();
  await known(d, 'Shivpuri');
  const before = d.models();
  await d.say(contractor, 'x', jcb({ site: 'Shivpuri Phase 2' }));
  assert.equal(d.last(contractor)[1], 'site.which_site');
  await d.say(contractor, 'x', jcb({ site: 'Shivpur' }));
  assert.equal(d.last(contractor)[1], 'site.which_site');
  assert.equal(d.models(), before + 2, 'one call per message, none about the name');
  await d.say(contractor, 'x', jcb({ site: 'SHIVPURI' }));
  assert.equal(d.last(contractor)[1], 'step.request_jcb', 'case does not matter');
  assert.ok(d.last(contractor)[2].includes('Shivpuri'));
});

test('the question: a number off the list and a yes ask again; नहीं cancels; another message lapses it', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(contractor, 'x', jcb({ site: 'NDUAT' }));
  await d.say(contractor, '9');
  assert.equal(d.last(contractor)[1], 'site.which_site');
  await d.say(contractor, 'हाँ');
  assert.equal(d.last(contractor)[1], 'site.which_site');
  await d.say(contractor, '१');
  assert.equal(d.last(contractor)[1], 'step.request_jcb', 'Devanagari digits count');
  await d.say(contractor, 'नहीं');
  await d.say(contractor, 'x', jcb({ site: 'Second' }));
  await d.say(contractor, 'नहीं');
  assert.equal(d.last(contractor)[1], 'step.cancelled');
  assert.equal(d.siteNames.lookup('Second'), null, 'a cancelled question saves nothing');
  await d.say(contractor, 'x', jcb({ site: 'Second' }));
  await d.say(contractor, 'मदद');
  assert.equal(d.talk.pending(contractor), null);
  assert.equal(d.siteNames.lookup('Second'), null);
});

test('at most 6 recent sites, newest first, then नई साइट', async () => {
  const d = await desk();
  const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'];
  for (const name of names) d.siteNames.save(name, name, 'contractor');
  await d.say(contractor, 'x', jcb({ site: 'Far' }));
  const [, , text] = d.last(contractor);
  assert.equal(text.split('\n').filter((l) => /^\d\. /.test(l)).length, 7, text);
  assert.ok(text.includes('7. नई साइट') && !text.includes('8.'), text);
});

test('inside two requests: one question for one name, then one read-back naming the full site', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(contractor, 'x', material({ site: 'NDUAT' }), jcb({ site: 'NDUAT' }));
  assert.equal(d.last(contractor)[1], 'site.which_site');
  await d.say(contractor, '1');
  const [, key, text] = d.last(contractor);
  assert.equal(key, 'step.two_requests');
  assert.ok(!text.includes('NDUAT') && text.split('Rampur').length === 3, text);
  assert.equal(d.said.filter(([, k]) => k === 'site.which_site').length, 1, 'one question');
  await d.say(contractor, 'हाँ');
  assert.deepEqual(d.orders().map((x) => x.site), ['Rampur', 'Rampur', 'Rampur']);
});

test('inside two requests: a site typed as the missing value is still checked, once', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(contractor, 'x', material({ site: null }), jcb({ site: null, day: '30-10' }));
  // Rampur is the only site among the open jobs, so it is the default: not asked at all.
  assert.equal(d.last(contractor)[1], 'step.two_requests');
  await d.say(contractor, 'नहीं');
  await d.say(contractor, 'x', jcb({ site: 'Second' }));
  await d.say(contractor, '2');
  await d.say(contractor, 'हाँ');
  await d.say(contractor, 'x', material({ site: null }), jcb({ site: null }));
  assert.equal(d.last(contractor)[1], 'ask.missing', 'two sites open: which one');
  await d.say(contractor, 'NDUAT');
  assert.equal(d.last(contractor)[1], 'site.which_site');
  await d.say(contractor, 'Rampur');
  assert.equal(d.last(contractor)[1], 'step.two_requests');
});

test('"भूल जाओ NDUAT" drops a wrong short name; orders stay; it is asked again', async () => {
  const d = await desk();
  await known(d, 'Rampur');
  await d.say(contractor, 'x', jcb({ site: 'NDUAT' }));
  await d.say(contractor, '1');
  await d.say(contractor, 'नहीं');
  await d.say(contractor, 'भूल जाओ NDUAT');
  assert.equal(d.last(contractor)[1], 'site.forgot_name');
  await d.say(contractor, 'x', jcb({ site: 'NDUAT' }));
  assert.equal(d.last(contractor)[1], 'site.which_site');
  assert.deepEqual(d.orders().map((x) => x.site), ['Rampur']);
});

test('the names survive a restart, in the agent\'s own file, and rows are append-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-sites-'));
  try {
    const file = join(dir, 'site.sites.db');
    const a = openSiteNames({ file, now: () => 0 });
    a.save(' NDUAT ', 'Rampur', 'supervisor');
    a.save('nduat', 'Other', 'contractor');
    assert.equal(a.lookup('NDUAT'), 'Rampur', 'the first answer stands');
    a.close();
    const b = openSiteNames({ file, now: () => 0 });
    assert.equal(b.lookup('nduat '), 'Rampur');
    assert.deepEqual(b.sites().map((s) => s.site), ['Rampur']);
    assert.equal(b.forget('Nduat', 'contractor'), true);
    assert.equal(b.forget('Nduat', 'contractor'), false);
    assert.equal(b.lookup('NDUAT'), null);
    b.save('NDUAT', 'Other', 'contractor');
    assert.equal(b.lookup('NDUAT'), 'Other');
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
