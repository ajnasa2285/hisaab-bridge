import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../src/agents/common.js';
import { createOffice } from '../../src/agents/office.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const contractor = person('contractor', 'agent:contractor-1');
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012' };
const supplier = person('supplier', 'agent:supplier-1');
const owner = person('jcb_owner', 'agent:jcb-1');
const cement = (quantity = 5000) => ({ name: 'सीमेंट', unit: 'बोरी', qtyHundredths: quantity });
const pause = () => new Promise((r) => setImmediate(r));
const textOf = (/** @type {{key:string,params?:any}} */ r) => t(r.key, r.params);
/** @param {any} s @param {number} [quantity] @param {number} [rate] @param {boolean} [accepted] */
async function material(s, quantity = 5000, rate = 38000, accepted = true) {
  const before = new Set(s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id));
  const r = await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'कल्पित साइट', day: '2026-10-29', items: [cement(quantity)] } });
  assert.equal(r.ok, true);
  const orderId = s.siteCore.ledger.orders().find((/** @type {any} */ o) => !before.has(o.order_id)).order_id;
  const reply = await runTool(s.sup.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [rate], gstPercents: [28] } });
  assert.equal(reply.ok, true);
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'record_delivery', args: { orderId, items: [cement(quantity)], sha256: SHA_A } })).ok, true);
  assert.equal((await runTool(s.sup.tools, supplier, { tool: 'send_bill', args: { orderId } })).ok, true);
  await pause();
  if (accepted) assert.equal((await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } })).ok, true);
  return { orderId, reply };
}
/** @param {any} s @param {number} [hoursTenths] @param {number} [ratePaise] @param {boolean} [accepted] */
async function jcb(s, hoursTenths = 60, ratePaise = 120000, accepted = true) {
  const before = new Set(s.siteCore.ledger.orders().map((/** @type {any} */ o) => o.order_id));
  assert.equal((await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'कल्पित साइट', day: '2026-10-29', hoursTenths } })).ok, true);
  const orderId = s.siteCore.ledger.orders().find((/** @type {any} */ o) => !before.has(o.order_id)).order_id;
  const reply = await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise } });
  assert.equal(reply.ok, true);
  for (const [which, valueTenths, sha256] of [['start', 1000, SHA_A], ['end', 1000 + hoursTenths, SHA_B]]) {
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'record_meter', args: { orderId, which, valueTenths, sha256 } })).ok, true);
  }
  assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } })).ok, true);
  await pause();
  if (accepted) assert.equal((await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } })).ok, true);
  return { orderId, reply };
}

test('material bill and supplier yes append one usual line; normal figures stay silent and acceptance stays human', async () => {
  /** @type {any[]} */ const decisions = [];
  const s = await setup({ onTell: (side, role, key, params, expect) => decisions.push({ side, role, key, params, expect }) });
  try {
    for (let i = 0; i < 3; i++) await material(s);
    assert.ok(!s.told.some((x) => x[2] === 'usual.notice'), 'fewer than three previous observations are silent');
    const ordinary = await material(s);
    assert.equal(ordinary.reply.key, 'supplier.reply_sent_yes');
    const a = await material(s, 10000, 380000, false);
    assert.match(textOf(a.reply), /900% ज़्यादा.*₹380\/बोरी/);
    const readBack = s.sup.tools.reply_order.describe?.({ orderId: a.orderId, answer: 'yes', ratesPaise: [380000] });
    assert.ok(readBack);
    assert.match(textOf(readBack), /900% ज़्यादा/);
    const notice = decisions.find((x) => x.side === 'site' && x.role === 'contractor' && x.expect?.tool === 'accept_bill' && x.expect?.args.orderId === a.orderId);
    assert.equal(notice.key, 'usual.notice');
    assert.match(textOf(notice), /100% ज़्यादा.*50 बोरी/);
    assert.match(textOf(notice), /900% ज़्यादा.*₹380\/बोरी/);
    assert.equal(notice.expect.tool, 'accept_bill');
    assert.equal((textOf(notice).match(/सामान्य से अलग:/g) ?? []).length, 1);
    assert.equal(s.siteCore.ledger.view(a.orderId).state, 'billed');
    assert.ok(!decisions.filter((x) => x.role === 'supervisor').some((x) => x.key === 'usual.notice'));
    assert.equal((await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId: a.orderId } })).ok, true);
  } finally { await s.close(); }
});

test('JCB yes and bill flag rates and hours from the JCB and contractor own histories', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 3; i++) await jcb(s);
    const a = await jcb(s, 120, 180000, false);
    assert.match(textOf(a.reply), /50% ज़्यादा.*₹1,200\/घंटे/);
    const readBack = s.jcb.tools.reply_booking.describe?.({ orderId: a.orderId, answer: 'yes', ratePaise: 180000 });
    assert.ok(readBack);
    assert.match(textOf(readBack), /50% ज़्यादा/);
    const notice = s.told.filter((x) => x[0] === 'site' && x[1] === 'contractor' && x[2] === 'usual.notice').at(-1);
    assert.ok(notice);
    assert.match(t(notice[2], notice[3]), /100% ज़्यादा.*6\.0 घंटे/);
    assert.equal(s.siteCore.ledger.view(a.orderId).state, 'billed');
  } finally { await s.close(); }
});

test('usual quantity never holds an order; contractor sees ordered context below limit and estimate context above it', async () => {
  const s = await setup();
  /** @type {any[]} */ const notices = [];
  try {
    for (let i = 0; i < 3; i++) await material(s, 1000);
    const office = createOffice({ ledger: s.siteCore.ledger, tools: s.site.tools, kind: 'contractor',
      limits: { procurementPaise: 2500000 }, now: s.siteCore.now,
      tell: (role, key, params) => { notices.push({ role, key, params }); }, reply: () => {} });
    const small = { site: 'कल्पित साइट', day: '2026-10-29', items: [cement(2000)] };
    assert.equal(office.holds(supervisor, 'request_material', small), false);
    const sent = await office.commit(supervisor, 'request_material', small);
    assert.equal(sent.key, 'site.material_requested', 'supervisor gets existing receipt only');
    assert.equal(notices.length, 1, 'only ordered context, no approval question');
    const ordered = notices[0];
    assert.ok(ordered);
    assert.match(textOf(ordered), /100% ज़्यादा.*10 बोरी/);
    assert.doesNotMatch(textOf(ordered), /मंज़ूरी|OK/);
    notices.length = 0;
    const large = { ...small, items: [cement(10000)] };
    assert.equal(office.holds(supervisor, 'request_material', large), true);
    const before = s.siteCore.ledger.orders().length;
    const held = await office.commit(supervisor, 'request_material', large);
    assert.equal(held.key, 'office.held_step');
    assert.equal(s.siteCore.ledger.orders().length, before, 'holding still only follows value limit');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].role, 'contractor');
    assert.match(textOf(notices[0]), /₹38,000/);
    assert.match(textOf(notices[0]), /सामान्य मात्रा और दर पर अनुमान ₹3,800/);
    assert.match(textOf(notices[0]), /900% ज़्यादा/);
    const approved = await office.command(contractor, { cmd: 'ok', ref: String(held.params?.ref), note: null });
    assert.ok(approved?.ok);
    assert.match(textOf(approved), /900% ज़्यादा/);
    assert.equal(notices.length, 1, 'approval returns one enriched receipt, without another contractor notice');
    assert.equal(s.siteCore.ledger.orders().length, before + 1);
  } finally { await s.close(); }
});
