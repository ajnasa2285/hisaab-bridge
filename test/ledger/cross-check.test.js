// The receipts cross-check between real agents over real A2A: healthy exchanges never alarm, and a
// rewrite the chain alone cannot see is caught through the other side's signed receipts. Invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTool } from '../../src/agents/common.js';
import { checkReceipts, crossCheck } from '../../src/ledger/cross-check.js';
import { checkLedgers } from '../../src/ledger/integrity.js';
import { verifyMessage } from '../../src/protocol/keys.js';
import { setup, person, SHA_A } from '../agents/helpers.js';
import { deleteFrom, rewriteRow } from './forge.js';

const owner = person('jcb_owner', 'agent:jcb-1');
const seller = person('supplier', 'agent:supplier-1');
const contractor = person('contractor', 'agent:contractor-1');
const CEMENT = { name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' };
const DAY = 24 * 60 * 60 * 1000;

/** @param {any} core @returns {{id: string, events: any[]}} */
const sideOf = (core) => ({ id: core.self.id, events: core.ledger.orders().flatMap((/** @type {any} */ o) => core.ledger.events(o.order_id)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.seq - b.seq) });
/** @param {any} holder a core, whose peer keys are used @returns {(e: any) => boolean | null} */
const verifier = (holder) => (e) => { const peer = holder.peers.get(e.body.from); return peer ? verifyMessage(e.body, peer.publicKey) : null; };

/** @param {any} tools @param {any} who @param {string} tool @param {any} args */
const step = async (tools, who, tool, args) => {
  const r = await runTool(tools, who, { tool, args });
  assert.equal(r.ok, true, `${tool}: ${r.key}`);
};

/** A JCB order up to booked, and a material order up to billed, so the contractor's ledger has both peers. @param {Awaited<ReturnType<typeof setup>>} s */
async function exchange(s) {
  await step(s.site.tools, contractor, 'request_jcb', { site: 'Shivpuri', day: '2026-10-29', time: '08:00', hoursTenths: 60 });
  const jcbOrder = /** @type {any} */ (s.siteCore.ledger.orders()[0]).order_id;
  await step(s.jcb.tools, owner, 'reply_booking', { orderId: jcbOrder, answer: 'yes', ratePaise: 120000 });
  s.advance(1000);
  await step(s.site.tools, contractor, 'request_material', { site: 'Rampur', day: '2026-10-30', items: [CEMENT] });
  const matOrder = /** @type {any} */ (s.supCore.ledger.orders()[0]).order_id;
  await step(s.sup.tools, seller, 'reply_order', { orderId: matOrder, answer: 'yes', ratesPaise: [38000] });
  await step(s.sup.tools, seller, 'record_delivery', { orderId: matOrder, items: [CEMENT], sha256: SHA_A });
  await step(s.site.tools, contractor, 'confirm_count', { orderId: matOrder, qtysHundredths: [5000] });
  await step(s.sup.tools, seller, 'send_bill', { orderId: matOrder });
  return { jcbOrder, matOrder };
}

test('a healthy exchange gives no mismatch in either direction, each receipt with a good signature', async () => {
  const s = await setup();
  try {
    await exchange(s);
    for (const peer of [s.jcbCore, s.supCore]) {
      const r = crossCheck(sideOf(s.siteCore), sideOf(peer), { verify: (e) => (e.body.from === peer.self.id ? verifier(s.siteCore) : verifier(peer))(e) });
      assert.deepEqual(r.mismatches, []);
      assert.ok(r.receipts >= 2, `${r.receipts} receipts`);
      assert.equal(r.signaturesChecked, r.receipts);
    }
    const toSupplier = checkReceipts(sideOf(s.siteCore), sideOf(s.supCore));
    const toSite = checkReceipts(sideOf(s.supCore), sideOf(s.siteCore));
    assert.ok(toSupplier.receipts > 0 && toSite.receipts > 0, 'both directions have receipts');
    assert.equal(toSite.signaturesChecked, 0, 'no verify given: no signature counted as checked');
  } finally { await s.close(); }
});

test('a repeated message: its second receipt names the first entry and a later head, and is no mismatch', async () => {
  const s = await setup();
  try {
    await exchange(s);
    const first = /** @type {any} */ (s.siteCore.ledger.orders()[0]);
    const sent = s.siteCore.ledger.events(first.order_id)[0];
    const d = await s.siteLink.deliver(/** @type {any} */ (sent.body));
    assert.equal(d.ok, true);
    assert.equal(s.jcbCore.ledger.events(first.order_id).filter((e) => e.msgId === sent.msgId).length, 1, 'written once');
    const receipts = s.siteCore.ledger.events(first.order_id).filter((e) => e.type === 'RECEIPT' && e.body.body.receipt_for === sent.msgId);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].body.body.entry_hash, receipts[1].body.body.entry_hash, 'the same entry');
    assert.notEqual(receipts[0].body.body.chain_head, receipts[1].body.body.chain_head, 'a later head');
    assert.deepEqual(crossCheck(sideOf(s.siteCore), sideOf(s.jcbCore), { verify: (e) => (e.body.from === 'agent:jcb-1' ? verifier(s.siteCore) : verifier(s.jcbCore))(e) }).mismatches, []);
  } finally { await s.close(); }
});

