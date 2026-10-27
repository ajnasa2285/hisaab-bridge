// Every text key the agents use exists in the Hindi table, so no person ever sees a raw key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { hi } from '../../src/i18n/hi.js';

const dir = new URL('../../src/agents/', import.meta.url);

test('every key used in src/agents exists in hi.js', () => {
  const used = new Set();
  for (const f of readdirSync(dir)) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    // ('site.material_' alone is the prefix keyFor puts on a key, not a key.)
    for (const m of text.matchAll(/'((?:common|jcb|site|supplier|challan|step)\.[a-z_]+)'/g)) if (!m[1].endsWith('_')) used.add(m[1]);
    // Keys built from a fixed set of values.
    for (const m of text.matchAll(/`((?:jcb|site)\.[a-z_]+)\$\{a\.which\}_saved`/g)) ['start', 'end'].forEach((w) => used.add(`${m[1]}${w}_saved`));
    for (const m of text.matchAll(/`((?:jcb|site|supplier|step)\.[a-z_]+)\$\{(?:a|b)\.answer\}`/g)) ['yes', 'no', 'other_time'].forEach((w) => used.add(`${m[1]}${w}`));
    // A contractor key chosen by keyFor has a material twin as well.
    for (const m of text.matchAll(/keyFor\([^,]+, ['`]site\.([a-z_]+)(\$\{b\.answer\})?/g)) {
      for (const w of m[2] ? ['yes', 'no', 'other_time'] : ['']) used.add(`site.material_${m[1]}${w}`);
    }
  }
  assert.ok(used.has('site.material_bill_accepted') && used.has('site.material_booking_other_time') && used.has('supplier.reply_sent_other_time'));
  assert.ok(used.size > 30);
  assert.deepEqual([...used].filter((k) => !Object.hasOwn(hi, k)), []);
});
