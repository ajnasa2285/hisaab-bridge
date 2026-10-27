// Turning what a person wrote (as the model copied it out) into the integers the agents use.
// The model copies figures exactly as written; every conversion and every date is done here.

/**
 * "6.1" → 61, "6" → 60. More than one decimal, or anything else, is refused (null).
 * @param {unknown} s
 * @returns {number | null}
 */
export function parseTenths(s) {
  if (typeof s !== 'string' || !/^\d{1,6}(\.\d)?$/.test(s.trim())) return null;
  const [w, f = '0'] = s.trim().split('.');
  return Number(w) * 10 + Number(f);
}

/**
 * "7320" → 732000, "7,320.50" → 732050 (commas allowed as grouping only).
 * @param {unknown} s
 * @returns {number | null}
 */
export function parsePaise(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^₹\s*/, '');
  if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.replace(/,/g, '').split('.');
  const paise = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

/** The IST calendar day of a moment. @param {number} ms @returns {string} YYYY-MM-DD */
export function istDay(ms) {
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {string} day @param {number} n */
function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * A day as the model copied it: 'today' | 'tomorrow' | 'day_after' | 'DD-MM' | 'DD-MM-YYYY'
 * (also with '/' or '.'). 'DD-MM' is this year, or next year if that date is more than 60 days past.
 * @param {unknown} s
 * @param {number} nowMs
 * @returns {string | null} YYYY-MM-DD
 */
export function resolveDay(s, nowMs) {
  if (typeof s !== 'string') return null;
  const today = istDay(nowMs);
  const t = s.trim().toLowerCase();
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  if (t === 'day_after') return addDays(today, 2);
  const m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}))?$/.exec(t);
  if (!m) return null;
  const [d, mo] = [Number(m[1]), Number(m[2])];
  let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  const make = (/** @type {number} */ y) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let day = make(year);
  const check = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d || check.getUTCMonth() + 1 !== mo) return null;
  if (!m[3] && Date.parse(`${day}T00:00:00Z`) < Date.parse(`${addDays(today, -60)}T00:00:00Z`)) day = make(year += 1);
  return day;
}

/** "8", "8:00", "08:30" → "08:00"/"08:30"; null when absent or not a time. @param {unknown} s */
export function parseTime(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(s.trim());
  if (!m || Number(m[1]) > 23) return null;
  return `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
}
