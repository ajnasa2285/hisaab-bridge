import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hi } from '../../src/i18n/hi.js';
import { t, keys, paramsOf } from '../../src/i18n/index.js';

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN_WORD = /[A-Za-z]+/g;
const ALLOWED_LATIN = new Set(['JCB', 'UPI', 'UTR', 'OK']);
// Keys whose text is legitimately without Devanagari.
const NO_DEVANAGARI_OK = new Set(['account.none', 'kind.jcb', 'bill.line', 'request.list_line', 'account.line', 'account.material', 'explain.wrapper']);
// AGENTS.md rule 9: status only, never a nudge to pay.
const CHASING = ['जल्दी', 'तुरंत', 'याद दिला', 'कब दोगे', 'कब देंगे', 'कब देंगी', 'चुकाएँ', 'चुकाओ', 'भुगतान करें', 'भुगतान कीजिए', 'पैसे दो', 'पैसे दें', 'देर हो', 'बकाया चुका', 'reminder', 'overdue'];

/** A sample value for every parameter, so every key can be filled. @type {Record<string, string|number>} */
const SAMPLE = {
  site: 'शिवपुरी', day: '29 अक्टूबर 2026', hours: '6.1 घंटे', time: '9', items: 'सीमेंट 50 बोरी', what: 'JCB, 6 घंटे',
  to: 'राम JCB', from: 'राम JCB', rate: '₹1,200', otherDay: '30 अक्टूबर 2026', reading: '3677.7', when: '17:05',
  raw: '36?7.7', qty: '6.1 घंटे', amount: '₹7,320', start: '3671.6', end: '3677.7', no: '412', sha: 'ab12…ef90',
  rev: 1, lines: 'JCB: 6.1 घंटे × ₹1,200 = ₹7,320', total: '₹7,320', evidence: 'मीटर 3671.6 से 3677.7 तक = 6.1 घंटे',
  theirFigure: '5.5 घंटे', billFigure: '6.1 घंटे', reason: 'मीटर 3677.1 पर था', old: '₹7,320', sum: '₹7,320',
  explanation: 'बिल 6.1 घंटे का है।', figures: '3671.6, 3677.7, ₹1,200', utr: '123456789012', status: 'सफल',
  seen: '₹7,000', state: 'बिल आया', role: 'ठेकेदार', question: 'बिल ₹7,320 ठीक है?', id: 3, neededOn: '30 अक्टूबर 2026',
  by: 'मोहन', estimate: '₹12,000', materials: 'सीमेंट 50 बोरी', billed: '₹7,320', paid: '—', pending: '₹7,320',
  disputes: 0, name: 'सीमेंट', their: '5.5 घंटे', photos: 2,
};

test('every key has a non-empty Hindi text and fills with its parameters', () => {
  assert.ok(keys().length >= 100, `only ${keys().length} keys`);
  for (const key of keys()) {
    const text = hi[key];
    assert.ok(typeof text === 'string' && text.trim().length > 0, `${key} is empty`);
    if (!NO_DEVANAGARI_OK.has(key)) assert.match(text, DEVANAGARI, `${key} is not Hindi`);
    const params = paramsOf(key);
    for (const p of params) assert.ok(p in SAMPLE, `${key}: no sample value for {${p}}`);
    const filled = t(key, SAMPLE);
    assert.doesNotMatch(filled, /[{}]/, `${key}: placeholder left in "${filled}"`);
    for (const p of params) assert.ok(filled.includes(String(SAMPLE[p])), `${key}: {${p}} not filled`);
  }
});

test('no English words except JCB, UPI, UTR, OK', () => {
  const offenders = [];
  for (const key of keys()) {
    const stripped = hi[key].replace(/\{[a-zA-Z0-9]+\}/g, '');
    for (const word of stripped.match(LATIN_WORD) ?? []) if (!ALLOWED_LATIN.has(word)) offenders.push(`${key}: ${word}`);
  }
  assert.deepEqual(offenders, []);
});

test('no payment reminders or chasing language anywhere', () => {
  const offenders = [];
  for (const key of keys()) for (const phrase of CHASING) if (hi[key].toLowerCase().includes(phrase)) offenders.push(`${key}: ${phrase}`);
  assert.deepEqual(offenders, []);
});

