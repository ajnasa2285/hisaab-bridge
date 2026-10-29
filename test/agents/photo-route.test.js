// Any photo, any time: the photo's kind (a stand-in for classifyPhoto here) decides the flow, not the
// sender's role. A kind the person may not send is named with who sends it; an unsure kind is asked;
// nothing is read twice; a clear, consistent reading is recorded with a receipt, anything else asks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person } from './helpers.js';

const owner = { ...person('jcb_owner', 'agent:jcb-1'), phone: '919000000021' };
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000022' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000023' };
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000024' };
const supplier = { ...person('supplier', 'agent:supplier-1'), phone: '919000000025' };
const photo = { mime: 'image/jpeg', bytes: new Uint8Array([7, 1, 7, 1]) };

/** @typedef {'meter' | 'upi' | 'challan' | 'other'} Kind */

/** The three agents' conversations wired as in src/app.js, each reader and the classifier counted. */
async function start() {
  /** @type {[string, string, string][]} [role, key, text] */
  const said = [];
  /** @type {{kind: Kind, clear: boolean} | {fail: true}} */
  let sees = { kind: 'other', clear: true };
  const calls = { classify: 0, meter: 0, upi: 0, challan: 0 };
  const s = await setup();
  const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
  /** @type {import('../../src/agents/conversation.js').PhotoClassifier} */
  const classifyPhoto = async () => {
    calls.classify += 1;
    return 'fail' in sees ? { ok: false, transient: true, reason: 'timeout' } : { ok: true, ...sees, model: 'stand-in', latencyMs: 1 };
  };
  /** @type {import('../../src/agents/conversation.js').MeterReader} */
  const readMeter = async () => { calls.meter += 1; return { ok: true, kind: 'hour_meter', raw: '1234.5', valueTenths: 12345, clear: true }; };
  /** @type {import('../../src/agents/conversation.js').UpiReader} */
  const readUpi = async () => { calls.upi += 1; return { ok: true, kind: 'not_upi' }; };
  /** @type {import('../../src/agents/conversation.js').ChallanReader} */
  const readChallan = async () => { calls.challan += 1; return { ok: true, kind: 'not_challan' }; };
  const common = { spark, classifyPhoto, reply };
  const talks = {
    jcb: createConversation({ ...common, ledger: s.jcbCore.ledger, tools: s.jcb.tools, readMeter, now: s.jcbCore.now }),
    site: createConversation({ ...common, ledger: s.siteCore.ledger, tools: s.site.tools, readUpi, readChallan, now: s.siteCore.now }),
    sup: createConversation({ ...common, ledger: s.supCore.ledger, tools: s.sup.tools, readChallan, now: s.supCore.now }),
  };
  return {
    s, said, calls, talks,
    sees: (/** @type {Kind} */ kind, clear = true) => { sees = { kind, clear }; },
    fails: () => { sees = { fail: true }; },
    last: () => said.at(-1),
    reads: () => calls.meter + calls.upi + calls.challan,
    /** Nothing is written in any ledger. */
    events: () => [s.jcbCore, s.siteCore, s.supCore].reduce((n, c) => n + c.ledger.orders().length, 0),
  };
}

/** @type {[keyof Awaited<ReturnType<typeof start>>['talks'], any][]} */
const WHO = [['jcb', owner], ['jcb', operator], ['site', contractor], ['site', supervisor], ['sup', supplier]];
// With no order open, each allowed kind ends in its own flow's first answer, which tells the flows apart.
/** @type {Record<string, Partial<Record<Kind, string>>>} */
const ALLOWED = {
  jcb_owner: { meter: 'orchestrator.no_job_for_photo' },
  operator: { meter: 'orchestrator.no_job_for_photo' },
  contractor: { upi: 'common.wrong_state', challan: 'site.challan_no_order' },
  supervisor: { challan: 'site.challan_no_order' },
  supplier: { challan: 'challan.no_order_for_photo' },
};

test('every kind × every role: an allowed kind goes to its flow; any other is named with who sends it; other is refused', async () => {
  const c = await start();
  try {
    for (const [side, who] of WHO) {
      for (const kind of /** @type {Kind[]} */ (['meter', 'upi', 'challan', 'other'])) {
        c.sees(kind);
        const before = c.calls.classify;
        await c.talks[side].onImage(who, photo);
        const label = `${who.role} sends ${kind}`;
        assert.equal(c.calls.classify, before + 1, label);
        const want = ALLOWED[who.role][kind] ?? (kind === 'other' ? 'photo.other' : `photo.sent_by_${kind}`);
        assert.equal(c.last()?.[1], want, label);
      }
    }
    // The texts name what this person can send, and the sender of what they cannot.
    c.sees('upi');
    await c.talks.site.onImage(supervisor, photo);
    assert.equal(c.last()?.[2], 'भुगतान की फ़ोटो ठेकेदार भेजते हैं। कुछ दर्ज नहीं हुआ। आप भेज सकते हैं: चालान।');
    c.sees('other');
    await c.talks.site.onImage(contractor, photo);
    assert.ok(c.last()?.[2].includes('UPI भुगतान, चालान'), c.last()?.[2]);
    // No order is open anywhere: no reader was reached, nothing was recorded.
    assert.equal(c.reads(), 0);
    assert.equal(c.events(), 0);
  } finally {
    await c.s.close();
  }
});

test('a person who sends no photos on this agent is told so; the photo is not even classified', async () => {
  const c = await start();
  try {
    await c.talks.site.onImage(/** @type {any} */ ({ ...person('operator', 'agent:contractor-1'), phone: '919000000026' }), photo);
    assert.equal(c.last()?.[1], 'photo.none');
    await c.talks.sup.onImage(supervisor, photo);
    assert.equal(c.last()?.[1], 'photo.none');
    assert.equal(c.calls.classify, 0);
  } finally {
    await c.s.close();
  }
});

