import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestUsualNotes } from '../../src/agents/usual.js';
import { usualBooks } from './usual-fixture.js';

const peer = 'agent:supplier-1';
const item = (quantity = 5000, rate = 38000) => ({ name: 'सीमेंट', unit: 'बोरी', quantity, rate });

test('combined approval estimate can be unusual while its rate and quantity individually are usual', () => {
  const f = usualBooks();
  try {
    for (let i = 0; i < 3; i++) f.add();
    // +20% quantity and +18% rate are below the individual threshold; together +42% is not.
    const notes = requestUsualNotes(f.ledger, peer, [item(6000, 45000)], 'quantity', undefined, true);
    assert.match(notes, /अनुमान 42% ज़्यादा/);
    assert.match(notes, /₹19,000/);
    assert.doesNotMatch(notes, /पिछले 3 ऑर्डर/);
    // The ordinary supervisor order notice remains above-quantity-only, without an estimate flag.
    assert.equal(requestUsualNotes(f.ledger, peer, [item(6000, 45000)], 'quantity'), '');
  } finally { f.close(); }
});

test('combined lower estimate is shown and exact 25 percent remains usual', () => {
  const f = usualBooks();
  try {
    for (let i = 0; i < 3; i++) f.add();
    assert.match(requestUsualNotes(f.ledger, peer, [item(4000, 32000)], 'quantity', undefined, true), /अनुमान 33% कम/);
    assert.equal(requestUsualNotes(f.ledger, peer, [item(6250, 38000)], 'quantity', undefined, true), '');
  } finally { f.close(); }
});

test('no history, insufficient history and unsafe input never invent an estimated baseline', () => {
  const f = usualBooks();
  try {
    assert.equal(requestUsualNotes(f.ledger, peer, [item(Infinity, NaN)], 'quantity', undefined, true), '');
    f.add(); f.add();
    assert.equal(requestUsualNotes(f.ledger, peer, [item(6000, 45000)], 'quantity', undefined, true), '');
    f.add();
    assert.equal(requestUsualNotes(f.ledger, peer, [item(Infinity, NaN)], 'quantity', undefined, true), '');
    const notes = requestUsualNotes(f.ledger, peer, [item(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)], 'quantity', undefined, true);
    assert.ok(notes, 'individually valid observations can still be compared');
    assert.doesNotMatch(notes, /अनुमान|NaN|Infinity/, 'an unsafe multiplied total is omitted');
    assert.equal(requestUsualNotes(f.ledger, peer, [], 'quantity', undefined, true), '');
  } finally { f.close(); }
});

test('current order exclusion still prevents its accepted estimate from supplying the third sample', () => {
  const f = usualBooks();
  try {
    f.add(); f.add();
    const current = f.add({ quantity: 6000, rate: 45000 });
    assert.equal(requestUsualNotes(f.ledger, peer, [item(6000, 45000)], 'quantity', current.orderId, true), '');
  } finally { f.close(); }
});
