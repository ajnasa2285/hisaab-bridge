// One person's conversation with their agent. A text becomes one proposed step (Muse Spark, via the
// orchestrator); a step that commits anything is read back and runs only after the person says yes.
// A meter photo (or a challan photo, the supplier's or the site's own copy) is read by Muse Spark; the
// reading is confirmed by the person, or typed by them when the photo is not clear. Exact commands (status, pending, stock, ok,
// no) are answered by code before the model sees anything, and a confirmed step passes the site
// office's gate (approvals with limits, src/agents/office.js). People decide; the model only proposes.

import { createHash } from 'node:crypto';
import { proposeStep, orderRefs, pickOrder } from '../orchestrator/orchestrator.js';
import { parseHundredthsList } from '../orchestrator/units.js';
import { meterReadings } from './jcb.js';
import { challanQuantities, requestedItems, siteCount } from './material.js';
import { openRefs, parseRef } from '../ledger/refs.js';
import { runTool } from './common.js';
import { parseCommand } from './office.js';
import { day as dayName, rupees } from '../i18n/format.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {(person: Person, key: string, params?: Record<string, string | number>) => Promise<void> | void} Reply */
/**
 * @typedef {{kind: 'confirm', tool: string, args: Record<string, any>, at: number} |
 *   {kind: 'meter_digits', orderId: string, which: 'start' | 'end', sha256: string, takenAt: string | null, at: number} |
 *   {kind: 'challan_figures', orderId: string, sha256: string, challanNo: string | null, at: number} |
 *   {kind: 'site_challan_order', orderIds: string[], sha256: string, reading: SiteReading, at: number} |
 *   {kind: 'site_challan_figures', orderId: string, sha256: string, challanNo: string | null, at: number}} Pending
 */
/** @typedef {{challanNo: string | null, items: {name: string, qtyHundredths: number | null, raw: string}[], clear: boolean}} SiteReading */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'challan', challanNo: string | null, date: string | null,
 *     items: {name: string, qtyHundredths: number | null, unit: string | null, raw: string}[], clear: boolean} |
 *   {ok: true, kind: 'not_challan'} | {ok: false, transient: boolean, reason: string}>} ChallanReader */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'hour_meter', raw: string, valueTenths: number | null, clear: boolean} | {ok: true, kind: 'not_meter'} |
 *   {ok: false, transient: boolean, reason: string}>} MeterReader */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'upi_payment', amountPaise: number | null, date: string | null, utr: string | null,
 *     status: 'success' | 'pending' | 'failed' | null, clear: boolean} | {ok: true, kind: 'not_upi'} |
 *   {ok: false, transient: boolean, reason: string}>} UpiReader */

const PENDING_MS = 30 * 60 * 1000;
const YES = new Set(['हाँ', 'हां', 'हा', 'जी', 'जी हाँ', 'ठीक', 'ठीक है', 'सही', 'सही है', 'han', 'haan', 'ha', 'haa', 'ji', 'yes', 'y', 'ok', 'okay', 'theek', 'thik', 'sahi', '👍', '✅']);
const NO = new Set(['नहीं', 'नही', 'ना', 'न', 'गलत', 'ग़लत', 'nahi', 'nahin', 'nhi', 'na', 'no', 'n', 'galat', 'cancel', '❌']);
const HELP = new Set(['मदद', 'help', 'madad', '?']);

/** @param {string} text */
const norm = (text) => text.trim().toLowerCase().replace(/[।.!]+$/u, '').replace(/\s+/g, ' ');

/**
 * @param {{
 *   ledger: ReturnType<typeof import('../ledger/store.js').openLedger>,
 *   tools: Record<string, Tool>,
 *   spark: import('../orchestrator/orchestrator.js').Spark,
 *   readMeter?: MeterReader,
 *   readUpi?: UpiReader,
 *   readChallan?: ChallanReader,
 *   reply: Reply,
 *   now: () => number,
 *   office?: ReturnType<typeof import('./office.js').createOffice>,
 * }} o
 */
