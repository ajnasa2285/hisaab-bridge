import { normaliseUnit, parseQtyHundredths, MAX_CHALLAN_ITEMS } from '../src/readers/challan.js';
import { parseUpiDate, validUpiDate } from '../src/readers/upi.js';
import { isObject } from '../src/meta/schema.js';

/** @typedef {{name:string,qtyHundredths:number|null,unit:string|null}} ChallanAnswerItem */
/** @typedef {{kind:'challan',challanNo:string|null,date:string|null,vehicle:string|null,
 * items:ChallanAnswerItem[],clear:boolean,confirmedBy:'human'} | {kind:'not_challan',confirmedBy:'human'}} ChallanAnswer */
/** @typedef {{kind:'challan'|'not_challan',challanNo:string,date:string,vehicle:string,
 * items:{name:string,qty:string,unit:string}[],clear:boolean}} ChallanAnswerInput */

/** @param {unknown} value @param {number} limit @returns {value is string} */
function visibleText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value === value.trim() && !/[\p{C}*?<>…]/u.test(value) && !value.includes('...');
}

/** @param {unknown} value @returns {value is ChallanAnswer} */
export function validChallanAnswer(value) {
  if (!isObject(value) || value.confirmedBy !== 'human') return false;
  if (value.kind === 'not_challan') return true;
  if (value.kind !== 'challan' || typeof value.clear !== 'boolean') return false;
  if (value.challanNo !== null && !visibleText(value.challanNo, 40)) return false;
  if (value.date !== null && (typeof value.date !== 'string' || !validUpiDate(value.date))) return false;
  if (value.vehicle !== null && (typeof value.vehicle !== 'string' || !/^[A-Za-z0-9]{4,12}$/.test(value.vehicle))) return false;
  if (!Array.isArray(value.items) || value.items.length > MAX_CHALLAN_ITEMS) return false;
  for (const item of value.items) {
    if (!isObject(item) || !visibleText(item.name, 120)) return false;
    if (item.qtyHundredths !== null && (!Number.isSafeInteger(item.qtyHundredths) || item.qtyHundredths <= 0)) return false;
    if (item.unit !== null && !visibleText(item.unit, 16)) return false;
  }
  return !value.clear || (value.items.length > 0 && value.items.every((/** @type {any} */ i) => i.qtyHundredths !== null && i.unit !== null));
}

/** Human input only. Empty means not visible; '?' means unclear (null, and overall clear becomes false).
 * Quantities and units are converted by the same code the reader uses.
 * @param {ChallanAnswerInput} input @returns {ChallanAnswer|null} */
export function buildChallanAnswer(input) {
  if (input.kind === 'not_challan') return { kind: 'not_challan', confirmedBy: 'human' };
  if (input.kind !== 'challan' || typeof input.clear !== 'boolean' || !Array.isArray(input.items)) return null;
  if ([input.challanNo, input.date, input.vehicle].some(v => typeof v !== 'string')) return null;
  let doubt = [input.challanNo, input.date, input.vehicle].includes('?');
  /** @param {string} value */
  const nullable = value => value === '' || value === '?' ? null : value;
  const rawDate = nullable(input.date);
  const date = rawDate === null ? null : validUpiDate(rawDate) ? rawDate : parseUpiDate(rawDate);
  if (rawDate !== null && date === null) return null;
  const rawVehicle = nullable(input.vehicle);
  const vehicle = rawVehicle === null ? null : rawVehicle.replace(/[\s-]/g, '');
  /** @type {ChallanAnswerItem[]} */
  const items = [];
  for (const item of input.items) {
    if (typeof item.name !== 'string' || typeof item.qty !== 'string' || typeof item.unit !== 'string') return null;
    const qtyHundredths = item.qty === '' || item.qty === '?' ? null : parseQtyHundredths(item.qty);
    if (item.qty !== '' && item.qty !== '?' && qtyHundredths === null) return null;
    const unit = item.unit === '' || item.unit === '?' ? null : normaliseUnit(item.unit);
    if (item.unit !== '' && item.unit !== '?' && unit === null) return null;
    if (qtyHundredths === null || unit === null) doubt = true;
    items.push({ name: item.name.trim(), qtyHundredths, unit });
  }
  const answer = { kind: /** @type {const} */ ('challan'), challanNo: nullable(input.challanNo), date, vehicle, items,
    clear: input.clear && !doubt, confirmedBy: /** @type {const} */ ('human') };
  return validChallanAnswer(answer) ? answer : null;
}
