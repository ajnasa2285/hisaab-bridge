// The conversation over the real agents: text → proposed step → read-back → "हाँ" → signed message.
// Muse Spark and the meter reader are stand-ins that return fixed answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000002' };
const contractor = person('contractor', 'agent:contractor-1');
const supervisor = { ...person('supervisor', 'agent:contractor-1'), phone: '919000000012' };

test('a JCB job by conversation: every committing step is read back and runs only on "हाँ"', async () => {
  /** @type {{name: string, args: any}[]} */
  let nextCalls = [];
  const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: nextCalls });
  /** @type {any} */
  let nextRead = null;
  const readMeter = async () => nextRead;
  /** @type {[string, string, string][]} [who, key, text] */
  const said = [];
  /** @type {any} */
  let jcbTalk = null;
  /** @type {any} */
  let siteTalk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      // The wiring: tell everyone in the role, and remember what a plain yes would mean.
      const who = side === 'jcb' ? (role === 'operator' ? operator : owner) : (role === 'supervisor' ? supervisor : contractor);
      said.push([`${side}:${role}`, key, t(key, params)]);
      if (expect) (side === 'jcb' ? jcbTalk : siteTalk).expect(who, expect.tool, expect.args);
    },
  });
  try {
    const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
    jcbTalk = createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark, readMeter, classifyPhoto: seesPhoto('meter'), reply, now: s.jcbCore.now });
    siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now });
    const last = () => said.at(-1)?.[1];
    const settle = () => new Promise((r) => setImmediate(r));

    // Supervisor asks for the JCB; read back; yes.
    nextCalls = [{ name: 'request_jcb', args: { site: 'Shivpuri', day: '29-10', time: '8', hours: '6' } }];
    await siteTalk.onText(supervisor, 'kal 8 baje Shivpuri JCB chahiye 6 ghante');
    assert.equal(last(), 'step.request_jcb');
    assert.equal(s.siteCore.ledger.orders().length, 0, 'nothing sent before yes');
    await siteTalk.onText(supervisor, 'हाँ');
    assert.equal(last(), 'site.jcb_requested');
    await settle();
    assert.ok(said.some(([w, k, text]) => w === 'jcb:jcb_owner' && k === 'jcb.booking_request' && text.includes('29 अक्टूबर 2026')));

    // Owner says yes at ₹1,200; read back; yes.
    nextCalls = [{ name: 'reply_booking', args: { order: null, answer: 'yes', rate_rupees_per_hour: '1200', day: null, time: null } }];
    await jcbTalk.onText(owner, 'haan 1200 ghanta');
    assert.equal(last(), 'step.reply_booking_yes');
    await jcbTalk.onText(owner, 'ok');
    assert.equal(last(), 'jcb.reply_sent_yes');
    assert.ok(said.some(([w, k]) => w === 'jcb:operator' && k === 'jcb.job_booked'));

    // Start photo is clear: read back, yes. End photo is not clear: the operator types it.
    nextRead = { ok: true, kind: 'hour_meter', raw: '1234.5', valueTenths: 12345, clear: true };
    nextRead = { ok: true, kind: 'hour_meter', raw: '1284.5', valueTenths: 12845, clear: true };
    await jcbTalk.onImage(operator, { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
    assert.deepEqual(said.at(-1)?.slice(0, 2), ['operator', 'step.record_meter_start']);
    // The model misread a digit; the operator types the right reading and is asked again.
    await jcbTalk.onText(operator, '1234.5');
    assert.equal(last(), 'step.record_meter_start');
    assert.ok(said.at(-1)?.[2].includes('1234.5'));
    await jcbTalk.onText(operator, 'हाँ');
    assert.equal(last(), 'jcb.meter_start_saved');
    nextRead = { ok: true, kind: 'hour_meter', raw: '124?.6', valueTenths: null, clear: false };
    await jcbTalk.onImage(operator, { mime: 'image/jpeg', bytes: new Uint8Array([4, 5, 6]) });
    assert.equal(last(), 'meter.ask_person');
    await jcbTalk.onText(operator, '1240.6');
    assert.equal(last(), 'step.record_meter_end');
    await jcbTalk.onText(operator, 'haan');
    assert.equal(last(), 'jcb.meter_end_saved');

    // Bill: the read-back already shows the figures from the ledger.
    nextCalls = [{ name: 'send_bill', args: { order: null } }];
    await jcbTalk.onText(owner, 'bill bhejo');
    assert.equal(last(), 'step.send_bill');
    assert.ok(said.at(-1)?.[2].includes('₹7,320'));
    await jcbTalk.onText(owner, 'हाँ');
    assert.equal(last(), 'jcb.bill_sent');
    await settle();

    // The contractor was asked "ठीक हो तो हाँ": one "हाँ" accepts, with no second question.
    assert.ok(said.some(([w, k]) => w === 'site:contractor' && k === 'site.bill_received'));
    await siteTalk.onText(contractor, 'हाँ');
    assert.equal(last(), 'site.bill_accepted');
    assert.equal(s.jcbCore.ledger.view(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id).state, 'accepted');

    // "नहीं" to a read-back sends nothing.
    nextCalls = [{ name: 'request_jcb', args: { site: 'Gwalior', day: '30-10', time: null, hours: null } }];
    await siteTalk.onText(contractor, 'Gwalior parso');
    await siteTalk.onText(contractor, 'नहीं');
    assert.equal(last(), 'step.cancelled');
    assert.equal(s.siteCore.ledger.orders().length, 1);

    // Help needs no model.
    nextCalls = [];
    await siteTalk.onText(supervisor, 'मदद');
    assert.equal(last(), 'help.supervisor');
  } finally {
    await s.close();
  }
});

