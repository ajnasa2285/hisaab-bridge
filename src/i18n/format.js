// Numbers for the texts (docs/CONTRACTS.md section 9): formatted by code, from integers only.
// Money in paise, hours in tenths, quantities in hundredths; never a float on the way.

const MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
export const NONE = '—';

/** @param {unknown} n */
function requireInt(n, what = 'number') {
  if (!Number.isSafeInteger(n)) throw new TypeError(`format: ${what} must be a safe integer, got ${String(n)}`);
  return /** @type {number} */ (n);
}

/**
 * Indian digit grouping: 1234567 -> "12,34,567".
 * @param {number} n a non-negative safe integer
 */
export function groupIndian(n) {
  const s = String(requireInt(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/**
 * @param {number} paise
 * @returns {string} "₹7,320" or "₹7,320.50"; a negative amount keeps its sign: "-₹500"
 */
export function rupees(paise) {
  const p = requireInt(paise, 'paise');
  const abs = Math.abs(p);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const sign = p < 0 ? '-' : '';
  return `${sign}₹${groupIndian(whole)}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
}

/**
 * @param {number} tenths
 * @returns {string} "6.1 घंटे" (61), "6 घंटे" (60)
 */
export function hours(tenths) {
  const t = requireInt(tenths, 'tenths');
  const abs = Math.abs(t);
  const whole = Math.trunc(abs / 10);
  const frac = abs % 10;
  return `${t < 0 ? '-' : ''}${whole}${frac === 0 ? '' : `.${frac}`} घंटे`;
}

/**
 * @param {number} hundredths
 * @param {string} unit e.g. "बोरी"
 * @returns {string} "50 बोरी" (5000), "2.5 ट्रॉली" (250), "1.25 टन" (125)
 */
export function qty(hundredths, unit) {
  const h = requireInt(hundredths, 'hundredths');
  const abs = Math.abs(h);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  let fracText = '';
  if (frac !== 0) fracText = frac % 10 === 0 ? `.${frac / 10}` : `.${String(frac).padStart(2, '0')}`;
  return `${h < 0 ? '-' : ''}${whole}${fracText} ${unit}`;
}

/**
 * @param {string} isoDay "YYYY-MM-DD"
 * @returns {string} "29 अक्टूबर 2026"
 */
export function day(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) throw new TypeError(`format: day must be YYYY-MM-DD, got ${String(isoDay)}`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new TypeError(`format: bad month in ${isoDay}`);
  return `${Number(m[3])} ${MONTHS[month - 1]} ${m[1]}`;
}

/**
 * A missing value is shown as "—", never as 0 or an invented figure.
 * @template T
 * @param {T|null|undefined} value
 * @param {(v: T) => string} show
 */
export function orNone(value, show) {
  return value === null || value === undefined ? NONE : show(value);
}
