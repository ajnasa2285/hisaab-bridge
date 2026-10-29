// Inside the agents, through the whole service: a JCB job and a material job over WhatsApp leave the
// expected trace on every agent, in order, with nothing private in it; the trace endpoint needs the
// export token; and a broken trace changes nothing the agents do or say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY, CONTRACTOR, OPERATOR, OWNER, PHOTO_MARK, SUPERVISOR, SUPPLIER, jcbJob, materialJob, startService } from './harness.js';

const PHONES = [OWNER, OPERATOR, SUPERVISOR, CONTRACTOR, SUPPLIER];

/**
 * Checks that `want` appears in `kinds` in this order (other entries may stand between).
 * @param {string[]} kinds @param {string[]} want
 */
function inOrder(kinds, want) {
  let i = 0;
  for (const k of kinds) if (k === want[i]) i += 1;
  assert.equal(i, want.length, `expected in order ${want.join(' > ')}, got ${kinds.join(' ')}`);
}

/** @param {any[]} entries @param {string} kind @param {(e: any) => boolean} [f] */
const find = (entries, kind, f = () => true) => entries.find((e) => e.kind === kind && f(e));

test('a whole JCB job and a whole material job: each agent\'s trace shows the Muse steps, checks, decisions, signed messages and ledger rows', async () => {
  const s = await startService();
  try {
    const jcbOrder = await jcbJob(s);
    const matOrder = await materialJob(s);
    const site = s.app.agent('agent:contractor-1');
    assert.deepEqual([site.core.ledger.view(jcbOrder).state, site.core.ledger.view(matOrder).state], ['settled', 'settled']);

    const siteJ = (await (await s.trace('site', '?order=J-1')).json()).entries;
    const jcbJ = (await (await s.trace('jcb', '?order=j-1')).json()).entries;
    const siteP = (await (await s.trace('site', '?order=P-1')).json()).entries;
    const supP = (await (await s.trace('supplier', '?order=P-1')).json()).entries;
    for (const list of [siteJ, jcbJ]) assert.ok(list.every((/** @type {any} */ e) => e.ref === 'J-1' && e.orderId === jcbOrder));
    for (const list of [siteP, supP]) assert.ok(list.every((/** @type {any} */ e) => e.ref === 'P-1' && e.orderId === matOrder));

    // Contractor's side of J-1: the supervisor's words understood by Muse, held for approval, the
    // contractor's OK, the signed request out with its receipt, the bill in, accept, payment, settled.
    inOrder(siteJ.map((/** @type {any} */ e) => e.kind), ['received', 'model', 'check', 'received', 'decision', 'ledger', 'signed_out', 'reply',
      'signed_in', 'signed_in', 'decision', 'signed_out', 'received', 'model', 'model', 'check', 'decision', 'signed_out', 'signed_in']);
    const understood = find(siteJ, 'model', (e) => e.detail.job === 'understand');
    assert.deepEqual([understood.detail.model, understood.detail.calls[0].tool, understood.ms], ['muse-spark-1.2', 'request_jcb', 7]);
    assert.match(find(siteJ, 'check', (e) => e.detail.name === 'approval').title, /approval needed: no limit set → held/);
    assert.deepEqual([find(siteJ, 'decision').detail.role, find(siteJ, 'decision').detail.onBehalfOf, find(siteJ, 'decision').detail.tool], ['contractor', 'supervisor', 'request_jcb']);
    const out = find(siteJ, 'signed_out', (e) => e.detail.type === 'BOOKING_REQUEST');
    assert.deepEqual([out.detail.to, out.detail.verified, out.detail.answer, typeof out.ms], ['agent:jcb-1', true, 'RECEIPT', 'number']);
    assert.ok(find(siteJ, 'signed_in', (e) => e.detail.type === 'BILL' && e.detail.verified === true));
    assert.equal(find(siteJ, 'check', (e) => e.detail.name === 'upi_amount').detail.pass, true);
    assert.equal(find(siteJ, 'model', (e) => e.detail.job === 'upi').detail.utr, '000011112222');
    const row = find(siteJ, 'ledger', (e) => e.detail.type === 'BOOKING_REQUEST');
    const ev = site.core.ledger.events(jcbOrder).find((/** @type {any} */ e) => e.type === 'BOOKING_REQUEST');
    assert.deepEqual([row.detail.seq, row.detail.hash], [ev.seq, ev.hash.slice(0, 12)]);

    // JCB side: the request in, the owner's "हाँ 1200", two meter photos read by Muse and checked by code,
    // the bill computed from them, the payment claim in, the owner's confirmation.
    inOrder(jcbJ.map((/** @type {any} */ e) => e.kind), ['signed_in', 'received', 'decision', 'signed_out', 'received', 'model', 'model', 'check',
      'decision', 'ledger', 'received', 'model', 'model', 'check', 'decision', 'check', 'ledger', 'decision', 'check', 'signed_out', 'signed_in', 'signed_in', 'decision', 'signed_out']);
    assert.deepEqual(jcbJ.filter((/** @type {any} */ e) => e.kind === 'model').map((/** @type {any} */ e) => e.detail.job), ['photo_kind', 'meter', 'photo_kind', 'meter']);
    assert.ok(find(jcbJ, 'check', (e) => e.title === 'meter end above start ✓ 1240.6 > 1234.5' && e.detail.pass));
    assert.match(find(jcbJ, 'check', (e) => e.detail.name === 'bill_from_meter').title, /6\.1 h × ₹1,200 = ₹7,320/);

    // Material: the supplier's challan read by Muse, the site's count checked against the signed delivery,
    // the bill checked against delivery × agreed rate.
    inOrder(supP.map((/** @type {any} */ e) => e.kind), ['signed_in', 'received', 'decision', 'signed_out', 'received', 'model', 'model', 'decision', 'signed_out', 'decision', 'signed_out', 'signed_in', 'signed_in', 'decision', 'signed_out']);
    assert.deepEqual(find(supP, 'model', (e) => e.detail.job === 'challan').detail.items, [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }]);
    inOrder(siteP.map((/** @type {any} */ e) => e.kind), ['received', 'model', 'check', 'decision', 'signed_out', 'signed_in', 'signed_in', 'decision', 'check', 'signed_in', 'check', 'decision', 'signed_out']);
    assert.equal(find(siteP, 'check', (e) => e.detail.name === 'count_vs_delivery').detail.pass, true);
    assert.equal(find(siteP, 'check', (e) => e.detail.name === 'bill_follows').detail.pass, true);

    // Nothing private: no phone, no API key, no photo bytes, no person's words (text is off).
    const all = JSON.stringify(await Promise.all(['site', 'jcb', 'supplier'].map(async (n) => (await s.trace(n)).json())));
    for (const p of PHONES) assert.ok(!all.includes(p) && !all.includes(p.slice(2)), `phone ${p} in the trace`);
    assert.ok(!all.includes(API_KEY) && !all.includes(PHOTO_MARK) && !all.includes(Buffer.from(PHOTO_MARK).toString('base64').slice(0, 20)));
    assert.ok(!all.includes('Shivpuri JCB 6 ghante') && !all.includes('"हाँ 1200"'));
    assert.ok(JSON.parse(all).flatMap((/** @type {any} */ x) => x.entries).every((/** @type {any} */ e) => e.detail.text === undefined || e.detail.text === null));
  } finally {
    await s.close();
  }
});

