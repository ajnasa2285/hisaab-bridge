// One person's conversation with their agent. A text becomes one proposed step (Muse Spark, via the
// orchestrator); a step the model understood from free words is read back and runs only after the
// person says yes. A person's own exact reply to a request open for them ("हाँ 380", "नहीं", "30-10",
// "बिल", typed figures; src/agents/replies.js) is their decision and runs at once, with one receipt.
// A supervisor's request that waits for the contractor's approval goes to the contractor without a
// read-back: the contractor's OK is the check (docs/BUILD2.md "Fewer steps").
// Any photo, any time: Muse Spark first says what it is (meter, UPI, challan, other); code checks that
// this person may send that kind here, and only then that kind's reader reads it (an unsure kind is
// asked). A clear reading with every figure, that code finds consistent, is recorded at once with a
// receipt; an unclear one, a missing figure or a mismatch is read back or typed by the person.
// Exact commands (status, pending, stock, ok, no) are answered by code before the model sees
// anything, and every committing step passes the site office's gate (approvals with limits,
// src/agents/office.js). A request with a value left out (site, day, quantity, unit) is kept, and only
// what is missing is asked; the reply fills it, nothing is guessed. A question about the person's own
// records is answered read-only (src/agents/ask.js): no read-back, nothing committed.
// People decide; the model only proposes.

import { createHash } from 'node:crypto';
import { fillStep, proposeStep, orderRefs, pickOrder } from '../orchestrator/orchestrator.js';
import { parseHundredthsList } from '../orchestrator/units.js';
import { meterReadings } from './jcb.js';
import { challanQuantities, countDifferences, delivery, requestedItems, sameChallanNo, siteCount } from './material.js';
import { exactReply, yesNo } from './replies.js';
import { openRefs, parseRef } from '../ledger/refs.js';
import { runTool } from './common.js';
import { parseCommand } from './office.js';
import { answerQuestion } from './ask.js';
import { day as dayName, qty as qtyText, rupees } from '../i18n/format.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {(person: Person, key: string, params?: Record<string, string | number>) => Promise<void> | void} Reply */
/**
 * @typedef {{kind: 'confirm', tool: string, args: Record<string, any>, at: number} |
 *   {kind: 'meter_digits', orderId: string, which: 'start' | 'end', sha256: string, takenAt: string | null, at: number} |
 *   {kind: 'challan_figures', orderId: string, sha256: string, challanNo: string | null, at: number} |
 *   {kind: 'site_challan_order', orderIds: string[], sha256: string, reading: SiteReading, at: number} |
 *   {kind: 'site_challan_figures', orderId: string, sha256: string, challanNo: string | null, at: number} |
 *   {kind: 'fill', tool: string, raw: Record<string, any>, args: Record<string, any>, missing: string[], said: string, at: number} |
 *   {kind: 'photo_kind', image: Photo, at: number}} Pending
 */
/** @typedef {{mime: string, bytes: Uint8Array, takenAt?: string | null}} Photo */
/** @typedef {'meter' | 'upi' | 'challan'} PhotoKind */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) =>
 *   Promise<import('../readers/photo.js').PhotoClassification>} PhotoClassifier */
/** @typedef {{challanNo: string | null, items: {name: string, qtyHundredths: number | null, raw: string}[], clear: boolean}} SiteReading */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'challan', challanNo: string | null, date: string | null,
 *     items: {name: string, qtyHundredths: number | null, unit: string | null, raw: string}[], clear: boolean, signed?: boolean | null} |
 *   {ok: true, kind: 'not_challan'} | {ok: false, transient: boolean, reason: string}>} ChallanReader */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'hour_meter', raw: string, valueTenths: number | null, clear: boolean} | {ok: true, kind: 'not_meter'} |
 *   {ok: false, transient: boolean, reason: string}>} MeterReader */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'upi_payment', amountPaise: number | null, date: string | null, utr: string | null,
 *     clock?: string | null, status: 'success' | 'pending' | 'failed' | null, clear: boolean} | {ok: true, kind: 'not_upi'} |
 *   {ok: false, transient: boolean, reason: string}>} UpiReader */

