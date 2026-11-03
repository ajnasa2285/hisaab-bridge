// Reply buttons with the agents and the router in separate processes, on one shared number and on a
// number per agent: the agent's question reaches the router as text and leaves as two buttons, a tap
// comes back to the agent as the typed word, and buttons WhatsApp refuses go as the same text. Models and
// the Graph API are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../../src/i18n/index.js';
import { CONTRACTOR, OPERATOR, OWNER, startServices } from './harness.js';

const LONG = { timeout: 240_000 };

for (const [name, o] of /** @type {[string, {sharedNumber?: boolean, threeLines?: boolean}][]} */ ([['one shared number', { sharedNumber: true }], ['a number per agent', { threeLines: true }]])) {
  test(`${name}: questions go as buttons through the router, a tap answers them, and refused buttons go as text`, LONG, async (tc) => {
    const s = await startServices(tc, o);
    for (const p of [OWNER, OPERATOR, CONTRACTOR]) await s.say(p, 'मदद');
    const last = (/** @type {string} */ phone) => s.sent.filter((/** @type {any} */ x) => x.to === phone).at(-1);
    const count = (/** @type {string} */ phone) => s.sent.filter((/** @type {any} */ x) => x.to === phone).length;
    /** A step, then a wait until `phone` has been sent something more (a slow first answer is not a quiet one). @param {string} phone @param {() => Promise<void>} step */
    const replied = async (phone, step) => {
      const before = count(phone);
      await step();
      for (let i = 0; i < 200 && count(phone) === before; i += 1) await new Promise((r) => setTimeout(r, 50));
    };

    // The contractor's own request is read back: two buttons, on the contractor's line.
    await replied(CONTRACTOR, () => s.say(CONTRACTOR, 'kal Shivpuri JCB'));
    assert.equal(last(CONTRACTOR).kind, 'interactive', last(CONTRACTOR).text);
    assert.equal(last(CONTRACTOR).line, 'line-site');
    assert.ok(last(CONTRACTOR).text.endsWith('हाँ / नहीं'));
    await replied(OWNER, () => s.tap(CONTRACTOR, 'हाँ'));
    assert.ok(s.lastTo(OWNER).includes('Shivpuri'), s.lastTo(OWNER));
    assert.equal(last(OWNER).line, o.sharedNumber ? 'line-site' : 'line-jcb');
    await replied(OPERATOR, () => s.say(OWNER, 'हाँ 1200'));

    // An unsure meter reading: one tap records it.
    await replied(OPERATOR, () => s.photo(OPERATOR, 'meter:99894:unsure'));
    assert.equal(last(OPERATOR).kind, 'interactive');
    assert.equal(last(OPERATOR).text, t('meter.unsure_read_back', { reading: '9989.4' }));
    await replied(OPERATOR, () => s.tap(OPERATOR, 'हाँ'));
    assert.equal(s.lastTo(OPERATOR), t('jcb.meter_start_saved', { reading: '9989.4' }));

    // WhatsApp refuses the buttons: the router sends the same question as text, and logs four digits only.
    s.setButtonFails(1);
    await replied(OPERATOR, () => s.photo(OPERATOR, 'meter:99954:unsure'));
    assert.deepEqual([last(OPERATOR).kind, last(OPERATOR).text], ['text', t('meter.unsure_read_back', { reading: '9995.4' })]);
    const routerLog = /** @type {any} */ (s.children.get('router')).output.join('');
    assert.match(routerLog, /buttons to …0102 failed: http 400 code 131009; sent as text/);
    assert.ok(!routerLog.includes(OPERATOR));
    await replied(OPERATOR, () => s.say(OPERATOR, 'हाँ'));
    assert.ok(s.lastTo(OPERATOR).includes('9995.4'), s.lastTo(OPERATOR));
    const jcb = await s.exportOf('jcb');
    const figures = jcb.events.filter((/** @type {any} */ e) => e.direction === 'local' && e.type === 'EVIDENCE').map((/** @type {any} */ e) => e.body.valueTenths);
    assert.deepEqual(figures, [99894, 99954]);
  });
}