test('unsure kind: asked once with the role\'s reply forms; the answer routes the kept photo, read once', async () => {
  const c = await start();
  try {
    await runTool(c.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site A', day: '2026-10-29' } });
    const orderId = /** @type {{order_id: string}} */ (c.s.siteCore.ledger.orders()[0]).order_id;
    await runTool(c.s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });

    c.sees('meter', false);
    await c.talks.jcb.onImage(operator, photo);
    assert.equal(c.last()?.[1], 'photo.ask_kind');
    assert.equal(c.last()?.[2], 'यह फ़ोटो क्या है? "मीटर" लिखें। ("नहीं" लिखें तो कुछ दर्ज नहीं होगा।)');
    assert.equal(c.calls.meter, 0);
    await c.talks.jcb.onText(operator, 'मीटर');
    assert.equal(c.calls.meter, 1);
    assert.equal(c.calls.classify, 1);
    // A clear reading that code finds consistent is recorded at once.
    assert.equal(c.last()?.[1], 'jcb.meter_start_saved');

    // The contractor is offered both of their forms; "UPI" goes to the payment flow, "चालान" to the site count.
    c.sees('challan', false);
    await c.talks.site.onImage(contractor, photo);
    assert.ok(c.last()?.[2].includes('"UPI" / "चालान"'), c.last()?.[2]);
    await c.talks.site.onText(contractor, 'UPI');
    assert.equal(c.last()?.[1], 'common.wrong_state');
    await c.talks.site.onImage(contractor, photo);
    await c.talks.site.onText(contractor, 'चालान');
    assert.equal(c.last()?.[1], 'site.challan_no_order');

    // An answer naming a kind this person may not send: told who sends it, nothing read.
    c.sees('other', false);
    await c.talks.site.onImage(supervisor, photo);
    assert.ok(c.last()?.[2].includes('"चालान"') && !c.last()?.[2].includes('UPI'), c.last()?.[2]);
    await c.talks.site.onText(supervisor, 'upi');
    assert.equal(c.last()?.[1], 'photo.sent_by_upi');
    assert.equal(c.calls.upi + c.calls.challan, 0);
  } finally {
    await c.s.close();
  }
});

test('unsure kind: a cancel word cancels; any other text lapses the question and the photo; it expires like other questions', async () => {
  const c = await start();
  try {
    c.sees('challan', false);
    await c.talks.sup.onImage(supplier, photo);
    assert.equal(c.last()?.[1], 'photo.ask_kind');
    await c.talks.sup.onText(supplier, 'नहीं');
    assert.equal(c.last()?.[1], 'step.cancelled');
    await c.talks.sup.onText(supplier, 'चालान');
    assert.notEqual(c.last()?.[1], 'challan.no_order_for_photo');

    await c.talks.sup.onImage(supplier, photo);
    await c.talks.sup.onText(supplier, 'मदद');
    assert.equal(c.last()?.[1], 'help.supplier');
    assert.equal(c.talks.sup.pending(supplier), null);
    await c.talks.sup.onText(supplier, 'चालान');
    assert.notEqual(c.last()?.[1], 'challan.no_order_for_photo');

    await c.talks.sup.onImage(supplier, photo);
    assert.equal(c.talks.sup.pending(supplier)?.kind, 'photo_kind');
    c.s.advance(31 * 60 * 1000);
    assert.equal(c.talks.sup.pending(supplier), null);
    await c.talks.sup.onText(supplier, 'चालान');
    assert.notEqual(c.last()?.[1], 'challan.no_order_for_photo');
    assert.equal(c.reads(), 0);
  } finally {
    await c.s.close();
  }
});

test('classifier failure or timeout: try again, nothing read or recorded', async () => {
  const c = await start();
  try {
    c.fails();
    for (const [side, who] of WHO) {
      await c.talks[side].onImage(who, photo);
      assert.equal(c.last()?.[1], 'orchestrator.try_again', who.role);
      assert.equal(c.talks[side].pending(who), null);
    }
    assert.equal(c.reads(), 0);
    assert.equal(c.events(), 0);
  } finally {
    await c.s.close();
  }
});

test('a photo while another question is open starts its own flow; the old question lapses', async () => {
  const c = await start();
  try {
    await runTool(c.s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site A', day: '2026-10-29' } });
    const orderId = /** @type {{order_id: string}} */ (c.s.siteCore.ledger.orders()[0]).order_id;
    await runTool(c.s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
    // The start is 2000.0, so the photo's 1234.5 as the end fails code's check: it is read back.
    await runTool(c.s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 20000, sha256: 'a'.repeat(64) } });
    c.sees('meter');
    await c.talks.jcb.onImage(operator, photo);
    assert.equal(c.last()?.[1], 'step.record_meter_end');
    // An unsure photo now: the meter read-back lapses, so a "हाँ" can no longer record it.
    c.sees('meter', false);
    await c.talks.jcb.onImage(operator, photo);
    assert.equal(c.last()?.[1], 'photo.ask_kind');
    await c.talks.jcb.onText(operator, 'नहीं');
    await c.talks.jcb.onText(operator, 'हाँ');
    assert.notEqual(c.last()?.[1], 'jcb.end_not_after_start');
    assert.equal(c.s.jcbCore.ledger.events(orderId).filter((e) => e.type === 'EVIDENCE').length, 1, 'only the start reading');
  } finally {
    await c.s.close();
  }
});
