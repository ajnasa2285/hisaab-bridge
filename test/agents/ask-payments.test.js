import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, answerViolation, orderFacts, runLookup } from '../../src/agents/ask.js';
import { differenceFacts } from '../../src/agents/explain-facts.js';
import { brief, numbersSupported } from '../../src/agents/explain.js';
import { paymentBooks } from './ask-payments-fixture.js';

const nowMs = Date.parse('2026-10-29T06:00:00Z');
const person = { agent: 'agent:contractor-1', line: 'site', role: /** @type {const} */ ('contractor'), phone: '919000000022', name: 'कल्पित ठेकेदार' };
const ctx = (/** @type {import('../../src/ledger/store.js').Ledger} */ ledger) => ({ ledger, facts: orderFacts(ledger), side: /** @type {const} */ ('buyer'), nowMs });

test('all payments are summary-backed: part, cash, advance, group, denial, due and credit', () => {
  const b = paymentBooks();
  try {
    const c = ctx(b.ledger);
    const all = runLookup('payments', {}, c);
    assert.equal(all.data.payments, '6'); // One clubbed payment, two shares.
    assert.equal(all.data.list.length, 7);
    assert.equal(all.data.total_confirmed, '₹6,200');
    assert.equal(all.data.total_waiting, '₹9,600');
    assert.equal(all.data.total_denied, '₹1,000');
    const p1 = runLookup('order_detail', { ref: 'P-1' }, c);
    assert.deepEqual(p1.data.balance, { ref: 'P-1', billed: '₹10,000', confirmed: '₹5,000', waiting: '₹5,000', due: '₹5,000', credit: '₹0' });
    assert.equal(p1.data.payments[0].purpose, 'एडवांस');
    assert.equal(p1.data.payments[0].method, 'नकद');
    assert.deepEqual(p1.data.payments[2].group, { refs: ['P-1', 'P-2'], total: '₹9,000' });
    assert.equal(runLookup('order_detail', { ref: 'P-3' }, c).data.balance.credit, '₹200');
    const unbilled = runLookup('order_detail', { ref: 'P-4' }, c);
    assert.equal('due' in unbilled.data.balance, false);
    assert.equal('billed' in unbilled.data.balance, false);
    assert.doesNotMatch(unbilled.lines.join('\n'), /—/);
    const totals = runLookup('totals', {}, c).data.groups[0];
    assert.equal(totals.money.confirmed, '₹6,200');
    assert.equal(totals.money.due, '₹13,000');
    assert.equal(totals.money.credit, '₹200');
    assert.equal(totals.balances.length, 4);
    assert.equal(answerViolation('P-2 पर ₹8,000 बाक़ी है।', runLookup('order_detail', { ref: 'P-2' }, c).allowed), null);
    assert.equal(answerViolation('P-2 पर ₹7,000 बाक़ी है।', all.allowed), 'numbers');
  } finally { b.close(); }
});

test('payment filters use paid days, cash/status and exact refs; group totals are never added twice', () => {
  const b = paymentBooks();
  try {
    const c = ctx(b.ledger);
    const cash = runLookup('payments', { method: 'cash', period: 'this_month' }, c);
    assert.equal(cash.data.total_reported, '₹4,800');
    assert.equal(cash.data.total_confirmed, '₹3,200');
    const waiting = runLookup('payments', { status: 'waiting' }, c);
    assert.equal(waiting.data.payments, '2');
    assert.equal(waiting.data.list.length, 3);
    const club = runLookup('payments', { refs: ['P-1', 'P-2'], grouped_only: true }, c);
    assert.equal(club.data.payments, '1');
    assert.equal(club.data.total_reported, '₹9,000');
    assert.equal(club.data.total_waiting, '₹9,000');
    assert.equal(answerViolation('P-1 और P-2 के लिए एक साथ ₹9,000 दर्ज है।', club.allowed), null);
    assert.equal(answerViolation('₹एक का भुगतान है।', club.allowed), 'numbers');
    assert.equal(answerViolation('3 पेमेंट की पुष्टि बाक़ी है।', waiting.allowed), 'numbers');
    assert.equal(runLookup('payments', { refs: ['P-1'], grouped_only: false }, c).data.total_reported, '₹10,000');
    assert.equal(runLookup('payments', { from: '2026-10-23', to: '2026-10-23' }, c).data.total_reported, '₹9,000');
    assert.ok(runLookup('payments', { refs: ['P-999'] }, c).data.error);
    assert.ok(runLookup('payments', { method: 'cheque' }, c).data.error);
  } finally { b.close(); }
});

