import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hi } from '../../src/i18n/hi.js';
import { t, keys, paramsOf } from '../../src/i18n/index.js';

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN_WORD = /[A-Za-z]+/g;
const ALLOWED_LATIN = new Set(['JCB', 'UPI', 'UTR', 'OK', 'GST']);
// Keys whose text is legitimately without Devanagari.
const NO_DEVANAGARI_OK = new Set(['account.none', 'kind.jcb', 'bill.line', 'request.list_line', 'account.line', 'account.material', 'explain.wrapper', 'office.stock_line', 'office.pending_order', 'office.pending_order_plain', 'records.fig.order_plain', 'bill.line_gst', 'bill.rate_gst']);
// Order references as written in examples ("J-1", "P-2") are Latin by design (docs/BUILD2.md section 4).
const REF_EXAMPLE = /\b[JP]-\d+\b/g;
// AGENTS.md rule 9: status only, never a nudge to pay.
const CHASING = ['जल्दी', 'तुरंत', 'याद दिला', 'कब दोगे', 'कब देंगे', 'कब देंगी', 'चुकाएँ', 'चुकाओ', 'भुगतान करें', 'भुगतान कीजिए', 'पैसे दो', 'पैसे दें', 'देर हो', 'बकाया चुका', 'reminder', 'overdue'];

/** A sample value for every parameter, so every key can be filled. @type {Record<string, string|number>} */
const SAMPLE = { word: 'नमूना-word', words: 'नमूना-words',
  material: 'शिवपुरी पर सीमेंट 50 बोरी', jcb: 'शिवपुरी पर JCB, 2 घंटे', first: 'P-1 भेजी', second: 'J-1 भेजी', why: 'जवाब नहीं आया', new: 3,
  message: 'बिल मिला।', pct: 30, n: 5, metric: 'दर', value: '₹380/बोरी', min: '₹350/बोरी', max: '₹400/बोरी',
  who: 'सप्लायर', recordKind: 'चालान',
  details: 'नकद, अग्रिम', due: '₹3,000', credit: '₹200', waiting: '₹1,000', denied: '₹500',
  group: 'एक साथ P-1, P-2', shares: 'P-1 का हिस्सा ₹3,000', payments: 'पक्का भुगतान ₹4,000',
  balance: 'बिल ₹7,000 · पक्का भुगतान ₹4,000 · देना बाक़ी ₹3,000',
  site: 'शिवपुरी', day: '29 अक्टूबर 2026', hours: '6.1 घंटे', time: '9', items: 'सीमेंट 50 बोरी', what: 'JCB, 6 घंटे',
  to: 'राम JCB', from: 'राम JCB', rate: '₹1,200', otherDay: '30 अक्टूबर 2026', reading: '3677.7', when: '17:05',
  raw: '36?7.7', qty: '6.1 घंटे', amount: '₹7,320', start: '3671.6', end: '3677.7', no: '412', sha: 'ab12…ef90',
  rev: 1, lines: 'JCB: 6.1 घंटे × ₹1,200 = ₹7,320', total: '₹7,320', evidence: 'मीटर 3671.6 से 3677.7 तक = 6.1 घंटे',
  theirFigure: '5.5 घंटे', billFigure: '6.1 घंटे', reason: 'मीटर 3677.1 पर था', old: '₹7,320', sum: '₹7,320',
  explanation: 'बिल 6.1 घंटे का है।', figures: '3671.6, 3677.7, ₹1,200', utr: '123456789012', status: 'सफल',
  seen: '₹7,000', state: 'बिल आया', role: 'ठेकेदार', question: 'बिल ₹7,320 ठीक है?', id: 3, neededOn: '30 अक्टूबर 2026',
  by: 'मोहन', estimate: '₹12,000', materials: 'सीमेंट 50 बोरी', billed: '₹7,320', paid: '—', pending: '₹7,320',
  disputes: 0, name: 'सीमेंट', their: '5.5 घंटे', photos: 2, percent: 28, gst: '₹5,320', invoiceTotal: '₹24,320', example: '48 बोरी', taxable: '₹19,000',
  rates: 'सीमेंट ₹350/बोरी', count: 'सीमेंट 48 बोरी', expected: 'सीमेंट 50 बोरी × ₹350 = ₹17,500',
  expectedTotal: '₹17,500', agreedRate: '₹1,250', siteTotal: '₹16,800', item: 'सरिया (टन)',
  ref: 'J-1', step: 'शिवपुरी पर 29 अक्टूबर 2026 को 8 बजे से 6 घंटे के लिए JCB माँगें?', note: 'ठीक है', decision: 'मंज़ूर',
  awaited: 'बिल का इंतज़ार', bill: '₹7,320', challan: '50 बोरी',
  names: 'बालू (cft), गिट्टी (brass)', siteNo: '96', challanNo: '97', questions: 'किस साइट पर?', forms: '"UPI" / "चालान"', kinds: 'UPI भुगतान, चालान',
  signed: 'दस्तख़त हैं', receipt: 'साइट की प्रति: चालान 96 पर सीमेंट 48 बोरी', payment: '₹35,000, 23 अक्टूबर 2026, 14:05 बजे, UTR 123456789012',
  quantity: '50', unit: 'बोरी', number: '412', figure: '48 बोरी', before: '₹17,500', after: '₹16,800',
  answer: 'शिवपुरी पर सीमेंट 50 बोरी आया।', refs: 'P-1, P-2', orders: 2, asked: '50 बोरी', delivered: '50 बोरी',
  counted: '48 बोरी', open: '₹7,320', accepted: '₹7,320', claimed: '₹7,320', settled: '₹0', confirmed: 'अभी नहीं',
  now: '₹10,000, 30 अक्टूबर 2026, UTR 412300000009', typed: '₹5,000',
  kind: 'चालान', reads: 4, again: 1, yes: 'हाँ',
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
  for (const s of ['requested', 'offered', 'declined', 'booked', 'working', 'delivered', 'billed', 'disputed', 'accepted', 'payment_claimed', 'settled', 'cancelled']) assert.ok(hi[`state.${s}`], s);
  assert.ok(hi['meter.retake'] && hi['payment.retake'], 'retake requests');
});

