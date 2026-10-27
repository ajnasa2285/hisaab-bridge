// Order references: J-n and P-n per agent, in order of creation, stored beside the ledger and the
// same after a restart. The ledger's own tables and hash chain are untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../../src/ledger/store.js';
import { openRefs, parseRef } from '../../src/ledger/refs.js';

const id = (/** @type {number} */ n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** @param {ReturnType<typeof openLedger>} ledger @param {number} n @param {'jcb_hours' | 'material'} kind */
function order(ledger, n, kind) {
  ledger.ensureOrder({ orderId: id(n), kind, counterparty: 'agent:jcb-1', site: 'Shivpuri', at: `2026-10-29T0${n}:00:00Z` });
}

test('references as people write them become one form', () => {
  const table = [
    ['J-1', 'J-1'], ['j1', 'J-1'], ['J 1', 'J-1'], ['j - 12', 'J-12'], ['P-3', 'P-3'], ['p03', 'P-3'], ['पी-2', 'P-2'], ['जे 4', 'J-4'],
    ['#1', null], ['J-0', null], ['X-1', null], ['J-', null], ['J-1a', null], ['', null], [' P 7 ', 'P-7'],
  ];
  for (const [text, want] of table) assert.equal(parseRef(text), want, String(text));
  assert.equal(parseRef(7), null);
});

test('references are numbered per kind in order of creation, kept across a restart, and leave the chain alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-refs-'));
  const file = join(dir, 'contractor.db');
  try {
    let ledger = openLedger(file);
    order(ledger, 1, 'jcb_hours');
    order(ledger, 2, 'material');
    order(ledger, 3, 'jcb_hours');
    ledger.append({ orderId: id(1), direction: 'local', type: 'NOTE', msgId: null, body: { kind: 'test' }, at: '2026-10-29T01:00:00Z' });
    let refs = openRefs(ledger);
    assert.deepEqual([1, 2, 3].map((n) => refs.refOf(id(n))), ['J-1', 'P-1', 'J-2']);
    // A held step takes the next number before its order exists; the order is tied to it later.
    const held = refs.reserve('J');
    assert.equal(held, 'J-3');
    assert.equal(refs.orderOfRef('j3'), null);
    assert.equal(refs.exists('J 3'), true);
    order(ledger, 4, 'jcb_hours');
    assert.equal(refs.bind('J-3', id(4)), true);
    assert.equal(refs.bind('J-3', id(4)), false, 'tied once');
    assert.equal(refs.orderOfRef('J - 3'), id(4));
    assert.throws(() => ledger.db.exec("UPDATE refs SET n = 9 WHERE ref = 'J-1'"), /never changed/);
    assert.throws(() => ledger.db.exec('DELETE FROM ref_orders'), /never deleted/);
    ledger.close();

    ledger = openLedger(file);
    refs = openRefs(ledger);
    assert.deepEqual([1, 2, 3, 4].map((n) => refs.refOf(id(n))), ['J-1', 'P-1', 'J-2', 'J-3']);
    order(ledger, 5, 'material');
    order(ledger, 6, 'jcb_hours');
    assert.deepEqual([refs.refOf(id(5)), refs.refOf(id(6))], ['P-2', 'J-4']);
    assert.equal(refs.orderOfRef('P-9'), null);
    assert.equal(refs.orderOfRef('nonsense'), null);
    assert.deepEqual(ledger.verifyChain(), { ok: true, events: 1 });
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