test('a message refused as expired has no receipt and gives no alarm', async () => {
  const s = await setup();
  try {
    await exchange(s);
    s.net.up = false;
    await runTool(s.site.tools, contractor, { tool: 'request_jcb', args: { site: 'Shivpuri', day: '2026-11-20', time: '08:00', hoursTenths: 60 } });
    const pending = s.siteLink.pending();
    assert.equal(pending.length, 1);
    const receiptsBefore = crossCheck(sideOf(s.siteCore), sideOf(s.jcbCore)).receipts;
    s.net.up = true;
    s.advance(30 * DAY);
    await s.siteLink.retryPending();
    const events = s.siteCore.ledger.events(pending[0].order_id);
    assert.ok(events.some((e) => e.type === 'REFUSE'), 'refused');
    assert.ok(events.some((e) => e.type === 'NOTE' && e.body.kind === 'undelivered'), 'given up');
    const r = crossCheck(sideOf(s.siteCore), sideOf(s.jcbCore));
    assert.equal(r.receipts, receiptsBefore);
    assert.deepEqual(r.mismatches, []);
  } finally { await s.close(); }
});

test('an edited row with every later hash recomputed passes verifyChain but fails the cross-check', async () => {
  const s = await setup();
  try {
    await exchange(s);
    rewriteRow(/** @type {any} */ (s.supCore.ledger), 1, (m) => { m.body.items[0].qtyHundredths = 9900; });
    assert.equal(s.supCore.ledger.verifyChain().ok, true, 'the chain alone sees nothing');
    const r = crossCheck(sideOf(s.siteCore), sideOf(s.supCore));
    assert.ok(r.mismatches.length > 0);
    assert.ok(r.mismatches.every((m) => m.holder === 'agent:contractor-1' && m.peer === 'agent:supplier-1' && Number.isInteger(m.seq) && typeof m.orderId === 'string'));
    assert.ok(r.mismatches.some((m) => m.kind === 'entry_missing'));
    assert.ok(r.mismatches.some((m) => m.kind === 'head_missing'));
    assert.deepEqual(crossCheck(sideOf(s.siteCore), sideOf(s.jcbCore)).mismatches, [], 'the JCB pair is untouched');
  } finally { await s.close(); }
});

test('the same edit on the contractor\'s ledger is caught from the seller\'s receipts: the check runs both ways', async () => {
  const s = await setup();
  try {
    await exchange(s);
    rewriteRow(/** @type {any} */ (s.siteCore.ledger), 1, (m) => { m.body.site = 'Other'; });
    assert.equal(s.siteCore.ledger.verifyChain().ok, true);
    const r = crossCheck(sideOf(s.siteCore), sideOf(s.supCore));
    assert.ok(r.mismatches.length > 0);
    assert.ok(r.mismatches.every((m) => m.holder === 'agent:supplier-1'), 'the seller holds the contractor\'s receipts');
  } finally { await s.close(); }
});