test('new payment questions get checked stand-in answers; an invented balance falls back to code figures', async () => {
  const b = paymentBooks();
  try {
    const scenarios = [
      ['P-2 का कितना बाक़ी है?', 'order_detail', { ref: 'P-2' }, 'P-2 का बिल ₹8,000 है और ₹8,000 बाक़ी है।'],
      ['इस महीने कितना नकद दिया?', 'payments', { method: 'cash', period: 'this_month' }, 'नकद ₹3,200 की पुष्टि हुई है, ₹600 की पुष्टि बाक़ी है। ₹1,000 मिलने से इनकार दर्ज है।'],
      ['कौन सा पेमेंट अभी पक्का नहीं हुआ?', 'payments', { status: 'waiting' }, 'P-1 और P-2 का ₹9,000 साथ में दर्ज है, पुष्टि बाक़ी है। P-4 पर ₹600 की पुष्टि बाक़ी है।'],
      ['P-1 और P-2 का एक साथ कितना दिया था?', 'payments', { refs: ['P-1', 'P-2'], grouped_only: true }, 'P-1 और P-2 का ₹9,000 साथ में दर्ज है। पुष्टि बाक़ी है।'],
    ];
    for (const [question, name, args, answer] of scenarios) {
      let n = 0;
      const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: n++ ? [{ name: 'answer', args: { answer } }] : [{ name: String(name), args }] });
      const r = await answerQuestion({ ledger: b.ledger, person, nowMs, question: String(question), spark });
      assert.equal(r.key, 'records.answer', String(question));
    }
    let n = 0;
    const bad = await answerQuestion({ ledger: b.ledger, person, nowMs, question: 'P-2 का कितना बाक़ी है?', spark: async () => ({ ok: true, toolCalls: n++ ? [{ name: 'answer', args: { answer: 'P-2 पर ₹7,000 बाक़ी है।' } }] : [{ name: 'order_detail', args: { ref: 'P-2' } }] }) });
    assert.equal(bad.key, 'records.unavailable');
    assert.match(String(bad.params?.figures), /देना बाक़ी ₹8,000/);
  } finally { b.close(); }
});

test('explanation facts and brief include denied payments and overpayment without private identifiers', () => {
  const b = paymentBooks();
  try {
    const denied = differenceFacts(b.ledger, b.ids[1], 'P-2');
    assert.match(denied.figures, /₹1,000.*नकद.*नहीं मिला बताया/);
    assert.match(denied.figures, /देना बाक़ी ₹8,000/);
    assert.match(brief(denied.context, 'buyer'), /₹1,000.*नकद.*नहीं मिला बताया/);
    const credit = differenceFacts(b.ledger, b.ids[2], 'P-3');
    assert.match(credit.figures, /मिला ₹1,200.*ज़्यादा जमा ₹200/);
    assert.equal(numbersSupported('₹1,200 मिले, बिल ₹1,000 है, अंतर ₹200 है।', credit.allowedNumbers), true);
    assert.equal(numbersSupported('अंतर ₹250 है।', credit.allowedNumbers), false);
    assert.doesNotMatch(JSON.stringify(denied.context), /INVENTED-|00000000-0000/);
  } finally { b.close(); }
});
