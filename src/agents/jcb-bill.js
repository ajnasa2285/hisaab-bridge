// The figures of a JCB job, pure: its limit, its meter readings and the bill they make. Both the JCB
// owner's agent and the contractor's agent work a bill out this same way (the contractor's to check what
// it receives), and neither should have to load the other's agent code to do so.

import { tenths as hours } from '../i18n/format.js';
import { ofType } from './common.js';

/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
// One job is one day's work: more than 24 hours between two meter readings means the photos are of
// different machines or a misread, never work done. Code refuses it; the person sends the right photo
// or types the digits. (Found live on 29 Oct: two clear photos of two different JCBs gave 4,738 hours.)
export const MAX_JOB_TENTHS = 240;
/** @param {number} startTenths @param {number} endTenths */
export const impossible = (startTenths, endTenths) => ({ start: hours(startTenths), end: hours(endTenths), hours: hours(endTenths - startTenths) });

/** @typedef {{which: 'start' | 'end', valueTenths: number, sha256: string, takenAt: string | null, at: string, record?: string}} MeterReading */

/**
 * The meter readings in force for an order: the latest confirmed start and end.
 * @param {LedgerEvent[]} events
 * @returns {{start: MeterReading | null, end: MeterReading | null}}
 */
export function meterReadings(events) {
  /** @type {{start: MeterReading | null, end: MeterReading | null}} */
  const r = { start: null, end: null };
  for (const e of ofType(events, 'EVIDENCE', 'local')) {
    if (e.body.kind !== 'meter') continue;
    const which = /** @type {'start' | 'end'} */ (e.body.which);
    r[which] = { which, valueTenths: e.body.valueTenths, sha256: e.body.sha256, takenAt: e.body.takenAt ?? null, at: e.at, record: e.msgId ?? undefined };
  }
  return r;
}

/**
 * Bill lines and evidence from the ledger. Rounds the amount to the nearest paisa only when the
 * rate is not a whole number of paise per tenth of an hour.
 * @param {number} hoursTenths
 * @param {number} ratePaise per hour
 * @param {MeterReading[]} readings
 */
export function jcbBillBody(hoursTenths, ratePaise, readings) {
  const amountPaise = Math.round((hoursTenths * ratePaise) / 10);
  return {
    lines: [{ what: 'JCB', hoursTenths, ratePaise, amountPaise }],
    totalPaise: amountPaise,
    evidence: readings.map((m) => ({ sha256: m.sha256, kind: 'meter', readValue: hours(m.valueTenths), takenAt: m.takenAt, sentAt: m.at, ...(m.record ? { record: m.record } : {}) })),
  };
}
