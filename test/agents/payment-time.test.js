// The payment's time: the UPI receipt's clock (HH:MM) goes with the claim as `paidAt` when it was
// printed, and both sides see it; an old claim without it stays valid and reads as before. Invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { paymentText, runTool } from '../../src/agents/common.js';
import { orderFacts, runLookup } from '../../src/agents/ask.js';
import { bodyIsValid } from '../../src/protocol/messages.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B, SHA_C, seesPhoto } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = person('operator', 'agent:jcb-1');
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000031' };

/** A JCB job accepted at ₹7,320, with the agents' notices kept. */
async function acceptedJob() {
  /** @type {[string, string, string][]} */
  const said = [];
  const s = await setup({ onTell: (side, role, key, params) => { said.push([`${side}:${role}`, key, t(key, params)]); } });
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Site C', day: '2026-10-23' } });
  const orderId = /** @type {{order_id: string}} */ (s.siteCore.ledger.orders()[0]).order_id;
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_A } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
  await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
  await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } });
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  return { s, said, orderId, settle };
}

/** @param {Record<string, any>} [extra] */
const claim = (extra = {}) => ({ bill: '00000000-0000-4000-8000-000000000001', amountPaise: 3500000, utr: '412300000001', paidOn: '2026-10-23', screenshot: { sha256: SHA_C }, ...extra });

test('PAYMENT_CLAIM: an old claim without paidAt stays valid; paidAt is HH:MM on 24 hours or null', () => {
  assert.equal(bodyIsValid('PAYMENT_CLAIM', claim()), true);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', claim({ paidAt: '14:05' })), true);
  assert.equal(bodyIsValid('PAYMENT_CLAIM', claim({ paidAt: null })), true);
  for (const bad of ['2:05 PM', '24:00', '14:5', '', 1405]) assert.equal(bodyIsValid('PAYMENT_CLAIM', claim({ paidAt: bad })), false, String(bad));
});

test('the payment line: with the time when printed, without it (never "—") when not', () => {
  assert.equal(paymentText(claim({ paidAt: '14:05' })), '₹35,000, 23 अक्टूबर 2026, 14:05 बजे, UTR 412300000001');
  assert.equal(paymentText(claim()), '₹35,000, 23 अक्टूबर 2026, UTR 412300000001');
  assert.equal(paymentText(claim({ paidAt: null })), '₹35,000, 23 अक्टूबर 2026, UTR 412300000001');
});

test('paidAt shown: the owner and the payer see the time; ask-anything payments carries it', async () => {
  const j = await acceptedJob();
  try {
    const r = await runTool(j.s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: j.orderId, amountPaise: 732000, utr: '412300000002', paidOn: '2026-10-23', paidAt: '14:05', screenshotSha256: SHA_C } });
    assert.equal(r.key, 'site.payment_claimed');
    assert.equal(t(r.key, r.params), 'J-1: भुगतान की जानकारी JCB मालिक को भेजी: ₹7,320, 23 अक्टूबर 2026, 14:05 बजे, UTR 412300000002। उनकी पुष्टि आते ही बताया जाएगा।');
    await j.settle();
    const told = j.said.find(([w, k]) => w === 'jcb:jcb_owner' && k.startsWith('jcb.payment_claimed'));
    assert.equal(told?.[1], 'jcb.payment_claimed_at');
    assert.ok(told?.[2].includes('23 अक्टूबर 2026 को 14:05 बजे') && told?.[2].includes('UTR 412300000002'), told?.[2]);
    assert.equal(j.s.jcbCore.ledger.events(j.orderId).find((e) => e.type === 'PAYMENT_CLAIM')?.body.body.paidAt, '14:05');

    for (const [ledger, side] of /** @type {const} */ ([[j.s.siteCore.ledger, 'buyer'], [j.s.jcbCore.ledger, 'seller']])) {
      const facts = orderFacts(ledger);
      assert.deepEqual(facts[0].claim, { amountPaise: 732000, paidOn: '2026-10-23', paidAt: '14:05' });
      const p = runLookup('payments', { site: null, kind: null, period: 'all', from: null, to: null }, { ledger, side, nowMs: Date.parse('2026-10-29T06:00:00Z'), facts });
      assert.equal(p.data.list[0].paid_at, '14:05', side);
      assert.ok(p.lines[0].includes('23 अक्टूबर 2026, 14:05 बजे'), p.lines[0]);
      assert.ok(p.allowed.some((a) => a.value === '14:05' && a.kind === 'time'));
      const d = runLookup('order_detail', { ref: 'J-1' }, { ledger, side, nowMs: Date.parse('2026-10-29T06:00:00Z'), facts });
      assert.equal(d.data.payment_reported, '₹7,320, 23 अक्टूबर 2026, 14:05 बजे');
    }
  } finally {
    await j.s.close();
  }
});