export function createConversation(o) {
  /** @type {Map<string, Pending>} */
  const pending = new Map();
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
    pending.set(keyOf(person), { kind: 'confirm', tool, args, at: o.now() });
    const d = readBack ?? t.describe(args);
    return o.reply(person, d.key, d.params);
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
    if (p && p.kind === 'confirm') {
      if (YES.has(said)) {
        pending.delete(keyOf(person));
        const r = o.office ? await o.office.commit(person, p.tool, p.args) : await runTool(o.tools, person, { tool: p.tool, args: p.args });
        // Once the site's count is recorded, nobody else's count question on that order stays open.
        if (r.ok && p.tool === 'confirm_count') {
          for (const [k, q] of pending) if (q.kind === 'confirm' && q.tool === 'confirm_count' && q.args.orderId === p.args.orderId) pending.delete(k);
        }
        return o.reply(person, r.key, r.params);
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      // A meter read-back can be answered with the right digits: read back again with them.
      const digits = /^(\d{1,7})(?:\.(\d))?$/.exec(said);
      if (p.tool === 'record_meter' && digits) {
        pending.delete(keyOf(person));
        return propose(person, 'record_meter', { ...p.args, valueTenths: Number(digits[1]) * 10 + Number(digits[2] ?? '0') });
      }
      // A challan read-back or a delivery count can be answered with the right quantities, in order.
      const figures = parseHundredthsList(said);
      if (figures && p.tool === 'record_delivery') {
        pending.delete(keyOf(person));
        return proposeDelivery(person, { orderId: p.args.orderId, sha256: p.args.sha256, challanNo: p.args.challanNo ?? null }, figures);
      }
      if (figures && p.tool === 'confirm_count' && p.args.challan) {
        pending.delete(keyOf(person));
        return proposeSiteCount(person, { orderId: p.args.orderId, sha256: p.args.challan.sha256, challanNo: p.args.challan.number ?? null }, figures, false);
      }
      if (figures && p.tool === 'confirm_count') {
        pending.delete(keyOf(person));
        return propose(person, 'confirm_count', { orderId: p.args.orderId, qtysHundredths: figures });
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
      if (figures) return proposeSiteCount(person, p, figures, false);
      if (NO.has(said)) return o.reply(person, 'step.cancelled');
    }
    if (p && p.kind === 'meter_digits') {
      const m = /^(\d{1,7})(?:\.(\d))?$/.exec(said);
      if (m) {
        pending.delete(keyOf(person));
        const valueTenths = Number(m[1]) * 10 + Number(m[2] ?? '0');
        return propose(person, 'record_meter', { orderId: p.orderId, which: p.which, valueTenths, sha256: p.sha256, takenAt: p.takenAt });
      }
      if (NO.has(said)) {
        pending.delete(keyOf(person));
        return o.reply(person, 'step.cancelled');
      }
      pending.delete(keyOf(person));
    }
    if (HELP.has(said)) return o.reply(person, `help.${person.role}`);

    const proposal = await proposeStep({ spark: o.spark, person, text, orders: orderRefs(o.ledger), nowMs: o.now() });
    if (proposal.kind === 'help') return o.reply(person, `help.${person.role}`);
    if (proposal.kind === 'none') return o.reply(person, proposal.key);
    return propose(person, proposal.tool, proposal.args);
  }

  /**
   * A photo from the JCB side is a meter reading for the job that is booked or working.
   * @param {Person} person
   * @param {{mime: string, bytes: Uint8Array, takenAt?: string | null}} image
   */
  async function onImage(person, image) {
    if (mayCountChallan(person)) {
      if (person.role !== 'contractor' || !o.readUpi) return onSiteChallanImage(person, image);
      // The contractor's photo is a UPI screenshot or the site's challan; the open orders tell which,
      // and when both could be, a photo that is not a UPI screenshot is read as a challan.
      const toCount = uncounted().length > 0;
      const toPay = orderRefs(o.ledger).some((r) => r.state === 'accepted' || r.state === 'payment_claimed');
      if (toCount && !toPay) return onSiteChallanImage(person, image);
      if (toCount) return onPaymentImage(person, image, () => onSiteChallanImage(person, image));
    }
    if (person.role === 'contractor') return onPaymentImage(person, image);
    if (person.role === 'supplier') return onChallanImage(person, image);
    if (person.role !== 'operator' && person.role !== 'jcb_owner') return o.reply(person, 'common.unknown_step');
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
      return o.reply(person, 'meter.ask_person', { raw: read.raw || '—' });
    }
    return propose(person, 'record_meter', { orderId: picked.orderId, which, valueTenths: read.valueTenths, sha256, takenAt });
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
    return o.reply(person, 'challan.ask_person', { raw: raw || '—', items: items || '—' });
  }

  /**
   * Reads back a delivery: one quantity per ordered item, in order; an item at 0 was not delivered.
   * Typed figures that do not fit the order are asked for again.
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
    return propose(person, 'record_delivery', { orderId: c.orderId, items, sha256: c.sha256, challanNo: c.challanNo });
  }

  /** May this person count a delivery from the site's own challan on this agent? @param {Person} person */
  function mayCountChallan(person) {
    return !!o.readChallan && Object.hasOwn(o.tools, 'confirm_count') && o.tools.confirm_count.roles.includes(person.role);
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
    /** @type {SiteReading} */
    const reading = { challanNo, items: read.items, clear: read.clear };
    if (open.length > 1) {
      pending.set(keyOf(person), { kind: 'site_challan_order', orderIds: open.map((r) => r.orderId), sha256, reading, at: o.now() });
      return askOrder(person, open.map((r) => r.orderId));
    }
    return siteCountFromRead(person, open[0].orderId, sha256, reading);
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
   * What the reader saw, as the site's count of this order: read back when every item was read
   * clearly, else the person types the figures. Nothing is filled in.
   * @param {Person} person @param {string} orderId @param {string} sha256 @param {SiteReading} reading
   */
  function siteCountFromRead(person, orderId, sha256, reading) {
    const qtys = challanQuantities(requestedItems(o.ledger.events(orderId)), reading.items);
    if (!reading.clear || qtys.some((q) => q === null)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId, sha256, challanNo: reading.challanNo, at: o.now() });
      return o.reply(person, 'site.challan_ask_person', { ref: refOf(orderId), raw: reading.items.map((i) => i.raw).filter(Boolean).join(', ') || '—', names: namesOf(orderId) });
    }
    return proposeSiteCount(person, { orderId, sha256, challanNo: reading.challanNo }, /** @type {number[]} */ (qtys), true);
  }

  /**
   * Reads back the site's count from its challan: one figure per ordered item, in order (0 = did not
   * come). `fromRead` marks figures the reader saw: a bare "हाँ" to them records a first count only.
   * Typed figures that do not fit the order are asked for again.
   * @param {Person} person
   * @param {{orderId: string, sha256: string, challanNo: string | null}} c
   * @param {number[]} qtys
   * @param {boolean} fromRead
   */
  function proposeSiteCount(person, c, qtys, fromRead) {
    const ordered = requestedItems(o.ledger.events(c.orderId));
    if (qtys.length !== ordered.length || qtys.every((q) => q === 0)) {
      pending.set(keyOf(person), { kind: 'site_challan_figures', orderId: c.orderId, sha256: c.sha256, challanNo: c.challanNo, at: o.now() });
      return o.reply(person, 'site.challan_ask_person', { ref: refOf(c.orderId), raw: '—', names: namesOf(c.orderId) });
    }
    /** @type {Record<string, any>} */
    const args = { orderId: c.orderId, qtysHundredths: qtys, challan: { sha256: c.sha256, number: c.challanNo } };
    if (fromRead) args.sameAsChallan = true;
    return propose(person, 'confirm_count', args);
  }

  /**
   * A UPI screenshot from the contractor is a payment claim for the accepted bill. The model reads
   * it; the contractor confirms what was read; the JCB owner later confirms the money arrived.
   * @param {Person} person
   * @param {{mime: string, bytes: Uint8Array}} image
   * @param {() => Promise<void> | void} [notUpi] what to do instead when the photo is not a UPI screenshot
   */
  async function onPaymentImage(person, image, notUpi) {
    if (!o.readUpi) return o.reply(person, 'orchestrator.try_again');
    if (image.mime !== 'image/jpeg' && image.mime !== 'image/png' && image.mime !== 'image/webp') return o.reply(person, 'payment.not_upi');
    const picked = pickOrder(orderRefs(o.ledger), null, ['accepted', 'payment_claimed']);
    if (typeof picked === 'string') return o.reply(person, picked);
    const read = await o.readUpi({ mime: image.mime, bytes: image.bytes });
    if (!read.ok) return o.reply(person, 'orchestrator.try_again');
    if (read.kind === 'not_upi') return notUpi ? notUpi() : o.reply(person, 'payment.not_upi');
    const day = read.date && /^\d{4}-\d{2}-\d{2}$/.test(read.date) ? read.date : null;
    if (!read.clear || read.amountPaise === null || !read.utr || day === null) return o.reply(person, 'payment.retake');
    if (read.status !== 'success') {
      return o.reply(person, 'payment.read', {
        amount: rupees(read.amountPaise), utr: read.utr, day: dayName(day), status: t(`payment.status.${read.status ?? 'unknown'}`),
      });
    }
    const args = { orderId: picked.orderId, amountPaise: read.amountPaise, utr: read.utr, paidOn: day, screenshotSha256: createHash('sha256').update(image.bytes).digest('hex') };
    const bill = o.ledger.view(picked.orderId).currentBill;
    const total = bill ? o.ledger.eventOfMessage(bill)?.body.body.totalPaise : undefined;
    // A different amount is not refused (part payments happen); the contractor sees both figures first.
    if (Number.isSafeInteger(total) && total !== read.amountPaise) {
      return propose(person, 'claim_payment', args, { key: 'payment.amount_differs', params: { seen: rupees(read.amountPaise), total: rupees(/** @type {number} */ (total)) } });
    }
    return propose(person, 'claim_payment', args);
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