test('a request with a value left out keeps the rest and asks only for that value', async () => {
  /** @type {{name: string, args: any}[]} */
  let nextCalls = [];
  let calls = 0;
  const spark = async () => {
    calls += 1;
    return { ok: /** @type {const} */ (true), toolCalls: nextCalls };
  };
  /** @type {[string, string][]} [key, text] */
  const said = [];
  const s = await setup();
  try {
    const reply = (/** @type {any} */ _p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([key, t(key, params)]); };
    const talk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, reply, now: s.siteCore.now });
    const last = () => said.at(-1) ?? ['', ''];

    // No site named and none known: one question, for the site only.
    nextCalls = [{ name: 'request_material', args: { site: 'साइट', day: 'tomorrow', time: 'null', items: [{ name: 'सीमेंट', quantity: 'pachaas', unit: 'बोरी' }] } }];
    await talk.onText(supervisor, 'कल साइट पर सीमेंट पचास बोरी चाहिए');
    assert.equal(last()[0], 'ask.missing');
    assert.equal(last()[1], t('ask.missing', { questions: t('ask.site') }));
    // The site typed alone is read by code; then the usual read-back with everything kept.
    nextCalls = [];
    calls = 0;
    await talk.onText(supervisor, 'Rampur');
    assert.equal(calls, 0);
    assert.equal(last()[0], 'step.request_material');
    assert.ok(last()[1].includes('Rampur') && last()[1].includes('50 बोरी'), last()[1]);
    assert.equal(s.siteCore.ledger.orders().length, 0, 'nothing sent before yes');
    await talk.onText(supervisor, 'हाँ');
    assert.equal(last()[0], 'site.material_requested');
    assert.equal(s.siteCore.ledger.orders().length, 1);

    // A missing quantity is asked by item; "नहीं" cancels and nothing is sent.
    nextCalls = [{ name: 'request_material', args: { site: 'Rampur', day: 'tomorrow', time: null, items: [{ name: 'रेत', quantity: null, unit: 'ट्रॉली' }] } }];
    await talk.onText(supervisor, 'kal Rampur ret chahiye trolley');
    assert.equal(last()[1], t('ask.missing', { questions: t('ask.qty', { name: 'रेत', unit: 'ट्रॉली' }) }));
    await talk.onText(supervisor, 'नहीं');
    assert.equal(last()[0], 'step.cancelled');
    assert.equal(s.siteCore.ledger.orders().length, 1);

    // With one open job, its site is the one meant; the day is asked. Help instead of an answer: the question lapses.
    nextCalls = [{ name: 'request_jcb', args: { site: null, day: null, time: null, hours: null } }];
    await talk.onText(supervisor, 'JCB chahiye');
    assert.equal(last()[1], t('ask.missing', { questions: t('ask.day') }));
    await talk.onText(supervisor, 'मदद');
    assert.equal(last()[0], 'help.supervisor');
    assert.equal(talk.pending(supervisor), null);
  } finally {
    await s.close();
  }
});