test('changing a stored receipt to fit a rewrite is caught by its signature', async () => {
  const s = await setup();
  try {
    await exchange(s);
    const receipt = sideOf(s.siteCore).events.find((e) => e.type === 'RECEIPT' && e.body.from === 'agent:jcb-1');
    assert.ok(receipt);
    const other = sideOf(s.jcbCore).events.find((e) => e.msgId === receipt.body.body.receipt_for);
    assert.ok(other);
    rewriteRow(/** @type {any} */ (s.siteCore.ledger), receipt.seq, (m) => { m.body.chain_head = other.prevHash; });
    assert.equal(s.siteCore.ledger.verifyChain().ok, true);
    const r = checkReceipts(sideOf(s.siteCore), sideOf(s.jcbCore), verifier(s.siteCore));
    assert.ok(r.mismatches.some((m) => m.kind === 'bad_signature' && m.seq === receipt.seq));
  } finally { await s.close(); }
});

test('deleting a ledger\'s last rows is caught when a receipt already named them', async () => {
  const s = await setup();
  try {
    await exchange(s);
    const rows = sideOf(s.supCore).events;
    const lastReceipt = sideOf(s.siteCore).events.filter((e) => e.type === 'RECEIPT' && e.body.from === 'agent:supplier-1').at(-1);
    const named = rows.find((e) => e.hash === lastReceipt?.body.body.chain_head);
    assert.ok(named);
    deleteFrom(/** @type {any} */ (s.supCore.ledger), named.seq);
    assert.equal(s.supCore.ledger.verifyChain().ok, true, 'what is left still verifies');
    const r = checkReceipts(sideOf(s.siteCore), sideOf(s.supCore));
    assert.deepEqual(r.mismatches.filter((m) => m.seq === lastReceipt?.seq).map((m) => m.kind), ['entry_missing', 'head_missing']);
  } finally { await s.close(); }
});

test('the limit, stated: rows after the peer\'s last receipt, its own sent bill among them, can be deleted unseen', async () => {
  const s = await setup();
  try {
    await exchange(s);
    const lastReceipt = sideOf(s.siteCore).events.filter((e) => e.type === 'RECEIPT' && e.body.from === 'agent:supplier-1').at(-1);
    const rows = sideOf(s.supCore).events;
    const named = rows.find((e) => e.hash === lastReceipt?.body.body.chain_head);
    assert.ok(named);
    const bill = rows.find((e) => e.type === 'BILL' && e.direction === 'out');
    assert.ok(bill && bill.seq > named.seq, 'the bill came after the last message the supplier received');
    deleteFrom(/** @type {any} */ (s.supCore.ledger), named.seq + 1);
    assert.deepEqual(crossCheck(sideOf(s.siteCore), sideOf(s.supCore)).mismatches, [], 'no receipt named them');
  } finally { await s.close(); }
});

/** A pair of small invented ledgers: row 1 and 2 on the peer, a receipt for row 2 on the holder. */
function pair() {
  /** @param {number} seq @param {string} hash @param {string} msgId */
  const row = (seq, hash, msgId) => ({ seq, orderId: 'o1', direction: 'in', type: 'BILL', msgId, body: { from: 'a' }, at: '2026-10-29T02:30:00.000Z', hash });
  const peer = { id: 'b', events: [row(1, 'h1', 'm1'), row(2, 'h2', 'm2')] };
  const receipt = { seq: 7, orderId: 'o1', direction: 'in', type: 'RECEIPT', msgId: 'r1', at: '2026-10-29T02:30:01.000Z', hash: 'x', body: { from: 'b', body: { receipt_for: 'm2', entry_hash: 'h2', chain_head: 'h2' } } };
  return { peer, receipt, holder: { id: 'a', events: [receipt] } };
}

