// The only evidence we can request or serve is a prior commitment in this order's history.
// Local photo records are named in a signed BILL or DISPUTE before the peer can request them.
import { createHash } from 'node:crypto';

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {{record: string, sha256: string, kind: 'meter'|'challan'|'site_count'|'upi', at: string, owner: string, body: Record<string, any>}} EvidenceRecord */

/** @param {Ledger} ledger @param {string} orderId @param {string} [ownerId] @returns {EvidenceRecord[]} */
export function evidenceRecords(ledger, orderId, ownerId) {
  const events = ledger.events(orderId);
  const refused = new Set(events.filter((e) => e.type === 'REFUSE' && e.direction === 'in').map((e) => e.body.body.refers_to));
  const booking = events.find((e) => e.type === 'BOOKING_REQUEST');
  const self = booking ? (booking.direction === 'out' ? booking.body.from : booking.body.to) : '';
  /** @type {Map<string, EvidenceRecord>} */
  const records = new Map();
  /** @param {EvidenceRecord} record */
  function add(record) {
    if (record.record && /^[0-9a-f]{64}$/.test(record.sha256) && (!ownerId || record.owner === ownerId)) records.set(record.record, record);
  }
  for (const e of events) {
    if (e.direction === 'out' && refused.has(e.msgId)) continue;
    const b = e.direction === 'local' ? e.body : e.body.body;
    const owner = e.direction === 'local' ? self : e.body.from;
    const at = e.direction === 'local' ? e.at : e.body.created_at;
    const record = e.msgId;
    if (e.type === 'DELIVERY' && record) add({ record, sha256: b.challan.sha256, kind: 'challan', at, owner, body: b });
    if (e.type === 'PAYMENT_CLAIM' && record) add({ record, sha256: b.screenshot.sha256, kind: 'upi', at, owner, body: b });
    if (e.direction === 'local' && e.type === 'EVIDENCE' && b.kind === 'meter' && record) add({ record, sha256: b.sha256, kind: 'meter', at: e.at, owner, body: b });
    if (e.direction === 'local' && e.type === 'NOTE' && b.kind === 'site_count' && b.challan && record) add({ record, sha256: b.challan.sha256, kind: 'site_count', at: e.at, owner, body: b });
    if (e.type === 'BILL' || e.type === 'CORRECTION') {
      for (const item of b.evidence ?? []) if (item.record && item.kind === 'meter') {
        // On the owner side the original local record supplies richer provenance.
        if (!records.has(item.record)) add({ record: item.record, sha256: item.sha256, kind: 'meter', at: item.sentAt, owner, body: item });
      }
    }
    if (e.type === 'DISPUTE' && b.siteCount) {
      const c = b.siteCount;
      if (!records.has(c.record)) add({ record: c.record, sha256: c.sha256, kind: 'site_count', at: c.at, owner, body: { kind: 'site_count', items: c.items, challan: { sha256: c.sha256, number: c.number ?? null } } });
    }
  }
  return [...records.values()];
}

/** @param {Ledger} ledger @param {string} orderId @param {string} record @param {string} [ownerId] */
export function findEvidenceRecord(ledger, orderId, record, ownerId) {
  return evidenceRecords(ledger, orderId, ownerId).find((r) => r.record === record) ?? null;
}

/** A single bounded, canonical base64 image. Decode only after the length check.
 * @param {unknown} value @returns {Buffer|null} */
export function evidenceBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * Math.ceil(MAX_EVIDENCE_BYTES / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES && bytes.toString('base64') === value ? bytes : null;
}

/** @param {Uint8Array} bytes */
export function evidenceHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** The sender signs this hash-only projection separately, so ledger exports retain a verifiable
 * signature without keeping photo bytes. The outer wire message is signed normally as well.
 * @param {Record<string, any>} m @returns {Record<string, any>} */
export function evidenceMetadata(m) {
  return { v: m.v, msg_id: m.msg_id, type: m.type, from: m.from, to: m.to, order_id: m.order_id,
    rev: m.rev, created_at: m.created_at, expires_at: m.expires_at,
    body: { refers_to: m.body.refers_to, items: m.body.items.map((/** @type {any} */ i) => ({ record: i.record, sha256: i.sha256, mime: i.mime })) },
    ...(m.body.metadata_sig ? { sig: m.body.metadata_sig } : {}) };
}
