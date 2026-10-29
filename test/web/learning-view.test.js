// The judge page's "learning from corrections" card: the export's optional `learning` field is
// checked strictly (anything else shows no card), unknown kinds are ignored, the rows, rate and total
// are made by code in both languages, and the committed sample carries a valid field for each agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEXTS } from '../../web/texts.js';
import { KINDS, learningCard, percent, readLearning } from '../../web/learning-view.js';

const en = TEXTS.en;
/** @param {number} recorded @param {number} readsWithMemory @param {number} correctedAfterMemory @param {number} readBackByMemory */
const c = (recorded, readsWithMemory, correctedAfterMemory, readBackByMemory) => ({ recorded, readsWithMemory, correctedAfterMemory, readBackByMemory });
/** @param {Record<string, any>} kinds @param {boolean} [on] */
const stats = (kinds, on = true) => {
  /** @param {string} f */
  const sum = (f) => Object.values(kinds).reduce((n, k) => n + (Number.isSafeInteger(k?.[f]) ? k[f] : 0), 0);
  return { v: 'hb-learn/0.1', on, kinds, recorded: sum('recorded'), readsWithMemory: sum('readsWithMemory'), correctedAfterMemory: sum('correctedAfterMemory'), readBackByMemory: sum('readBackByMemory') };
};

test('a well-formed field is read; unknown kinds are ignored', () => {
  const l = readLearning(stats({ challan: c(4, 6, 1, 1), voice: c(2, 2, 0, 0), scribble: c(9, 9, 9, 9) }));
  assert.deepEqual(l, { on: true, kinds: { challan: c(4, 6, 1, 1), voice: c(2, 2, 0, 0) } });
  // An unknown kind of any shape does not matter.
  assert.ok(readLearning(stats({ meter: c(1, 0, 0, 0), later: 'x' })));
  assert.deepEqual(readLearning(stats({}, false)), { on: false, kinds: {} });
});

test('no field, or any other shape, shows nothing', () => {
  const good = stats({ meter: c(5, 8, 1, 2) });
  for (const bad of [
    undefined, null, 'hb-learn/0.1', [], 7,
    { ...good, v: 'hb-learn/0.2' }, { ...good, v: undefined },
    { ...good, on: 'yes' }, { ...good, on: undefined },
    { ...good, kinds: [] }, { ...good, kinds: null },
    { ...good, recorded: -1 }, { ...good, readsWithMemory: 1.5 }, { ...good, correctedAfterMemory: '1' }, { ...good, readBackByMemory: undefined },
    { ...good, recorded: Number.MAX_SAFE_INTEGER + 1 },
    stats({ meter: c(5, 8, -1, 2) }), stats({ meter: c(5, 8, 1, 2.5) }), stats({ meter: { recorded: 5, readsWithMemory: 8, correctedAfterMemory: 1 } }),
    stats({ meter: null }), stats({ meter: [5, 8, 1, 2] }), stats({ meter: c(5, 8, 1, NaN) }),
    // A part larger than its whole: corrections after memory are among those recorded, read-backs among readings with memory.
    stats({ meter: c(1, 8, 2, 0) }), stats({ upi: c(1, 1, 0, 2) }),
  ]) assert.equal(readLearning(bad), null, JSON.stringify(bad));
});

test('the card: memory on, a row per kind in a fixed order, the rate when there were readings with memory, a total by code', () => {
  const l = /** @type {NonNullable<ReturnType<typeof readLearning>>} */ (readLearning(stats({ voice: c(2, 2, 0, 0), challan: c(4, 6, 1, 1), upi: c(1, 0, 0, 0) })));
  const card = learningCard(l, en);
  assert.deepEqual([card.title, card.status, card.on, card.empty], ['Learning from corrections', 'Memory use: on', true, '']);
  assert.deepEqual(card.head, ['Kind', 'Corrections recorded', 'Readings with memory', 'Still corrected', 'Read back (memory changed a figure)']);
  assert.deepEqual(card.rows.map((r) => r.kind), ['challan', 'upi', 'voice']);
  assert.deepEqual(card.rows[0], { kind: 'challan', label: 'challan', recorded: '4', reads: '6', again: '1 (17%)', readBack: '1' });
  assert.equal(card.rows[1].again, '0', 'no rate without readings with memory');
  assert.equal(card.rows[2].again, '0 (0%)');
  assert.deepEqual(card.total, { kind: 'total', label: 'Total', recorded: '7', reads: '8', again: '1 (13%)', readBack: '1' });
  assert.equal(card.note, 'Memory only steers the reading; code checks every figure; a person decides.');
});

test('one kind needs no total; memory off says so; nothing recorded yet says so', () => {
  const one = learningCard(/** @type {any} */ (readLearning(stats({ meter: c(5, 8, 1, 2) }))), en);
  assert.equal(one.total, null);
  assert.equal(one.rows[0].again, '1 (13%)');
  const off = learningCard(/** @type {any} */ (readLearning(stats({ meter: c(3, 0, 0, 0) }, false))), TEXTS.hi);
  assert.deepEqual([off.on, off.status, off.rows[0].label], [false, 'याद का इस्तेमाल: बंद (सुधार फिर भी दर्ज होते हैं)', 'मीटर']);
  for (const empty of [stats({}), stats({ meter: c(0, 0, 0, 0), voice: c(0, 0, 0, 0) })]) {
    const card = learningCard(/** @type {any} */ (readLearning(empty)), en);
    assert.deepEqual([card.rows, card.total, card.empty], [[], null, 'No corrections recorded yet.']);
  }
});

test('the rate is rounded half up on integers', () => {
  assert.deepEqual([percent(1, 8), percent(1, 6), percent(1, 3), percent(2, 3), percent(0, 4), percent(4, 4), percent(3, 2), percent(1, 0)],
    ['13%', '17%', '33%', '67%', '0%', '100%', '150%', '']);
});

test('every kind and every text has a label in both languages', () => {
  for (const t of [TEXTS.hi, TEXTS.en]) {
    for (const kind of KINDS) assert.equal(typeof t.learning_kinds[kind], 'string', kind);
    for (const key of ['learning_title', 'learning_on', 'learning_off', 'learning_none', 'learning_kind', 'learning_recorded', 'learning_reads', 'learning_again', 'learning_readback', 'learning_total', 'learning_hint', 'learning_note']) {
      assert.ok(/** @type {any} */ (t)[key], key);
    }
  }
});

test('the judge page builds the card with elements and text only, never markup from data', () => {
  const src = readFileSync(new URL('../../web/judge.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/learning-view\.js'/);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const view = readFileSync(new URL('../../web/learning-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /document|innerHTML|\bstyle\b/);
});

test('the committed sample carries a valid learning field for each agent, totals equal to the kinds', () => {
  const x = JSON.parse(readFileSync(new URL('../../web/sample/export.json', import.meta.url), 'utf8'));
  for (const name of ['jcb', 'contractor', 'supplier']) {
    const raw = x[name].learning;
    const l = readLearning(raw);
    assert.ok(l, name);
    assert.ok(Object.keys(l.kinds).length > 0, name);
    for (const f of /** @type {const} */ (['recorded', 'readsWithMemory', 'correctedAfterMemory', 'readBackByMemory'])) {
      assert.equal(raw[f], Object.values(l.kinds).reduce((n, k) => n + k[f], 0), `${name} ${f}`);
    }
  }
});