test('each kind of problem is named, with the row and the order', () => {
  const ok = pair();
  assert.deepEqual(checkReceipts(ok.holder, ok.peer).mismatches, []);

  const wrong = pair();
  wrong.receipt.body.body.entry_hash = 'h1';
  assert.deepEqual(checkReceipts(wrong.holder, wrong.peer).mismatches, [{ holder: 'a', peer: 'b', seq: 7, orderId: 'o1', kind: 'wrong_entry' }]);

  const old = pair();
  old.receipt.body.body.chain_head = 'h1';
  assert.deepEqual(checkReceipts(old.holder, old.peer).mismatches.map((m) => m.kind), ['head_before_entry']);

  const elsewhere = pair();
  elsewhere.peer.events[1].orderId = 'o2';
  assert.deepEqual(checkReceipts(elsewhere.holder, elsewhere.peer).mismatches.map((m) => m.kind), ['wrong_entry']);

  const other = pair();
  other.peer.events[1].body.from = 'c';
  assert.deepEqual(checkReceipts(other.holder, other.peer).mismatches.map((m) => m.kind), ['wrong_entry']);

  const gone = pair();
  gone.peer.events = [];
  assert.deepEqual(checkReceipts(gone.holder, gone.peer).mismatches.map((m) => m.kind), ['entry_missing', 'head_missing']);

  const unknown = pair();
  assert.equal(checkReceipts(unknown.holder, { id: 'c', events: [] }).receipts, 0, 'another agent\'s receipts are not this pair\'s');
});

test('a receipt newer than the copy of the peer\'s ledger is not judged from that copy', () => {
  const p = pair();
  p.peer.events = [];
  const copy = { ...p.peer, exportedAt: '2026-10-29T02:30:01.000Z' };
  const r = checkReceipts(p.holder, copy);
  assert.deepEqual([r.receipts, r.notYet, r.mismatches], [0, 1, []]);
  assert.equal(checkReceipts(p.holder, { ...p.peer, exportedAt: '2026-10-29T02:30:02.000Z' }).mismatches.length, 2, 'older than the copy: judged');
});

test('the comparison has no imports, so the browser can run it', () => {
  const src = readFileSync(new URL('../../src/ledger/cross-check.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bBuffer\b/);
});

test('checkLedgers reports a broken chain, compares connected pairs only, and counts what it could not check', async () => {
  const s = await setup();
  try {
    await exchange(s);
    /** @type {any[]} */
    const cores = [s.jcbCore, s.siteCore, s.supCore];
    const agents = cores.map((c) => ({ name: c.self.id, id: c.self.id, ledger: c.ledger, peers: c.peers }));
    const healthy = await checkLedgers(agents);
    assert.deepEqual(healthy.failures, []);
    assert.ok(healthy.receipts > 0);
    assert.equal(healthy.signaturesChecked, healthy.receipts);

    s.jcbCore.ledger.db.exec('DROP TRIGGER events_no_update');
    s.jcbCore.ledger.db.exec("UPDATE events SET at = '2020-01-01T00:00:00.000Z' WHERE seq = 1");
    const broken = await checkLedgers(agents);
    assert.deepEqual(broken.failures.map((f) => [f.id, f.agents]), [['chain:agent:jcb-1:1', ['agent:jcb-1']]]);

    /** @type {string[]} */
    const errors = [];
    const faulty = agents.map((a) => (a.name === 'agent:supplier-1' ? { ...a, ledger: { ...a.ledger, verifyChain() { throw new TypeError('boom'); }, orders() { throw new TypeError('boom'); } } } : a));
    const r = await checkLedgers(faulty, { onError: (name) => { errors.push(name); } });
    assert.deepEqual(errors, ['agent:supplier-1', 'agent:supplier-1']);
    assert.ok(r.receipts > 0, 'the others are still checked');
  } finally { await s.close(); }
});
