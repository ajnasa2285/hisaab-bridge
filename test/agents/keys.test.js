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
    for (const m of text.matchAll(/'((?:common|jcb|site)\.[a-z_]+)'/g)) used.add(m[1]);
    // Keys built from a fixed set of values.
    for (const m of text.matchAll(/`((?:jcb|site)\.[a-z_]+)\$\{a\.which\}_saved`/g)) ['start', 'end'].forEach((w) => used.add(`${m[1]}${w}_saved`));
    for (const m of text.matchAll(/`((?:jcb|site)\.[a-z_]+)\$\{(?:a|b)\.answer\}`/g)) ['yes', 'no', 'other_time'].forEach((w) => used.add(`${m[1]}${w}`));
  }
  assert.ok(used.size > 30);
  assert.deepEqual([...used].filter((k) => !Object.hasOwn(hi, k)), []);
});
