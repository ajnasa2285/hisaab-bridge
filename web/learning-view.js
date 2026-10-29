// "Learning from corrections" on the judge page: one small card per agent from the export's optional
// `learning` field (the `stats()` of src/learn/corrections.js, shape hb-learn/0.1). Pure functions only
// (no DOM), so they are tested in node (test/web/learning-view.test.js); judge.js turns the rows into
// elements. An export without the field, or with a field of any other shape, shows nothing.

/** @typedef {typeof import('./texts.js').TEXTS['hi']} Texts */
/** @typedef {{recorded: number, readsWithMemory: number, correctedAfterMemory: number, readBackByMemory: number}} Counts */
/** @typedef {{on: boolean, kinds: Partial<Record<Kind, Counts>>}} Learning */

/** The kinds the page knows, in the order it shows them (src/learn/corrections.js KINDS). */
export const KINDS = /** @type {const} */ (['meter', 'challan', 'invoice', 'upi', 'site_challan', 'voice']);
/** @typedef {typeof KINDS[number]} Kind */
const FIELDS = /** @type {const} */ (['recorded', 'readsWithMemory', 'correctedAfterMemory', 'readBackByMemory']);

/** @param {unknown} n */
const count = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
/** @param {unknown} x @returns {x is Record<string, unknown>} */
const plainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * One kind's counts, or null when they are not four non-negative safe integers, or when a part is
 * larger than its whole (a correction after memory is one of the corrections recorded; a read-back
 * is one of the readings with memory).
 * @param {unknown} c @returns {Counts | null}
 */
function counts(c) {
  if (!plainObject(c) || !FIELDS.every((f) => count(c[f]))) return null;
  const k = /** @type {Counts} */ (/** @type {unknown} */ (c));
  if (k.correctedAfterMemory > k.recorded || k.readBackByMemory > k.readsWithMemory) return null;
  return { recorded: k.recorded, readsWithMemory: k.readsWithMemory, correctedAfterMemory: k.correctedAfterMemory, readBackByMemory: k.readBackByMemory };
}

/**
 * The side's `learning` field, checked strictly: `v` is `hb-learn/0.1`, `on` a boolean, `kinds` an
 * object, every known kind's counts and the four totals non-negative safe integers. Unknown kinds are
 * ignored. Anything else, or no field at all, gives null (the page then shows no card).
 * @param {unknown} x @returns {Learning | null}
 */
export function readLearning(x) {
  if (!plainObject(x) || x.v !== 'hb-learn/0.1' || typeof x.on !== 'boolean' || !plainObject(x.kinds)) return null;
  if (!FIELDS.every((f) => count(x[f]))) return null;
  /** @type {Learning['kinds']} */
  const kinds = {};
  for (const kind of KINDS) {
    if (!Object.hasOwn(x.kinds, kind)) continue;
    const c = counts(x.kinds[kind]);
    if (!c) return null;
    kinds[kind] = c;
  }
  return { on: x.on, kinds };
}

/** "25%": `part` per `whole`, rounded half up on integers; '' when the whole is 0.
 * @param {number} part @param {number} whole */
export function percent(part, whole) {
  return whole > 0 ? `${Math.floor((200 * part + whole) / (2 * whole))}%` : '';
}

/**
 * One table row: the kind's label and its four counts as text; "still corrected" carries the rate
 * per reading with memory when there were any.
 * @typedef {{kind: string, label: string, recorded: string, reads: string, again: string, readBack: string}} LearningRow
 */

/** @param {string} kind @param {string} label @param {Counts} c @returns {LearningRow} */
function rowOf(kind, label, c) {
  const rate = percent(c.correctedAfterMemory, c.readsWithMemory);
  return { kind, label, recorded: String(c.recorded), reads: String(c.readsWithMemory),
    again: rate ? `${c.correctedAfterMemory} (${rate})` : String(c.correctedAfterMemory), readBack: String(c.readBackByMemory) };
}

/**
 * The card's content in the page's language: the status line, one row per known kind present (in
 * KINDS order), a total row summed by code over those kinds when there is more than one, and the note.
 * @param {Learning} l @param {Texts} t
 * @returns {{title: string, status: string, on: boolean, head: string[], rows: LearningRow[], total: LearningRow | null, empty: string, note: string, hint: string}}
 */
export function learningCard(l, t) {
  const present = KINDS.filter((k) => l.kinds[k]);
  const rows = present.map((k) => rowOf(k, t.learning_kinds[k], /** @type {Counts} */ (l.kinds[k])));
  /** @type {Counts} */
  const sum = { recorded: 0, readsWithMemory: 0, correctedAfterMemory: 0, readBackByMemory: 0 };
  for (const k of present) for (const f of FIELDS) sum[f] += /** @type {Counts} */ (l.kinds[k])[f];
  const nothing = present.every((k) => FIELDS.every((f) => /** @type {Counts} */ (l.kinds[k])[f] === 0));
  return {
    title: t.learning_title, status: l.on ? t.learning_on : t.learning_off, on: l.on,
    head: [t.learning_kind, t.learning_recorded, t.learning_reads, t.learning_again, t.learning_readback],
    rows: nothing ? [] : rows, total: !nothing && rows.length > 1 ? rowOf('total', t.learning_total, sum) : null,
    empty: nothing ? t.learning_none : '', note: t.learning_note, hint: t.learning_hint,
  };
}
