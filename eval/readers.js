import { readMeter, METER_VERSION } from '../src/readers/meter.js';
import { readUpi, UPI_VERSION } from '../src/readers/upi.js';
import { validAnswer } from './answers.js';
import { validUpiAnswer } from './upi-answers.js';
import { summarizeMeters } from './metrics.js';
import { summarizeUpi } from './upi-metrics.js';

/** @typedef {{kind:import('./private-data.js').DatasetKind,version:string,
 * read:(image:import('../src/meta/client.js').ImageInput)=>Promise<any>,
 * validAnswer:(answer:unknown)=>boolean,
 * summarize:(rows:{prediction:any,expected?:unknown,elapsedMs:number}[])=>any}} Reader */

/** @param {string} kind @returns {Reader} */
export function evaluationReader(kind) {
  if (kind === 'meter') return { kind, version: METER_VERSION, read: readMeter, validAnswer, summarize: summarizeMeters };
  if (kind === 'upi') return { kind, version: UPI_VERSION, read: readUpi, validAnswer: validUpiAnswer, summarize: summarizeUpi };
  throw new Error('invalid_reader');
}
