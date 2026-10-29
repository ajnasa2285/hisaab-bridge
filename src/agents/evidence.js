// Evidence is requested only for a known order and a hash already committed to this ledger.
// The protocol verifies every byte before this module can display or read it. Automatic requests
// are deduplicated by record in the append-only history, including across process restarts.
// The photo's owner decides before it is shared (docs/BUILD2.md "Photo guards and owner consent"):
// a received request asks them once, "हाँ" sends the photo, "नहीं" a signed REFUSE
// `declined_by_owner`; no answer within the question's window sends nothing. The decision is a
// local NOTE `evidence_consent`.
import { randomUUID } from 'node:crypto';
import { openRefs } from '../ledger/refs.js';
import { evidenceRecords, findEvidenceRecord } from '../protocol/evidence.js';
import { evidenceAnswer } from '../protocol/exchange.js';
import { differenceFacts } from './explain-facts.js';
import { explainDifference } from './explain.js';
import { readEvidence } from './evidence-readings.js';
import { deliveryResult, no, ok } from './common.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('./common.js').Said} Said */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('../wa/directory.js').Role} Role */

/** As long as the owner's yes/no question stays open (the conversation's window, 30 minutes). */
const CONSENT_MS = 30 * 60 * 1000;

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
  /** The owner's open question per order: the photo kinds and reasons it named, and when. @type {Map<string, {kinds: string[], reasons: string[], at: number}>} */
  const asking = new Map();
  /** Who decides about this agent's photos, and who is told about the other side's. @type {Role} */
  const ownerRole = o.kind === 'contractor' ? 'contractor' : o.kind === 'jcb' ? 'jcb_owner' : 'supplier';
  /** The other party of an order, as the texts name it. @param {string} orderId */
  const otherWho = (orderId) => t(o.kind === 'contractor' ? (ledger.order(orderId)?.kind === 'material' ? 'records.who.supplier' : 'records.who.jcb') : 'records.who.contractor');

  /** @param {string} orderId @param {string} record @param {'asked'|'bill_disputed'|'count_differs'} reason
   * @returns {Promise<{ok: boolean, evidence?: boolean}>} */
  async function request(orderId, record, reason) {
    const order = ledger.order(orderId);
    if (!order) return { ok: false };
    const key = `${orderId}:${record}`;
    if (running.has(key)) return { ok: false };
    if (reason !== 'asked' && ledger.events(orderId).some((e) => e.direction === 'out' && e.type === 'EVIDENCE_REQUEST'
      && e.body.body.refers_to === record && e.body.body.reason !== 'asked')) return { ok: false };
    running.add(key);
    try {
      const result = await link.send({ type: 'EVIDENCE_REQUEST', to: String(order.counterparty), orderId,
        body: { order: orderId, refers_to: record, reason } });
      // An agent from before owner consent answers with the photo at once.
      return { ok: result.ok, evidence: result.ok && result.evidence !== undefined };
    } finally { running.delete(key); }
  }

  /** The requester is told once that the other side's owner decides. @param {string} orderId @param {{ok: boolean, evidence?: boolean}[]} results */
  async function toldWaiting(orderId, results) {
    if (results.some((r) => r.ok && !r.evidence)) await o.tell(ownerRole, 'evidence.waiting', { ref: refOf(orderId), who: otherWho(orderId) });
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
    /** @type {{ok: boolean, evidence?: boolean}[]} */
    const results = [];
    for (const r of records) results.push(await request(orderId, r.record, 'asked'));
    if (results.some((r) => r.evidence)) return ok('evidence.received', { ref: refOf(orderId) });
    // Asked: the photos come when the other side's owner says yes.
    return results.some((r) => r.ok) ? ok('evidence.waiting', { ref: refOf(orderId), who: otherWho(orderId) }) : no('evidence.unavailable', { ref: refOf(orderId) });
  }

  /** @param {string} orderId */
  async function countDifference(orderId) {
    const delivery = peerRecords(orderId).filter((r) => r.kind === 'challan').at(-1);
    if (delivery) await toldWaiting(orderId, [await request(orderId, delivery.record, 'count_differs')]);
  }

  /** @param {string} orderId */
  async function disputedBill(orderId) {
    /** @type {{ok: boolean, evidence?: boolean}[]} */
    const results = [];
    for (const r of latest(orderId).filter((r) => r.kind === 'meter' || r.kind === 'challan')) {
      results.push(await request(orderId, r.record, 'bill_disputed'));
    }
    await toldWaiting(orderId, results);
  }

  /** @param {Message} m */
  async function onApplied(m) {
    if (m.type === 'DISPUTE' && m.body.siteCount?.record) await toldWaiting(m.order_id, [await request(m.order_id, m.body.siteCount.record, 'bill_disputed')]);
    if (m.type === 'EVIDENCE') await onEvidence(m);
    if (m.type === 'EVIDENCE_REQUEST') await askOwner(m);
    if (m.type === 'REFUSE') await onRefused(m);
  }

  /** Received requests of an order the owner has not decided yet, oldest first. @param {string} orderId */
  function openRequests(orderId) {
    const events = ledger.events(orderId);
    const decided = new Set(events.filter((e) => e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'evidence_consent').map((e) => e.body.request));
    return events.filter((e) => e.direction === 'in' && e.type === 'EVIDENCE_REQUEST' && !decided.has(e.msgId));
  }

  /**
   * A request for one of our photos asks the owner once: which photo, why, and "हाँ / नहीं". A
   * further request on the same order while the question is open is covered by it (same kind of
   * photo) or asks again naming every kind, so one answer decides all of them.
   * @param {Message} m
   */
  async function askOwner(m) {
    const record = findEvidenceRecord(ledger, m.order_id, m.body.refers_to, agent.self.id);
    if (!record) return;
    const open = asking.get(m.order_id);
    const fresh = open && agent.now() - open.at <= CONSENT_MS ? open : null;
    if (fresh && fresh.kinds.includes(record.kind)) return;
    const kinds = [...new Set([...(fresh?.kinds ?? []), record.kind])];
    const reasons = [...new Set([...(fresh?.reasons ?? []), String(m.body.reason)])];
    asking.set(m.order_id, { kinds, reasons, at: agent.now() });
    await o.tell(ownerRole, 'evidence.ask_owner', {
      ref: refOf(m.order_id), who: otherWho(m.order_id),
      what: kinds.map((k) => t(`evidence.what.${k}`)).join(', '), reason: reasons.map((r) => t(`evidence.reason.${r}`)).join(', '),
    }, { tool: 'share_evidence', args: { orderId: m.order_id }, no: { tool: 'decline_evidence', args: { orderId: m.order_id } } });
  }

  /** The owner's decision on one request, kept in this agent's history. @param {string} orderId @param {string} request @param {'yes'|'no'} answer @param {Role} by */
  function decide(orderId, request, answer, by) {
    ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(), at: new Date(agent.now()).toISOString(),
      body: { kind: 'evidence_consent', request, answer, by } });
  }

  /**
   * The owner's yes or no to every open request of the order: the photos go (hash-checked), or a
   * signed REFUSE `declined_by_owner` does. A photo no longer kept is refused `not_kept`.
   * @param {import('../wa/directory.js').Person} person @param {string} orderId @param {'yes'|'no'} answer
   * @returns {Promise<Said>}
   */
  async function answerRequests(person, orderId, answer) {
    const order = ledger.order(orderId);
    if (!order) return no('common.no_such_order');
    asking.delete(orderId);
    const open = openRequests(orderId);
    if (!open.length) return no('evidence.nothing_open', { ref: refOf(orderId) });
    let shared = 0;
    /** @type {import('./link.js').Delivery | null} */
    let failed = null;
    for (const req of open) {
      const requestId = /** @type {string} */ (req.msgId);
      decide(orderId, requestId, answer, person.role);
      const a = answer === 'yes' ? evidenceAnswer(agent, orderId, requestId) : null;
      const d = a && a.ok
        ? await link.send({ type: 'EVIDENCE', to: String(order.counterparty), orderId, body: a.body })
        : await link.send({ type: 'REFUSE', to: String(order.counterparty), orderId,
          body: { refers_to: requestId, code: a ? (a.code === 'no_such_record' ? 'no_such_record' : 'not_kept') : 'declined_by_owner' } });
      if (!d.ok) failed = d;
      else if (a && a.ok) shared += 1;
    }
    const params = { ref: refOf(orderId), who: otherWho(orderId) };
    if (failed) return deliveryResult(failed, answer === 'yes' ? 'evidence.shared' : 'evidence.declined_sent', params);
    if (answer === 'no') return ok('evidence.declined_sent', params);
    return shared ? ok('evidence.shared', params) : no('evidence.not_kept_own', { ref: refOf(orderId) });
  }

  /**
   * The other side refused one of our requests after asking its owner. Told once per order, when no
   * request of ours there is still waiting; no reason asked for, no reminder.
   * @param {Message} m
   */
  async function onRefused(m) {
    const req = ledger.eventOfMessage(m.body.refers_to);
    if (!req || req.direction !== 'out' || req.type !== 'EVIDENCE_REQUEST' || req.orderId !== m.order_id) return;
    const events = ledger.events(m.order_id);
    const requests = new Set(events.filter((e) => e.direction === 'out' && e.type === 'EVIDENCE_REQUEST').map((e) => e.msgId));
    const answers = events.filter((e) => e.direction === 'in' && (e.type === 'EVIDENCE' || e.type === 'REFUSE') && requests.has(e.body.body.refers_to));
    const answered = new Set(answers.map((e) => e.body.body.refers_to));
    // Only the last answer tells, so two refused photos make one message.
    if ([...requests].some((id) => !answered.has(id)) || answers.at(-1)?.msgId !== m.msg_id) return;
    const params = { ref: refOf(m.order_id), who: otherWho(m.order_id) };
    await o.tell(ownerRole, m.body.code === 'declined_by_owner' ? 'evidence.declined' : 'evidence.unavailable', m.body.code === 'declined_by_owner' ? params : { ref: params.ref });
  }

  /** The owner's yes / no to a request for their photos; asked only by askOwner's question. @type {Record<string, Tool>} */
  const tools = {
    share_evidence: { roles: [ownerRole], commits: true, run: (person, a) => answerRequests(person, String(a.orderId), 'yes') },
    decline_evidence: { roles: [ownerRole], commits: true, run: (person, a) => answerRequests(person, String(a.orderId), 'no') },
  };

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
      const who = otherWho(m.order_id);
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

  return { requestLatest, countDifference, disputedBill, onApplied, onEvidence, tools };
}

/** Image failure falls back to the same code caption through the normal text/window path.
 * @param {{image: {bytes: Uint8Array, mime: string}, caption: string,
 *   sendImage: (image: {bytes: Uint8Array, mime: string}, caption: string) => Promise<{ok:boolean}>,
 *   sendText: (text: string) => Promise<unknown>}} o */
export async function forwardEvidence(o) {
  try { if ((await o.sendImage(o.image, o.caption)).ok) return; } catch { /* Text still carries provenance. */ }
  await o.sendText(o.caption);
}
