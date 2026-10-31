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
// A meter photo is checked before anything is recorded: a forwarded one is refused, Muse Spark
// compares it with the other reading's photo (same machine?), and a date on the display must be the
// job's (src/agents/meter-guard.js).
// Exact commands (status, pending, stock, ok, no) are answered by code before the model sees
// anything, and every committing step passes the site office's gate (approvals with limits,
// src/agents/office.js). A request with a value left out (site, day, quantity, unit) is kept, and only
// what is missing is asked; the reply fills it, nothing is guessed. A question about the person's own
// records is answered read-only (src/agents/ask.js): no read-back, nothing committed.
// One question is open per person: a notice that asks something while another question is open waits
// in that person's queue and is asked when the open one is answered or lapses, so a bare हाँ always
// answers what the person was last asked. A yes/no older than the question is not an answer to it.
// One message may ask for material and the JCB together: one read-back, one "हाँ", two orders, each
// through the office's gate on its own. A request naming a site this agent does not know asks once
// which site it is, before the read-back; the answer is kept for everyone on this agent
// (src/agents/site-names.js). Code decides from exact matches only.
// A free-text message is first read as the answer to the person's latest open question, or to the
// question of the one reference it names (src/agents/open-questions.js); a message that is something
// else is handled as usual, and a question it set aside is asked again once.
// A meter or (supplier's) challan photo with several orders open is held as the open question: they are listed by number,
// reference, site and day, and a number or a reference (or a reference in the photo's caption) says which.
// People decide; the model only proposes.

import { createHash } from 'node:crypto';
import { answerOpen, fillStep, proposeStep, orderRefs, shareFilled } from '../orchestrator/orchestrator.js';
import { blank, parseHundredthsList, parseQuantity } from '../orchestrator/units.js';
import { impossible, meterReadings, MAX_JOB_TENTHS } from './jcb.js';
import { displayDateWrong, jobDay } from './meter-guard.js';
import { agreedRates, billLineNamed, challanQuantities, countDifferences, delivery, disputedItems, invoiceFromReading, itemsText, requestedItems, sameChallanNo, siteCount, unitFromOrder } from './material.js';
import { exactReply, saysCash, yesNo } from './replies.js';
import { balanceText, owedPaise, payableOrders, paymentLine, shares, summaryOf, todayIst, utrUses } from './pay.js';
import { openRefs, parseRef, refsIn } from '../ledger/refs.js';
import { no, plainRupees, runTool } from './common.js';
import { openQuestions } from './open-questions.js';
import { parseCommand } from './office.js';
import { cancelBlock } from './cancel.js';
import { siteKey } from './site-names.js';
import { traceCheck, tracePart } from '../trace/trace.js';
import { answerQuestion } from './ask.js';
import { day as dayName, qty as qtyText, rupees, tenths } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { plain, promptBlock, voiceParty } from '../learn/corrections.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('./common.js').Tool} Tool */
/** `missed`: what to remember if this could not be sent outside the 24-hour window (src/app.js sendTo).
 * @typedef {(person: Person, key: string, params?: Record<string, string | number>, missed?: {ref: string, key: string}) => Promise<void> | void} Reply */
/**
 * `notice`: a question the agent put to the person, not a read-back of their own step; `again`: it has been asked again once.
 * @typedef {{kind: 'confirm', tool: string, args: Record<string, any>, no?: {tool: string, args: Record<string, any>}, ask?: Asked, at: number, notice?: boolean, again?: boolean} |
 *   {kind: 'meter_digits', orderId: string, which: 'start' | 'end', sha256: string, takenAt: string | null, at: number} |
 *   {kind: 'challan_figures', orderId: string, sha256: string, challanNo: string | null, invoice?: Invoice | null, at: number} |
 *   {kind: 'site_challan_order', orderIds: string[], sha256: string, reading: SiteReading, at: number} |
 *   {kind: 'site_challan_figures', orderId: string, sha256: string, challanNo: string | null, at: number} |
 *   {kind: 'fill', tool: string, raw: Record<string, any>, args: Record<string, any>, missing: string[], said: string, at: number, pair?: {parts: PairPart[], index: number}} |
 *   {kind: 'site_name', name: string, options: string[], steps: Step[], at: number} |
 *   {kind: 'two_requests', steps: Step[], at: number} |
 *   {kind: 'photo_kind', image: Photo, at: number} |
 *   {kind: 'meter_job' | 'challan_job', image: Photo, orderIds: string[], at: number} |
 *   {kind: 'pay_choice', orderIds: string[], group: boolean, amountPaise: number, base: Record<string, any>, at: number}} Pending
 */
/** @typedef {import('../orchestrator/orchestrator.js').PairPart} PairPart */
/** A request understood completely. @typedef {{tool: string, args: Record<string, any>}} Step */
/** The words of a question. @typedef {{key: string, params?: Record<string, string | number>}} Asked */
/** A question waiting for the open one to end. @typedef {{tool: string, args: Record<string, any>, no?: {tool: string, args: Record<string, any>}, ask?: Asked, again?: boolean}} Waiting */
/**
 * A payment typed without its proof yet ("P-3 अग्रिम ₹5,000"): the UPI screenshot that follows, or
 * "नकद", completes it. Kept apart from the open question, so the photo flow does not end it.
 * @typedef {{orderIds: string[] | null, amountPaise: number, at: number}} PayWait
 */
/** `forwarded`: WhatsApp marked the message as forwarded (src/wa/webhook.js); `caption`: the words sent with the photo.
 * @typedef {{mime: string, bytes: Uint8Array, takenAt?: string | null, forwarded?: boolean, caption?: string}} Photo */
/** @typedef {'meter' | 'upi' | 'challan' | 'cash_receipt'} PhotoKind */
/** @typedef {NonNullable<ReturnType<typeof invoiceFromReading>>} Invoice */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) =>
 *   Promise<import('../readers/photo.js').PhotoClassification>} PhotoClassifier */
/** `memory`: past corrections the reading had; `differs`: its figures differ from the reading without them.
 * @typedef {{challanNo: string | null, items: {name: string, qtyHundredths: number | null, raw: string}[], clear: boolean,
 *   onlyUnitMissing?: boolean, memory?: number, differs?: boolean}} SiteReading */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'challan', challanNo: string | null, date: string | null,
 *     items: {name: string, qtyHundredths: number | null, unit: string | null, raw: string}[], clear: boolean, onlyUnitMissing?: boolean, signed?: boolean | null} |
 *   {ok: true, kind: 'not_challan'} | {ok: false, transient: boolean, reason: string}>} ChallanReader */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'hour_meter', raw: string, valueTenths: number | null, clear: boolean, displayDate?: string | null} | {ok: true, kind: 'not_meter'} |
 *   {ok: false, transient: boolean, reason: string}>} MeterReader */
/** @typedef {(o: {a: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}, b: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}}) =>
 *   Promise<import('../readers/same-meter.js').SameMeter>} SameMeterCheck */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'upi_payment', amountPaise: number | null, date: string | null, utr: string | null,
 *     clock?: string | null, status: 'success' | 'pending' | 'failed' | null, clear: boolean, payeeName?: string | null} | {ok: true, kind: 'not_upi'} |
 *   {ok: false, transient: boolean, reason: string}>} UpiReader */
/** @typedef {typeof import('../readers/cash-receipt.js').readCashReceipt} CashReceiptReader */

const PENDING_MS = 30 * 60 * 1000;
const MAX_WAITING = 20;
/** A JCB day longer than this (12 h) is read back once before it counts. */
const LONG_JOB_TENTHS = 120;
// A short yes or no, typed or spoken ("हाँ जी", "ok bhej do", "नहीं चाहिए"; src/agents/replies.js).
const YES = { has: (/** @type {string} */ said) => yesNo(said) === 'yes' };
const NO = { has: (/** @type {string} */ said) => yesNo(said) === 'no' };
const HELP = new Set(['मदद', 'help', 'madad', '?']);
// Drops a held meter photo. Not a general "no": alone, to a seller, it must not decline an order at once.
const DROP_WORDS = new Set(['रद्द', 'रद', 'radd', 'कैंसल', 'कैंसिल']);
/** The replies to "यह फ़ोटो क्या है?"; the first of each is the form asked for. @type {Record<PhotoKind, string[]>} */
const KIND_WORDS = {
  meter: ['मीटर', 'meter', 'mitar'],
  upi: ['upi', 'यूपीआई', 'भुगतान', 'payment', 'bhugtan'],
  challan: ['चालान', 'चलान', 'challan', 'chalan'],
  cash_receipt: ['नकद पर्ची', 'नकद रसीद', 'नकद पर्चा', 'cash receipt', 'parchi', 'nakad parchi'],
};
/** @param {string} said @returns {PhotoKind | null} */
const kindOfWord = (said) => /** @type {PhotoKind | null} */ (Object.entries(KIND_WORDS).find(([, w]) => w.includes(said))?.[0] ?? null);
/** @param {string} mime */
const isImageMime = (mime) => mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';

/** @param {string} text */
const norm = (text) => text.trim().toLowerCase().replace(/[।.!?,]+$/u, '').replace(/\s+/g, ' ');
/** "१२" → "12" @param {string} s */
const latinDigits = (s) => s.replace(/[०-९]/gu, (d) => String(d.charCodeAt(0) - 0x0966));
// "भूल जाओ P-1": drop what was learnt from that order's corrections (owner or contractor).
const FORGET = /^(?:भूल\s*जाओ|भूल\s*जाइए|भूल\s*जाइये|bhool\s*jao|bhul\s*jao|forget)\s+(.+)$/iu;
const FORGET_ROLES = new Set(['jcb_owner', 'supplier', 'contractor']);
// The requests whose site name is checked, and the most recent sites a question shows.
const SITE_TOOLS = new Set(['request_material', 'request_jcb']);
const MAX_SITE_CHOICES = 6;
const NEW_SITE_WORDS = new Set(['नई साइट', 'नयी साइट', 'नई', 'नयी', 'new site', 'new', 'nayi site', 'nai site', 'nayi', 'nai']);
// "कितनी बार ग़लत पढ़ा गया?" (with or without the nukta, or in Latin letters): answered by code from the
// memory. Only a question: "how many" and no figure, so a dispute ("नहीं 5 घंटे, मीटर ग़लत पढ़ा") is never taken.
const MISREAD_Q = /^(?!.*[0-9०-९])(?=.*(?:कितन|kitn|how many))(?=.*(?:ग़?लत|galat|wrong))(?=.*(?:पढ|padh|read|सुन|sun))/iu;
/** Figures as people write them: hundredths "50" / "50.5", tenths "3677.7". */
const hundredthsText = (/** @type {number} */ q) => (q % 100 === 0 ? String(q / 100) : (q / 100).toFixed(2).replace(/0$/, ''));
const tenthsText = (/** @type {number} */ v) => `${Math.floor(v / 10)}.${v % 10}`;

