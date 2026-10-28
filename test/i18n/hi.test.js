import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hi } from '../../src/i18n/hi.js';
import { t, keys, paramsOf } from '../../src/i18n/index.js';

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN_WORD = /[A-Za-z]+/g;
const ALLOWED_LATIN = new Set(['JCB', 'UPI', 'UTR', 'OK']);
// Keys whose text is legitimately without Devanagari.
const NO_DEVANAGARI_OK = new Set(['account.none', 'kind.jcb', 'bill.line', 'request.list_line', 'account.line', 'account.material', 'explain.wrapper', 'office.stock_line', 'office.pending_order']);
// Order references as written in examples ("J-1", "P-2") are Latin by design (docs/BUILD2.md section 4).
const REF_EXAMPLE = /\b[JP]-\d+\b/g;
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
  rates: 'सीमेंट ₹350/बोरी', count: 'सीमेंट 48 बोरी', expected: 'सीमेंट 50 बोरी × ₹350 = ₹17,500',
  expectedTotal: '₹17,500', siteTotal: '₹16,800', item: 'सरिया (टन)',
  ref: 'J-1', step: 'शिवपुरी पर 29 अक्टूबर 2026 को 8 बजे से 6 घंटे के लिए JCB माँगें?', note: 'ठीक है', decision: 'मंज़ूर',
  awaited: 'बिल का इंतज़ार', bill: '₹7,320', challan: '50 बोरी',
  names: 'बालू (cft), गिट्टी (brass)', siteNo: '96', challanNo: '97', unit: 'बोरी', questions: 'किस साइट पर?',
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
    const stripped = hi[key].replace(/\{[a-zA-Z0-9]+\}/g, '').replace(REF_EXAMPLE, '');
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
    'ask.missing': ['questions'], 'ask.site': [], 'ask.day': [], 'ask.qty': ['name', 'unit'], 'ask.qty_unit': ['name'], 'ask.unit': ['name', 'qty'],
    'jcb.booking_request': ['ref', 'site', 'day', 'time', 'hours'], 'jcb.rate_needed': [], 'jcb.day_needed': [],
    'jcb.reply_sent_yes': [], 'jcb.reply_sent_no': [], 'jcb.reply_sent_other_time': [],
    'jcb.job_booked': ['ref', 'site', 'day', 'time'], 'jcb.meter_start_saved': ['reading'], 'jcb.meter_end_saved': ['reading', 'hours'],
    'jcb.start_first': [], 'jcb.end_not_after_start': ['start'], 'jcb.meter_done': ['hours'], 'jcb.readings_missing': [],
    'jcb.bill_sent': ['hours', 'rate', 'total'], 'jcb.bill_accepted': ['ref', 'site'], 'jcb.bill_disputed': ['ref', 'site', 'their', 'reason'],
    'jcb.correction_sent': ['hours', 'total'], 'jcb.payment_claimed': ['ref', 'site', 'amount', 'utr', 'day'], 'jcb.settled_sent': ['amount'],
    'site.jcb_requested': ['ref', 'site', 'day', 'time'], 'site.booking_yes': ['ref', 'site', 'day', 'time', 'rate'],
    'site.booking_no': ['ref', 'site', 'day', 'time', 'rate'], 'site.booking_other_time': ['ref', 'site', 'day', 'time', 'rate'],
    'site.bill_received': ['ref', 'site', 'hours', 'rate', 'total', 'photos'], 'site.correction_received': ['ref', 'site', 'hours', 'rate', 'total', 'photos'],
    'site.bill_accepted': ['ref', 'site'], 'site.bill_disputed': ['ref', 'site'], 'site.reason_needed': [], 'site.figure_needed': [],
    'site.payment_claimed': ['amount'], 'site.settled': ['ref', 'site', 'amount'],
    'step.reply_booking_yes': ['site', 'day', 'time', 'rate'], 'step.reply_booking_no': ['site', 'day', 'time', 'rate'],
    'step.reply_booking_other_time': ['site', 'day', 'time', 'rate'], 'step.record_meter_start': ['reading'], 'step.record_meter_end': ['reading'],
    'step.send_bill': ['site', 'hours', 'rate', 'total'], 'step.send_correction': ['site', 'hours', 'total'], 'step.confirm_payment': ['site', 'amount'],
    'step.request_jcb': ['site', 'day', 'time', 'hours'], 'step.accept_bill': ['site', 'total'], 'step.dispute_bill': ['site', 'their', 'reason'],
    'step.claim_payment': ['site', 'amount', 'utr'], 'step.cancelled': [],
    'orchestrator.try_again': [], 'orchestrator.which_job': [], 'orchestrator.no_job_for_photo': [],
    // Material: contractor side, supplier side, challan photo, read-backs.
    'site.no_supplier': [], 'site.material_requested': ['ref', 'site', 'day', 'items'],
    'site.material_booking_yes': ['ref', 'site', 'day', 'time', 'rates'], 'site.material_booking_no': ['ref', 'site', 'day', 'time', 'rates'],
    'site.material_booking_other_time': ['ref', 'site', 'day', 'time', 'rates'], 'site.delivery_received': ['ref', 'site', 'items', 'challan'],
    'site.count_figures': ['items'], 'site.count_matches': ['ref', 'site', 'items'], 'site.count_saved_differs': ['ref', 'site', 'challan', 'count'],
    'site.count_differs': ['ref', 'site', 'challan', 'count'], 'site.count_already': ['ref', 'count'],
    'site.count_changed': ['ref', 'site', 'old', 'count', 'challan'], 'site.material_bill_received': ['ref', 'site', 'lines', 'total', 'photos'],
    'site.material_correction_received': ['ref', 'site', 'lines', 'total', 'photos'],
    'site.material_bill_mismatch': ['ref', 'site', 'lines', 'total', 'expected', 'expectedTotal'],
    'site.material_bill_count_differs': ['ref', 'site', 'lines', 'total', 'count', 'siteTotal'], 'site.material_bill_accepted': ['ref', 'site'],
    'site.material_bill_disputed': ['ref', 'site'], 'site.material_figure_needed': [], 'site.material_total_only': [], 'site.material_payment_claimed': ['amount'],
    'site.material_settled': ['ref', 'site', 'amount'],
    'supplier.order_request': ['ref', 'site', 'day', 'time', 'items'], 'supplier.rates_needed': ['items'], 'supplier.reply_sent_yes': [],
    'supplier.reply_sent_no': [], 'supplier.reply_sent_other_time': [], 'supplier.item_not_agreed': ['item'],
    'supplier.delivery_sent': ['ref', 'site', 'items'], 'supplier.delivery_missing': [], 'supplier.bill_sent': ['lines', 'total'],
    'supplier.bill_accepted': ['ref', 'site'], 'supplier.bill_disputed': ['ref', 'site', 'their', 'reason'], 'supplier.correction_sent': ['lines', 'total'],
    'supplier.payment_claimed': ['ref', 'site', 'amount', 'utr', 'day'], 'supplier.settled_sent': ['amount'],
    'challan.not_challan': [], 'challan.ask_person': ['raw', 'items'], 'challan.no_order_for_photo': [],
    'step.reply_order_yes': ['site', 'day', 'time', 'rates'], 'step.reply_order_no': ['site', 'day', 'time', 'rates'],
    'step.reply_order_other_time': ['site', 'day', 'time', 'rates'], 'step.record_delivery': ['site', 'items', 'challan'],
    'step.send_material_bill': ['site', 'lines', 'total'], 'step.send_material_correction': ['site', 'lines', 'total'],
    'step.request_material': ['site', 'day', 'time', 'items'], 'step.confirm_count': ['site', 'items'],
    'office.held': ['ref'], 'office.approval_needed': ['ref', 'by', 'estimate', 'step'], 'office.approved': ['ref', 'by'],
    'office.approved_note': ['ref', 'by', 'note'], 'office.declined': ['ref', 'by', 'reason'], 'office.you_declined': ['ref'],
    'office.already_decided': ['ref', 'decision', 'by'], 'office.decision.ok': [], 'office.decision.no': [],
    'office.only_contractor': [], 'office.own_entry': [], 'office.no_such_ref': ['ref'], 'office.reason_needed': ['ref'],
    'office.status': ['ref', 'what', 'site', 'day', 'state', 'rate', 'bill', 'paid', 'awaited'],
    'office.status_held': ['ref', 'step', 'estimate', 'decision'], 'office.held_waiting': [], 'office.held_ok': ['by'], 'office.held_no': ['by', 'reason'],
    'office.what_jcb': ['hours'], 'office.what_material': ['items'], 'office.pending': ['lines'], 'office.pending_held': ['ref', 'step', 'by'],
    'office.pending_order': ['ref', 'what', 'site', 'awaited'], 'office.pending_none': [], 'office.stock': ['lines'], 'office.stock_site': ['site'],
    'office.stock_line': ['name', 'qty'], 'office.stock_line_differs': ['name', 'qty', 'challan'], 'office.stock_none': [], 'office.stock_not_here': [],
    ...Object.fromEntries(['buyer', 'seller'].flatMap((side) => ['requested', 'offered', 'declined', 'booked', 'working', 'delivered', 'billed', 'disputed', 'accepted', 'payment_claimed', 'settled']
      .map((s) => [`office.await.${side}.${s}`, []]))),
  };
  for (const [key, params] of Object.entries(AGENT_KEYS)) {
    assert.ok(hi[key], `missing ${key}`);
    // The text may leave a listed parameter out (e.g. a rate on a "no"), but never needs one not listed.
    for (const p of paramsOf(key)) assert.ok(params.includes(p), `${key} uses {${p}}, which the agents do not pass`);
  }
  // A read-back ends with the two answers it accepts.
  for (const key of Object.keys(AGENT_KEYS)) if (key.startsWith('step.') && key !== 'step.cancelled') assert.ok(hi[key].endsWith('हाँ / नहीं'), `${key} must end with हाँ / नहीं`);
  // Goes to the JCB owner: the contractor *says* they paid; the owner checks. Never "the money arrived".
  const claimed = t('jcb.payment_claimed', SAMPLE);
  assert.match(claimed, /कहना है/);
  assert.match(claimed, /खाता/);
  assert.doesNotMatch(claimed, /आ गया|मिल गया|मिला/);
  // The same for the supplier.
  const toSupplier = t('supplier.payment_claimed', SAMPLE);
  assert.match(toSupplier, /कहना है/);
  assert.match(toSupplier, /खाता/);
  assert.doesNotMatch(toSupplier, /आ गया|मिल गया|मिला/);
});
