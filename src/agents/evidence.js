// Evidence is requested only for a known order and a hash already committed to this ledger.
// The protocol verifies every byte before this module can display or read it. Automatic requests
// are deduplicated by record in the append-only history, including across process restarts.
import { openRefs } from '../ledger/refs.js';
import { evidenceRecords } from '../protocol/evidence.js';
import { differenceFacts } from './explain-facts.js';
import { explainDifference } from './explain.js';
import { readEvidence } from './evidence-readings.js';
import { no, ok } from './common.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('./common.js').Said} Said */

/**
 * @param {{agent: Parameters<typeof import('../protocol/exchange.js').receive>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>, kind: 'jcb'|'contractor'|'supplier',
 *   tell: import('./common.js').Tell, spark?: import('./explain.js').Spark,
 *   readMeter?: import('./conversation.js').MeterReader,
 *   readChallan?: import('./conversation.js').ChallanReader, readUpi?: import('./conversation.js').UpiReader,
 *   show: (image: {bytes: Uint8Array, mime: string}, caption: string) => Promise<void>}} o
 */
export function createEvidenceService(o) {
  const { agent, link } = o;
  const { ledger } = agent;
  const refs = openRefs(ledger);
  /** @param {string} orderId */
  const refOf = (orderId) => refs.refOf(orderId) ?? '—';
  /** @type {Set<string>} */
  const running = new Set();

  /** @param {string} orderId @param {string} record @param {'asked'|'bill_disputed'|'count_differs'} reason
   * @returns {Promise<boolean>} */
  async function request(orderId, record, reason) {
    const order = ledger.order(orderId);
    if (!order) return false;
    const key = `${orderId}:${record}`;
    if (running.has(key)) return false;
    if (reason !== 'asked' && ledger.events(orderId).some((e) => e.direction === 'out' && e.type === 'EVIDENCE_REQUEST'
      && e.body.body.refers_to === record && e.body.body.reason !== 'asked')) return false;
    running.add(key);
    try {
      const result = await link.send({ type: 'EVIDENCE_REQUEST', to: String(order.counterparty), orderId,
        body: { order: orderId, refers_to: record, reason } });
      return result.ok;
    } finally { running.delete(key); }
  }

  /** @param {string} orderId */
  function peerRecords(orderId) {
    const order = ledger.order(orderId);
    return order ? evidenceRecords(ledger, orderId).filter((r) => r.owner === order.counterparty) : [];
  }

  /** The current bill's meter photos, the latest delivery, count and payment, from this peer only.
   * @param {string} orderId */
  function latest(orderId) {
    const records = peerRecords(orderId);
    const bill = ledger.view(orderId).currentBill;
    const hashes = new Set((bill ? ledger.eventOfMessage(bill)?.body.body.evidence ?? [] : []).map((/** @type {any} */ e) => e.sha256));
    const meters = records.filter((r) => r.kind === 'meter' && hashes.has(r.sha256));
    const others = ['challan', 'site_count', 'upi'].flatMap((kind) => records.filter((r) => r.kind === kind).slice(-1));
    return [...new Map([...meters, ...others].map((r) => [r.record, r])).values()];
  }

  /** @param {string} orderId @returns {Promise<Said>} */
  async function requestLatest(orderId) {
    const records = latest(orderId);
    if (!records.length) return no('evidence.none', { ref: refOf(orderId) });
    let received = 0;
    for (const r of records) if (await request(orderId, r.record, 'asked')) received += 1;
    return received ? ok('evidence.received', { ref: refOf(orderId) }) : no('evidence.unavailable', { ref: refOf(orderId) });
  }

  /** @param {string} orderId */
  async function countDifference(orderId) {
    const delivery = peerRecords(orderId).filter((r) => r.kind === 'challan').at(-1);
    if (delivery) await request(orderId, delivery.record, 'count_differs');
  }

  /** @param {string} orderId */
  async function disputedBill(orderId) {
    for (const r of latest(orderId).filter((r) => r.kind === 'meter' || r.kind === 'challan')) {
      await request(orderId, r.record, 'bill_disputed');
    }
  }

  /** @param {Message} m */
  async function onApplied(m) {
    if (m.type === 'DISPUTE' && m.body.siteCount?.record) await request(m.order_id, m.body.siteCount.record, 'bill_disputed');
    if (m.type === 'EVIDENCE') await onEvidence(m);
  }

  /** Runs only after protocol validation and persistence. Display failure never changes a bill.
   * @param {Message} m */
  async function onEvidence(m) {
    const received = ledger.eventOfMessage(m.msg_id);
    if (!received || received.direction !== 'in' || received.type !== 'EVIDENCE') return;
    for (const item of m.body.items) {
      const record = peerRecords(m.order_id).find((r) => r.record === item.record && r.sha256 === item.sha256);
      if (!record) continue;
      let image;
      try { image = agent.mediaStore?.get(item.sha256); } catch { continue; }
      if (!image) continue;
      const who = t(o.kind === 'contractor' ? (ledger.order(m.order_id)?.kind === 'material' ? 'records.who.supplier' : 'records.who.jcb') : 'records.who.contractor');
      const date = new Date(Date.parse(record.at) + 330 * 60_000);
      const when = Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} IST` : '—';
      await o.show(image, t('evidence.caption', { ref: refOf(m.order_id), who, recordKind: t(`evidence.kind.${record.kind}`), when }));
      await readEvidence({ ledger, orderId: m.order_id, item: { ...item, bytes: image.bytes }, record,
        readMeter: o.readMeter, readChallan: o.readChallan, readUpi: o.readUpi, now: agent.now });
    }
    const explanation = await explainDifference({ spark: o.spark, audience: o.kind === 'contractor' ? 'buyer' : 'seller',
      facts: differenceFacts(ledger, m.order_id, refOf(m.order_id)) });
    await o.tell(o.kind === 'contractor' ? 'contractor' : o.kind === 'jcb' ? 'jcb_owner' : 'supplier', explanation.key, explanation.params);
  }

  return { requestLatest, countDifference, disputedBill, onApplied, onEvidence };
}

/** Image failure falls back to the same code caption through the normal text/window path.
 * @param {{image: {bytes: Uint8Array, mime: string}, caption: string,
 *   sendImage: (image: {bytes: Uint8Array, mime: string}, caption: string) => Promise<{ok:boolean}>,
 *   sendText: (text: string) => Promise<unknown>}} o */
export async function forwardEvidence(o) {
  try { if ((await o.sendImage(o.image, o.caption)).ok) return; } catch { /* Text still carries provenance. */ }
  await o.sendText(o.caption);
}