/**
 * @param {{
 *   ledger: ReturnType<typeof import('../ledger/store.js').openLedger>,
 *   tools: Record<string, Tool>,
 *   spark: import('../orchestrator/orchestrator.js').Spark,
 *   readMeter?: MeterReader,
 *   sameMeter?: SameMeterCheck,
 *   readUpi?: UpiReader,
 *   readCashReceipt?: CashReceiptReader,
 *   readChallan?: ChallanReader,
 *   classifyPhoto?: PhotoClassifier,
 *   reply: Reply,
 *   now: () => number,
 *   office?: ReturnType<typeof import('./office.js').createOffice>,
 *   mediaStore?: ReturnType<typeof import('../media/store.js').openMediaStore>,
 *   log?: (line: string) => void,
 *   learn?: import('../learn/corrections.js').Learn,
 *   siteNames?: import('./site-names.js').SiteNames,
 *   peopleSites?: () => string[],
 * }} o
 * `learn`: this agent's own correction memory (src/learn/corrections.js); without it nothing is learnt.
 * `siteNames`: the site names this agent was told (src/agents/site-names.js); without it no site is asked about.
 * `peopleSites`: the sites people.json gives this agent's people.
 */
export function createConversation(o) {
  /** @type {Map<string, Pending>} */
  const pending = new Map();
  // Notices told again after a closed 24-hour window: which references, and when (replayed()).
  /** @type {Map<string, {refs: string[], at: number}>} */
  const replayedRefs = new Map();
  /** Questions waiting behind the open one, per person, oldest first. @type {Map<string, Waiting[]>} */
  const waiting = new Map();
  /** The receiver's mark on a site challan photo, by its sha256 (see rememberSigned). @type {Map<string, boolean | null>} */
  const signedOf = new Map();
  /** Bytes stay in memory until the person confirms the exact photo-based step. @type {Map<string, {image: Photo, sha256: string, at: number}>} */
  const photos = new Map();
  /** @param {Person} p */
  const keyOf = (p) => `${p.agent}|${p.line}|${p.phone}`;
  /** @type {Map<string, PayWait>} */
  const payWaits = new Map();
  /** @param {Person} person @returns {PayWait | null} */
  const payWait = (person) => {
    const w = payWaits.get(keyOf(person));
    if (w && o.now() - w.at <= PENDING_MS) return w;
    payWaits.delete(keyOf(person));
    return null;
  };

  // --- Learning from corrections (src/learn/corrections.js) -----------------------------------
  /**
   * @typedef {{kind: import('../learn/corrections.js').Kind, party: string, orderId: string, fields: string[],
   *   read: (string | null)[], scale: 'tenths' | 'hundredths', layout: (i: number) => string | null, memory: number}} ReadNote
   */
  /** What a photo reader read, by the photo's fingerprint, until the person's own figures for it are
   * committed (then each figure that differs is one correction). Bounded: oldest go first. @type {Map<string, ReadNote>} */
  const readOf = new Map();
  /** @param {string} sha256 @param {ReadNote} r */
  function rememberRead(sha256, r) {
    readOf.delete(sha256);
    readOf.set(sha256, r);
    while (readOf.size > 200) readOf.delete(/** @type {string} */ (readOf.keys().next().value));
  }
  /**
   * The person's own figures for a photo were committed: each that differs from what was read is
   * one correction, kept for the next reading of the same kind from the same party.
   * @param {string} sha256 @param {number[]} figures in the read's own scale and order
   */
  function learnFrom(sha256, figures) {
    const r = readOf.get(sha256);
    readOf.delete(sha256);
    if (!r || !o.learn) return;
    const fmt = r.scale === 'tenths' ? tenthsText : hundredthsText;
    let n = 0;
    for (const [i, read] of r.read.entries()) {
      if (read === null || typeof figures[i] !== 'number') continue;
      const row = o.learn.record({ kind: r.kind, party: r.party, field: r.fields[i], read, corrected: fmt(figures[i]),
        sha256, layout: r.layout(i), orderId: r.orderId, memory: r.memory });
      if (row) n++;
    }
    if (n === 0) return;
    traceCheck(r.memory > 0 ? `corrected again after using ${r.memory} past correction(s) ✗ → ${n} more kept` : `${n} correction(s) kept for the next ${r.kind} from ${r.party}`,
      r.memory === 0, { name: 'learn_correction', kind: r.kind, corrections: n, memory: r.memory }, r.orderId);
  }
  /**
   * One photo reading with this party's past corrections, when there are any: read with and without
   * them together (one wait); the reading with memory is used, and `differs` says whether its figures
   * differ from the reading without memory (or that one failed): then it is read back, never recorded
   * silently. Without past corrections (or memory off), one plain reading as before.
   * @template {{ok: boolean}} R
   * @param {import('../learn/corrections.js').Kind} kind @param {string} party @param {string | null} orderId
   * @param {(image: any, opts?: {memory?: string}) => Promise<R>} reader @param {any} photo
   * @param {(r: R) => string} figures what code compares
   * @returns {Promise<{read: R, memory: number, differs: boolean}>}
   */
  async function readLearned(kind, party, orderId, reader, photo, figures) {
    const past = o.learn ? o.learn.past({ kind, party }) : [];
    if (past.length === 0) return { read: await reader(photo), memory: 0, differs: false };
    const [withMemory, without] = await Promise.all([reader(photo, { memory: promptBlock(past) }), reader(photo)]);
    if (!withMemory.ok) return { read: without, memory: 0, differs: false };
    const differs = !without.ok || figures(withMemory) !== figures(without);
    o.learn?.noteReading({ kind, party, orderId, memory: past.length, differs });
    traceCheck(`used ${past.length} past correction(s) from ${party}: ${differs ? 'figures differ from the reading without them ✗ → read back' : 'same figures as without them ✓'}`,
      !differs, { name: 'learn_memory', kind, memory: past.length, differs }, orderId);
    return { read: withMemory, memory: past.length, differs };
  }
  /** Whose memory a reading uses: the order's counterparty for the site's copy of a supplier's challan
   * (the supplier printed it), else the sender's role on this agent.
   * @param {Person} person @param {string | null} orderId @param {boolean} site @returns {string} */
  const partyOf = (person, orderId, site) =>
    (site && orderId ? /** @type {{counterparty: string} | null} */ (o.ledger.order(orderId))?.counterparty : null) ?? person.role;
  /** A short note of the document's layout, made by code from the reading: its shape only, never its
   * words (printed text must not reach a later prompt).
   * @param {{items: {raw: string, ratePaise?: number | null}[]}} read */
  const layoutOf = (read) => () => `${read.items.length} line(s)${read.items.some((it) => typeof it.ratePaise === 'number') ? '; tax invoice' : ''}`;
  /**
   * Voice: the step understood from a voice note that the person did not commit as it was. When the
   * same tool is committed soon after with other words (site, item names) and the replaced word was
   * in the transcript, each replaced word is one voice correction.
   * @type {Map<string, {tool: string, args: Record<string, any>, heard: string, at: number}>}
   */
  const voiceSteps = new Map();
  /** The transcript of the voice note being handled, per person. @type {Map<string, string>} */
  const voiceNow = new Map();
  /** @param {Person} person @param {string} tool @param {Record<string, any>} args */
  function learnVoice(person, tool, args) {
    const v = voiceSteps.get(keyOf(person));
    if (!v) return;
    voiceSteps.delete(keyOf(person));
    if (!o.learn || v.tool !== tool || v.args === args || o.now() - v.at > PENDING_MS) return;
    /** @type {[string, unknown, unknown][]} */
    const pairs = [['site', v.args.site, args.site]];
    const a = Array.isArray(v.args.items) ? v.args.items : [], b = Array.isArray(args.items) ? args.items : [];
    if (a.length === b.length) for (const [i, it] of a.entries()) pairs.push([`item:${i}`, it?.name, b[i]?.name]);
    let n = 0;
    for (const [field, heard, said] of pairs) {
      if (typeof heard !== 'string' || typeof said !== 'string' || heard === said || !v.heard.normalize('NFC').includes(heard.normalize('NFC'))) continue;
      if (o.learn.record({ kind: 'voice', party: voiceParty(person), field, read: heard, corrected: said, orderId: typeof args.orderId === 'string' ? args.orderId : null })) n++;
    }
    if (n) traceCheck(`${n} voice word(s) corrected by the person, kept (used once confirmed twice)`, true, { name: 'learn_voice', corrections: n });
  }

  /** @param {Person} person @param {Photo} image */
  function rememberPhoto(person, image) {
    for (const [key, photo] of photos) if (o.now() - photo.at > PENDING_MS) photos.delete(key);
    photos.set(keyOf(person), { image, sha256: createHash('sha256').update(image.bytes).digest('hex'), at: o.now() });
  }

  /** Persist before a signed record leaves, without putting any bytes in step arguments or ledgers.
   * @param {Person} person @param {Record<string, any>} args */
  function keepConfirmedPhoto(person, args) {
    if (!o.mediaStore) return true;
    const sha256 = args.sha256 ?? args.screenshotSha256 ?? args.challan?.sha256;
    if (!sha256) return true;
    const photo = photos.get(keyOf(person));
    try {
      if (photo && photo.sha256 === sha256 && o.now() - photo.at <= PENDING_MS) {
        o.mediaStore.put({ bytes: photo.image.bytes, mime: photo.image.mime, sha256 });
        photos.delete(keyOf(person));
        return true;
      }
      return o.mediaStore.get(sha256) !== null;
    } catch { return false; }
  }

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
    args = t.bind?.(args) ?? args;
    // A step understood from a voice note: kept until the person commits it, or another of the same tool.
    const heard = voiceNow.get(keyOf(person));
    const earlier = voiceSteps.get(keyOf(person));
    if (heard !== undefined && (!earlier || earlier.tool !== tool || o.now() - earlier.at > PENDING_MS)) voiceSteps.set(keyOf(person), { tool, args, heard, at: o.now() });
    const d = readBack ?? t.describe(args);
    pending.set(keyOf(person), { kind: 'confirm', tool, args, ask: d, at: o.now() });
    return o.reply(person, d.key, d.params);
  }

  /**
   * Runs a committing step now, through the office's gate, and says what was recorded: the person's
   * own exact reply, a clear photo reading code found consistent, or a step held for approval.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   * @param {() => void} [onOk] after the step was recorded (a person's figures for a photo: learnt from)
   */
  async function commitNow(person, tool, args, onOk) {
    const t = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (!t) return o.reply(person, 'common.unknown_step');
    if (!t.roles.includes(person.role)) return o.reply(person, 'common.not_allowed');
    // A photo-based record keeps its bytes privately before it leaves, so the other side can ask for them.
    if (!keepConfirmedPhoto(person, args)) return o.reply(person, 'evidence.store_failed');
    const r = o.office ? await o.office.commit(person, tool, args) : await runTool(o.tools, person, { tool, args });
    // Once the site's count is recorded, nobody else's count question on that order stays open.
    if (r.ok && tool === 'confirm_count') {
      for (const [k, q] of pending) if (q.kind === 'confirm' && q.tool === 'confirm_count' && q.args.orderId === args.orderId) pending.delete(k);
    }
    // Learning never changes what was recorded or said: a failure here is dropped.
    if (r.ok) {
      try {
        onOk?.();
        learnVoice(person, tool, args);
      } catch { o.log?.('learn: correction not kept'); }
    }
    // The answer itself asks something (a new bill, a waiting claim): its yes/no means this.
    if (r.expect) expect(person, r.expect.tool, r.expect.args, r.expect.no, { key: r.key, params: r.params });
    return o.reply(person, r.key, r.params);
  }

  /**
   * The open question is being left for something else. One the agent put to the person is not lost: it
   * goes first in the queue, and is asked again once when nothing else is open, so a bare "हाँ" means
   * what was last asked. After that it stands on the ledger, and a yes needs a read-back.
   * @param {Person} person
   */
  function setAside(person) {
    const p = current(person);
    if (p?.kind !== 'confirm' || !p.notice || p.again) return;
    const queue = waiting.get(keyOf(person)) ?? [];
    queue.unshift({ tool: p.tool, args: p.args, ...(p.no ? { no: p.no } : {}), ...(p.ask ? { ask: p.ask } : {}), again: true });
    waiting.set(keyOf(person), queue);
  }

  /** The person answered about this order and is asked for more: its question need not be asked as well. @param {Person} person @param {string} orderId */
  function notAgain(person, orderId) {
    const queue = waiting.get(keyOf(person));
    if (queue) waiting.set(keyOf(person), queue.filter((q) => q.args.orderId !== orderId));
  }

  /**
   * The next waiting question that still applies becomes the open one and is asked, if nothing is open.
   * @param {Person} person @returns {Promise<boolean>} asked
   */
  async function askNext(person) {
    if (current(person)) return false;
    const queue = waiting.get(keyOf(person));
    while (queue?.length) {
      const next = /** @type {Waiting} */ (queue.shift());
      const step = Object.hasOwn(o.tools, next.tool) ? o.tools[next.tool] : undefined;
      if (!step || (step.stillOpen && !step.stillOpen(next.args))) continue;
      const d = next.ask ?? step.describe?.(next.args);
      if (!d) continue;
      pending.set(keyOf(person), { kind: 'confirm', tool: next.tool, args: next.args, ...(next.no ? { no: next.no } : {}), ask: d, at: o.now(), notice: true, ...(next.again ? { again: true } : {}) });
      await o.reply(person, d.key, d.params);
      return true;
    }
    waiting.delete(keyOf(person));
    return false;
  }

  /**
   * @param {Person} person
   * @param {string} text
   * @param {{voice?: string, atMs?: number, replaced?: [string, string][]}} [how] `voice`: the text is a voice note's transcript (as heard,
   *   before any normalising), so a step understood from it that the person then corrects teaches its
   *   words; `atMs`: when WhatsApp says the message was sent; `replaced`: words code replaced in the
   *   transcript from this person's own corrections, shown to them
   */
  async function onText(person, text, how) {
    if (how?.replaced?.length) await o.reply(person, 'learn.voice_replaced', { words: how.replaced.map(([heard, to]) => `${heard} → ${to}`).join(', ') });
    // The open question lapsed and another waits: a bare yes/no is not its answer, it has to be asked first.
    const said = norm(text);
    if (!current(person) && (YES.has(said) || NO.has(said)) && await askNext(person)) return;
    if (how?.voice !== undefined) voiceNow.set(keyOf(person), how.voice);
    try {
      await handleText(person, text, how?.atMs);
    } finally {
      voiceNow.delete(keyOf(person));
    }
    await askNext(person);
  }

  /**
   * "भूल जाओ P-1": the owner (JCB owner, supplier) or the contractor drops what was learnt from that
   * order's corrections. "कितनी बार ग़लत पढ़ा गया?": the counts by kind, from the memory, by code.
   * @param {Person} person @param {string} said @returns {{key: string, params?: Record<string, string | number>} | null}
   */
  function learnCommand(person, said) {
    if (!o.learn) return null;
    const f = FORGET.exec(said);
    if (f) {
      const ref = parseRef(f[1]);
      // Not a reference: one of this person's own voice words, which anyone may drop for themselves.
      if (ref === null) {
        const n = o.learn.forgetVoice(voiceParty(person), f[1]);
        return n > 0 ? { key: 'learn.forgot_word', params: { word: f[1].trim(), n } } : { key: 'learn.forget_which' };
      }
      if (!FORGET_ROLES.has(person.role)) return { key: 'learn.forget_not_allowed' };
      const r = ref === null ? undefined : orderRefs(o.ledger).find((x) => x.ref === ref);
      if (!r) return { key: 'learn.forget_which' };
      const n = o.learn.forget(r.orderId, person.role);
      traceCheck(`forgot ${n} correction(s) learnt from ${ref} (asked by ${person.role})`, true, { name: 'learn_forget', corrections: n }, r.orderId);
      return n > 0 ? { key: 'learn.forgot', params: { ref, n } } : { key: 'learn.forgot_none', params: { ref } };
    }
    if (!MISREAD_Q.test(said.normalize('NFC'))) return null;
    const s = o.learn.stats();
    if (s.recorded === 0) return { key: 'learn.misreads_none' };
    const lines = Object.entries(s.kinds).filter(([, k]) => k.recorded > 0)
      .map(([kind, k]) => t('learn.misreads_line', { kind: t(`learn.kind.${kind}`), n: k.recorded }));
    if (s.readsWithMemory > 0) lines.push(t('learn.memory_line', { reads: s.readsWithMemory, again: s.correctedAfterMemory }));
    if (!s.on) lines.push(t('learn.memory_off'));
    return { key: 'learn.misreads', params: { n: s.recorded, lines: lines.join('\n') } };
  }

  /**
   * @param {Person} person
   * @param {string} text
   * @param {number} [atMs]
   */
  async function handleText(person, text, atMs) {
    const said = norm(text);
    const forgotSite = forgetSite(person, said);
    if (forgotSite) return o.reply(person, forgotSite.key, forgotSite.params);
    const learnt = learnCommand(person, said);
    // Like an exact command, it leaves any open question as it was.
    if (learnt) return o.reply(person, learnt.key, learnt.params);
    // An exact command is answered first and leaves any open question as it was: a command always
    // has a command word, so it is never a figure, and typed figures are never a command.
    const command = o.office ? parseCommand(text) : null;
    // "रद्द J-2" commits, so unlike the others it is read back: its question is the open one.
    if (command?.cmd === 'cancel') {
      setAside(person);
      return askCancel(person, command.ref);
    }
    // "हाँ P-1" from a supervisor, on a delivery waiting for the site's count: the same as the challan.
    const counted = command ? countOfDecision(person, command) : null;
    if (counted) return commitNow(person, 'confirm_count', counted);
    const onBill = command ? billOfDecision(person, command) : null;
    if (command && onBill) {
      if (command.cmd === 'ok') {
        setAside(person);
        return propose(person, 'accept_bill', { orderId: onBill.orderId });
      }
      if (onBill.state === 'disputed') return o.reply(person, 'site.dispute_already', { ref: onBill.ref });
      const reason = command.cmd === 'no' ? command.reason : null;
      if (!reason) return o.reply(person, 'site.dispute_format', { example: plainRupees(o.ledger.view(onBill.orderId).billTotalPaise ?? 0) });
      // "नहीं P-4 ₹54420 कारण" is the exact objection. Other words go on below, read against that order's question.
      const exact = exactReply({ ledger: o.ledger, person, text: `${onBill.ref} नहीं ${reason}`, nowMs: o.now() });
      if (exact?.kind === 'ask') return o.reply(person, exact.key, exact.params);
      if (exact?.kind === 'step') {
        setAside(person);
        pending.delete(keyOf(person));
        return commitNow(person, exact.tool, exact.args);
      }
    } else if (command && o.office) {
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
    if (p && (p.kind === 'meter_job' || p.kind === 'challan_job')) {
      const answer = jobAnswer(said, p.orderIds);
      if (answer?.again) return askJob(person, p.kind, p.orderIds);
      pending.delete(keyOf(person));
      if (answer) return p.kind === 'meter_job' ? onMeterImage(person, p.image, answer.orderId) : onChallanImage(person, p.image, answer.orderId);
      if (NO.has(said) || DROP_WORDS.has(said)) return o.reply(person, 'step.cancelled');
      // Not an answer: the question lapses, the photo with it, and the message is read as a new one.
    }
    const waitingPay = payWait(person);
    if (waitingPay) {
      payWaits.delete(keyOf(person));
      if (saysCash(text)) return payTyped(person, { orderIds: waitingPay.orderIds, amountPaise: waitingPay.amountPaise, method: 'cash', advance: false });
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
      // Anything else: the wait lapses and the message is read as a new one.
    }
    if (p && p.kind === 'pay_choice') {
      pending.delete(keyOf(person));
      if (YES.has(said) && p.group) return payGroup(person, p.orderIds, p.amountPaise, p.base, true);
      const want = parseRef(text);
      const r = want === null ? undefined : orderRefs(o.ledger).find((x) => x.ref === want && p.orderIds.includes(x.orderId));
      if (r) return paySingle(person, r.orderId, p.amountPaise, p.base);
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
    }
    if (p && p.kind === 'confirm') {
      // Sent before the question was asked (a delayed message; WhatsApp's time is in whole seconds):
      // not an answer to it. The question stays open and is asked again.
      if ((YES.has(said) || NO.has(said)) && atMs && atMs + 1000 < p.at) {
        traceCheck('a yes/no older than the question ✗ → asked again', false, { name: 'answer_older_than_question', tool: p.tool });
        const d = p.ask ?? o.tools[p.tool]?.describe?.(p.args);
        return d ? o.reply(person, d.key, d.params) : o.reply(person, 'step.cancelled');
      }
      if (YES.has(said)) {
        pending.delete(keyOf(person));
        return commitNow(person, p.tool, p.args);
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        // A question whose "no" is itself a decision (the owner declines to share a photo) runs it.
        if (p.no) return commitNow(person, p.no.tool, p.no.args);
        return o.reply(person, 'step.cancelled');
      }
      // A meter read-back can be answered with the right digits: the person's own figure, recorded at once.
      const digits = /^(\d{1,7})(?:\.(\d))?$/.exec(said);
      if (p.tool === 'record_meter' && digits) {
        pending.delete(keyOf(person));
        const valueTenths = Number(digits[1]) * 10 + Number(digits[2] ?? '0');
        return commitNow(person, 'record_meter', { ...p.args, valueTenths }, () => learnFrom(p.args.sha256, [valueTenths]));
      }
      // A challan read-back or a delivery count can be answered with the right quantities, in order.
      const figures = parseHundredthsList(said);
      if (figures && p.tool === 'record_delivery') {
        pending.delete(keyOf(person));
        return proposeDelivery(person, { orderId: p.args.orderId, sha256: p.args.sha256, challanNo: p.args.challanNo ?? null, invoice: p.args.orderedInvoice ?? null }, figures, { typed: true });
      }
      if (figures && p.tool === 'confirm_count' && p.args.challan) {
        pending.delete(keyOf(person));
        return proposeSiteCount(person, { orderId: p.args.orderId, sha256: p.args.challan.sha256, challanNo: p.args.challan.number ?? null }, figures, 'typed');
      }
      if (figures && p.tool === 'confirm_count') {
        pending.delete(keyOf(person));
        return commitNow(person, 'confirm_count', { orderId: p.args.orderId, qtysHundredths: figures });
      }
      // Anything else: the message is read as a new one, and a question the agent asked comes back after it.
      setAside(person);
      pending.delete(keyOf(person));
    }
    if (p && p.kind === 'two_requests') {
      if ((YES.has(said) || NO.has(said)) && atMs && atMs + 1000 < p.at) {
        traceCheck('a yes/no older than the question ✗ → asked again', false, { name: 'answer_older_than_question', tool: 'two_requests' });
        return readBackTwo(person, p.steps);
      }
      pending.delete(keyOf(person));
      if (YES.has(said)) return commitTwo(person, p.steps);
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
    }
    if (p && p.kind === 'site_name') {
      const answer = siteAnswer(text, said, p.options);
      // A yes or a number that is not on the list does not say which site: asked again.
      if (answer?.again || YES.has(said)) return askSite(person, p);
      pending.delete(keyOf(person));
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
      if (answer) {
        /** @type {import('./site-names.js').SiteNames} */ (o.siteNames).save(p.name, answer.site ?? p.name, person.role);
        return stepsReady(person, p.steps);
      }
      // Anything else: the question lapses and the message is read as a new one.
    }
    if (p && p.kind === 'challan_figures') {
      const figures = parseHundredthsList(said);
      if (figures) {
        pending.delete(keyOf(person));
        return proposeDelivery(person, p, figures, { typed: true });
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
        return commitNow(person, 'record_meter', { orderId: p.orderId, which: p.which, valueTenths, sha256: p.sha256, takenAt: p.takenAt }, () => learnFrom(p.sha256, [valueTenths]));
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
        if (r) return onProposal(person, p.said, r, p.pair);
      }
      // Not an answer: the question lapses and the message is read as a new one.
      pending.delete(keyOf(person));
    }
    if (HELP.has(said)) return o.reply(person, `help.${person.role}`);

    // Right after notices told again: a bare yes may have been written before they were read, and may
    // not be about them. It decides nothing and goes to no model; the person is told how to name one.
    const told = YES.has(said) ? replayedOpen(person) : [];
    if (told.length) return o.reply(person, 'site.yes_needs_ref', { ref: told[0], refs: told.join(', ') });

    // A person's exact reply to a request open for them is read by code and runs at once (a correction,
    // or a bill that differs from the tax invoice, is read back once first).
    const exact = exactReply({ ledger: o.ledger, person, text, nowMs: o.now() });
    if (exact && exact.kind === 'ask') return o.reply(person, exact.key, exact.params);
    if (exact && exact.kind === 'pay') return payTyped(person, exact);
    if (exact) return exact.confirm ? propose(person, exact.tool, exact.args) : commitNow(person, exact.tool, exact.args);

    // The supervisor saw a copy of a bill; accepting it is the contractor's.
    if (person.role === 'supervisor' && YES.has(said) && orderRefs(o.ledger).some((r) => r.state === 'billed' || r.state === 'disputed')) return o.reply(person, 'site.bill_contractor_accepts');

    // Free text: the answer to the latest open question, or to the one reference it names, if it is one.
    const named = refsIn(text);
    const open = openQuestions(o.ledger, person.role);
    const question = named.length === 1 ? open.find((q) => q.ref === named[0]) : named.length === 0 ? open.at(-1) : undefined;
    if (question) {
      const answer = await answerOpen({ spark: o.spark, person, text, nowMs: o.now(), orders: orderRefs(o.ledger), question });
      traceCheck(`free text read against the open question of ${question.ref}: ${answer ? answer.kind : 'not an answer'}`, answer !== null, { name: 'open_question', tools: question.tools }, question.orderId);
      if (answer?.kind === 'unclear') {
        notAgain(person, question.orderId);
        return answer.tool === 'dispute_bill' ? o.reply(person, 'site.dispute_format', { example: plainRupees(o.ledger.view(question.orderId).billTotalPaise ?? 0) }) : o.reply(person, 'answer.unclear', { ref: question.ref });
      }
      if (answer) return onProposal(person, text, answer);
    }
    const proposal = await proposeStep({ spark: o.spark, person, text, orders: orderRefs(o.ledger), nowMs: o.now(), ask: true });
    // Code's rule, whatever the model said (live, 31 Oct, both runs): with a bill question open, the bill's
    // own items with figures and no site, day or time are the person's figures for that bill, not an order.
    const figures = question && named.length === 0 && question.tools.includes('dispute_bill') ? billFiguresIn(proposal, question.orderId) : null;
    if (question && figures) {
      traceCheck(`a new order with the bill's own items and no site or day ✗ → read as the objection to ${question.ref}`, false, { name: 'order_or_objection' }, question.orderId);
      return disputeByItems(person, text, { orderId: question.orderId, itemFigures: figures, reason: text.trim().slice(0, 300) });
    }
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
   * @param {{parts: PairPart[], index: number}} [pair] the step is one of two requests from that message
   */
  function onProposal(person, text, proposal, pair) {
    if (proposal.kind === 'pair') return twoRequests(person, text, proposal.parts);
    if (pair && (proposal.kind === 'step' || proposal.kind === 'missing')) {
      const filled = proposal;
      const parts = pair.parts.map((part, i) => (i === pair.index ? filled : part));
      return twoRequests(person, text, shareFilled({ person, orders: orderRefs(o.ledger), nowMs: o.now() }, parts));
    }
    if (proposal.kind === 'step' && proposal.tool === 'dispute_bill' && (proposal.args.itemFigures || (proposal.args.qtyHundredths && billLines(proposal.args.orderId).length > 1))) return disputeByItems(person, text, proposal.args);
    const noRate = proposal.kind === 'step' ? rateMissing(proposal) : null;
    if (noRate) return o.reply(person, noRate.key, noRate.params);
    if (proposal.kind === 'help') return o.reply(person, `help.${person.role}`);
    if (proposal.kind === 'none') return o.reply(person, proposal.key);
    if (proposal.kind === 'ask') return o.reply(person, 'common.unknown_step');
    // A cash payment understood without its order: which order (with balances), or the split.
    if (proposal.kind === 'step' && proposal.tool === 'claim_payment' && !proposal.args.orderId) {
      const { amountPaise, ...base } = proposal.args;
      return payTo(person, null, amountPaise, base);
    }
    if (proposal.kind === 'missing') {
      pending.set(keyOf(person), { kind: 'fill', tool: proposal.tool, raw: proposal.raw, args: proposal.args, missing: proposal.missing, said: text, at: o.now() });
      return o.reply(person, 'ask.missing', { questions: askText(proposal.args, proposal.missing) });
    }
    return stepsReady(person, [{ tool: proposal.tool, args: proposal.args }]);
  }

  /**
   * A material request with no site, day or time whose every item, with a figure, is a line of this
   * order's bill: those figures, under the bill's own names. Null for anything else.
   * @param {import('../orchestrator/orchestrator.js').Proposal} proposal @param {string} orderId
   * @returns {{item: string, quantity: string}[] | null}
   */
  function billFiguresIn(proposal, orderId) {
    if (proposal.kind !== 'missing' || proposal.tool !== 'request_material') return null;
    const { site, day, time, items } = proposal.raw;
    if (!blank(site) || !blank(day) || !blank(time) || !Array.isArray(items) || items.length === 0) return null;
    const lines = billLines(orderId);
    /** @type {{item: string, quantity: string}[]} */
    const out = [];
    for (const it of items) {
      const line = billLineNamed(lines, it?.name);
      if (!line || typeof it.quantity !== 'string' || blank(it.quantity)) return null;
      out.push({ item: line.what, quantity: it.quantity });
    }
    return out;
  }

  /**
   * A seller's yes understood without its rate, or with too few: the rate is asked for now, never read
   * back with a dash (live, 31 Oct). Null when the step has what it needs.
   * @param {{tool: string, args: Record<string, any>}} step
   * @returns {{key: string, params?: Record<string, string>} | null}
   */
  function rateMissing(step) {
    if (step.args.answer !== 'yes') return null;
    if (step.tool === 'reply_booking') return step.args.ratePaise ? null : { key: 'jcb.rate_needed' };
    if (step.tool !== 'reply_order') return null;
    const asked = requestedItems(o.ledger.events(step.args.orderId));
    return step.args.ratesPaise?.length === asked.length ? null : { key: 'supplier.rates_needed', params: { items: itemsText(asked) } };
  }

  /** The lines of the bill in force. @param {string} orderId @returns {any[]} */
  function billLines(orderId) {
    const bill = o.ledger.view(orderId).currentBill;
    return bill ? o.ledger.eventOfMessage(bill)?.body.body.lines ?? [] : [];
  }

  /**
   * An objection naming quantities on a material bill: code works out the total at the agreed rates and
   * GST and reads it back, or asks when a figure cannot be tied to one item. The signed objection carries
   * the total, as ever.
   * @param {Person} person @param {string} text @param {Record<string, any>} a
   */
  function disputeByItems(person, text, a) {
    const view = o.ledger.view(a.orderId);
    const lines = billLines(a.orderId);
    const events = o.ledger.events(a.orderId);
    const d = delivery(events);
    const rates = agreedRates(events);
    const worked = a.itemFigures && d && rates ? disputedItems(lines, d.items, rates, a.itemFigures, text) : null;
    const ref = refOfId(a.orderId);
    if (!worked) {
      notAgain(person, a.orderId);
      return o.reply(person, 'site.dispute_which_item', { ref, items: lines.map((/** @type {{what: string}} */ l) => l.what).join(', ') });
    }
    if (worked.totalPaise === view.billTotalPaise) {
      notAgain(person, a.orderId);
      return o.reply(person, 'site.dispute_same', { ref, total: rupees(worked.totalPaise) });
    }
    const site = /** @type {{site: string}} */ (o.ledger.order(a.orderId)).site;
    const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason : text.trim().slice(0, 300);
    return propose(person, 'dispute_bill', { orderId: a.orderId, totalPaise: worked.totalPaise, reason }, {
      key: 'step.dispute_bill_items', params: { ref, site, items: itemsText(worked.items), total: rupees(worked.totalPaise), reason } });
  }

  /**
   * Two requests from one message: what is still missing is asked first, one question at a time;
   * nothing is read back until both are complete.
   * @param {Person} person @param {string} text the first message @param {PairPart[]} parts
   */
  function twoRequests(person, text, parts) {
    const index = parts.findIndex((part) => part.kind === 'missing');
    const open = parts[index];
    if (open?.kind === 'missing') {
      pending.set(keyOf(person), { kind: 'fill', tool: open.tool, raw: open.raw, args: open.args, missing: open.missing, said: text, at: o.now(), pair: { parts, index } });
      return o.reply(person, 'ask.missing', { questions: askText(open.args, open.missing) });
    }
    return stepsReady(person, parts.map((part) => ({ tool: part.tool, args: part.args })));
  }

  /**
   * Complete requests go on to their read-back, unless one names a site this agent does not know:
   * then that is asked first, once, and they wait for the answer.
   * @param {Person} person @param {Step[]} steps
   */
  function stepsReady(person, steps) {
    const ready = [];
    for (const step of steps) {
      if (!o.siteNames || !SITE_TOOLS.has(step.tool) || typeof step.args.site !== 'string') {
        ready.push(step);
        continue;
      }
      const known = knownSite(person, step.args.site);
      if (typeof known !== 'string') {
        traceCheck('a site name this agent does not know ✗ → asked once', false, { name: 'site_name_unknown', choices: known.length });
        const question = { kind: /** @type {const} */ ('site_name'), name: step.args.site, options: known, steps, at: o.now() };
        pending.set(keyOf(person), question);
        return askSite(person, question);
      }
      ready.push({ ...step, args: { ...step.args, site: known } });
    }
    if (ready.length === 1) return propose(person, ready[0].tool, ready[0].args);
    pending.set(keyOf(person), { kind: 'two_requests', steps: ready, at: o.now() });
    return readBackTwo(person, ready);
  }

  /** @param {Person} person @param {{name: string, options: string[]}} q */
  function askSite(person, q) {
    const lines = q.options.map((site, i) => `${i + 1}. ${site}`).join('\n');
    return o.reply(person, 'site.which_site', { name: q.name, lines, new: q.options.length + 1 });
  }

  /**
   * The sites on this agent, most recent first; the person's own comes first of all. Every order on the
   * ledger counts (a settled site is still a site), with steps waiting for approval, the sites saved
   * here and those people.json gives its people.
   * @param {Person} person @returns {string[]}
   */
  function sitesHere(person) {
    const orders = /** @type {{site: string, created_at: string}[]} */ (o.ledger.orders()).map((x) => ({ site: x.site, at: x.created_at }));
    const held = (o.office?.held() ?? []).filter((h) => h.decision?.decision !== 'no' && typeof h.args.site === 'string').map((h) => ({ site: /** @type {string} */ (h.args.site), at: h.createdAt }));
    const dated = [...orders, ...held, ...(o.siteNames?.sites() ?? [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((x) => x.site);
    const seen = new Set();
    return [...(person.site ? [person.site] : []), ...dated, ...(o.peopleSites?.() ?? [])].filter((site) => {
      const key = siteKey(site);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * The full site's name this name is, from an exact match only; with no sites at all any name is
   * taken as it is. Otherwise the choices to offer.
   * @param {Person} person @param {string} name @returns {string | string[]}
   */
  function knownSite(person, name) {
    const sites = sitesHere(person);
    const key = siteKey(name);
    const exact = sites.find((site) => siteKey(site) === key);
    if (exact) return exact;
    const saved = o.siteNames?.lookup(name);
    if (saved) return saved;
    return sites.length === 0 ? name : sites.slice(0, MAX_SITE_CHOICES);
  }

  /**
   * The reply to "which site?", read by code: a number or a site's exact name is that site; the last
   * number or "नई साइट" is the name itself as a new site (no `site`). A number off the list is `again`;
   * anything else null.
   * @param {string} text @param {string} said @param {string[]} options
   * @returns {{site?: string, again?: boolean} | null}
   */
  function siteAnswer(text, said, options) {
    if (NEW_SITE_WORDS.has(said)) return {};
    const named = options.find((site) => siteKey(site) === siteKey(text));
    if (named) return { site: named };
    const digits = latinDigits(said);
    const q = /^\d{1,2}$/.test(digits) ? Number(digits) * 100 : parseQuantity(digits);
    if (typeof q !== 'number' || q <= 0 || q % 100 !== 0) return null;
    const n = q / 100;
    if (n === options.length + 1) return {};
    return n <= options.length ? { site: options[n - 1] } : { again: true };
  }

  /** @param {Person} person @param {Step[]} steps */
  function readBackTwo(person, steps) {
    const [material, jcb] = steps.map((s) => stepWords(s));
    return o.reply(person, 'step.two_requests', { material, jcb });
  }

  /** A request as a plain statement. @param {Step} step */
  function stepWords(step) {
    const what = o.tools[step.tool].summary?.(step.args);
    return what ? t(what.key, what.params) : t('office.step_unknown');
  }

  /**
   * "हाँ" to both: each runs as its own order through the office's gate, so the limit is checked per
   * order. A failure on one leaves the other's result standing, and the reply says what happened to each.
   * Each is one part of the trace, so its lines carry its own reference.
   * @param {Person} person @param {Step[]} steps
   */
  async function commitTwo(person, steps) {
    const lines = [];
    for (const step of steps) {
      let r;
      try {
        r = await tracePart(() => (o.office ? o.office.commit(person, step.tool, step.args) : runTool(o.tools, person, step)));
      } catch {
        o.log?.(`two requests: ${step.tool} failed`);
        r = no('common.try_again');
      }
      if (r.ok) {
        try { learnVoice(person, step.tool, step.args); } catch { o.log?.('learn: correction not kept'); }
      }
      lines.push(r.ok ? t(r.key, r.params) : t('site.two_requests_failed', { what: stepWords(step), why: t(r.key, r.params) }));
    }
    return o.reply(person, 'site.two_requests_done', { first: lines[0], second: lines[1] });
  }

  /**
   * "हाँ P-4" / "नहीं P-4 ..." from the contractor are about the bill, not an approval, when no step
   * for that reference waits for a decision and the order has a bill to answer.
   * @param {Person} person @param {import('./office.js').Command} c
   * @returns {{orderId: string, ref: string, state: string} | null}
   */
  function billOfDecision(person, c) {
    if ((c.cmd !== 'ok' && c.cmd !== 'no') || person.role !== 'contractor') return null;
    if (o.office?.held().some((h) => h.ref === c.ref && h.decision === null)) return null;
    const orderId = openRefs(o.ledger).orderOfRef(c.ref);
    const state = orderId === null ? null : o.ledger.view(orderId).state;
    return orderId !== null && state !== null && (state === 'billed' || state === 'disputed') ? { orderId, ref: c.ref, state } : null;
  }

  /**
   * A supervisor's "हाँ <ref>" on a delivery still waiting for the site's count (the form a notice told
   * again asks for): the count step for that order, one figure per delivered item. Null for anything
   * else, which stays what it was (a held step's decision is the contractor's).
   * @param {Person} person @param {import('./office.js').Command} c
   */
  function countOfDecision(person, c) {
    if (c.cmd !== 'ok' || c.note || person.role !== 'supervisor' || o.office?.held().some((h) => h.ref === c.ref && h.decision === null)) return null;
    const orderId = openRefs(o.ledger).orderOfRef(c.ref);
    if (orderId === null || o.ledger.view(orderId).state !== 'delivered') return null;
    const events = o.ledger.events(orderId);
    const d = delivery(events);
    if (!d || siteCount(events) !== null) return null;
    return { orderId, qtysHundredths: d.items.map((it) => it.qtyHundredths), sameAsChallan: true };
  }

  /**
   * The references told again to this person in the last while (PENDING_MS) that still wait for them.
   * @param {Person} person @returns {string[]}
   */
  function replayedOpen(person) {
    const r = replayedRefs.get(keyOf(person));
    if (!r) return [];
    if (o.now() - r.at > PENDING_MS) {
      replayedRefs.delete(keyOf(person));
      return [];
    }
    const open = new Set(openQuestions(o.ledger, person.role).map((q) => q.ref));
    if (person.role === 'contractor') for (const h of o.office?.held() ?? []) if (h.decision === null) open.add(h.ref);
    return r.refs.filter((ref) => open.has(ref));
  }

  /**
   * "रद्द J-2": who may, and whether it can be, is said at once; else the read-back.
   * @param {Person} person @param {string} ref
   */
  function askCancel(person, ref) {
    if (!may(person, 'cancel_order')) return o.reply(person, 'cancel.not_allowed');
    const orderId = openRefs(o.ledger).orderOfRef(ref);
    if (orderId === null) return o.reply(person, o.office?.held().some((h) => h.ref === ref && h.decision === null) ? 'cancel.held' : 'office.no_such_ref', { ref });
    const blocked = cancelBlock(o.ledger, orderId);
    return blocked ? o.reply(person, blocked.key, blocked.params) : propose(person, 'cancel_order', { orderId });
  }

  /**
   * "भूल जाओ NDUAT": a site name saved here is dropped, so it is asked again. Orders already recorded
   * stay as they are.
   * @param {Person} person @param {string} said @returns {{key: string, params?: Record<string, string | number>} | null}
   */
  function forgetSite(person, said) {
    const f = FORGET.exec(said);
    if (!f || !o.siteNames || parseRef(f[1]) !== null || !may(person, 'request_material') || !o.siteNames.forget(f[1], person.role)) return null;
    return { key: 'site.forgot_name', params: { name: f[1].trim() } };
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
    if (o.readCashReceipt && person.role === 'contractor' && may(person, 'claim_payment')) kinds.push('cash_receipt');
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
    await handleImage(person, image);
    await askNext(person);
  }

  /** @param {Person} person @param {Photo} image */
  async function handleImage(person, image) {
    setAside(person);
    pending.delete(keyOf(person));
    photos.delete(keyOf(person));
    const kinds = photoKinds(person);
    if (kinds.length === 0) return o.reply(person, 'photo.none');
    if (!isImageMime(image.mime)) return o.reply(person, 'photo.other', { kinds: kindNames(kinds) });
    if (image.bytes.byteLength > 5 * 1024 * 1024) return o.reply(person, 'evidence.too_large');
    if (!o.classifyPhoto) return o.reply(person, 'orchestrator.try_again');
    const c = await o.classifyPhoto({ mime: /** @type {'image/jpeg'} */ (image.mime), bytes: image.bytes });
    if (!c.ok) return o.reply(person, 'orchestrator.try_again');
    // The classifier's evaluated kinds are unchanged. A possible cash receipt comes through an
    // explicit answer, including when that classifier correctly calls it "other".
    if (!c.clear || (c.kind === 'other' && kinds.includes('cash_receipt'))) {
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
    if (kind === 'cash_receipt') return onCashReceiptImage(person, image);
    return may(person, 'record_delivery') ? onChallanImage(person, image) : onSiteChallanImage(person, image);
  }

  /** A cash receipt is a read-only preview until the recording branch binds it to a cash claim.
   * No photo is retained, no confirmation is opened and no payment tool is invoked here.
   * @param {Person} person @param {Photo} image */
  async function onCashReceiptImage(person, image) {
    if (!o.readCashReceipt) return o.reply(person, 'cash_receipt.unavailable');
    if (image.forwarded) return o.reply(person, 'payment.forwarded');
    let read;
    try {
      read = await o.readCashReceipt({ mime: /** @type {'image/jpeg'} */ (image.mime), bytes: image.bytes });
    } catch {
      return o.reply(person, 'cash_receipt.unavailable');
    }
    if (!read.ok) return o.reply(person, 'cash_receipt.unavailable');
    if (read.kind === 'not_cash_receipt') return o.reply(person, 'cash_receipt.not_receipt');
    /** @type {string[]} */
    const lines = [];
    if (read.amountRaw !== null) lines.push(t('cash_receipt.fig.amount_raw', { raw: read.amountRaw }));
    if (read.amountPaise !== null) lines.push(t('cash_receipt.fig.amount', { amount: rupees(read.amountPaise) }));
    if (read.dateRaw !== null) lines.push(t('cash_receipt.fig.date_raw', { raw: read.dateRaw }));
    if (read.date !== null) lines.push(t('cash_receipt.fig.date', { day: dayName(read.date) }));
    if (read.receiverName !== null) lines.push(t('cash_receipt.fig.receiver', { name: read.receiverName }));
    lines.push(t(`cash_receipt.mark.${read.receiverMark === true ? 'visible' : read.receiverMark === false ? 'absent' : 'unclear'}`));
    if (read.reference !== null) lines.push(t('cash_receipt.fig.reference', { number: read.reference }));
    return o.reply(person, read.clear ? 'cash_receipt.preview' : 'cash_receipt.preview_unclear', { figures: lines.join('\n') });
  }

  /**
   * A meter photo from the JCB side is a meter reading for the job that is booked or working. Before
   * anything is recorded: a forwarded photo is refused; a photo of another machine than the other
   * reading's (Muse Spark compares the two) is refused, and an unsure comparison is read back once; a
   * date on the display that is not the job's day is refused. Then the existing checks. The job is the
   * one named in the caption, else the one open; with several open (or a caption naming a job that is
   * not open) the photo waits, unread, as the open question (askJob).
   * @param {Person} person @param {Photo} image @param {string} [chosen] the order the person said this photo is for
   */
  async function onMeterImage(person, image, chosen) {
    if (!o.readMeter) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'meter.not_meter');
    // A forwarded photo can be of any day and any machine (live, 29 Oct): only a photo taken now counts.
    if (image.forwarded) return o.reply(person, 'meter.forwarded');
    const picked = await orderForPhoto(person, 'meter_job', image, chosen);
    if (!picked) return;
    let events = o.ledger.events(picked.orderId);
    let r = meterReadings(events);
    /** @type {'start' | 'end'} */
    let which = r.start ? 'end' : 'start';
    const other = which === 'end' ? r.start : r.end;
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const takenAt = image.takenAt ?? null;
    /** @type {{mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}} */
    const photo = { mime: image.mime, bytes: image.bytes };
    // Reading and comparing run together: one wait for the person.
    const [learnt, compared] = await Promise.all([
      readLearned('meter', person.role, picked.orderId, o.readMeter, photo, (r) => (r.ok && r.kind === 'hour_meter' ? String(r.valueTenths) : 'none')),
      other && other.sha256 !== sha256 ? sameMachine(other.sha256, photo) : null]);
    let same = compared;
    // The readers are slow: another photo of this job may have been recorded meanwhile. Everything
    // below works from the ledger as it is now, and is compared with the reading that came in.
    events = o.ledger.events(picked.orderId);
    r = meterReadings(events);
    which = r.start ? 'end' : 'start';
    const otherNow = which === 'end' ? r.start : r.end;
    if (otherNow && otherNow.sha256 !== other?.sha256) same = otherNow.sha256 !== sha256 ? await sameMachine(otherNow.sha256, photo) : null;
    const read = learnt.read;
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_meter') return o.reply(person, 'meter.not_meter');
    // What was read, so the digits the person may type for this photo are learnt from (a doubtful
    // digit is not a misread and teaches nothing).
    const seen = read.valueTenths ?? (/^\d{1,7}(?:\.\d)?$/.test(read.raw) ? Number(read.raw.split('.')[0]) * 10 + Number(read.raw.split('.')[1] ?? '0') : null);
    rememberRead(sha256, { kind: 'meter', party: person.role, orderId: picked.orderId, fields: ['reading'], read: [seen === null ? null : tenthsText(seen)],
      scale: 'tenths', layout: () => null, memory: learnt.memory });
    if (same && same.same === 'no') {
      return o.reply(person, 'meter.other_machine', { reason: same.differs.map((d) => t(`meter.differs.${d}`)).join(', ') });
    }
    const day = jobDay(events);
    const dated = displayDateWrong(read.displayDate, day, o.now());
    if (dated.wrong) return o.reply(person, 'meter.display_date', { raw: dated.shown, day: dayName(/** @type {string} */ (day)) });
    rememberPhoto(person, image);
    if (!read.clear || read.valueTenths === null) {
      pending.set(keyOf(person), { kind: 'meter_digits', orderId: picked.orderId, which, sha256, takenAt, at: o.now() });
      return o.reply(person, read.raw ? 'meter.ask_person' : 'meter.ask_person_blank', { raw: read.raw });
    }
    const args = { orderId: picked.orderId, which, valueTenths: read.valueTenths, sha256, takenAt };
    const { start: startNow, end: endNow } = r;
    // Code's check: an end reading must be above the start (and a start below an end). A reading that
    // fails it is read back, so the person can type the right digits; a clear one is recorded at once.
    const mismatch = which === 'end' ? startNow !== null && read.valueTenths <= startNow.valueTenths : endNow !== null && read.valueTenths >= endNow.valueTenths;
    // More than a day's work between the two readings: not this job (another machine, or a misread).
    // Nothing is recorded; the person sends the right photo or types the digits.
    const worked = which === 'end' && startNow !== null ? read.valueTenths - startNow.valueTenths : null;
    if (worked !== null && worked > MAX_JOB_TENTHS) {
      traceCheck('more than 24 h between the two meter readings ✗ → not this job, nothing recorded', false,
        { name: 'meter_day_limit', startTenths: startNow?.valueTenths ?? null, endTenths: read.valueTenths }, picked.orderId);
      pending.set(keyOf(person), { kind: 'meter_digits', orderId: picked.orderId, which, sha256, takenAt, at: o.now() });
      return o.reply(person, 'jcb.meter_hours_impossible', impossible(/** @type {{valueTenths: number}} */ (startNow).valueTenths, read.valueTenths));
    }
    // Muse Spark could not tell whether it is the same machine: read back once, "हाँ" records it.
    if (same && same.same === 'unsure') return propose(person, 'record_meter', args, { key: 'meter.same_unsure', params: { reading: tenths(read.valueTenths) } });
    traceCheck(mismatch ? `meter reading not consistent with the ${which === 'end' ? 'start' : 'end'} ✗ → read back` : `meter reading clear and consistent ✓ → recorded at once`,
      !mismatch, { name: 'meter_photo', which, valueTenths: read.valueTenths, startTenths: startNow?.valueTenths ?? null, endTenths: endNow?.valueTenths ?? null }, picked.orderId);
    // A long day (more than LONG_JOB_TENTHS) is possible but unusual: read back once before it counts.
    const long = worked !== null && worked > LONG_JOB_TENTHS;
    if (mismatch || long) return propose(person, 'record_meter', args);
    // Memory changed the figure: read back, never recorded silently.
    if (learnt.differs) return propose(person, 'record_meter', args, { key: 'learn.read_back_meter', params: { reading: tenths(read.valueTenths) } });
    return commitNow(person, 'record_meter', args);
  }

  /** @typedef {'meter_job' | 'challan_job'} PhotoQuestion */
  /** The orders a meter photo (booked or working) or a supplier's challan (booked) can be for, oldest first. @param {PhotoQuestion} kind */
  const photoOrders = (kind) => orderRefs(o.ledger).filter((r) => r.state === 'booked' || (kind === 'meter_job' && r.state === 'working'));
  /** @param {PhotoQuestion} kind */
  const noOrderKey = (kind) => (kind === 'meter_job' ? 'orchestrator.no_job_for_photo' : 'challan.no_order_for_photo');

  /**
   * The order a photo is for: the one the person chose, the one named in the caption, else the one
   * open. With several open (or a caption naming one that is not open) the photo waits, unread, as the
   * open question. Nothing to go on yet: the person has been told or asked, and the answer is null.
   * @param {Person} person @param {PhotoQuestion} kind @param {Photo} image @param {string} [chosen]
   */
  async function orderForPhoto(person, kind, image, chosen) {
    const open = photoOrders(kind);
    const named = refsIn(image.caption ?? '');
    const picked = chosen ? open.find((r) => r.orderId === chosen)
      : named.length === 1 ? open.find((r) => r.ref === named[0]) : named.length === 0 && open.length === 1 ? open[0] : undefined;
    if (picked) return picked;
    // The order moved on while the question was open: nothing is put on another one.
    if (chosen || open.length === 0) await o.reply(person, chosen ? 'common.wrong_state' : noOrderKey(kind));
    else {
      const orderIds = open.map((r) => r.orderId);
      pending.set(keyOf(person), { kind, image, orderIds, at: o.now() });
      await askJob(person, kind, orderIds);
    }
    return null;
  }

  /**
   * Which order is this photo for? Those still open, numbered as first listed.
   * @param {Person} person @param {PhotoQuestion} kind @param {string[]} orderIds
   */
  function askJob(person, kind, orderIds) {
    const open = photoOrders(kind);
    const jobs = orderIds.flatMap((id, i) => open.filter((r) => r.orderId === id).map((r) => ({ n: i + 1, ref: r.ref, site: r.site, day: /^\d{4}-/.test(r.day) ? dayName(r.day) : r.day, what: r.what ?? t('kind.material') })));
    if (jobs.length === 0) {
      pending.delete(keyOf(person));
      return o.reply(person, noOrderKey(kind));
    }
    const [ask, line] = kind === 'meter_job' ? ['meter.which_job', 'meter.job_line'] : ['challan.which_order', 'challan.order_line'];
    return o.reply(person, ask, { lines: jobs.map((j) => t(line, j)).join('\n'), ref: jobs[0].ref });
  }

  /**
   * The reply to "which job?", read by code: a number on the list or a listed job's reference. A number
   * or reference off the list, or a yes, does not say which (`again`); anything else null.
   * @param {string} said @param {string[]} orderIds @returns {{orderId?: string, again?: boolean} | null}
   */
  function jobAnswer(said, orderIds) {
    const digits = latinDigits(said);
    if (/^\d{1,2}$/.test(digits)) {
      const orderId = orderIds[Number(digits) - 1];
      return orderId ? { orderId } : { again: true };
    }
    const want = parseRef(said);
    if (want !== null) {
      const orderId = openRefs(o.ledger).orderOfRef(want);
      return orderId && orderIds.includes(orderId) ? { orderId } : { again: true };
    }
    return YES.has(said) ? { again: true } : null;
  }

  /**
   * Muse Spark compares the other reading's kept photo with the new one. No kept photo, no checker,
   * or a model error: null, and the photo goes on as before (work is never blocked by the check).
   * @param {string} otherSha256 @param {{mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}} photo
   */
  async function sameMachine(otherSha256, photo) {
    if (!o.sameMeter || !o.mediaStore) return null;
    let kept;
    try { kept = o.mediaStore.get(otherSha256); } catch { kept = null; }
    if (!kept || !isImageMime(kept.mime)) return null;
    try {
      const r = await o.sameMeter({ a: { mime: /** @type {'image/jpeg'} */ (kept.mime), bytes: kept.bytes }, b: photo });
      if (r.ok) return r;
      o.log?.(`meter: same-machine check unavailable (${r.reason}); photo handled as before`);
    } catch {
      o.log?.('meter: same-machine check failed; photo handled as before');
    }
    return null;
  }

  /**
   * A photo from the supplier is the challan of the order that is booked and not yet delivered. The
   * model reads it; code matches what it read to the order's items; the supplier confirms what was
   * read, or types the quantities when the photo is not clear. With several booked, the order is asked
   * for as for a meter photo (orderForPhoto).
   * @param {Person} person @param {Photo} image @param {string} [chosen] the order the person said this photo is for
   */
  async function onChallanImage(person, image, chosen) {
    if (!o.readChallan) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'challan.not_challan');
    const picked = await orderForPhoto(person, 'challan_job', image, chosen);
    if (!picked) return;
    const items = requestedItems(o.ledger.events(picked.orderId));
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const learnt = await readLearned('challan', person.role, picked.orderId, o.readChallan, { mime: image.mime, bytes: image.bytes },
      // Every figure used from the reading: a tax invoice's rate, taxable value, GST and grand total too.
      (r) => (r.ok && r.kind === 'challan' ? JSON.stringify([challanQuantities(items, r.items), r.challanNo, invoiceFromReading(items, r)]) : 'none'));
    const read = learnt.read;
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_challan') return o.reply(person, 'challan.not_challan');
    rememberPhoto(person, image);
    const challanNo = typeof read.challanNo === 'string' && read.challanNo.trim() ? read.challanNo.trim().slice(0, 40) : null;
    const qtys = challanQuantities(items, read.items);
    rememberRead(sha256, { kind: 'challan', party: person.role, orderId: picked.orderId, fields: items.map((i) => `qty ${i.name}`),
      read: qtys.map((q) => (q === null ? null : hundredthsText(q))), scale: 'hundredths', layout: layoutOf(read), memory: learnt.memory });
    // A tax invoice's GST rates, rates and grand total, as read, go with the delivery (never as quantities).
    const invoice = invoiceFromReading(items, read);
    if (!(read.clear || unitFromOrder(items, read)) || qtys.some((q) => q === null)) {
      pending.set(keyOf(person), { kind: 'challan_figures', orderId: picked.orderId, sha256, challanNo, invoice, at: o.now() });
      return askQuantities(person, picked.orderId, read.items.map((i) => i.raw).filter(Boolean).join(', '));
    }
    return proposeDelivery(person, { orderId: picked.orderId, sha256, challanNo, invoice }, /** @type {number[]} */ (qtys), { confirm: learnt.differs });
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
   * @param {{orderId: string, sha256: string, challanNo: string | null, invoice?: Invoice | null}} c `invoice`: what a tax
   *   invoice printed, one line per ordered item (src/agents/material.js invoiceFromReading)
   * @param {number[]} qtys
   * @param {{typed?: boolean, confirm?: boolean}} [how] `typed`: the supplier's own figures for the photo (learnt
   *   from); `confirm`: memory changed a figure of the reading, so it is read back
   */
  function proposeDelivery(person, c, qtys, how = {}) {
    const ordered = requestedItems(o.ledger.events(c.orderId));
    if (qtys.length !== ordered.length || qtys.every((q) => q === 0)) {
      pending.set(keyOf(person), { kind: 'challan_figures', ...c, at: o.now() });
      return askQuantities(person, c.orderId, '');
    }
    const kept = ordered.map((it, i) => ({ item: { name: it.name, qtyHundredths: qtys[i], unit: it.unit }, line: c.invoice?.lines[i] })).filter((x) => x.item.qtyHundredths > 0);
    const items = kept.map((x) => x.item);
    // The invoice's lines follow the delivered items; the whole reading stays for figures typed again.
    const invoice = c.invoice ? { lines: kept.map((x) => x.line ?? null), grandTotalPaise: c.invoice.grandTotalPaise } : null;
    const args = { orderId: c.orderId, items, sha256: c.sha256, challanNo: c.challanNo, ...(invoice ? { invoice, orderedInvoice: c.invoice } : {}) };
    if (how.confirm) return propose(person, 'record_delivery', args, { key: 'learn.read_back_challan', params: { items: items.map((it) => `${it.name} ${qtyText(it.qtyHundredths, it.unit)}`).join(', ') } });
    return commitNow(person, 'record_delivery', args, how.typed ? () => learnFrom(c.sha256, qtys) : undefined);
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
    // The supplier printed the challan: its memory is that supplier's, when all open orders are with one.
    const sellers = new Set(open.map((r) => /** @type {{counterparty: string} | null} */ (o.ledger.order(r.orderId))?.counterparty));
    const seller = sellers.size === 1 ? [...sellers][0] : undefined;
    const photo = { mime: /** @type {'image/jpeg'} */ (image.mime), bytes: image.bytes };
    const learnt = seller
      ? await readLearned('site_challan', seller, open.length === 1 ? open[0].orderId : null, o.readChallan, photo,
        (r) => (r.ok && r.kind === 'challan' ? JSON.stringify([r.items.map((i) => i.qtyHundredths), r.challanNo, r.signed ?? null]) : 'none'))
      : { read: await o.readChallan(photo), memory: 0, differs: false };
    const read = learnt.read;
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_challan') return o.reply(person, 'challan.not_challan');
    rememberPhoto(person, image);
    const challanNo = typeof read.challanNo === 'string' && read.challanNo.trim() ? read.challanNo.trim().slice(0, 40) : null;
    rememberSigned(sha256, read.signed);
    /** @type {SiteReading} */
    const reading = { challanNo, items: read.items, clear: read.clear, onlyUnitMissing: read.onlyUnitMissing, memory: learnt.memory, differs: learnt.differs };
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
    const ordered = requestedItems(o.ledger.events(orderId));
    const qtys = challanQuantities(ordered, reading.items);
    rememberRead(sha256, { kind: 'site_challan', party: partyOf(person, orderId, true), orderId, fields: ordered.map((i) => `qty ${i.name}`),
      read: qtys.map((q) => (q === null ? null : hundredthsText(q))), scale: 'hundredths', layout: layoutOf(reading), memory: reading.memory ?? 0 });
    if (!(reading.clear || unitFromOrder(ordered, reading)) || qtys.some((q) => q === null)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId, sha256, challanNo: reading.challanNo, at: o.now() });
      const raw = reading.items.map((i) => i.raw).filter(Boolean).join(', ');
      return o.reply(person, raw ? 'site.challan_ask_person' : 'site.challan_ask_person_blank', { ref: refOf(orderId), raw, names: namesOf(orderId) });
    }
    return proposeSiteCount(person, { orderId, sha256, challanNo: reading.challanNo }, /** @type {number[]} */ (qtys), 'read', reading.differs === true);
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
   * @param {boolean} [memoryDiffers] memory changed a figure of the reading: read back, never recorded silently
   */
  function proposeSiteCount(person, c, qtys, from, memoryDiffers = false) {
    const ordered = requestedItems(o.ledger.events(c.orderId));
    if (qtys.length !== ordered.length || qtys.every((q) => q === 0)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId: c.orderId, sha256: c.sha256, challanNo: c.challanNo, at: o.now() });
      return o.reply(person, 'site.challan_ask_person_blank', { ref: refOf(c.orderId), names: namesOf(c.orderId) });
    }
    /** @type {Record<string, any>} */
    const args = { orderId: c.orderId, qtysHundredths: qtys, challan: { sha256: c.sha256, number: c.challanNo, ...(signedOf.has(c.sha256) ? { signed: signedOf.get(c.sha256) } : {}) } };
    if (from === 'typed') return commitNow(person, 'confirm_count', args, () => learnFrom(c.sha256, qtys));
    args.sameAsChallan = true;
    const d = delivery(o.ledger.events(c.orderId));
    const counted = ordered.map((it, i) => ({ name: it.name, unit: it.unit, qtyHundredths: qtys[i] })).filter((it) => it.qtyHundredths > 0);
    const differs = d !== null && (countDifferences(counted, d.items).length > 0 || (c.challanNo !== null && d.number !== null && !sameChallanNo(c.challanNo, d.number)));
    if (differs) return propose(person, 'confirm_count', args);
    if (memoryDiffers) return propose(person, 'confirm_count', args, { key: 'learn.read_back_site', params: { ref: refOf(c.orderId), items: counted.map((it) => `${it.name} ${qtyText(it.qtyHundredths, it.unit)}`).join(', ') } });
    return commitNow(person, 'confirm_count', args);
  }

  /**
   * A UPI screenshot from the contractor is a payment claim (CONTRACTS 4.1): any amount, part or
   * more. The model reads it; code decides the order: the one typed just before ("P-3 अग्रिम ₹5,000"),
   * else the one order with something owed (or, with nothing billed, the one order booked). A clear
   * successful payment for one order is sent at once with the balance (the seller's हाँ is the check);
   * several orders owed are asked: which one, or the split of one payment among them.
   * @param {Person} person
   * @param {Photo} image
   */
  async function onPaymentImage(person, image) {
    if (!o.readUpi) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'payment.not_upi');
    // A forwarded receipt can be someone else's payment (a sub-contractor paying this person): only
    // a screenshot from their own UPI app becomes a signed claim. Challans stay exempt (CONTRACTS 7).
    if (image.forwarded) return o.reply(person, 'payment.forwarded');
    const typed = payWait(person);
    if (!typed && payableOrders(o.ledger).length === 0) return o.reply(person, 'common.wrong_state');
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
    payWaits.delete(keyOf(person));
    /** @type {Record<string, any>} */
    const base = { method: 'upi', utr: read.utr, paidOn: day, screenshotSha256: createHash('sha256').update(image.bytes).digest('hex') };
    // The receipt's clock (HH:MM) goes with the claim only when it was printed and read.
    if (typeof read.clock === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(read.clock)) base.paidAt = read.clock;
    const payee = plain(read.payeeName, 60);
    if (payee) base.payeeName = payee;
    rememberPhoto(person, image);
    if (typed && typed.amountPaise !== read.amountPaise) {
      traceCheck(`UPI amount ✗ ≠ typed: ${rupees(read.amountPaise)} / ${rupees(typed.amountPaise)}`, false, { name: 'upi_amount_typed', paidPaise: read.amountPaise, typedPaise: typed.amountPaise, utr: read.utr });
      // The screenshot's amount is the one that goes; the payer sees both first.
      if (typed.orderIds && typed.orderIds.length === 1) {
        return propose(person, 'claim_payment', { ...base, orderId: typed.orderIds[0], amountPaise: read.amountPaise }, { key: 'pay.shot_differs', params: { seen: rupees(read.amountPaise), typed: rupees(typed.amountPaise) } });
      }
    }
    return payTo(person, typed?.orderIds ?? null, read.amountPaise, base);
  }

  /**
   * A payment typed as words (src/agents/replies.js): cash goes now (to the order named, or decided
   * as for a screenshot); without "नकद" the UPI screenshot is asked for, or "नकद".
   * @param {Person} person @param {{orderIds: string[] | null, amountPaise: number, method: 'cash' | null, advance: boolean}} w
   */
  async function payTyped(person, w) {
    let orderIds = w.orderIds;
    // "अग्रिम ₹5,000" without a reference: the one order booked and not billed yet.
    if (orderIds === null && w.advance) {
      const open = payableOrders(o.ledger).filter((x) => x.owedPaise === null);
      if (open.length === 0) return o.reply(person, 'common.wrong_state');
      if (open.length > 1) return askWhich(person, open.map((x) => x.orderId), w.amountPaise, null);
      orderIds = [open[0].orderId];
    }
    if (w.method === 'cash') return payTo(person, orderIds, w.amountPaise, { method: 'cash', paidOn: todayIst(o.now()) });
    payWaits.set(keyOf(person), { orderIds, amountPaise: w.amountPaise, at: o.now() });
    const refs = (orderIds ?? []).map((id) => refOfId(id)).join(', ');
    return o.reply(person, 'pay.await_shot', { what: refs ? `${refs} ${rupees(w.amountPaise)}` : rupees(w.amountPaise) });
  }

  /** @param {string} orderId */
  const refOfId = (orderId) => openRefs(o.ledger).refOf(orderId) ?? orderId.slice(0, 8);

  /**
   * Where one payment goes: the orders named, else the one order owed something, else the one with
   * exactly this amount owed; several orders owed by one seller → the split read back (or one named);
   * several sellers → which order.
   * @param {Person} person @param {string[] | null} orderIds @param {number} amountPaise @param {Record<string, any>} base
   */
  function payTo(person, orderIds, amountPaise, base) {
    if (orderIds && orderIds.length === 1) return paySingle(person, orderIds[0], amountPaise, base);
    if (orderIds && orderIds.length > 1) return payGroup(person, orderIds, amountPaise, base, false);
    const payable = payableOrders(o.ledger);
    const owed = payable.filter((x) => x.owedPaise !== null && x.owedPaise > 0);
    if (owed.length === 0) {
      // Nothing billed and owed: an advance for the one order booked, else which.
      if (payable.length === 1) return paySingle(person, payable[0].orderId, amountPaise, base);
      if (payable.length === 0) return o.reply(person, 'common.wrong_state');
      return askWhich(person, payable.map((x) => x.orderId), amountPaise, base);
    }
    if (owed.length === 1) return paySingle(person, owed[0].orderId, amountPaise, base);
    const exact = owed.filter((x) => x.owedPaise === amountPaise);
    traceCheck(`payment ${rupees(amountPaise)}: ${owed.length} orders owed, ${exact.length} with exactly this amount`, exact.length === 1,
      { name: 'payment_order', amountPaise, owed: owed.map((x) => ({ orderId: x.orderId, owedPaise: x.owedPaise })) });
    if (exact.length === 1) return paySingle(person, exact[0].orderId, amountPaise, base);
    if (new Set(owed.map((x) => x.counterparty)).size > 1) return askWhich(person, owed.map((x) => x.orderId), amountPaise, base);
    // One seller: offer the split, oldest bill first; naming one order sends it all to that order.
    const ids = owed.map((x) => x.orderId);
    const split = shares(o.ledger, ids, amountPaise);
    if (split === null) return askWhich(person, ids, amountPaise, base);
    pending.set(keyOf(person), { kind: 'pay_choice', orderIds: ids, group: true, amountPaise, base, at: o.now() });
    return o.reply(person, 'pay.split_choose', { amount: rupees(amountPaise), to: sellerWord(ids[0]), lines: shareText(split), ref: refOfId(ids[0]) });
  }

  /** @param {string} orderId */
  const sellerWord = (orderId) => t(/** @type {{kind: string} | null} */ (o.ledger.order(orderId))?.kind === 'material' ? 'pay.to.supplier' : 'pay.to.jcb');
  /** @param {{orderId: string, amountPaise: number}[]} split */
  const shareText = (split) => split.map((x) => t(o.ledger.view(x.orderId).currentBill === null ? 'pay.share_advance' : 'pay.share', { ref: refOfId(x.orderId), amount: rupees(x.amountPaise) })).join('\n');

  /**
   * Which order is this payment for? The orders with their balance; the answer is a reference.
   * Without the payment's proof yet (base null), the answer starts the wait for it.
   * @param {Person} person @param {string[]} orderIds @param {number} amountPaise @param {Record<string, any> | null} base
   */
  function askWhich(person, orderIds, amountPaise, base) {
    if (base) pending.set(keyOf(person), { kind: 'pay_choice', orderIds, group: false, amountPaise, base, at: o.now() });
    const lines = orderIds.map((id) => `${refOfId(id)}: ${balanceText(summaryOf(o.ledger, id))}`).join('\n');
    return o.reply(person, 'pay.which_order', { payment: base ? paymentLine({ ...base, amountPaise }) : rupees(amountPaise), lines });
  }

  /**
   * A UTR already told to this seller is never sent silently: both are shown and asked.
   * @param {string} seller @param {Record<string, any>} base @param {string} now @returns {{key: string, params: Record<string, string>} | null}
   */
  function utrQuestion(seller, base, now) {
    if (typeof base.utr !== 'string') return null;
    const used = utrUses(o.ledger, seller, base.utr);
    traceCheck(`UTR ${base.utr} ${used.length ? '✗ used before' : '✓ not used before'}`, used.length === 0, { name: 'utr_unused', utr: base.utr, uses: used.length });
    if (used.length === 0) return null;
    return { key: 'pay.utr_used', params: { utr: base.utr, before: used.map((u) => `${refOfId(u.orderId)}: ${paymentLine(u.body)}`).join('; '), now } };
  }

  /** One order's payment: sent at once (its UTR asked first when already used). @param {Person} person @param {string} orderId @param {number} amountPaise @param {Record<string, any>} base */
  function paySingle(person, orderId, amountPaise, base) {
    const args = { ...base, orderId, amountPaise };
    const seller = /** @type {{counterparty: string}} */ (o.ledger.order(orderId)).counterparty;
    if (base.method === 'upi') {
      // Shown, never refused: a part payment or more than owed is a payment too (CONTRACTS 4.1).
      const owed = owedPaise(summaryOf(o.ledger, orderId));
      traceCheck(owed === null ? `UPI amount ${rupees(amountPaise)}: no bill yet (advance)` : `UPI amount ${owed === amountPaise ? '✓ =' : '≠'} owed: ${rupees(amountPaise)} / ${rupees(owed)}`,
        owed === amountPaise, { name: 'upi_amount', paidPaise: amountPaise, owedPaise: owed, utr: base.utr }, orderId);
    }
    const q = utrQuestion(seller, base, paymentLine(args));
    if (q) return propose(person, 'claim_payment', { ...args, sameUtrOk: true }, q);
    return commitNow(person, 'claim_payment', args);
  }

  /**
   * One payment for several orders: the split read back once (unless the payer already said yes
   * to it), the UTR asked first when already used.
   * @param {Person} person @param {string[]} orderIds @param {number} totalPaise @param {Record<string, any>} base @param {boolean} agreed
   */
  function payGroup(person, orderIds, totalPaise, base, agreed) {
    const sellers = new Set(orderIds.map((id) => /** @type {{counterparty: string} | null} */ (o.ledger.order(id))?.counterparty));
    if (sellers.size !== 1 || sellers.has(undefined)) return o.reply(person, 'pay.one_seller');
    const args = { ...base, orderIds, totalPaise };
    const q = utrQuestion(/** @type {string} */ ([...sellers][0]), base, paymentLine({ ...base, amountPaise: totalPaise }));
    if (q) return propose(person, 'claim_group', { ...args, sameUtrOk: true }, q);
    return agreed ? commitNow(person, 'claim_group', args) : propose(person, 'claim_group', args);
  }

  /**
   * After a notice that asks this person a yes/no question: a plain "yes" runs this step, and a
   * plain "no" runs `no` when given (otherwise nothing happens). With another question open it never
   * takes that one's place: it waits, and is asked when that one is answered or lapses.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   * @param {{tool: string, args: Record<string, any>}} [no] @param {Asked} [ask] the notice's own words
   */
  function expect(person, tool, args, no, ask) {
    const open = current(person);
    if (!open) {
      pending.set(keyOf(person), { kind: 'confirm', tool, args, ...(no ? { no } : {}), ...(ask ? { ask } : {}), at: o.now(), notice: true });
      return;
    }
    const same = (/** @type {{tool: string, args: Record<string, any>}} */ q) => q.tool === tool && JSON.stringify(q.args) === JSON.stringify(args);
    if (open.kind === 'confirm' && same(open)) return;
    const queue = waiting.get(keyOf(person)) ?? [];
    if (queue.some(same)) return;
    if (queue.length >= MAX_WAITING) queue.shift();
    queue.push({ tool, args, ...(no ? { no } : {}), ...(ask ? { ask } : {}) });
    waiting.set(keyOf(person), queue);
  }

  /**
   * Notices about these references were told again to this person (src/app.js tellWaiting). They set no
   * expectation; for a while a bare yes only says how to answer them (replayedOpen).
   * @param {Person} person @param {string[]} refs
   */
  function replayed(person, refs) {
    replayedRefs.set(keyOf(person), { refs, at: o.now() });
  }

  return { onText, onImage, expect, replayed, pending: (/** @type {Person} */ p) => current(p) };
}
