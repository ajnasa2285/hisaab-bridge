// The contractor's agent rechecks a JCB bill: the rate is the one in the JCB owner's yes, and the amount
// is hours × that rate. One that does not follow is told with both figures and offers no one-word "हाँ".
// Bills from the real JCB agent behave as before. Wrong bills are signed and sent over the real link, as
// a faulty or dishonest JCB agent would. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool, ofType } from '../../src/agents/common.js';
import { t } from '../../src/i18n/index.js';
import { setup, person, SHA_A, SHA_B } from './helpers.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const operator = { ...person('operator', 'agent:jcb-1'), phone: '919000000041' };
const contractor = { ...person('contractor', 'agent:contractor-1'), phone: '919000000042' };
const SITE = 'agent:contractor-1';
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A booked JCB job at this rate, with both meter readings 6 hours apart. @param {number} ratePaise */
async function booked(ratePaise = 120000) {
  /** @type {any[]} */
  const expects = [];
  const s = await setup({ onTell: (/** @type {string} */ side, /** @type {string} */ role, /** @type {string} */ key, /** @type {any} */ _params, /** @type {any} */ expect) => {
    if (side === 'site') expects.push({ role, key, expect });
  } });
  await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Rampur', day: '2026-10-29', hoursTenths: 60 } });
  await settle();
  const orderId = String(/** @type {any} */ (s.jcbCore.ledger.orders()[0]).order_id);
  await runTool(s.jcb.tools, owner, { tool: 'reply_booking', args: { orderId, answer: 'yes', ratePaise } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'start', valueTenths: 1000, sha256: SHA_A } });
  await runTool(s.jcb.tools, operator, { tool: 'record_meter', args: { orderId, which: 'end', valueTenths: 1060, sha256: SHA_B } });
  await settle();
  return { s, orderId, expects };
}

/** @param {number} hoursTenths @param {number} ratePaise @param {number} amountPaise */
const billBody = (hoursTenths, ratePaise, amountPaise) => ({ lines: [{ what: 'JCB', hoursTenths, ratePaise, amountPaise }], totalPaise: amountPaise, evidence: [{ sha256: SHA_A, kind: 'meter', readValue: '100', takenAt: null, sentAt: '2026-10-29T02:30:00.000Z' }] });
/** @param {any} s @param {string} key */
const toldContractor = (s, key) => s.told.filter((/** @type {any[]} */ x) => x[0] === 'site' && x[1] === 'contractor' && x[2] === key);

test('a bill from the real JCB agent is told as ever, offered for one word, with its copy to the supervisor', async () => {
  const { s, orderId, expects } = await booked();
  try {
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await settle();
    const e = expects.find((x) => x.key === 'site.bill_received');
    assert.equal(e.expect.tool, 'accept_bill');
    assert.equal(toldContractor(s, 'site.bill_mismatch').length, 0);
    assert.ok(s.told.some((x) => x[1] === 'supervisor' && x[2] === 'site.bill_copy'));
  } finally { await s.close(); }
});

test('a rate that is no whole paise per tenth of an hour rounds as the JCB agent rounds: it follows', async () => {
  const { s, orderId, expects } = await booked(123333);
  try {
    assert.equal((await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 61 } })).key, 'common.wrong_state', 'no bill yet');
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await settle();
    assert.equal(expects.find((x) => x.key === 'site.bill_received').expect.tool, 'accept_bill');
  } finally { await s.close(); }
});

test('a rate other than the agreed one: both figures, no one-word yes, no copy; "हाँ J-1" is the way', async () => {
  const { s, orderId, expects } = await booked();
  try {
    await s.jcbLink.send({ type: 'BILL', to: SITE, orderId, body: billBody(60, 150000, 900000) });
    await settle();
    const [told] = toldContractor(s, 'site.bill_mismatch');
    const text = t(told[2], told[3]);
    for (const figure of ['₹1,500', '₹9,000', '₹1,200', '₹7,200', '"हाँ J-1"', 'नहीं ₹7200']) assert.ok(text.includes(figure), `${figure}: ${text}`);
    assert.ok(!text.includes('"हाँ" लिखें'), text);
    assert.equal(expects.find((x) => x.key === 'site.bill_mismatch').expect, undefined);
    assert.ok(!s.told.some((x) => x[1] === 'supervisor' && x[2] === 'site.bill_copy'));
    assert.equal(ofType(s.siteCore.ledger.events(orderId), 'ACCEPT', 'out').length, 0);
  } finally { await s.close(); }
});

