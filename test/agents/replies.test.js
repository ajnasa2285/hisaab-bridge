// Fewer steps (docs/BUILD2.md): a person's own exact reply to a request open for them runs at once
// with one receipt, read by code (the model is never asked); short spoken yes/no phrases count as a
// yes or a no only when they are nothing else; and no message shows "—" for a time, day or estimate
// that was simply not given. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { yesNo, tokens } from '../../src/agents/replies.js';
import { t } from '../../src/i18n/index.js';
import { setup, person } from './helpers.js';

const owner = { ...person('jcb_owner', 'agent:jcb-1'), phone: '919000000031' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000032' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000033' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000034' };
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const SAND = { name: 'रेत', qtyHundredths: 200, unit: 'ट्रॉली' };
// The other agent answers over real HTTP: give it a moment, as site-receipt.test.js does.
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 10)); };

test('short yes and no: typed or spoken, punctuation stripped; anything with digits or other content is neither', () => {
  for (const s of ['हाँ', 'हां जी', 'जी हाँ', 'हाँ जी।', 'हां भेज दो', 'haan ji', 'ok bhej do', 'ठीक है भेजो', 'Ok.', 'हाँ, भेज दो।', 'जी', 'हाँ?', 'हाँ आ गया']) {
    assert.equal(yesNo(s), 'yes', s);
  }
  for (const s of ['नहीं', 'नहीं चाहिए', 'nahi abhi nahi', 'नहीं, अभी नहीं।', 'जी नहीं', 'no.', 'नहीं आया']) {
    assert.equal(yesNo(s), 'no', s);
  }
  for (const s of ['हाँ 50 बोरी', 'हाँ नहीं', 'हाँ सीमेंट कल भेजो', 'हाँ जी ठीक है भेज दो', '50', 'कल', 'हाँ 380', 'भेज दो', '', 'नहीं 45 बोरी कम आई']) {
    assert.equal(yesNo(s), null, s);
  }
  assert.deepEqual(tokens('हाँ, 350।'), ['हाँ', '350']);
  assert.deepEqual(tokens('हाँ 350.50'), ['हाँ', '350.50']);
});

/** The supplier's conversation over the real agents; the model must never be asked here. */
async function supplierDesk() {
  let calls = 0;
  const spark = async () => {
    calls += 1;
    return { ok: /** @type {const} */ (true), toolCalls: [] };
  };
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const talk = createConversation({ ledger: s.supCore.ledger, tools: s.sup.tools, spark, reply, now: s.supCore.now });
  /** @param {any[]} items @param {string} [time] */
  const order = async (items, time) => {
    const ids = () => /** @type {{order_id: string}[]} */ (s.siteCore.ledger.orders()).map((o) => o.order_id);
    const before = new Set(ids());
    const r = await runTool(s.site.tools, contractor, { tool: 'request_material', args: { site: 'Site A', day: '2026-10-30', items, ...(time ? { time } : {}) } });
    assert.equal(r.ok, true);
    await settle();
    // The new order: the test clock is fixed, so creation times tie and the list order is by id.
    return ids().find((id) => !before.has(id)) ?? '';
  };
  return { s, talk, said, order, calls: () => calls, last: () => said.at(-1) ?? ['', '', ''] };
}

test('supplier: "हाँ 350, 4000" commits at once with one receipt; the wrong number of rates asks only for the rates', async () => {
  const d = await supplierDesk();
  try {
    const id = await d.order([CEMENT, SAND]);
    // The order notice has no time: no "—", no "बजे".
    const notice = d.said.find(([w, k]) => w === 'supplier:supplier' && k === 'supplier.order_request');
    assert.ok(notice && !notice[2].includes('—') && !notice[2].includes('बजे'), notice?.[2]);

    // One rate for two items: only the rates are asked; nothing is sent.
    await d.talk.onText(supplier, 'हाँ 350');
    assert.equal(d.last()[1], 'supplier.rates_needed');
    assert.equal(d.s.siteCore.ledger.view(id).state, 'requested');
    // A bare "हाँ" also asks for the rates.
    await d.talk.onText(supplier, 'हाँ जी');
    assert.equal(d.last()[1], 'supplier.rates_needed');

    // The exact reply, as a voice transcript writes it: sent at once, no read-back, no second "हाँ".
    await d.talk.onText(supplier, 'हाँ, 350, 4000।');
    assert.equal(d.last()[1], 'supplier.reply_sent_yes');
    assert.ok(d.last()[2].includes('P-1') && d.last()[2].includes('सीमेंट ₹350/बोरी') && d.last()[2].includes('रेत ₹4,000/ट्रॉली'), d.last()[2]);
    assert.equal(d.talk.pending(supplier), null);
    assert.equal(d.calls(), 0, 'read by code, never by the model');
    await settle();
    assert.equal(d.s.siteCore.ledger.view(id).state, 'booked');
    // The contractor's notice shows the day the order asked for (the yes carried none), never "—".
    const told = d.said.find(([w, k]) => w === 'site:contractor' && k === 'site.material_booking_yes');
    assert.ok(told && told[2].includes('30 अक्टूबर 2026') && !told[2].includes('—'), told?.[2]);
  } finally {
    await d.s.close();
  }
});

