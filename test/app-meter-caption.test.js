// A meter photo through the whole service with two jobs open: the caption WhatsApp carries reaches the
// conversation, and without a caption the question is asked and answered by number. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTOR, OPERATOR, OWNER, startService } from './trace/harness.js';
import { openRefs } from '../src/ledger/refs.js';

test('two jobs booked: a caption says which job; no caption asks, and a number answers', async () => {
  const s = await startService();
  try {
    for (const p of [OWNER, OPERATOR, CONTRACTOR]) await s.say(p, 'मदद');
    for (let i = 0; i < 2; i += 1) {
      s.model.calls = [{ name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }];
      await s.say(CONTRACTOR, 'kal Shivpuri JCB');
      await s.yesIfAsked(CONTRACTOR);
    }
    s.model.calls = [];
    await s.say(OWNER, 'J-1 हाँ 1200');
    await s.say(OWNER, 'J-2 हाँ 1200');
    const { ledger } = s.app.agent('agent:jcb-1').core;
    const refs = openRefs(ledger);
    const meters = (/** @type {string} */ ref) => ledger.events(/** @type {string} */ (refs.orderOfRef(ref))).filter((/** @type {any} */ e) => e.direction === 'local' && e.type === 'EVIDENCE');
    s.model.kind = 'meter';
    s.model.meters = [12345];
    await s.say(OPERATOR, null, undefined, 'J-2 शुरू');
    assert.deepEqual([meters('J-1').length, meters('J-2').length], [0, 1]);
    s.model.meters = [22345];
    await s.say(OPERATOR, null);
    assert.match(s.lastTo(OPERATOR), /1\. J-1: Shivpuri/);
    await s.say(OPERATOR, '1');
    assert.deepEqual([meters('J-1').length, meters('J-2').length], [1, 1]);
  } finally {
    await s.close();
  }
});
