// A received photo is read only after its bytes match the signed record already in our ledger.
// Reader output is an observation, never a count confirmation, bill edit or settlement.
import { createHash, randomUUID } from 'node:crypto';

/** @param {unknown} value */
const nat = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
/** @param {unknown} value @param {number} max */
const short = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** The only reader values retained; free text, identities and model instructions are discarded.
 * @param {string} kind @param {any} result @returns {Record<string, any>|null} */
export function cleanEvidenceReading(kind, result) {
  if (!result || !result.ok || result.clear !== true) return null;
  if (kind === 'meter') return result.kind === 'hour_meter' && nat(result.valueTenths)
    ? { valueTenths: result.valueTenths } : null;
  if (kind === 'upi') return result.kind === 'upi_payment' && nat(result.amountPaise)
    ? { amountPaise: result.amountPaise } : null;
  if (kind !== 'challan' && kind !== 'site_count') return null;
  if (result.kind !== 'challan' || !Array.isArray(result.items) || !result.items.length || result.items.length > 20
    || !result.items.every((/** @type {any} */ i) => i && short(i.name, 120) && short(i.unit, 20) && nat(i.qtyHundredths))) return null;
  return { challanNo: short(result.challanNo, 160) ? result.challanNo : null,
    items: result.items.map((/** @type {any} */ i) => ({ name: i.name, unit: i.unit, qtyHundredths: i.qtyHundredths })) };
}

/** A matching accepted response must precede the note. Fingerprints alone never authorize a read.
 * @param {import('../ledger/store.js').LedgerEvent[]} events
 * @param {{record:string,sha256:string,source:string}} note @param {number} [beforeSeq] */
export function hasReceivedEvidence(events, note, beforeSeq = Infinity) {
  return events.some((e) => e.seq < beforeSeq && e.direction === 'in' && e.type === 'EVIDENCE'
    && e.body.from === note.source && Array.isArray(e.body.body?.items)
    && e.body.body.items.some((/** @type {any} */ i) => i.record === note.record && i.sha256 === note.sha256));
}

/**
 * @param {{ledger:import('../ledger/store.js').Ledger,orderId:string,
 *   item:{record:string,sha256:string,mime:string,bytes:Uint8Array},
 *   record:{record:string,sha256:string,kind:string,owner:string,at:string,body?:any},
 *   readMeter?:import('./conversation.js').MeterReader,readChallan?:import('./conversation.js').ChallanReader,
 *   readUpi?:import('./conversation.js').UpiReader,now:()=>number}} o
 * @returns {Promise<import('../ledger/store.js').LedgerEvent|null>}
 */
export async function readEvidence(o) {
  const { ledger, orderId, item, record } = o;
  if (item.record !== record.record || item.sha256 !== record.sha256 || !(item.bytes instanceof Uint8Array)
    || item.bytes.byteLength === 0 || item.bytes.byteLength > 5 * 1024 * 1024
    || !['image/jpeg', 'image/png', 'image/webp'].includes(item.mime)
    || createHash('sha256').update(item.bytes).digest('hex') !== record.sha256) return null;
  const events = ledger.events(orderId);
  const provenance = { record: record.record, sha256: record.sha256, source: record.owner };
  if (!hasReceivedEvidence(events, provenance)) return null;
  // Explicit repeat requests may display the same photo again, but do not repeat reader charges.
  const existing = events.find((e) => e.direction === 'local' && e.type === 'NOTE' && e.body.kind === 'evidence_reading'
    && e.body.record === record.record && e.body.sha256 === record.sha256 && e.body.source === record.owner);
  if (existing) return existing;
  const image = { mime: /** @type {'image/jpeg'|'image/png'|'image/webp'} */ (item.mime), bytes: item.bytes };
  let result;
  try {
    if (record.kind === 'meter' && o.readMeter) result = await o.readMeter(image);
    else if ((record.kind === 'challan' || record.kind === 'site_count') && o.readChallan) result = await o.readChallan(image);
    else if (record.kind === 'upi' && o.readUpi) result = await o.readUpi(image);
    else return null;
  } catch { return null; }
  const reading = cleanEvidenceReading(record.kind, result);
  if (!reading) return null;
  return ledger.append({ orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(), at: new Date(o.now()).toISOString(),
    body: { kind: 'evidence_reading', ...provenance, sourceKind: record.kind, reading } });
}