test('the flows the brief names are covered', () => {
  const prefixes = ['booking.', 'meter.', 'bill.', 'explain.', 'payment.', 'settled.', 'refuse.', 'help.', 'request.', 'account.', 'state.'];
  for (const p of prefixes) assert.ok(keys().some((k) => k.startsWith(p)), `no key starts with ${p}`);
  for (const code of ['UNSUPPORTED', 'NOT_CONNECTED', 'BAD_SIGNATURE', 'NOT_FOR_ME', 'EXPIRED', 'WRONG_STATE', 'BAD_BODY']) assert.ok(hi[`refuse.${code}`], code);
  for (const role of ['jcb_owner', 'operator', 'contractor', 'supervisor', 'supplier']) assert.ok(hi[`help.${role}`] && hi[`role.${role}`], role);
  for (const s of ['requested', 'approved', 'declined', 'sent', 'done']) assert.ok(hi[`request.status.${s}`], s);
  for (const s of ['requested', 'offered', 'declined', 'booked', 'working', 'delivered', 'billed', 'disputed', 'accepted', 'payment_claimed', 'settled']) assert.ok(hi[`state.${s}`], s);
  assert.ok(hi['meter.retake'] && hi['payment.retake'], 'retake requests');
});

test('t is strict: unknown key and missing parameter throw', () => {
  assert.throws(() => t('no.such.key'), /unknown key/);
  assert.throws(() => t('booking.booked', { site: 'शिवपुरी', day: '29 अक्टूबर' }), /needs \{what\}/);
  assert.equal(t('request.done', { id: 7 }), 'माँग #7 पूरी हुई।');
  assert.deepEqual(paramsOf('request.decide_prompt'), ['by', 'id', 'what', 'site', 'neededOn', 'estimate']);
});

test('every key the agents use (docs/text-keys.md on main) exists, with its parameters', () => {
  /** @type {Record<string, string[]>} */
  const AGENT_KEYS = {
    'common.unknown_step': [], 'common.not_allowed': [], 'common.bad_args': [], 'common.no_such_order': [], 'common.wrong_state': [],
    'common.pending': [], 'common.refused': [], 'wa.unknown_sender': [],
    'jcb.booking_request': ['site', 'day', 'time', 'hours'], 'jcb.rate_needed': [], 'jcb.day_needed': [],
    'jcb.reply_sent_yes': [], 'jcb.reply_sent_no': [], 'jcb.reply_sent_other_time': [],
    'jcb.job_booked': ['site', 'day', 'time'], 'jcb.meter_start_saved': ['reading'], 'jcb.meter_end_saved': ['reading', 'hours'],
    'jcb.start_first': [], 'jcb.end_not_after_start': ['start'], 'jcb.meter_done': ['hours'], 'jcb.readings_missing': [],
    'jcb.bill_sent': ['hours', 'rate', 'total'], 'jcb.bill_accepted': ['site'], 'jcb.bill_disputed': ['site', 'their', 'reason'],
    'jcb.correction_sent': ['hours', 'total'], 'jcb.payment_claimed': ['site', 'amount', 'utr', 'day'], 'jcb.settled_sent': ['amount'],
    'site.jcb_requested': ['site', 'day', 'time'], 'site.booking_yes': ['site', 'day', 'time', 'rate'],
    'site.booking_no': ['site', 'day', 'time', 'rate'], 'site.booking_other_time': ['site', 'day', 'time', 'rate'],
    'site.bill_received': ['site', 'hours', 'rate', 'total', 'photos'], 'site.correction_received': ['site', 'hours', 'rate', 'total', 'photos'],
    'site.bill_accepted': ['site'], 'site.bill_disputed': ['site'], 'site.reason_needed': [], 'site.figure_needed': [],
    'site.payment_claimed': ['amount'], 'site.settled': ['site', 'amount'],
  };
  for (const [key, params] of Object.entries(AGENT_KEYS)) {
    assert.ok(hi[key], `missing ${key}`);
    // The text may leave a listed parameter out (e.g. a rate on a "no"), but never needs one not listed.
    for (const p of paramsOf(key)) assert.ok(params.includes(p), `${key} uses {${p}}, which the agents do not pass`);
  }
  // Goes to the JCB owner: the contractor *says* they paid; the owner checks. Never "the money arrived".
  const claimed = t('jcb.payment_claimed', SAMPLE);
  assert.match(claimed, /कहना है/);
  assert.match(claimed, /खाता/);
  assert.doesNotMatch(claimed, /आ गया|मिल गया|मिला/);
});
