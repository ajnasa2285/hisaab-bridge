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
    assert.deepEqual(question.interactive.action.buttons, [{ type: 'reply', reply: { id: 'yes', title: 'हाँ' } }, { type: 'reply', reply: { id: 'no', title: 'नहीं' } }]);
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
