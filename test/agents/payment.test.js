// The payment by screenshot: the contractor sends a UPI screenshot, confirms what was read; the
// JCB owner is asked whether the money arrived, and one "हाँ" settles both ledgers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation } from '../../src/agents/conversation.js';
import { runTool } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = person('operator', 'agent:jcb-1');
const contractor = person('contractor', 'agent:contractor-1');

/** Brings an order to "accepted" at ₹7,320. @param {any} s */
async function acceptedJob(s) {
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-10-29' } });
  const orderId = s.siteCore.ledger.orders()[0].order_id;
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise: 120000 } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 12345, sha256: SHA_A } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 12406, sha256: SHA_B } });
  await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
  await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId } });
  return orderId;
}

test('a UPI screenshot becomes a confirmed payment claim; the owner\'s one "हाँ" settles it', async () => {
  /** @type {any} */
  let nextRead = null;
  /** @type {[string, string, string][]} */
  const said = [];
  /** @type {any} */
  let jcbTalk = null;
  const s = await setup({
    onTell: (side, role, key, params, expect) => {
      said.push([`${side}:${role}`, key, t(key, params)]);
      if (expect && side === 'jcb' && role === 'jcb_owner') jcbTalk.expect(owner, expect.tool, expect.args);
    },
  });
  try {
    const reply = (/** @type {any} */ p, /** @type {string} */ key, /** @type {any} */ params) => { said.push([p.role, key, t(key, params)]); };
    const spark = async () => ({ ok: /** @type {const} */ (true), toolCalls: [] });
    jcbTalk = createConversation({ ledger: s.jcbCore.ledger, tools: s.jcb.tools, spark, reply, now: s.jcbCore.now });
    const siteTalk = createConversation({ ledger: s.siteCore.ledger, tools: s.site.tools, spark, readUpi: async () => nextRead, reply, now: s.siteCore.now });
    const orderId = await acceptedJob(s);
    const last = () => said.at(-1)?.[1];
    const shot = { mime: 'image/jpeg', bytes: new Uint8Array([9, 9, 9]) };

    // Not clear → retake; pending at the bank → shown, nothing claimed.
    nextRead = { ok: true, kind: 'upi_payment', amountPaise: 732000, date: '2026-10-30', utr: null, status: 'success', clear: false };
    await siteTalk.onImage(contractor, shot);
    assert.equal(last(), 'payment.retake');
    nextRead = { ok: true, kind: 'upi_payment', amountPaise: 732000, date: '2026-10-30', utr: '412345678901', status: 'pending', clear: true };
    await siteTalk.onImage(contractor, shot);
    assert.equal(last(), 'payment.read');
    assert.ok(said.at(-1)?.[2].includes('अटका'));
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'accepted');

    // A different amount is shown against the bill before anything goes.
    nextRead = { ok: true, kind: 'upi_payment', amountPaise: 700000, date: '2026-10-30', utr: '412345678901', status: 'success', clear: true };
    await siteTalk.onImage(contractor, shot);
    assert.equal(last(), 'payment.amount_differs');
    assert.ok(said.at(-1)?.[2].includes('₹7,000') && said.at(-1)?.[2].includes('₹7,320'));
    await siteTalk.onText(contractor, 'नहीं');
    assert.equal(last(), 'step.cancelled');

    // The right screenshot: read back, yes, claimed.
    nextRead = { ok: true, kind: 'upi_payment', amountPaise: 732000, date: '2026-10-30', utr: '412345678901', status: 'success', clear: true };
    await siteTalk.onImage(contractor, shot);
    assert.equal(last(), 'step.claim_payment');
    await siteTalk.onText(contractor, 'हाँ');
    assert.equal(last(), 'site.payment_claimed');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.jcbCore.ledger.view(orderId).state, 'payment_claimed');
    assert.ok(said.some(([w, k]) => w === 'jcb:jcb_owner' && k === 'jcb.payment_claimed'));

    // The owner checks the account and says yes once.
    await jcbTalk.onText(owner, 'हाँ');
    assert.equal(last(), 'jcb.settled_sent');
    assert.equal(s.siteCore.ledger.view(orderId).state, 'settled');
    const claim = s.jcbCore.ledger.events(orderId).find((e) => e.type === 'PAYMENT_CLAIM');
    assert.equal(claim?.body.body.screenshot.sha256.length, 64);
  } finally {
    await s.close();
  }
});