const PENDING_MS = 30 * 60 * 1000;
// A short yes or no, typed or spoken ("हाँ जी", "ok bhej do", "नहीं चाहिए"; src/agents/replies.js).
const YES = { has: (/** @type {string} */ said) => yesNo(said) === 'yes' };
const NO = { has: (/** @type {string} */ said) => yesNo(said) === 'no' };
const HELP = new Set(['मदद', 'help', 'madad', '?']);
/** The replies to "यह फ़ोटो क्या है?"; the first of each is the form asked for. @type {Record<PhotoKind, string[]>} */
const KIND_WORDS = {
  meter: ['मीटर', 'meter', 'mitar'],
  upi: ['upi', 'यूपीआई', 'भुगतान', 'payment', 'bhugtan'],
  challan: ['चालान', 'चलान', 'challan', 'chalan'],
};
/** @param {string} said @returns {PhotoKind | null} */
const kindOfWord = (said) => /** @type {PhotoKind | null} */ (Object.entries(KIND_WORDS).find(([, w]) => w.includes(said))?.[0] ?? null);
/** @param {string} mime */
const isImageMime = (mime) => mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';

/** @param {string} text */
const norm = (text) => text.trim().toLowerCase().replace(/[।.!?,]+$/u, '').replace(/\s+/g, ' ');

/**
 * @param {{
 *   ledger: ReturnType<typeof import('../ledger/store.js').openLedger>,
 *   tools: Record<string, Tool>,
 *   spark: import('../orchestrator/orchestrator.js').Spark,
 *   readMeter?: MeterReader,
 *   readUpi?: UpiReader,
 *   readChallan?: ChallanReader,
 *   classifyPhoto?: PhotoClassifier,
 *   reply: Reply,
 *   now: () => number,
 *   office?: ReturnType<typeof import('./office.js').createOffice>,
 * }} o
 */
