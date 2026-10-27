// Numbers for people are formatted here, never by a model and never inside the text table:
// money in rupees with Indian grouping, hours with one decimal, quantities with their unit.

/** @param {number} n integer @returns {string} Indian digit grouping: 1234567 → 12,34,567 */
function group(n) {
  const s = String(Math.abs(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** @param {number} paise @returns {string} ₹7,320 or ₹7,320.50 */
export function rupees(paise) {
  if (!Number.isInteger(paise)) throw new Error('format: paise must be an integer');
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}₹${group(whole)}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** @param {number} tenths @returns {string} 6.1 */
export function hours(tenths) {
  if (!Number.isInteger(tenths)) throw new Error('format: tenths must be an integer');
  return `${tenths < 0 ? '-' : ''}${Math.floor(Math.abs(tenths) / 10)}.${Math.abs(tenths) % 10}`;
}

/** @param {number} hundredths @returns {string} 50 or 12.5 */
export function qty(hundredths) {
  if (!Number.isInteger(hundredths)) throw new Error('format: hundredths must be an integer');
  const abs = Math.abs(hundredths);
  const frac = abs % 100;
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  return `${hundredths < 0 ? '-' : ''}${Math.floor(abs / 100)}${fracText}`;
}
