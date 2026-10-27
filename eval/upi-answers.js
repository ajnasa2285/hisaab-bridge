import { parseUpiAmount, validUpiDate, validUpiTime } from '../src/readers/upi.js';
import { isObject } from '../src/meta/schema.js';

/** @typedef {'success'|'pending'|'failed'} PaymentStatus */
/** @typedef {{kind:'upi_payment',amountPaise:number|null,date:string|null,time:string|null,
 * utr:string|null,status:PaymentStatus|null,payeeName:string|null,payeeVpa:string|null,
 * payerName:string|null,clear:boolean,confirmedBy:'human'} | {kind:'not_upi',confirmedBy:'human'}} UpiAnswer */
/** @typedef {{kind:'upi_payment'|'not_upi',amount:string,date:string,time:string,utr:string,
 * status:string,payeeName:string,payeeVpa:string,payerName:string,clear:boolean}} UpiAnswerInput */

/** Human text is preserved exactly; masked/placeholder text is not a known answer.
 * @param {unknown} value @param {number} limit @returns {value is string} */
function visibleText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value === value.trim() && !/[\p{C}*?<>…]/u.test(value) && !value.includes('...');
}

/** Human-readable truth may include a labelled UTR or VPA the conservative reader
 * cannot yet parse. Do not filter those cases out of evaluation. The human confirms
 * the identifier's visible UTR/reference label and the payer/payee roles in the CLI.
 * @param {unknown} value @returns {value is UpiAnswer} */
export function validUpiAnswer(value) {
  if (!isObject(value) || value.confirmedBy !== 'human') return false;
  if (value.kind === 'not_upi') return true;
  if (value.kind !== 'upi_payment' || typeof value.clear !== 'boolean') return false;
  if (value.amountPaise !== null && (!Number.isSafeInteger(value.amountPaise) || value.amountPaise < 0)) return false;
  if (value.date !== null && (typeof value.date !== 'string' || !validUpiDate(value.date))) return false;
  if (value.time !== null && (typeof value.time !== 'string' || !validUpiTime(value.time))) return false;
  if (value.utr !== null && !visibleText(value.utr, 128)) return false;
  if (value.status !== null && !['success', 'pending', 'failed'].includes(value.status)) return false;
  if (value.payeeName !== null && !visibleText(value.payeeName, 200)) return false;
  if (value.payerName !== null && !visibleText(value.payerName, 200)) return false;
  if (value.payeeVpa !== null && (!visibleText(value.payeeVpa, 256) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(value.payeeVpa))) return false;
  return !value.clear || (value.amountPaise !== null && value.status !== null);
}

/** Inputs come from human inspection, never from reader predictions. Empty input means
 * not visible; '?' means uncertain, maps to null and overrides overall clear to false.
 * Dates/times are canonical, and UTC timestamps require explicit timezone evidence.
 * @param {UpiAnswerInput} input @returns {UpiAnswer|null} */
export function buildUpiAnswer(input) {
  if (input.kind === 'not_upi') return { kind: 'not_upi', confirmedBy: 'human' };
  if (input.kind !== 'upi_payment' || typeof input.clear !== 'boolean') return null;
  const values = [input.amount, input.date, input.time, input.utr, input.status, input.payeeName, input.payeeVpa, input.payerName];
  if (values.some(v => typeof v !== 'string')) return null;
  /** @param {string} value */
  const nullable = value => value === '' || value === '?' ? null : value;
  const rawAmount = nullable(input.amount);
  const amountPaise = rawAmount === null ? null : parseUpiAmount(rawAmount);
  if (rawAmount !== null && amountPaise === null) return null;
  const rawTime = nullable(input.time);
  if (rawTime !== null && !validUpiTime(rawTime)) return null;
  const time = rawTime === null ? null : new Date(rawTime).toISOString();
  const answer = {
    kind: /** @type {const} */ ('upi_payment'), amountPaise,
    date: nullable(input.date), time, utr: nullable(input.utr),
    status: nullable(input.status), payeeName: nullable(input.payeeName),
    payeeVpa: nullable(input.payeeVpa), payerName: nullable(input.payerName),
    clear: input.clear && !values.includes('?'), confirmedBy: /** @type {const} */ ('human'),
  };
  return validUpiAnswer(answer) ? answer : null;
}
