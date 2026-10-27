// One person's conversation with their agent. A text becomes one proposed step (Muse Spark, via the
// orchestrator); a step that commits anything is read back and runs only after the person says yes.
// A meter photo is read by Muse Spark; the reading is confirmed by the person, or typed by them when
// the photo is not clear. People decide; the model only proposes.

import { createHash } from 'node:crypto';
import { proposeStep, orderRefs, pickOrder } from '../orchestrator/orchestrator.js';
import { meterReadings } from './jcb.js';
import { runTool } from './common.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {(person: Person, key: string, params?: Record<string, string | number>) => Promise<void> | void} Reply */
/**
 * @typedef {{kind: 'confirm', tool: string, args: Record<string, any>, at: number} |
 *   {kind: 'meter_digits', orderId: string, which: 'start' | 'end', sha256: string, takenAt: string | null, at: number}} Pending
 */
/** @typedef {(image: {mime: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Uint8Array}) => Promise<
 *   {ok: true, kind: 'hour_meter', raw: string, valueTenths: number | null, clear: boolean} | {ok: true, kind: 'not_meter'} |
 *   {ok: false, transient: boolean, reason: string}>} MeterReader */

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
 *   reply: Reply,
 *   now: () => number,
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

  /** Asks the person to confirm a committing step, or runs one that commits nothing. @param {Person} person @param {string} tool @param {Record<string, any>} args */
  async function propose(person, tool, args) {
    const t = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (!t) return o.reply(person, 'common.unknown_step');
    if (!t.roles.includes(person.role)) return o.reply(person, 'common.not_allowed');
    if (!t.commits || !t.describe) {
      const r = await runTool(o.tools, person, { tool, args });
      return o.reply(person, r.key, r.params);
    }
    pending.set(keyOf(person), { kind: 'confirm', tool, args, at: o.now() });
    const d = t.describe(args);
    return o.reply(person, d.key, d.params);
  }

  /**
   * @param {Person} person
   * @param {string} text
   */
  async function onText(person, text) {
    const said = norm(text);
    const p = current(person);
    if (p && p.kind === 'confirm') {
      if (YES.has(said)) {
        pending.delete(keyOf(person));
        const r = await runTool(o.tools, person, { tool: p.tool, args: p.args });
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
      // Anything else: the question lapses and the message is read as a new one.
      pending.delete(keyOf(person));
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
   * After a notice that asks this person a yes/no question: a plain "yes" runs this step.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   */
  function expect(person, tool, args) {
    pending.set(keyOf(person), { kind: 'confirm', tool, args, at: o.now() });
  }

  return { onText, onImage, expect, pending: (/** @type {Person} */ p) => current(p) };
}
