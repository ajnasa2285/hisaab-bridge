// Reply buttons through the whole one-process service: a हाँ / नहीं question goes as two buttons, a tap
// is the same message as the typed word, refused buttons go as the same text, and an unsure meter
// reading is one tap. Stand-in Graph API and readers; invented people and numbers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTOR, OPERATOR, OWNER, startService } from './trace/harness.js';
import { meterReadings } from './../src/agents/jcb.js';
import { t } from '../src/i18n/index.js';

const REQUEST = { name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } };
/** @param {string} raw */
const unsure = (raw) => ({ ok: true, kind: 'hour_meter', raw, valueTenths: null, clear: false, displayDate: null, dashClock: null, model: 'muse-spark-1.2', latencyMs: 9 });

/** @param {Awaited<ReturnType<typeof startService>>} s @param {string} phone */
const lastBody = (s, phone) => s.bodies.filter((b) => b.to === phone).at(-1);
/** @param {Awaited<ReturnType<typeof startService>>} s */
const siteOrders = (s) => s.app.agent('agent:contractor-1').core.ledger.orders().length;

/** @param {Awaited<ReturnType<typeof startService>>} s */
async function ask(s) {
  s.model.calls = [REQUEST];
  await s.say(CONTRACTOR, 'kal Shivpuri JCB');
  s.model.calls = [];
}

test('a read-back goes as two buttons; a tapped "हाँ" does what a typed one does, a tapped "नहीं" what a typed one does', async () => {
  const s = await startService();
  try {
    await s.say(CONTRACTOR, 'मदद');
    await ask(s);
    const question = lastBody(s, CONTRACTOR);
    assert.equal(question.type, 'interactive');
    assert.equal(question.interactive.type, 'button');
    const [yes, no] = question.interactive.action.buttons;
    assert.deepEqual([yes.type, yes.reply.title, no.type, no.reply.title], ['reply', 'हाँ', 'reply', 'नहीं']);
    const token = yes.reply.id.slice(4);
    assert.match(token, /^[A-Za-z0-9_-]{12}$/);
    assert.deepEqual([yes.reply.id, no.reply.id], [`yes:${token}`, `no:${token}`], 'both buttons name this question');
    const words = question.interactive.body.text;
    assert.ok(words.includes('Shivpuri') && !words.includes('हाँ / नहीं') && words === words.trim(), words);

    await s.tap(CONTRACTOR, 'हाँ');
    const tapped = s.lastTo(CONTRACTOR);
    assert.equal(siteOrders(s), 1);
    await ask(s);
    await s.say(CONTRACTOR, 'हाँ');
    const typed = s.lastTo(CONTRACTOR);
    assert.equal(siteOrders(s), 2);
    assert.equal(tapped.replaceAll('J-1', 'J-?'), typed.replaceAll('J-2', 'J-?'), `${tapped} / ${typed}`);

    await ask(s);
    await s.tap(CONTRACTOR, 'नहीं');
    assert.equal(s.lastTo(CONTRACTOR), t('step.cancelled'));
    assert.equal(siteOrders(s), 2);
  } finally {
    await s.close();
  }
});

test('a button of an earlier question decides nothing in the whole service: the open question is asked again; with nothing open, nothing is decided', async () => {
  const s = await startService();
  try {
    await s.say(CONTRACTOR, 'मदद');
    await ask(s);
    const [old] = s.buttonsTo(CONTRACTOR);
    await s.tap(CONTRACTOR, 'नहीं');
    assert.equal(s.lastTo(CONTRACTOR), t('step.cancelled'));
    await ask(s);
    const [current] = s.buttonsTo(CONTRACTOR);
    assert.notEqual(old.id, current.id);
    const before = s.sent.length;
    await s.tap(CONTRACTOR, 'हाँ', old.id);
    const told = s.sent.slice(before).filter((x) => x.to === CONTRACTOR).map((x) => x.text);
    assert.equal(told[0], t('common.button_old'));
    assert.ok(told[1]?.includes('Shivpuri') && told[1].endsWith('हाँ / नहीं'), told.join(' / '));
    assert.equal(lastBody(s, CONTRACTOR).interactive.action.buttons[0].reply.id, current.id, 'asked again with its own buttons');
    assert.equal(siteOrders(s), 0, 'nothing decided');
    await s.tap(CONTRACTOR, 'हाँ', current.id);
    assert.equal(siteOrders(s), 1);
    // Nothing open now: the same old button, and the button just used, decide nothing.
    for (const id of [old.id, current.id]) {
      await s.tap(CONTRACTOR, 'हाँ', id);
      assert.equal(s.lastTo(CONTRACTOR), t('common.button_old_none'));
    }
    assert.equal(siteOrders(s), 1);
  } finally {
    await s.close();
  }
});

test('buttons WhatsApp refuses go as the same text, with the last four digits in the log; a typed "हाँ" answers it', async () => {
  const s = await startService();
  try {
    await s.say(CONTRACTOR, 'मदद');
    s.model.buttonFails = 1;
    await ask(s);
    const [buttons, text] = s.bodies.filter((b) => b.to === CONTRACTOR).slice(-2);
    assert.deepEqual([buttons.type, text.type], ['interactive', 'text']);
    assert.ok(text.text.body.endsWith('हाँ / नहीं'), text.text.body);
    assert.ok(text.text.body.startsWith(buttons.interactive.body.text), 'the same question');
    assert.ok(s.logs.some((l) => l.startsWith('wa site: buttons to …0012 failed: http 400 code 131009; sent as text')), s.logs.join('\n'));
    assert.ok(!s.logs.some((l) => l.includes(CONTRACTOR)));
    await s.say(CONTRACTOR, 'हाँ');
    assert.equal(siteOrders(s), 1);
  } finally {
    await s.close();
  }
});

test('an unsure meter reading is one tap: "हाँ" records it; "नहीं" asks for the digits, and typed digits are recorded', async () => {
  const s = await startService();
  try {
    for (const p of [OWNER, OPERATOR, CONTRACTOR]) await s.say(p, 'मदद');
    await ask(s);
    await s.tap(CONTRACTOR, 'हाँ');
    await s.say(OWNER, 'J-1 हाँ 1200');
    const { ledger } = s.app.agent('agent:jcb-1').core;
    const orderId = String(/** @type {any} */ (ledger.orders()[0]).order_id);
    s.model.kind = 'meter';

    s.model.meters = [unsure('9989.4')];
    await s.say(OPERATOR, null);
    const question = lastBody(s, OPERATOR);
    assert.equal(question.type, 'interactive');
    assert.equal(question.interactive.body.text, 'मीटर 9989.4 पढ़ा। सही है?');
    assert.equal(meterReadings(ledger.events(orderId)).start, null);
    await s.tap(OPERATOR, 'हाँ');
    assert.equal(meterReadings(ledger.events(orderId)).start?.valueTenths, 99894);

    s.model.meters = [unsure('9995.4')];
    await s.say(OPERATOR, null);
    await s.tap(OPERATOR, 'नहीं');
    assert.equal(s.lastTo(OPERATOR), t('meter.ask_person_blank'));
    assert.equal(lastBody(s, OPERATOR).type, 'text');
    assert.equal(meterReadings(ledger.events(orderId)).end, null);
    await s.say(OPERATOR, '9995.9');
    assert.equal(meterReadings(ledger.events(orderId)).end?.valueTenths, 99959);
  } finally {
    await s.close();
  }
});