test('explanation figures have exactly the parameters their code supplies', () => {
  const expected = {
    'explain.unit.hours': [], 'explain.time.ist': [],
    'explain.figures.order': ['ref', 'site'],
    'explain.figures.line': ['item', 'quantity', 'unit', 'rate', 'amount'],
    'explain.figures.bill': ['lines', 'total'],
    'explain.figures.meter': ['start', 'end', 'hours'],
    'explain.figures.photoTimes': ['start', 'end'],
    'explain.figures.delivery': ['number', 'items'],
    'explain.figures.deliveryAmount': ['total'],
    'explain.figures.sitePhoto': ['number', 'items', 'total'],
    'explain.figures.siteCount': ['items', 'total'],
    'explain.figures.dispute': ['figure'], 'explain.figures.previousDispute': ['figure'],
    'explain.figures.correction': ['before', 'after'],
    'explain.wrapper': ['explanation', 'figures'], 'explain.unavailable': ['figures'],
  };
  for (const [key, params] of Object.entries(expected)) assert.deepEqual(paramsOf(key), params, key);
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
    'supplier.site_receipt_matches': ['ref', 'challanNo', 'count', 'signed'], 'supplier.site_receipt_differs': ['ref', 'challanNo', 'count', 'challan', 'signed'],
    'supplier.site_receipt_number_differs': ['ref', 'siteNo', 'challanNo', 'count', 'challan', 'signed'],
    'supplier.site_receipt_number_unknown': ['ref', 'count', 'challanNo', 'challan', 'siteNo', 'signed'],
    'supplier.site_receipt_other_delivery': ['ref', 'siteNo', 'count', 'challanNo', 'challan', 'signed'],
    'supplier.site_receipt_signed_yes': [], 'supplier.site_receipt_signed_no': [], 'supplier.site_receipt_signed_unsure': [],
    'office.status_with_receipt': ['ref', 'what', 'site', 'day', 'state', 'rate', 'payments', 'receipt', 'awaited'],
    'office.site_receipt': ['challanNo', 'count', 'signed'], 'office.signed_yes': [], 'office.signed_no': [], 'office.signed_unsure': [],
    'common.try_again': [], 'common.media_too_large': [], 'common.undelivered': ['ref', 'site'], 'common.delivery_unsure': ['ref', 'site'], 'common.question_waits': [], 'common.records_disagree': [],
    'site.bill_copy': ['ref', 'site', 'what'], 'site.bill_contractor_accepts': [], 'pay.payee': ['name'], 'jcb.meter_which_stale': [], 'learn.voice_replaced': ['words'], 'learn.forgot_word': ['word', 'n'], 'site.bill_changed': ['ref', 'site', 'bill'], 'site.bill_changed_check': ['ref', 'site', 'bill'], 'site.bill_is_material': ['lines', 'total'], 'site.bill_is_jcb': ['hours', 'rate', 'total'],
    'pay.seller.utr_seen': ['utr', 'before'], 'pay.seller.claim_waiting': ['ref', 'payment'], 'payment.forwarded': [],
    'pay.seller.same_recorded': ['ref', 'amount', 'before'], 'pay.seller.claim_same_confirmed': ['ref', 'amount', 'before'], 'step.deny_payment': ['site', 'amount'],
    'payment.at_time': ['time'],'jcb.payment_claimed_at': ['ref', 'site', 'amount', 'day', 'time', 'utr'],
    'supplier.payment_claimed_at': ['ref', 'site', 'amount', 'day', 'time', 'utr'],
    // Payments: part, cash, advance, clubbed (claude/payments, CONTRACTS 4.1).
    'payment.cash': [], 'pay.to.jcb': [], 'pay.to.supplier': [], 'pay.nothing': [], 'pay.nothing_waiting': [], 'pay.one_seller': [],
    'pay.balance.due': ['due'], 'pay.balance.due_waiting': ['due', 'waiting'], 'pay.balance.credit': ['credit'], 'pay.balance.credit_waiting': ['credit', 'waiting'],
    'pay.balance.clear': [], 'pay.balance.clear_waiting': ['waiting'], 'pay.balance.settled': [], 'pay.balance.no_bill': [],
    'pay.balance.no_bill_confirmed': ['confirmed'], 'pay.balance.no_bill_waiting': ['waiting'], 'pay.balance.no_bill_confirmed_waiting': ['confirmed', 'waiting'],
    'pay.line': ['ref', 'amount', 'balance'], 'pay.share': ['ref', 'amount'], 'pay.share_advance': ['ref', 'amount'],
    'pay.utr_used': ['utr', 'before', 'now'], 'pay.await_shot': ['what'], 'pay.shot_differs': ['seen', 'typed'], 'pay.which_order': ['payment', 'lines'],
    'pay.split_choose': ['amount', 'to', 'lines', 'ref'], 'step.claim_payment_cash': ['site', 'amount'],
    'step.claim_group': ['amount', 'to', 'lines'], 'step.claim_group_cash': ['amount', 'to', 'lines'],
    'step.record_received': ['ref', 'site', 'amount'], 'step.record_received_upi': ['ref', 'site', 'amount'],
    'pay.site.claimed': ['ref', 'to', 'payment', 'balance'], 'pay.site.claimed_advance': ['ref', 'to', 'payment', 'balance'],
    'pay.site.group_claimed': ['to', 'payment', 'lines'], 'pay.site.acked': ['ref', 'from', 'payment', 'balance'], 'pay.site.denied': ['ref', 'from', 'payment', 'balance'],
    'pay.site.group_acked': ['from', 'payment', 'lines'], 'pay.site.group_denied': ['from', 'payment', 'lines'], 'pay.site.received': ['ref', 'from', 'payment', 'balance'],
    'site.settled_credit': ['ref', 'amount', 'site', 'credit'], 'site.material_settled_credit': ['ref', 'amount', 'site', 'credit'],
    'pay.seller.claimed': ['ref', 'site', 'payment', 'balance'], 'pay.seller.claimed_advance': ['ref', 'site', 'payment', 'balance'],
    'pay.seller.group_claimed': ['payment', 'lines'], 'pay.seller.confirmed': ['ref', 'amount', 'balance'], 'pay.seller.denied': ['ref', 'amount', 'balance'],
    'pay.seller.group_confirmed': ['amount', 'lines'], 'pay.seller.group_denied': ['amount', 'lines'], 'pay.seller.received': ['ref', 'payment', 'balance'],
    'pay.seller.settled_at_accept': ['ref', 'site', 'amount'], 'pay.seller.settled_at_accept_credit': ['ref', 'site', 'amount', 'credit'],
    'jcb.settled_sent_credit': ['amount', 'credit'], 'supplier.settled_sent_credit': ['amount', 'credit'],
    'state.part_paid': [], 'office.await.buyer.part_paid': [], 'office.await.seller.part_paid': [],
    
    'step.two_requests': ['material', 'jcb'], 'site.two_requests_done': ['first', 'second'], 'site.two_requests_failed': ['what', 'why'], 'ask.jcb_separately': [],
    'site.which_site': ['name', 'lines', 'new'], 'site.forgot_name': ['name'],
    'ask.missing': ['questions'], 'ask.site': [], 'ask.day': [], 'ask.qty': ['name', 'unit'], 'ask.qty_unit': ['name'], 'ask.unit': ['name', 'qty'],
    'jcb.booking_request': ['ref', 'site', 'day', 'time', 'hours'], 'jcb.rate_needed': [], 'jcb.day_needed': [],
    'jcb.reply_sent_yes': ['ref', 'site', 'day', 'rate'], 'jcb.reply_sent_no': ['ref', 'site', 'day'], 'jcb.reply_sent_other_time': ['ref', 'site', 'day'],
    'jcb.job_booked': ['ref', 'site', 'day', 'time'], 'jcb.meter_start_saved': ['reading'], 'jcb.meter_end_saved': ['reading', 'hours'],
    'jcb.start_first': [], 'jcb.end_not_after_start': ['start'], 'jcb.meter_hours_impossible': ['start', 'end', 'hours'], 'jcb.meter_done': ['hours'], 'jcb.readings_missing': [],
    'jcb.bill_sent': ['hours', 'rate', 'total'], 'jcb.bill_accepted': ['ref', 'site'], 'jcb.bill_disputed': ['ref', 'site', 'their', 'reason', 'example'],
    'jcb.correction_sent': ['hours', 'total'], 'jcb.payment_claimed': ['ref', 'site', 'amount', 'utr', 'day'], 'jcb.settled_sent': ['amount'],
    'site.jcb_requested': ['ref', 'site', 'day', 'time'], 'site.booking_yes': ['ref', 'site', 'day', 'time', 'rate'],
    'site.booking_no': ['ref', 'site', 'day', 'time', 'rate'], 'site.booking_other_time': ['ref', 'site', 'day', 'time', 'rate'],
    'site.bill_received': ['yes', 'ref', 'site', 'hours', 'rate', 'total', 'photos', 'example'], 'site.correction_received': ['yes', 'ref', 'site', 'hours', 'rate', 'total', 'photos', 'example'],
    'site.bill_accepted': ['ref', 'site'], 'site.bill_disputed': ['ref', 'site'], 'site.reason_needed': [], 'site.figure_needed': [],
    'site.payment_claimed': ['ref', 'payment'], 'site.settled': ['ref', 'site', 'amount'],
    'step.reply_booking_yes': ['site', 'day', 'time', 'rate'], 'step.reply_booking_no': ['site', 'day', 'time', 'rate'],
    'step.reply_booking_other_time': ['site', 'day', 'time', 'rate'], 'step.record_meter_start': ['reading'], 'step.record_meter_end': ['reading'],
    'step.send_bill': ['site', 'hours', 'rate', 'total'], 'step.send_correction': ['site', 'hours', 'total'], 'step.confirm_payment': ['site', 'amount'],
    'step.request_jcb': ['what'], 'step.accept_bill': ['ref', 'site', 'total'], 'step.dispute_bill': ['ref', 'site', 'their', 'reason'],
    'step.claim_payment': ['site', 'amount', 'utr'], 'step.cancelled': [],
    'orchestrator.try_again': [], 'orchestrator.which_job': [], 'orchestrator.no_job_for_photo': [],
    // Material: contractor side, supplier side, challan photo, read-backs.
    'site.no_supplier': [], 'site.material_requested': ['ref', 'site', 'day', 'items'],
    'site.material_booking_yes': ['ref', 'site', 'day', 'time', 'rates'], 'site.material_booking_no': ['ref', 'site', 'day', 'time', 'rates'],
    'site.material_booking_other_time': ['ref', 'site', 'day', 'time', 'rates'], 'site.delivery_received': ['yes', 'ref', 'site', 'items', 'challan'],
    'site.delivery_info': ['ref', 'site', 'items'], 'site.delivery_info_challan': ['ref', 'site', 'items', 'challan'],
    'site.count_figures': ['items'], 'site.count_matches': ['ref', 'site', 'items'],
    'site.count_told_yes': ['ref', 'site', 'items'], 'site.count_told_typed': ['ref', 'site', 'items'], 'site.count_told_photo': ['ref', 'site', 'items'],
'site.count_saved_differs': ['ref', 'site', 'challan', 'count'],
    'site.count_differs': ['ref', 'site', 'challan', 'count'], 'site.count_already': ['ref', 'count'],
    'site.count_closed': [], 'site.dispute_which_item': ['ref', 'items'], 'site.dispute_same': ['ref', 'total'], 'site.dispute_format': ['example'], 'site.dispute_already': ['ref'], 'answer.unclear': ['ref'], 'step.dispute_bill_items': ['ref', 'site', 'items', 'total', 'reason'], 'site.material_bill_received': ['yes', 'ref', 'site', 'lines', 'total', 'photos', 'example'],
    'site.material_correction_received': ['yes', 'ref', 'site', 'lines', 'total', 'photos', 'example'],
    'site.material_bill_mismatch': ['ref', 'site', 'lines', 'total', 'expected', 'expectedTotal', 'example'],
    'site.bill_mismatch': ['ref', 'site', 'hours', 'rate', 'total', 'agreedRate', 'expectedTotal', 'example'], 'site.bill_changed_check_jcb': ['ref', 'site', 'bill', 'total'],
    'office.approved_later': ['ref', 'by', 'step', 'state'], 'office.approved_later_note': ['ref', 'by', 'step', 'state', 'note'], 'office.held_not_run': [],
    'office.status_plain': ['ref', 'what', 'site', 'day', 'state', 'awaited'], 'office.pending_order_plain': ['ref', 'what', 'site', 'awaited'],
    'records.fig.order_plain': ['ref', 'what', 'site', 'day', 'state'],
    'site.material_bill_no_count': ['ref', 'site', 'lines', 'total', 'example'], 'site.material_bill_no_count_invoice_differs': ['ref', 'site', 'lines', 'total', 'example', 'invoiceTotal'],
    'site.material_bill_count_differs': ['ref', 'site', 'lines', 'total', 'count', 'siteTotal', 'example'], 'site.material_bill_accepted': ['ref', 'site'],
    'site.material_bill_disputed': ['ref', 'site'], 'site.material_figure_needed': [], 'site.material_total_only': [], 'site.material_payment_claimed': ['ref', 'payment'],
    'site.material_settled': ['ref', 'site', 'amount'],
    'supplier.order_request': ['ref', 'site', 'day', 'time', 'items'], 'supplier.rates_needed': ['items'], 'supplier.reply_sent_yes': ['ref', 'site', 'day', 'rates'],
    'supplier.reply_sent_no': ['ref', 'site', 'day'], 'supplier.reply_sent_other_time': ['ref', 'site', 'day'], 'supplier.item_not_agreed': ['item'],
    'supplier.delivery_sent': ['ref', 'site', 'items'], 'supplier.delivery_missing': [], 'supplier.bill_sent': ['lines', 'total'],
    'supplier.bill_sent_invoice_match': ['lines', 'total'], 'supplier.bill_sent_invoice_differs': ['lines', 'total', 'invoiceTotal'],
    'step.send_material_bill_invoice_match': ['site', 'lines', 'total'], 'step.send_material_bill_invoice_differs': ['site', 'lines', 'total', 'invoiceTotal'],
    'site.material_bill_received_invoice_match': ['yes', 'ref', 'site', 'lines', 'total', 'photos', 'example'],
    'site.material_bill_received_invoice_differs': ['yes', 'ref', 'site', 'lines', 'total', 'photos', 'invoiceTotal', 'example'],
    'site.material_correction_received_invoice_match': ['yes', 'ref', 'site', 'lines', 'total', 'example'],
    'site.material_correction_received_invoice_differs': ['yes', 'ref', 'site', 'lines', 'total', 'invoiceTotal', 'example'],
    'bill.line_gst': ['percent', 'gst', 'amount'], 'bill.rate_gst': ['percent'],
    'supplier.bill_accepted': ['ref', 'site'], 'supplier.bill_disputed': ['ref', 'site', 'their', 'reason', 'example'], 'supplier.correction_sent': ['lines', 'total'],
    'supplier.payment_claimed': ['ref', 'site', 'amount', 'utr', 'day'], 'supplier.settled_sent': ['amount'],
    'challan.not_challan': [], 'challan.ask_person': ['raw', 'items'], 'challan.no_order_for_photo': [],
    'photo.ask_kind': ['forms'], 'photo.other': ['kinds'], 'photo.none': [], 'photo.sent_by_meter': ['kinds'],
    'photo.sent_by_upi': ['kinds'], 'photo.sent_by_challan': ['kinds'], 'photo.kind.meter': [], 'photo.kind.upi': [], 'photo.kind.challan': [],
    'step.reply_order_yes': ['site', 'day', 'time', 'rates'], 'step.reply_order_no': ['site', 'day', 'time', 'rates'],
    'step.reply_order_other_time': ['site', 'day', 'time', 'rates'], 'step.record_delivery': ['site', 'items', 'challan'],
    'step.send_material_bill': ['site', 'lines', 'total'], 'step.send_material_correction': ['site', 'lines', 'total'],
    'step.request_material': ['what'], 'step.confirm_count': ['site', 'items'],
    'office.held': ['ref'], 'office.held_step': ['ref', 'what'], 'office.approval_needed': ['ref', 'by', 'estimate', 'step'], 'office.approved': ['ref', 'by'],
    'office.approved_note': ['ref', 'by', 'note'], 'office.declined': ['ref', 'by', 'reason'], 'office.you_declined': ['ref'],
    'office.already_decided': ['ref', 'decision', 'by'], 'office.decision.ok': [], 'office.decision.no': [],
    'office.only_contractor': [], 'office.own_entry': [], 'office.no_such_ref': ['ref'], 'office.reason_needed': ['ref'],
    'office.status': ['ref', 'what', 'site', 'day', 'state', 'rate', 'payments', 'awaited'],
    'office.status_held': ['ref', 'step', 'estimate', 'decision'], 'office.held_waiting': [], 'office.held_ok': ['by'], 'office.held_no': ['by', 'reason'],
    'office.what_jcb': ['hours'], 'office.what_material': ['items'], 'office.pending': ['lines'], 'office.pending_held': ['ref', 'step', 'by'],
    'office.pending_order': ['ref', 'what', 'site', 'awaited', 'balance'], 'office.pending_none': [], 'office.stock': ['lines'], 'office.stock_site': ['site'],
    'office.stock_line': ['name', 'qty'], 'office.stock_line_differs': ['name', 'qty', 'challan'], 'office.stock_none': [], 'office.stock_not_here': [],
    // Variants without "—": a time, hours, an estimate or a challan number not given is left out (docs/BUILD2.md "Fewer steps").
    'jcb.booking_request_time': ['ref', 'site', 'day', 'time'], 'jcb.booking_request_hours': ['ref', 'site', 'day', 'hours'],
    'jcb.booking_request_time_hours': ['ref', 'site', 'day', 'time', 'hours'], 'jcb.job_booked_time': ['ref', 'site', 'day', 'time'],
    'site.jcb_requested_time': ['ref', 'site', 'day', 'time'], 'site.booking_yes_time': ['ref', 'site', 'day', 'time', 'rate'],
    'site.booking_other_time_time': ['ref', 'site', 'day', 'time'], 'site.material_booking_yes_time': ['ref', 'site', 'day', 'time', 'rates'],
    'site.material_booking_other_time_time': ['ref', 'site', 'day', 'time'], 'site.delivery_received_challan': ['yes', 'ref', 'site', 'items', 'challan'],
    'supplier.order_request_time': ['ref', 'site', 'day', 'time', 'items'], 'step.reply_booking_yes_time': ['site', 'day', 'time', 'rate'],
    'step.reply_booking_other_time_time': ['site', 'day', 'time'], 'step.reply_order_other_time_time': ['site', 'day', 'time'],
    'step.record_delivery_challan': ['site', 'items', 'challan'], 'office.approval_needed_estimate': ['ref', 'by', 'estimate', 'step'],
    'office.status_held_estimate': ['ref', 'step', 'estimate', 'decision'], 'meter.ask_person': ['raw'], 'meter.ask_person_blank': [],
    'challan.ask_person_blank': ['items'], 'site.challan_ask_person_blank': ['ref', 'names'],
    'site.challan_count_saved': ['ref', 'site', 'items'], 'site.challan_count_saved_challan': ['ref', 'site', 'items', 'challan'],
    'site.challan_count_matches': ['ref', 'site', 'items'], 'site.challan_count_matches_challan': ['ref', 'site', 'items', 'challan'],
    'step.site_challan': ['ref', 'site', 'items', 'names'], 'step.site_challan_challan': ['ref', 'site', 'challan', 'items', 'names'],
    'what.jcb': ['site', 'day'], 'what.jcb_time': ['site', 'day', 'time'], 'what.jcb_hours': ['site', 'day', 'hours'],
    'what.jcb_time_hours': ['site', 'day', 'time', 'hours'], 'what.material': ['site', 'day', 'items'], 'what.material_time': ['site', 'day', 'time', 'items'],
    'reply.which_order': ['refs', 'ref'], 'site.yes_needs_ref': ['ref', 'refs'], 'site.yes_word': [], 'meter.which_job': ['lines', 'ref'], 'meter.job_line': ['n', 'ref', 'site', 'day'], 'challan.which_order': ['lines', 'ref'], 'challan.order_line': ['n', 'ref', 'site', 'day', 'what'],
    'step.cancel_order': ['ref', 'site', 'day', 'what'], 'cancel.done': ['ref', 'site', 'day', 'what'], 'cancel.refused': ['ref'], 'cancel.not_allowed': [], 'cancel.held': ['ref'],
    'cancel.already': ['ref'], 'cancel.closed': ['ref', 'state'], 'cancel.has_bill': ['ref'], 'cancel.has_payment': ['ref', 'amount'], 'cancel.has_delivery': ['ref'], 'cancel.has_count': ['ref'], 'cancel.has_meter': ['ref'],
    'site.order_cancelled': ['from', 'ref', 'site', 'day', 'what'], 'site.order_cancelled_own': ['ref', 'site', 'day', 'what'], 'jcb.order_cancelled': ['ref', 'site', 'day'],
    'jcb.order_cancelled_own': ['ref', 'site', 'day'], 'supplier.order_cancelled': ['ref', 'site', 'day', 'what'], 'state.cancelled': [], 'office.await.buyer.cancelled': [], 'office.await.seller.cancelled': [],
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
