import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, answerViolation, lookupsFor, orderFacts, runLookup } from '../../src/agents/ask.js';
import { usualBooks } from './usual-fixture.js';

const person = { line: 'site', phone: '919000000022', role: /** @type {const} */ ('contractor'), agent: 'agent:contractor-1', name: 'कल्पित ठेकेदार' };
const nowMs = Date.parse('2026-10-29T06:00:00Z');
/** @param {ReturnType<typeof usualBooks>} f @param {Record<string, any>} args @param {'buyer'|'seller'} [side] */
const lookup = (f, args, side = 'buyer') => runLookup('usual', args, { ledger: f.ledger, facts: orderFacts(f.ledger), side, nowMs });

test('usual lookup keeps parties and units apart and returns pre-GST display values only', () => {
  const f = usualBooks();
  try {
    for (const rate of [35000, 38000, 40000]) f.add({ rate });
    for (const rate of [50000, 50000, 50000]) f.add({ rate, peer: 'agent:supplier-2', site: 'दूसरी साइट' });
    f.add({ rate: 90000, accepted: false });
    f.add({ unit: 'टन' }); f.add({ unit: 'टन' });
    const r = lookup(f, { item: 'सीमेंट', metric: 'rate' });
    assert.equal(r.data.usual.length, 2);
    assert.deepEqual(r.data.usual.map((/** @type {any} */ row) => [row.counterparty, row.n, row.value]),
      [['agent:supplier-1', '3', '₹380/बोरी'], ['agent:supplier-2', '3', '₹500/बोरी']]);
    assert.equal(r.data.usual[0].min, '₹350/बोरी');
    assert.equal(r.data.usual[0].max, '₹400/बोरी');
    assert.doesNotMatch(JSON.stringify(r.data), /38000|50000|₹486/);
    assert.equal(lookup(f, { site: 'कल्पित साइट', metric: 'quantity' }).data.usual.length, 1);
    assert.equal(lookup(f, { item: 'सीमेंट', unit: 'टन' }).data.usual.length, 0);
    assert.equal(lookup(f, { counterparty: 'agent:supplier-2', metric: 'rate' }).data.usual[0].value, '₹500/बोरी');
    assert.ok(lookup(f, { metric: 'mean' }).data.error);
    assert.ok(lookup(f, { item: { unsafe: true } }).data.error);
  } finally { f.close(); }
});

test('stand-in Spark chooses usual and every amount and count in its answer is checked', async () => {
  const f = usualBooks();
  try {
    for (const rate of [35000, 38000, 40000]) f.add({ rate });
    const before = f.ledger.verifyChain();
    let calls = 0;
    /** @type {import('../../src/agents/ask.js').AskSpark} */
    const spark = async (req) => {
      calls++;
      if (calls === 1) {
        assert.ok(req.tools?.some((/** @type {any} */ d) => d.function.name === 'usual'));
        return { ok: true, toolCalls: [{ name: 'usual', args: { item: 'सीमेंट', metric: 'rate' } }] };
      }
      assert.match(req.text, /₹380\/बोरी/);
      assert.doesNotMatch(req.text, /38000/);
      return { ok: true, toolCalls: [{ name: 'answer', args: { answer: 'पिछले 3 पूरे ऑर्डर में सीमेंट की सामान्य दर ₹380/बोरी है।' } }] };
    };
    const r = await answerQuestion({ spark, ledger: f.ledger, person, question: 'सीमेंट का रेट आमतौर पर कितना रहता है?', nowMs });
    assert.equal(r.key, 'records.answer_plain');
    assert.deepEqual(f.ledger.verifyChain(), before);
    const found = lookup(f, { item: 'सीमेंट', metric: 'rate' });
    assert.equal(answerViolation('सीमेंट की सामान्य दर ₹381/बोरी है।', found.allowed), 'numbers');
    calls = 0;
    /** @type {import('../../src/agents/ask.js').AskSpark} */
    const wrong = async () => ({ ok: true, toolCalls: ++calls === 1 ? [{ name: 'usual', args: { metric: 'rate' } }]
      : [{ name: 'answer', args: { answer: 'सीमेंट की सामान्य दर ₹381/बोरी है।' } }] });
    const fallback = await answerQuestion({ spark: wrong, ledger: f.ledger, person, question: 'सामान्य दर?', nowMs });
    assert.equal(fallback.key, 'records.unavailable');
    assert.match(String(fallback.params?.figures), /₹380\/बोरी/);
    assert.doesNotMatch(String(fallback.params?.figures), /₹381/);
  } finally { f.close(); }
});

test('JCB hours are per completed job and fewer than three remains unknown', async () => {
  const f = usualBooks();
  try {
    f.add({ kind: 'jcb_hours', hours: 60 }); f.add({ kind: 'jcb_hours', hours: 70 });
    assert.deepEqual(lookup(f, { kind: 'jcb', metric: 'hours' }).data.usual, []);
    f.add({ kind: 'jcb_hours', hours: 80 });
    const r = lookup(f, { kind: 'jcb', metric: 'hours' });
    assert.equal(r.data.usual[0].value, '7 घंटे');
    assert.equal(answerViolation('पिछले 3 पूरे काम में JCB सामान्य रूप से 7 घंटे चली।', r.allowed), null);
    assert.equal(answerViolation('JCB सामान्य रूप से 9 घंटे चली।', r.allowed), 'numbers');
    let calls = 0;
    /** @type {import('../../src/agents/ask.js').AskSpark} */
    const spark = async () => ({ ok: true, toolCalls: ++calls === 1 ? [{ name: 'usual', args: { kind: 'jcb', metric: 'hours' } }]
      : [{ name: 'answer', args: { answer: 'पिछले 3 पूरे काम में JCB सामान्य रूप से 7 घंटे चली।' } }] });
    assert.equal((await answerQuestion({ spark, ledger: f.ledger, person, question: 'JCB रोज़ कितने घंटे चलती है?', nowMs })).key, 'records.answer_plain');
  } finally { f.close(); }
});

test('usual is read from the seller ledger and is denied to an operator', async () => {
  const f = usualBooks();
  try {
    for (let i = 0; i < 3; i++) f.add({ seller: true, rate: 42000 });
    const r = lookup(f, { metric: 'rate' }, 'seller');
    assert.equal(r.data.usual[0].counterparty, 'agent:contractor-1');
    assert.equal(r.data.usual[0].value, '₹420/बोरी');
    assert.ok(lookupsFor('supplier').includes('usual'));
    assert.ok(!lookupsFor('operator').includes('usual'));
    /** @type {import('../../src/agents/ask.js').AskSpark} */
    const spark = async () => ({ ok: true, toolCalls: [{ name: 'usual', args: {} }] });
    const denied = await answerQuestion({ spark, ledger: f.ledger, person: { ...person, role: 'operator' }, question: 'सामान्य दर?', nowMs });
    assert.equal(denied.key, 'records.not_allowed');
  } finally { f.close(); }
});

test('GST usual remains visible in code figures without weakening the percent guard', () => {
  const f = usualBooks();
  try {
    for (let i = 0; i < 3; i++) f.add();
    const r = lookup(f, { metric: 'gst' });
    assert.equal(r.data.usual[0].value, '28%');
    assert.match(r.lines[0], /28%/);
    assert.equal(answerViolation('GST 28% है।', r.allowed), 'numbers');
  } finally { f.close(); }
});