test('the agreed rate with an amount that is not hours × rate does not follow either', async () => {
  const { s, orderId } = await booked();
  try {
    await s.jcbLink.send({ type: 'BILL', to: SITE, orderId, body: billBody(60, 120000, 800000) });
    await settle();
    const [told] = toldContractor(s, 'site.bill_mismatch');
    const text = t(told[2], told[3]);
    assert.ok(text.includes('₹8,000') && text.includes('₹7,200'), text);
  } finally { await s.close(); }
});

test('told again after a closed window: still both figures, still "हाँ J-1", under any key of the bill', async () => {
  const { s, orderId } = await booked();
  try {
    await s.jcbLink.send({ type: 'BILL', to: SITE, orderId, body: billBody(60, 150000, 900000) });
    await settle();
    const [n] = s.site.waiting('contractor');
    assert.equal(n.key, 'site.bill_mismatch');
    const text = t(n.key, n.params);
    assert.ok(text.includes('₹1,500') && text.includes('₹1,200') && text.includes('"हाँ J-1"'), text);
    assert.ok(!text.includes('"हाँ" लिखें'), text);
    assert.ok(n.also?.test('site.bill_mismatch') && n.also?.test('site.bill_received'));
  } finally { await s.close(); }
});

test('a correction may change the hours and stays one word; it may not change the rate', async () => {
  const { s, orderId, expects } = await booked();
  try {
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await settle();
    await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 50, reason: 'कम चली' } });
    await settle();
    // Other hours at the agreed rate, from the real agent: follows.
    await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 50 } });
    await settle();
    assert.equal(expects.find((x) => x.key === 'site.correction_received').expect.tool, 'accept_bill');
    assert.equal(toldContractor(s, 'site.bill_mismatch').length, 0);

    await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 40, reason: 'और कम' } });
    await settle();
    const replaces = String(s.jcbCore.ledger.view(orderId).currentBill);
    await s.jcbLink.send({ type: 'CORRECTION', to: SITE, orderId, body: { ...billBody(50, 130000, 650000), replaces } });
    await settle();
    const [told] = toldContractor(s, 'site.bill_mismatch');
    const text = t(told[2], told[3]);
    assert.ok(text.includes('₹1,300') && text.includes('₹1,200') && text.includes('₹6,000'), text);
    assert.equal(expects.find((x) => x.key === 'site.bill_mismatch').expect, undefined);
  } finally { await s.close(); }
});

test('a yes for a bill since replaced: the new bill is offered again only when it follows', async () => {
  const { s, orderId } = await booked();
  try {
    await runTool(s.jcb.tools, owner, { tool: 'send_bill', args: { orderId } });
    await settle();
    const first = String(s.siteCore.ledger.view(orderId).currentBill);
    await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 50, reason: 'कम चली' } });
    await settle();
    await runTool(s.jcb.tools, owner, { tool: 'send_correction', args: { orderId, hoursTenths: 50 } });
    await settle();
    const good = await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId, bill: first } });
    assert.equal(good.key, 'site.bill_changed');
    assert.equal(good.expect?.tool, 'accept_bill');

    await runTool(s.site.tools, contractor, { tool: 'dispute_bill', args: { orderId, hoursTenths: 40, reason: 'और कम' } });
    await settle();
    const second = String(s.jcbCore.ledger.view(orderId).currentBill);
    await s.jcbLink.send({ type: 'CORRECTION', to: SITE, orderId, body: { ...billBody(50, 130000, 650000), replaces: second } });
    await settle();
    const bad = await runTool(s.site.tools, contractor, { tool: 'accept_bill', args: { orderId, bill: first } });
    assert.equal(bad.key, 'site.bill_changed_check_jcb');
    assert.equal(bad.expect, undefined);
    assert.equal(ofType(s.siteCore.ledger.events(orderId), 'ACCEPT', 'out').length, 0);
  } finally { await s.close(); }
});