test('with HB_TRACE_TEXT on, people\'s words are kept with long digit runs masked; the decision shows the exact reply', async () => {
  const s = await startService({ traceText: true });
  try {
    await jcbJob(s);
    await s.say(SUPERVISOR, 'मेरा नंबर 9190000000777 है, status J-1');
    const site = (await (await s.trace('site')).json()).entries;
    const jcb = (await (await s.trace('jcb')).json()).entries;
    assert.equal(find(site, 'received', (e) => e.detail.text?.startsWith('kal 8 baje')).detail.text, 'kal 8 baje Shivpuri JCB 6 ghante');
    assert.equal(find(jcb, 'decision', (e) => e.detail.tool === 'reply_booking').detail.reply, 'हाँ 1200');
    assert.match(find(jcb, 'decision', (e) => e.detail.tool === 'reply_booking').title, /jcb_owner "हाँ 1200" → reply_booking/);
    const masked = find(site, 'received', (e) => e.detail.text?.startsWith('मेरा नंबर'));
    assert.equal(masked.detail.text, 'मेरा नंबर ••••••••••••• है, status J-1');
    const all = JSON.stringify([site, jcb]);
    for (const p of [...PHONES, '9190000000777']) assert.ok(!all.includes(p));
  } finally {
    await s.close();
  }
});

test('the trace endpoint needs the export token and filters by order and time', async () => {
  const s = await startService({ dataDir: true });
  try {
    await jcbJob(s);
    assert.equal((await s.trace('site', '', '')).status, 404);
    assert.equal((await s.trace('site', '', 'wrong')).status, 404);
    const r = await s.trace('site');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.json();
    assert.deepEqual([body.v, body.agentId, body.name], ['hb-trace/0.1', 'agent:contractor-1', 'site']);
    assert.ok(body.entries.length > 10);
    assert.deepEqual((await (await s.trace('site', '?order=P-9')).json()).entries, []);
    const later = body.entries.at(-3).at;
    const since = (await (await s.trace('site', `?since=${encodeURIComponent(later)}`)).json()).entries;
    assert.ok(since.length >= 3 && since.length < body.entries.length && since.every((/** @type {any} */ e) => e.at >= later));
    // Unknown agent names stay unknown.
    assert.equal((await s.trace('nobody')).status, 404);
  } finally {
    await s.close();
  }
});

test('a trace that fails changes nothing: the same messages go to the same people', async () => {
  const a = await startService();
  const b = await startService();
  try {
    for (const id of ['agent:jcb-1', 'agent:contractor-1', 'agent:supplier-1']) b.app.agent(id).trace.close();
    await jcbJob(a);
    await materialJob(a);
    await jcbJob(b);
    await materialJob(b);
    const said = (/** @type {typeof a} */ s) => s.sent.map((m) => `${m.to} ${m.text}`);
    assert.deepEqual(said(b), said(a));
    assert.equal(b.app.agent('agent:contractor-1').core.ledger.orders().length, 2);
  } finally {
    await a.close();
    await b.close();
  }
});
