import { meterTenths } from '../src/readers/meter.js';
import { isObject } from '../src/meta/schema.js';

/** @typedef {{kind:'hour_meter',raw:string,valueTenths:number|null,clear:boolean,dashClock:string|null,confirmedBy:'human'}
 * | {kind:'not_meter',confirmedBy:'human'}} Answer */

/** @param {unknown} value @returns {value is Answer} */
export function validAnswer(value) {
  if (!isObject(value) || value.confirmedBy !== 'human') return false;
  if (value.kind === 'not_meter') return true;
  if (value.kind !== 'hour_meter' || typeof value.raw !== 'string' || typeof value.clear !== 'boolean') return false;
  if (value.dashClock !== null && (typeof value.dashClock !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.dashClock))) return false;
  return value.clear ? meterTenths(value.raw) !== null && value.valueTenths === meterTenths(value.raw) : value.valueTenths === null;
}

/** CLI labels are human inputs, never initialized from reader predictions.
 * @param {string} input @param {string} clock @returns {Answer|null} */
export function answerFromInput(input, clock) {
  if (input === 'नहीं') return { kind: 'not_meter', confirmedBy: 'human' };
  const dashClock = clock === '' ? null : clock;
  const unclear = input === '?';
  const value = { kind: /** @type {const} */ ('hour_meter'), raw: unclear ? '' : input,
    valueTenths: unclear ? null : meterTenths(input), clear: !unclear, dashClock, confirmedBy: /** @type {const} */ ('human') };
  return validAnswer(value) ? value : null;
}
