// Checks on a meter photo before anything is recorded (docs/BUILD2.md "Photo guards and owner
// consent"). The reader copies a date shown on the display as printed; code parses it and compares it
// with the job's day. Code decides; a date it cannot parse is ignored, never guessed.

import { ofType } from './common.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = `(${MONTHS.join('|')})[a-z]*\\.?`;
const IST_MS = 330 * 60_000;

/** @param {number} y @param {number} m @param {number} d @returns {string | null} */
function dayOf(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2099)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 ? date.toISOString().slice(0, 10) : null;
}

/** A year left out is the one that puts the date nearest the job's day. @param {number} m @param {number} d @param {string} near */
function nearestYear(m, d, near) {
  const y = Number(near.slice(0, 4));
  const t = Date.parse(`${near}T00:00:00Z`);
  const all = [y - 1, y, y + 1].map((yy) => dayOf(yy, m, d)).filter((x) => x !== null);
  return all.sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - t) - Math.abs(Date.parse(`${b}T00:00:00Z`) - t))[0] ?? null;
}

/** @param {string | undefined} y @param {number} m @param {number} d @param {string} near */
function withYear(y, m, d, near) {
  if (y === undefined) return nearestYear(m, d, near);
  return dayOf(y.length === 2 ? 2000 + Number(y) : Number(y), m, d);
}

/**
 * The days a display date as printed can mean: one day, or two for a numeric date that reads both
 * day-month and month-day ("03/10"). Null when it is not a date code can read.
 * @param {string | null | undefined} text e.g. "26 OCT", "26/10/2026", "2026-10-26", "OCT 26"
 * @param {string} near the job's day (YYYY-MM-DD), for a date printed without a year
 * @returns {string[] | null}
 */
export function displayDays(text, near) {
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return one(dayOf(Number(m[1]), Number(m[2]), Number(m[3])));
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ \\-/.]?${MONTH}(?:[ ,\\-/.]+(\\d{4}|\\d{2}))?$`).exec(s);
  if (m) return one(withYear(m[3], MONTHS.indexOf(m[2]) + 1, Number(m[1]), near));
  m = new RegExp(`^${MONTH}[ \\-/.]?(\\d{1,2})(?:st|nd|rd|th)?(?:[ ,\\-/.]+(\\d{4}|\\d{2}))?$`).exec(s);
  if (m) return one(withYear(m[3], MONTHS.indexOf(m[1]) + 1, Number(m[2]), near));
  m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?$/.exec(s);
  if (m) {
    const days = [...new Set([withYear(m[3], Number(m[2]), Number(m[1]), near), withYear(m[3], Number(m[1]), Number(m[2]), near)]
      .filter((x) => x !== null))];
    return days.length ? days : null;
  }
  return null;
}

/** @param {string | null} d */
const one = (d) => (d === null ? null : [d]);

/** @param {string} day @param {number} n */
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The day the job is for: the day our "yes" (or the other day agreed) names, else the day asked for.
 * @param {import('../ledger/store.js').LedgerEvent[]} events
 * @returns {string | null}
 */
export function jobDay(events) {
  const yes = ofType(events, 'BOOKING_REPLY').filter((e) => e.body.body.answer === 'yes').at(-1)?.body.body;
  const asked = ofType(events, 'BOOKING_REQUEST').at(-1)?.body.body;
  const day = yes?.day ?? asked?.day;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Does the display's date rule this photo out? Allowed: the job's day, the day before (a night shift
 * that began then), and today or yesterday in IST (work done later than booked). A date code cannot
 * read, or a job without a day, rules nothing out.
 * @param {string | null | undefined} displayDate as printed @param {string | null} day the job's day @param {number} nowMs
 * @returns {{wrong: false} | {wrong: true, shown: string}}
 */
export function displayDateWrong(displayDate, day, nowMs) {
  if (!day) return { wrong: false };
  const days = displayDays(displayDate, day);
  if (!days) return { wrong: false };
  const today = new Date(nowMs + IST_MS).toISOString().slice(0, 10);
  const allowed = new Set([day, addDays(day, -1), today, addDays(today, -1)]);
  return days.some((d) => allowed.has(d)) ? { wrong: false } : { wrong: true, shown: String(displayDate).trim() };
}
