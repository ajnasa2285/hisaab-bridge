import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentBooks } from './ask-payments-fixture.js';
import { createOffice } from '../../src/agents/office.js';
import { createJcbAgent } from '../../src/agents/jcb.js';
import { createSupplierAgent } from '../../src/agents/supplier.js';
import { missedWaiting, orderPaymentText, paymentWaiting } from '../../src/agents/payment-view.js';
import { t } from '../../src/i18n/index.js';

const seller = { agent: 'agent:supplier-1', role: /** @type {const} */ ('supplier'), line: 'seller', phone: '919000000031', name: 'कल्पित विक्रेता' };
const now = () => Date.parse('2026-10-29T06:00:00Z');
/** @param {import('../../src/ledger/store.js').Ledger} ledger @param {'contractor'|'supplier'} kind */
const officeOf = (ledger, kind) => createOffice({ ledger, kind, tools: {}, tell: () => {}, reply: () => {}, now });

test('status uses all confirmed payments and shows waiting separately from due, on both sides', async () => {
  const b = paymentBooks();
  try {
    for (const kind of /** @type {const} */ (['contractor', 'supplier'])) {
      const o = officeOf(b.ledger, kind);
      const result = await o.command(seller, { cmd: 'status', ref: 'P-1' });
      assert.ok(result);
      const text = t(result.key, result.params);
      for (const part of ['बिल ₹10,000', 'पक्का भुगतान ₹5,000', 'पक्का होना बाक़ी ₹5,000', 'देना बाक़ी ₹5,000', 'ज़्यादा जमा ₹0', 'एक साथ P-1, P-2: ₹9,000']) assert.ok(text.includes(part), part);
      assert.doesNotMatch(text, /—/);
      const advance = orderPaymentText(b.ledger, b.ids[3]);
      assert.match(advance, /बिल अभी नहीं आया.*पक्का एडवांस ₹0.*पक्का होना बाक़ी ₹600/);
      assert.match(advance, /नकद, एडवांस/);
      assert.doesNotMatch(advance, /देना बाक़ी|—/);
      assert.match(orderPaymentText(b.ledger, b.ids[2]), /देना बाक़ी ₹0 · ज़्यादा जमा ₹200/);
    }
  } finally { b.close(); }
});

test('seller pending lists a clubbed claim once and excludes answered claims', async () => {
  const b = paymentBooks();
  try {
    const result = await officeOf(b.ledger, 'supplier').command(seller, { cmd: 'pending' });
    assert.ok(result);
    const text = t(result.key, result.params);
    assert.equal((text.match(/एक साथ कुल ₹9,000/g) ?? []).length, 1);
    assert.match(text, /P-1 का हिस्सा ₹5,000, P-2 का हिस्सा ₹4,000/);
    assert.match(text, /P-4.*नकद, एडवांस.*आपका पक्का करना बाक़ी ₹600/);
    assert.match(text, /P-1:.*बिल ₹10,000.*पक्का भुगतान ₹5,000.*देना बाक़ी ₹5,000/);
    assert.doesNotMatch(text, /—\s*—|आपका पक्का करना बाक़ी ₹1,000/);
    const group = b.ledger.events(b.ids[0]).find((e) => e.body.body?.group);
    assert.ok(group);
    b.put(b.ids[0], 'PAYMENT_ACK', { payment: group.msgId, received: true, amountPaise: 500000 });
    const partial = paymentWaiting(b.ledger);
    assert.equal(partial.length, 2);
    assert.equal(partial[0].params.amount, '₹4,000');
    assert.equal(partial[0].params.refs, 'P-1, P-2');
    assert.equal(partial[0].params.shares, 'P-2 का हिस्सा ₹4,000');
    const second = b.ledger.events(b.ids[1]).find((e) => e.body.body?.group);
    b.put(b.ids[1], 'PAYMENT_ACK', { payment: second?.msgId, received: false, amountPaise: 400000 });
    assert.deepEqual(paymentWaiting(b.ledger).map((n) => n.params.refs), ['P-4']);
  } finally { b.close(); }
});

test('both seller waiting(role) lists rebuild group and advance independently of old order state', () => {
  const b = paymentBooks();
  try {
    const options = /** @type {any} */ ({ agent: { ledger: b.ledger }, link: {}, tell: () => {} });
    const supplier = createSupplierAgent(options);
    const jcb = createJcbAgent(options);
    assert.deepEqual(supplier.waiting('supplier'), paymentWaiting(b.ledger));
    assert.deepEqual(jcb.waiting('jcb_owner'), paymentWaiting(b.ledger));
    assert.deepEqual(supplier.waiting('contractor'), []);
    assert.deepEqual(jcb.waiting('contractor'), []);
  } finally { b.close(); }
});

test('24-hour replay matches either member and old claim keys, deduplicates groups, drops answered items', () => {
  const b = paymentBooks();
  try {
    const open = paymentWaiting(b.ledger);
    const missed = [
      { ref: 'P-1', key: 'supplier.payment_claimed_at' },
      { ref: 'P-2', key: 'supplier.payment_claimed_at' },
      { ref: 'P-4', key: 'payview.waiting' },
      { ref: 'P-3', key: 'supplier.payment_claimed' },
    ];
    assert.deepEqual(missedWaiting(missed, open), open);
    assert.deepEqual(missedWaiting([{ ref: 'P-2', key: 'jcb.payment_claimed' }], open), [open[0]]);
    assert.deepEqual(missedWaiting([{ ref: 'P-2', key: 'supplier.bill_disputed' }], open), []);
    assert.deepEqual(missedWaiting(missed, []), []);
  } finally { b.close(); }
});

test('refused outgoing cash claim is neither money nor a waiting item', () => {
  const b = paymentBooks();
  try {
    const id = b.put(b.ids[3], 'PAYMENT_CLAIM', { bill: null, method: 'cash', amountPaise: 12345, paidOn: '2026-10-29' }, 'out');
    b.put(b.ids[3], 'REFUSE', { refers_to: id, code: 'WRONG_STATE' });
    const before = b.ledger.events(b.ids[3]).length;
    assert.equal(paymentWaiting(b.ledger).length, 2);
    assert.doesNotMatch(orderPaymentText(b.ledger, b.ids[3]), /123\.45/);
    assert.equal(b.ledger.events(b.ids[3]).length, before);
  } finally { b.close(); }
});
