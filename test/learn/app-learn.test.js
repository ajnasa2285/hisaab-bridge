// The app gives each agent its own correction memory, closes it with the app, and puts only its
// counts in that agent's export (the judge page's learning card). Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService, TOKEN } from '../trace/harness.js';

test('each agent has its own memory; its export carries only the counts', async () => {
  const s = await startService();
  try {
    const site = s.app.agent('agent:contractor-1');
    site.learn.record({ kind: 'site_challan', party: 'agent:supplier-1', field: 'qty सीमेंट', read: '40', corrected: '50', layout: 'call 919000000031' });
    /** @param {string} name */
    const exported = async (name) => (await fetch(`${s.base}/agents/${name}/export`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const mine = await exported('site');
    assert.equal(mine.learning.v, 'hb-learn/0.1');
    assert.deepEqual(mine.learning.kinds.site_challan, { recorded: 1, readsWithMemory: 0, correctedAfterMemory: 0, readBackByMemory: 0 });
    assert.ok(!JSON.stringify(mine.learning).includes('सीमेंट') && !JSON.stringify(mine.learning).includes('9190'), 'counts only');
    assert.equal((await exported('supplier')).learning.recorded, 0, 'never shared with another agent');
    assert.equal((await exported('jcb')).learning.recorded, 0);
  } finally {
    await s.close();
  }
});