export function createConversation(o) {
  /** @type {Map<string, Pending>} */
  const pending = new Map();
  /** The receiver's mark on a site challan photo, by its sha256 (see rememberSigned). @type {Map<string, boolean | null>} */
  const signedOf = new Map();
  /** @param {Person} p */
  const keyOf = (p) => `${p.agent}|${p.line}|${p.phone}`;

  /** @param {Person} person @returns {Pending | null} */
  function current(person) {
    const p = pending.get(keyOf(person));
    if (!p) return null;
    if (o.now() - p.at > PENDING_MS) {
      pending.delete(keyOf(person));
      return null;
    }
    return p;
  }

  /**
   * Asks the person to confirm a committing step, or runs one that commits nothing.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   * @param {{key: string, params?: Record<string, string | number>}} [readBack] instead of the tool's own read-back
   */
  async function propose(person, tool, args, readBack) {
    const t = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (!t) return o.reply(person, 'common.unknown_step');
    if (!t.roles.includes(person.role)) return o.reply(person, 'common.not_allowed');
    if (!t.commits || !t.describe) {
      const r = await runTool(o.tools, person, { tool, args });
      return o.reply(person, r.key, r.params);
    }
    // A supervisor's request that waits for the contractor's approval is not read back: the
    // contractor's OK is the check, and the supervisor is told what went for approval.
    if (o.office && o.office.holds(person, tool, args)) return commitNow(person, tool, args);
    pending.set(keyOf(person), { kind: 'confirm', tool, args, at: o.now() });
    const d = readBack ?? t.describe(args);
    return o.reply(person, d.key, d.params);
  }

  /**
   * Runs a committing step now, through the office's gate, and says what was recorded: the person's
   * own exact reply, a clear photo reading code found consistent, or a step held for approval.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   */
  async function commitNow(person, tool, args) {
    const t = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (!t) return o.reply(person, 'common.unknown_step');
    if (!t.roles.includes(person.role)) return o.reply(person, 'common.not_allowed');
    const r = o.office ? await o.office.commit(person, tool, args) : await runTool(o.tools, person, { tool, args });
    // Once the site's count is recorded, nobody else's count question on that order stays open.
    if (r.ok && tool === 'confirm_count') {
      for (const [k, q] of pending) if (q.kind === 'confirm' && q.tool === 'confirm_count' && q.args.orderId === args.orderId) pending.delete(k);
    }
    return o.reply(person, r.key, r.params);
  }

  /**
   * @param {Person} person
   * @param {string} text
   */
  async function onText(person, text) {
    const said = norm(text);
    // An exact command is answered first and leaves any open question as it was: a command always
    // has a command word, so it is never a figure, and typed figures are never a command.
    const command = o.office ? parseCommand(text) : null;
    if (command && o.office) {
      const r = await o.office.command(person, command);
      if (r) {
        // A decision ends the decider's open yes/no question, so a later "हाँ" cannot answer it by accident.
        if (command.cmd === 'ok' || command.cmd === 'no') pending.delete(keyOf(person));
        return o.reply(person, r.key, r.params);
      }
    }
    const p = current(person);
    if (p && p.kind === 'photo_kind') {
      pending.delete(keyOf(person));
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
      const kind = kindOfWord(said);
      if (kind) return routePhoto(person, p.image, kind);
      // Not an answer: the question lapses, the photo with it, and the message is read as a new one.
    }
    if (p && p.kind === 'confirm') {
      if (YES.has(said)) {
        pending.delete(keyOf(person));
        return commitNow(person, p.tool, p.args);
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      // A meter read-back can be answered with the right digits: the person's own figure, recorded at once.
      const digits = /^(\d{1,7})(?:\.(\d))?$/.exec(said);
      if (p.tool === 'record_meter' && digits) {
        pending.delete(keyOf(person));
        return commitNow(person, 'record_meter', { ...p.args, valueTenths: Number(digits[1]) * 10 + Number(digits[2] ?? '0') });
      }
      // A challan read-back or a delivery count can be answered with the right quantities, in order.
      const figures = parseHundredthsList(said);
      if (figures && p.tool === 'record_delivery') {
        pending.delete(keyOf(person));
        return proposeDelivery(person, { orderId: p.args.orderId, sha256: p.args.sha256, challanNo: p.args.challanNo ?? null }, figures);
      }
      if (figures && p.tool === 'confirm_count' && p.args.challan) {
        pending.delete(keyOf(person));
        return proposeSiteCount(person, { orderId: p.args.orderId, sha256: p.args.challan.sha256, challanNo: p.args.challan.number ?? null }, figures, 'typed');
      }
      if (figures && p.tool === 'confirm_count') {
        pending.delete(keyOf(person));
        return commitNow(person, 'confirm_count', { orderId: p.args.orderId, qtysHundredths: figures });
      }
      // Anything else: the question lapses and the message is read as a new one.
      pending.delete(keyOf(person));
    }
    if (p && p.kind === 'challan_figures') {
      const figures = parseHundredthsList(said);
      if (figures) {
        pending.delete(keyOf(person));
        return proposeDelivery(person, p, figures);
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      pending.delete(keyOf(person));
    }
    if (p && p.kind === 'site_challan_order') {
      const want = parseRef(text);
      if (want !== null) {
        const r = orderRefs(o.ledger).find((x) => x.ref === want && p.orderIds.includes(x.orderId));
        if (!r) return askOrder(person, p.orderIds);
        pending.delete(keyOf(person));
        return siteCountFromRead(person, r.orderId, p.sha256, p.reading);
      }
      pending.delete(keyOf(person));
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
    }
    if (p && p.kind === 'site_challan_figures') {
      const figures = parseHundredthsList(said);
      pending.delete(keyOf(person));
      if (figures) return proposeSiteCount(person, p, figures, 'typed');
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
    }
    if (p && p.kind === 'meter_digits') {
      const m = /^(\d{1,7})(?:\.(\d))?$/.exec(said);
      if (m) {
        pending.delete(keyOf(person));
        const valueTenths = Number(m[1]) * 10 + Number(m[2] ?? '0');
        // The person typed the reading from the meter: their own figure, recorded at once.
        return commitNow(person, 'record_meter', { orderId: p.orderId, which: p.which, valueTenths, sha256: p.sha256, takenAt: p.takenAt });
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      pending.delete(keyOf(person));
    }
    if (p && p.kind === 'fill') {
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      if (!HELP.has(said)) {
        const r = await fillStep({ spark: o.spark, person, text, orders: orderRefs(o.ledger), nowMs: o.now(), pending: p });
        // The model could not be reached: the question stays open for the same reply again.
        if (r && r.kind === 'none' && r.key === 'orchestrator.try_again') return o.reply(person, r.key);
        pending.delete(keyOf(person));
        if (r) return onProposal(person, p.said, r);
      }
      // Not an answer: the question lapses and the message is read as a new one.
      pending.delete(keyOf(person));
    }
    if (HELP.has(said)) return o.reply(person, `help.${person.role}`);

    // A person's exact reply to a request open for them is read by code and runs at once.
    const exact = exactReply({ ledger: o.ledger, person, text, nowMs: o.now() });
    if (exact && exact.kind === 'ask') return o.reply(person, exact.key, exact.params);
    if (exact) return commitNow(person, exact.tool, exact.args);

    const proposal = await proposeStep({ spark: o.spark, person, text, orders: orderRefs(o.ledger), nowMs: o.now(), ask: true });
    if (proposal.kind === 'ask') {
      // Read-only: the answer is only said; it never becomes a step, a pending question or a ledger entry.
      const r = await answerQuestion({ spark: o.spark, ledger: o.ledger, person, question: text, nowMs: o.now() });
      return o.reply(person, r.key, r.params);
    }
    return onProposal(person, text, proposal);
  }

  /**
   * @param {Person} person @param {string} text the message the step came from (the first one, across a second question)
   * @param {import('../orchestrator/orchestrator.js').Proposal} proposal
   */
  function onProposal(person, text, proposal) {
    if (proposal.kind === 'help') return o.reply(person, `help.${person.role}`);
    if (proposal.kind === 'none') return o.reply(person, proposal.key);
    if (proposal.kind === 'ask') return o.reply(person, 'common.unknown_step');
    if (proposal.kind === 'missing') {
      pending.set(keyOf(person), { kind: 'fill', tool: proposal.tool, raw: proposal.raw, args: proposal.args, missing: proposal.missing, said: text, at: o.now() });
      return o.reply(person, 'ask.missing', { questions: askText(proposal.args, proposal.missing) });
    }
    return propose(person, proposal.tool, proposal.args);
  }

  /**
   * One short question naming only what is missing, in the order site, day, then each item.
   * @param {Record<string, any>} args what is already understood @param {string[]} missing
   */
  function askText(args, missing) {
    const lines = [];
    if (missing.includes('site')) lines.push(t('ask.site'));
    if (missing.includes('day')) lines.push(t('ask.day'));
    for (const [i, it] of (Array.isArray(args.items) ? args.items : []).entries()) {
      const noQty = missing.includes(`qty:${i}`);
      const noUnit = missing.includes(`unit:${i}`);
      if (noQty && noUnit) lines.push(t('ask.qty_unit', { name: it.name }));
      else if (noQty) lines.push(t('ask.qty', { name: it.name, unit: it.unit }));
      else if (noUnit) lines.push(t('ask.unit', { name: it.name, qty: qtyText(it.qtyHundredths, '').trim() }));
    }
    return lines.join('\n');
  }

  /** May this person take this step on this agent? @param {Person} person @param {string} tool */
  const may = (person, tool) => Object.hasOwn(o.tools, tool) && o.tools[tool].roles.includes(person.role);

  /**
   * The kinds of photo this person may send on this agent: meter readings (operator, JCB owner), UPI
   * screenshots (contractor), challans (supplier; supervisor or contractor for the site's own copy).
   * @param {Person} person @returns {PhotoKind[]}
   */
  function photoKinds(person) {
    /** @type {PhotoKind[]} */
    const kinds = [];
    if (o.readMeter && may(person, 'record_meter')) kinds.push('meter');
    if (o.readUpi && may(person, 'claim_payment')) kinds.push('upi');
    if (o.readChallan && (may(person, 'record_delivery') || may(person, 'confirm_count'))) kinds.push('challan');
    return kinds;
  }

  /** "मीटर, UPI भुगतान" @param {PhotoKind[]} kinds */
  const kindNames = (kinds) => kinds.map((k) => t(`photo.kind.${k}`)).join(', ') || '—';

  /**
   * Any photo, any time: Muse Spark says what it is, then only that kind's reader reads it. An unsure
   * kind is asked ("यह फ़ोटो क्या है?") with the photo kept in memory as long as any open question.
   * A new photo starts its own flow: a question still open lapses, as it does for a new text.
   * @param {Person} person @param {Photo} image
   */
  async function onImage(person, image) {
    pending.delete(keyOf(person));
    const kinds = photoKinds(person);
    if (kinds.length === 0) return o.reply(person, 'photo.none');
    if (!isImageMime(image.mime)) return o.reply(person, 'photo.other', { kinds: kindNames(kinds) });
    if (!o.classifyPhoto) return o.reply(person, 'orchestrator.try_again');
    const c = await o.classifyPhoto({ mime: /** @type {'image/jpeg'} */ (image.mime), bytes: image.bytes });
    if (!c.ok) return o.reply(person, 'orchestrator.try_again');
    if (!c.clear) {
      pending.set(keyOf(person), { kind: 'photo_kind', image, at: o.now() });
      return o.reply(person, 'photo.ask_kind', { forms: kinds.map((k) => `"${KIND_WORDS[k][0].toUpperCase()}"`).join(' / ') });
    }
    if (c.kind === 'other') return o.reply(person, 'photo.other', { kinds: kindNames(kinds) });
    return routePhoto(person, image, c.kind);
  }

  /**
   * A photo whose kind is known (seen by Muse Spark, or said by the person) goes to that kind's flow
   * if this person may send it here; otherwise they are told who sends it, and nothing is read.
   * @param {Person} person @param {Photo} image @param {PhotoKind} kind
   */
  function routePhoto(person, image, kind) {
    const kinds = photoKinds(person);
    if (!kinds.includes(kind)) return o.reply(person, `photo.sent_by_${kind}`, { kinds: kindNames(kinds) });
    if (kind === 'meter') return onMeterImage(person, image);
    if (kind === 'upi') return onPaymentImage(person, image);
    return may(person, 'record_delivery') ? onChallanImage(person, image) : onSiteChallanImage(person, image);
  }

  /**
   * A meter photo from the JCB side is a meter reading for the job that is booked or working.
   * @param {Person} person @param {Photo} image
   */
  async function onMeterImage(person, image) {
    if (!o.readMeter) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'meter.not_meter');
    const picked = pickOrder(orderRefs(o.ledger), null, ['booked', 'working']);
    if (typeof picked === 'string') return o.reply(person, picked === 'common.wrong_state' ? 'orchestrator.no_job_for_photo' : picked);
    const r = meterReadings(o.ledger.events(picked.orderId));
    const which = r.start ? 'end' : 'start';
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const takenAt = image.takenAt ?? null;
    const read = await o.readMeter({ mime: image.mime, bytes: image.bytes });
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_meter') return o.reply(person, 'meter.not_meter');
    if (!read.clear || read.valueTenths === null) {
      pending.set(keyOf(person), { kind: 'meter_digits', orderId: picked.orderId, which, sha256, takenAt, at: o.now() });
      return o.reply(person, read.raw ? 'meter.ask_person' : 'meter.ask_person_blank', { raw: read.raw });
    }
    const args = { orderId: picked.orderId, which, valueTenths: read.valueTenths, sha256, takenAt };
    // Code's check: an end reading must be above the start (and a start below an end). A reading that
    // fails it is read back, so the person can type the right digits; a clear one is recorded at once.
    const mismatch = which === 'end' ? r.start !== null && read.valueTenths <= r.start.valueTenths : r.end !== null && read.valueTenths >= r.end.valueTenths;
    return mismatch ? propose(person, 'record_meter', args) : commitNow(person, 'record_meter', args);
  }

  /**
   * A photo from the supplier is the challan of the order that is booked and not yet delivered. The
   * model reads it; code matches what it read to the order's items; the supplier confirms what was
   * read, or types the quantities when the photo is not clear.
   * @param {Person} person
   * @param {{mime: string, bytes: Uint8Array}} image
   */
  async function onChallanImage(person, image) {
    if (!o.readChallan) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'challan.not_challan');
    const picked = pickOrder(orderRefs(o.ledger), null, ['booked']);
    if (typeof picked === 'string') return o.reply(person, picked === 'common.wrong_state' ? 'challan.no_order_for_photo' : picked);
    const items = requestedItems(o.ledger.events(picked.orderId));
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const read = await o.readChallan({ mime: image.mime, bytes: image.bytes });
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_challan') return o.reply(person, 'challan.not_challan');
    const challanNo = typeof read.challanNo === 'string' && read.challanNo.trim() ? read.challanNo.trim().slice(0, 40) : null;
    const qtys = challanQuantities(items, read.items);
    if (!read.clear || qtys.some((q) => q === null)) {
      pending.set(keyOf(person), { kind: 'challan_figures', orderId: picked.orderId, sha256, challanNo, at: o.now() });
      return askQuantities(person, picked.orderId, read.items.map((i) => i.raw).filter(Boolean).join(', '));
    }
    return proposeDelivery(person, { orderId: picked.orderId, sha256, challanNo }, /** @type {number[]} */ (qtys));
  }

  /**
   * Asks the supplier to type the delivered quantities, one per ordered item, in order.
   * @param {Person} person @param {string} orderId @param {string} raw what the reader saw, if anything
   */
  function askQuantities(person, orderId, raw) {
    const items = requestedItems(o.ledger.events(orderId)).map((i) => `${i.name} (${i.unit})`).join(', ');
    return o.reply(person, raw ? 'challan.ask_person' : 'challan.ask_person_blank', { raw, items });
  }

  /**
   * A delivery: one quantity per ordered item, in order; an item at 0 was not delivered. A clear
   * reading of every item, or the figures the supplier typed, is recorded at once (the site's own
   * count checks it downstream). Typed figures that do not fit the order are asked for again.
   * @param {Person} person
   * @param {{orderId: string, sha256: string, challanNo: string | null}} c
   * @param {number[]} qtys
   */
  function proposeDelivery(person, c, qtys) {
    const ordered = requestedItems(o.ledger.events(c.orderId));
    if (qtys.length !== ordered.length || qtys.every((q) => q === 0)) {
      pending.set(keyOf(person), { kind: 'challan_figures', ...c, at: o.now() });
      return askQuantities(person, c.orderId, '');
    }
    const items = ordered.map((it, i) => ({ name: it.name, qtyHundredths: qtys[i], unit: it.unit })).filter((it) => it.qtyHundredths > 0);
    return commitNow(person, 'record_delivery', { orderId: c.orderId, items, sha256: c.sha256, challanNo: c.challanNo });
  }

  /** The material orders waiting for the site's count: booked or delivered, not yet counted. */
  function uncounted() {
    return orderRefs(o.ledger).filter((r) => (r.state === 'booked' || r.state === 'delivered')
      && /** @type {{kind: string} | null} */ (o.ledger.order(r.orderId))?.kind === 'material'
      && siteCount(o.ledger.events(r.orderId)) === null);
  }

  /** @param {string} orderId */
  const refOf = (orderId) => openRefs(o.ledger).refOf(orderId) ?? '—';
  /** "बालू (cft), सीमेंट (बोरी)" @param {string} orderId */
  const namesOf = (orderId) => requestedItems(o.ledger.events(orderId)).map((i) => `${i.name} (${i.unit})`).join(', ') || '—';

  /**
   * A photo of the site's own copy of the challan (supervisor or contractor) is the site's record of
   * what arrived for a material order not yet counted. The model reads it; code matches what it read
   * to the order's items; the person confirms with "हाँ" or types the figures. It becomes the site's
   * count with the photo's fingerprint as evidence, compared with the supplier's signed DELIVERY.
   * @param {Person} person
   * @param {{mime: string, bytes: Uint8Array}} image
   */
  async function onSiteChallanImage(person, image) {
    if (!o.readChallan) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'challan.not_challan');
    const open = uncounted();
    if (open.length === 0) return o.reply(person, 'site.challan_no_order');
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const read = await o.readChallan({ mime: image.mime, bytes: image.bytes });
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_challan') return o.reply(person, 'challan.not_challan');
    const challanNo = typeof read.challanNo === 'string' && read.challanNo.trim() ? read.challanNo.trim().slice(0, 40) : null;
    rememberSigned(sha256, read.signed);
    /** @type {SiteReading} */
    const reading = { challanNo, items: read.items, clear: read.clear };
    if (open.length > 1) {
      pending.set(keyOf(person), { kind: 'site_challan_order', orderIds: open.map((r) => r.orderId), sha256, reading, at: o.now() });
      return askOrder(person, open.map((r) => r.orderId));
    }
    return siteCountFromRead(person, open[0].orderId, sha256, reading);
  }

  /**
   * Whether the reader saw the receiver's mark on a site challan photo, by the photo's fingerprint, so
   * every later step for that photo (which order, typed figures) carries it. A reader that does not
   * report it leaves nothing. Bounded: oldest go first.
   * @param {string} sha256 @param {unknown} signed
   */
  function rememberSigned(sha256, signed) {
    signedOf.delete(sha256);
    if (signed === undefined) return;
    signedOf.set(sha256, typeof signed === 'boolean' ? signed : null);
    while (signedOf.size > 200) signedOf.delete(/** @type {string} */ (signedOf.keys().next().value));
  }

  /**
   * Which order is this challan for? Lists the orders with their references, the exact reply form.
   * @param {Person} person @param {string[]} orderIds
   */
  function askOrder(person, orderIds) {
    const lines = orderRefs(o.ledger).filter((r) => orderIds.includes(r.orderId))
      .map((r) => t('site.challan_order_line', { ref: r.ref, site: r.site, what: r.what ?? '—' })).join('\n');
    return o.reply(person, 'site.challan_which_order', { lines });
  }

  /**
   * What the reader saw, as the site's count of this order: recorded at once when every item was read
   * clearly and agrees with the supplier's signed delivery (if it has come); read back when it differs;
   * else the person types the figures. Nothing is filled in.
   * @param {Person} person @param {string} orderId @param {string} sha256 @param {SiteReading} reading
   */
  function siteCountFromRead(person, orderId, sha256, reading) {
    const qtys = challanQuantities(requestedItems(o.ledger.events(orderId)), reading.items);
    if (!reading.clear || qtys.some((q) => q === null)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId, sha256, challanNo: reading.challanNo, at: o.now() });
      const raw = reading.items.map((i) => i.raw).filter(Boolean).join(', ');
      return o.reply(person, raw ? 'site.challan_ask_person' : 'site.challan_ask_person_blank', { ref: refOf(orderId), raw, names: namesOf(orderId) });
    }
    return proposeSiteCount(person, { orderId, sha256, challanNo: reading.challanNo }, /** @type {number[]} */ (qtys), 'read');
  }

  /**
   * The site's count from its challan: one figure per ordered item, in order (0 = did not come).
   * Figures the reader saw (`read`) are recorded at once unless they differ from the supplier's signed
   * delivery (quantities, or both challan numbers known and different): then they are read back, and a
   * bare "हाँ" records a first count only. Figures the person typed are their own and recorded at once.
   * Typed figures that do not fit the order are asked for again.
   * @param {Person} person
   * @param {{orderId: string, sha256: string, challanNo: string | null}} c
   * @param {number[]} qtys
   * @param {'read' | 'typed'} from
   */
  function proposeSiteCount(person, c, qtys, from) {
    const ordered = requestedItems(o.ledger.events(c.orderId));
    if (qtys.length !== ordered.length || qtys.every((q) => q === 0)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId: c.orderId, sha256: c.sha256, challanNo: c.challanNo, at: o.now() });
      return o.reply(person, 'site.challan_ask_person_blank', { ref: refOf(c.orderId), names: namesOf(c.orderId) });
    }
    /** @type {Record<string, any>} */
    const args = { orderId: c.orderId, qtysHundredths: qtys, challan: { sha256: c.sha256, number: c.challanNo, ...(signedOf.has(c.sha256) ? { signed: signedOf.get(c.sha256) } : {}) } };
    if (from === 'typed') return commitNow(person, 'confirm_count', args);
    args.sameAsChallan = true;
    const d = delivery(o.ledger.events(c.orderId));
    const counted = ordered.map((it, i) => ({ name: it.name, unit: it.unit, qtyHundredths: qtys[i] })).filter((it) => it.qtyHundredths > 0);
    const differs = d !== null && (countDifferences(counted, d.items).length > 0 || (c.challanNo !== null && d.number !== null && !sameChallanNo(c.challanNo, d.number)));
    return differs ? propose(person, 'confirm_count', args) : commitNow(person, 'confirm_count', args);
  }

  /**
   * A UPI screenshot from the contractor is a payment claim for the accepted bill. The model reads
   * it; a clear reading of a successful payment for the bill's amount is sent at once (the seller
   * confirms the money arrived); a different amount is read back first with both figures.
   * @param {Person} person
   * @param {{mime: string, bytes: Uint8Array}} image
   */
  async function onPaymentImage(person, image) {
    if (!o.readUpi) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'payment.not_upi');
    const picked = pickOrder(orderRefs(o.ledger), null, ['accepted', 'payment_claimed']);
    if (typeof picked === 'string') return o.reply(person, picked);
    const read = await o.readUpi({ mime: image.mime, bytes: image.bytes });
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_upi') return o.reply(person, 'payment.not_upi');
    const day = read.date && /^\d{4}-\d{2}-\d{2}$/.test(read.date) ? read.date : null;
    if (!read.clear || read.amountPaise === null || !read.utr || day === null) return o.reply(person, 'payment.retake');
    if (read.status !== 'success') {
      return o.reply(person, 'payment.read', {
        amount: rupees(read.amountPaise), utr: read.utr, day: dayName(day), status: t(`payment.status.${read.status ?? 'unknown'}`),
      });
    }
    /** @type {Record<string, any>} */
    const args = { orderId: picked.orderId, amountPaise: read.amountPaise, utr: read.utr, paidOn: day, screenshotSha256: createHash('sha256').update(image.bytes).digest('hex') };
    // The receipt's clock (HH:MM) goes with the claim only when it was printed and read.
    if (typeof read.clock === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(read.clock)) args.paidAt = read.clock;
    const bill = o.ledger.view(picked.orderId).currentBill;
    const total = bill ? o.ledger.eventOfMessage(bill)?.body.body.totalPaise : undefined;
    // A different amount is not refused (part payments happen); the contractor sees both figures first.
    if (Number.isSafeInteger(total) && total !== read.amountPaise) {
      return propose(person, 'claim_payment', args, { key: 'payment.amount_differs', params: { seen: rupees(read.amountPaise), total: rupees(/** @type {number} */ (total)) } });
    }
    return commitNow(person, 'claim_payment', args);
  }

  /**
   * After a notice that asks this person a yes/no question: a plain "yes" runs this step.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   */
  function expect(person, tool, args) {
    pending.set(keyOf(person), { kind: 'confirm', tool, args, at: o.now() });
  }

  return { onText, onImage, expect, pending: (/** @type {Person} */ p) => current(p) };
}