test('paidAt absent: the old text for the owner, no time phrase and no "—" anywhere', async () => {
  const j = await acceptedJob();
  try {
    const r = await runTool(j.s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: j.orderId, amountPaise: 732000, utr: '412300000003', paidOn: '2026-10-23', screenshotSha256: SHA_C } });
    const text = t(r.key, r.params);
    assert.ok(text.includes('₹7,320, 23 अक्टूबर 2026, UTR 412300000003') && !text.includes('बजे') && !text.includes('—'), text);
    await j.settle();
    const told = j.said.find(([w, k]) => w === 'jcb:jcb_owner' && k.startsWith('jcb.payment_claimed'));
    assert.equal(told?.[1], 'jcb.payment_claimed');
    assert.equal(j.s.jcbCore.ledger.events(j.orderId).find((e) => e.type === 'PAYMENT_CLAIM')?.body.body.paidAt, undefined);
    const facts = orderFacts(j.s.siteCore.ledger);
    const p = runLookup('payments', { site: null, kind: null, period: 'all', from: null, to: null }, { ledger: j.s.siteCore.ledger, side: 'buyer', nowMs: Date.parse('2026-10-29T06:00:00Z'), facts });
    assert.equal('paid_at' in p.data.list[0], false);
    // The line's own dash separates the confirmation; no time stands in for a missing one.
    assert.ok(!p.lines[0].includes('बजे') && p.lines[0].includes('23 अक्टूबर 2026 — पुष्टि'), p.lines[0]);
    // A bad time is refused before anything is sent.
    const bad = await runTool(j.s.site.tools, contractor, { tool: 'claim_payment', args: { orderId: j.orderId, amountPaise: 732000, utr: '412300000003', paidOn: '2026-10-23', paidAt: '2 बजे', screenshotSha256: SHA_C } });
    assert.equal(bad.key, 'common.bad_args');
  } finally {
    await j.s.close();
  }
});

test('the UPI screenshot\'s clock goes with the claim; a screenshot without one sends none', async () => {
  const j = await acceptedJob();
  try {
    /** @type {any} */
    let nextRead = null;
    /** @type {[string, string][]} */
    const replies = [];
    const talk = createConversation({
      ledger: j.s.siteCore.ledger, tools: j.s.site.tools, now: j.s.siteCore.now,
      spark: async () => ({ ok: /** @type {const} */ (true), toolCalls: [] }),
      readUpi: async () => nextRead, classifyPhoto: seesPhoto('upi'),
      reply: (/** @type {any} */ _p, /** @type {string} */ key, /** @type {any} */ params) => { replies.push([key, t(key, params)]); },
    });
    nextRead = { ok: true, kind: 'upi_payment', amountPaise: 732000, date: '2026-10-23', time: null, clock: '14:05', utr: '412300000004', status: 'success', clear: true };
    // A clear screenshot for the bill's amount is claimed at once (fewer steps), the clock with it.
    const claims = () => j.s.siteCore.ledger.events(j.orderId).filter((e) => e.type === 'PAYMENT_CLAIM' && e.direction === 'out');
    await talk.onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([7, 3, 7]) });
    assert.equal(replies.at(-1)?.[0], 'site.payment_claimed');
    assert.equal(claims().at(-1)?.body.body.paidAt, '14:05');
    nextRead = { ...nextRead, clock: null, utr: '412300000005' };
    await talk.onImage(contractor, { mime: 'image/jpeg', bytes: new Uint8Array([7, 3, 8]) });
    assert.equal(replies.at(-1)?.[0], 'site.payment_claimed');
    assert.equal('paidAt' in (claims().at(-1)?.body.body ?? {}), false);
  } finally {
    await j.s.close();
  }
});