test('supplier: "नहीं" and another day act at once; two open orders need the reference, then it acts on that one', async () => {
  const d = await supplierDesk();
  try {
    const first = await d.order([CEMENT], '09:00');
    assert.ok(d.said.some(([w, k, text]) => w === 'supplier:supplier' && k === 'supplier.order_request_time' && text.includes('09:00 बजे तक')));
    const second = await d.order([SAND]);

    // Two orders wait for an answer and none is named: which one? Nothing is sent.
    await d.talk.onText(supplier, 'नहीं');
    assert.equal(d.last()[1], 'reply.which_order');
    assert.ok(d.last()[2].includes('P-1, P-2') && d.last()[2].includes('"P-1 नहीं"'), d.last()[2]);
    assert.deepEqual([d.s.siteCore.ledger.view(first).state, d.s.siteCore.ledger.view(second).state], ['requested', 'requested']);

    await d.talk.onText(supplier, 'P-2 नहीं');
    assert.equal(d.last()[1], 'supplier.reply_sent_no');
    assert.ok(d.last()[2].includes('P-2'));
    await settle();
    assert.equal(d.s.siteCore.ledger.view(second).state, 'declined');

    // Now only P-1 is open: a day alone offers another day, at once.
    await d.talk.onText(supplier, '31-10 8 बजे');
    assert.equal(d.last()[1], 'supplier.reply_sent_other_time');
    assert.ok(d.last()[2].includes('31 अक्टूबर 2026'));
    await settle();
    assert.equal(d.s.siteCore.ledger.view(first).state, 'offered');
    const told = d.said.find(([w, k]) => w === 'site:contractor' && k === 'site.material_booking_other_time_time');
    assert.ok(told && told[2].includes('08:00') && !told[2].includes('—'), told?.[2]);
    assert.equal(d.calls(), 0);
  } finally {
    await d.s.close();
  }
});

test('JCB owner: "हाँ 1200" commits at once; the request without time or hours shows neither, and no "—"', async () => {
  let calls = 0;
  const spark = async () => {
    calls += 1;
    return { ok: /** @type {const} */ (true), toolCalls: [] };
  };
  /** @type {[string, string, string][]} */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  try {
    const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
    const talk = createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark, reply, now: s.jcbCore.now });
    const r = await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site B', day: '2026-10-31' } });
    assert.equal(r.key, 'site.jcb_requested');
    assert.ok(!t(r.key, r.params).includes('—'));
    await settle();
    const notice = said.find(([w, k]) => w === 'jcb:jcb_owner' && k === 'jcb.booking_request');
    assert.ok(notice && !notice[2].includes('—') && !notice[2].includes('बजे') && notice[2].includes('"हाँ 1200"'), notice?.[2]);

    // "हाँ" alone asks for the rate only.
    await talk.onText(owner, 'हाँ जी');
    assert.equal(said.at(-1)?.[1], 'jcb.rate_needed');
    await talk.onText(owner, 'हाँ ₹1200 घंटा');
    assert.equal(said.at(-1)?.[1], 'jcb.reply_sent_yes');
    assert.ok(said.at(-1)?.[2].includes('₹1,200') && said.at(-1)?.[2].includes('J-1'));
    assert.equal(calls, 0);
    await settle();
    const orderId = /** @type {{order_id: string}} */ (s.jcbCore.ledger.orders()[0]).order_id;
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'booked');
    for (const [who, key] of [['jcb:operator', 'jcb.job_booked'], ['site:contractor', 'site.booking_yes']]) {
      const m = said.find(([w, k]) => w === who && k === key);
      assert.ok(m && m[2].includes('31 अक्टूबर 2026') && !m[2].includes('—'), `${who} ${m?.[2]}`);
    }
  } finally {
    await s.close();
  }
});

test('contractor: "नहीं <figure> <reason>" to a bill disputes at once; without a reason only the reason is asked', async () => {
  /** @type {[string, string, string][]} */
  const said = [];
  let calls = 0;
  const spark = async () => {
    calls += 1;
    return { ok: /** @type {const} */ (true), toolCalls: [] };
  };
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  try {
    const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
    const talk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now });
    await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site C', day: '2026-10-30' } });
    const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
    await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
    await runTool(s.jcb.tools, owner, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 1000, sha256: 'a'.repeat(64) } });
    await runTool(s.jcb.tools, owner, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 1061, sha256: 'b'.repeat(64) } });
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await settle();
    assert.equal(s.siteCore.ledger.view(orderId).state, 'billed');

    await talk.onText(contractor, 'नहीं 5.5');
    assert.equal(said.at(-1)?.[1], 'site.reason_needed');
    assert.equal(s.siteCore.ledger.view(orderId).state, 'billed');
    await talk.onText(contractor, 'नहीं, 5.5 घंटे, मशीन देर से आई।');
    assert.equal(said.at(-1)?.[1], 'site.bill_disputed');
    assert.equal(calls, 0, 'read by code, never by the model');
    const dispute = s.siteCore.ledger.events(orderId).find((e) => e.type === 'DISPUTE')?.body.body;
    assert.deepEqual([dispute?.theirFigure, dispute?.reason], [{ hoursTenths: 55 }, 'मशीन देर से आई']);
  } finally {
    await s.close();
  }
});

test('a supervisor\'s message that is not an exact reply goes to the model as before', async () => {
  const s = await setup();
  try {
    let calls = 0;
    const spark = async () => {
      calls += 1;
      return { ok: /** @type {const} */ (true), toolCalls: [] };
    };
    const talk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply: () => {}, now: s.siteCore.now });
    await talk.onText(supervisor, 'हाँ 50 बोरी');
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});
