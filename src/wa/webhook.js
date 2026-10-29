// The pure parts of the WhatsApp Cloud API webhook: the subscription handshake, the
// X-Hub-Signature-256 check, and turning Meta's nested payload into a flat list of messages.
// Nothing here touches the network or a database.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {{
 *   phoneNumberId: string,
 *   from: string,
 *   msgId: string,
 *   atMs: number,
 *   kind: 'text' | 'image' | 'audio' | 'document' | 'button' | 'other',
 *   text?: string,
 *   mediaId?: string,
 *   mimeType?: string,
 *   mediaSha256?: string,
 *   caption?: string,
 *   replyId?: string,
 *   forwarded?: boolean,
 * }} Inbound
 */

/**
 * True when the header is the HMAC-SHA256 of the exact raw body under the app secret.
 * @param {Buffer | string} rawBody the bytes as received, before any JSON parsing
 * @param {string | string[] | undefined} header the X-Hub-Signature-256 value, "sha256=<hex>"
 * @param {string} appSecret
 */
export function signatureIsValid(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[1], 'hex'));
}

/**
 * The GET handshake Meta makes when the webhook is set up.
 * @param {URLSearchParams} query
 * @param {string} verifyToken
 * @returns {string | null} the challenge to echo back, or null to refuse
 */
export function handshake(query, verifyToken) {
  if (!verifyToken) return null;
  if (query.get('hub.mode') !== 'subscribe' || query.get('hub.verify_token') !== verifyToken) return null;
  const challenge = query.get('hub.challenge');
  return challenge && /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : undefined);

/**
 * Flattens a webhook payload into the messages it carries. Delivery statuses and anything
 * that is not a message are dropped; a message missing its sender, id or line is dropped.
 * @param {unknown} payload
 * @returns {Inbound[]}
 */
export function parseInbound(payload) {
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account') return [];
  /** @type {Inbound[]} */
  const out = [];
  for (const entry of arr(payload.entry)) {
    for (const change of arr(isObj(entry) ? entry.changes : undefined)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const phoneNumberId = str(isObj(change.value.metadata) ? change.value.metadata.phone_number_id : undefined);
      for (const m of arr(change.value.messages)) {
        if (!isObj(m) || !phoneNumberId) continue;
        const from = str(m.from);
        const msgId = str(m.id);
        if (!from || !/^\d{6,15}$/.test(from) || !msgId) continue;
        const seconds = Number(m.timestamp);
        /** @type {Inbound} */
        const msg = { phoneNumberId, from, msgId, atMs: Number.isFinite(seconds) ? seconds * 1000 : 0, kind: 'other' };
        // WhatsApp marks a forwarded message (and one forwarded many times) in its context.
        if (isObj(m.context) && (m.context.forwarded === true || m.context.frequently_forwarded === true)) msg.forwarded = true;
        if (m.type === 'text' && isObj(m.text)) {
          msg.kind = 'text';
          msg.text = str(m.text.body) ?? '';
        } else if ((m.type === 'image' || m.type === 'audio' || m.type === 'document') && isObj(m[m.type])) {
          const media = m[m.type];
          msg.kind = m.type;
          msg.mediaId = str(media.id);
          msg.mimeType = str(media.mime_type);
          msg.mediaSha256 = str(media.sha256);
          const caption = str(media.caption);
          if (caption) msg.caption = caption;
          if (!msg.mediaId) msg.kind = 'other';
        } else if (m.type === 'button' && isObj(m.button)) {
          msg.kind = 'button';
          msg.text = str(m.button.text) ?? '';
          msg.replyId = str(m.button.payload);
        } else if (m.type === 'interactive' && isObj(m.interactive)) {
          const reply = isObj(m.interactive.button_reply) ? m.interactive.button_reply : isObj(m.interactive.list_reply) ? m.interactive.list_reply : null;
          if (reply) {
            msg.kind = 'button';
            msg.text = str(reply.title) ?? '';
            msg.replyId = str(reply.id);
          }
        }
        out.push(msg);
      }
    }
  }
  return out;
}

/**
 * Meta accepts a send and reports later, on the same webhook, when delivery failed. Only failures
 * are kept, with Meta's error code and title, so a silent line can be explained from the log.
 * @param {unknown} payload
 * @returns {{recipient: string, code: number | null, title: string}[]}
 */
export function parseFailedStatuses(payload) {
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account') return [];
  /** @type {{recipient: string, code: number | null, title: string}[]} */
  const out = [];
  for (const entry of arr(payload.entry)) {
    for (const change of arr(isObj(entry) ? entry.changes : undefined)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      for (const s of arr(change.value.statuses)) {
        if (!isObj(s) || s.status !== 'failed') continue;
        const err = arr(s.errors).find(isObj);
        const code = err && Number.isSafeInteger(err.code) ? /** @type {number} */ (err.code) : null;
        const title = (err && (str(err.title) ?? str(err.message))) ?? 'unknown';
        out.push({ recipient: str(s.recipient_id) ?? '', code, title: title.slice(0, 160) });
      }
    }
  }
  return out;
}

/**
 * A phone as it may appear in logs: the last four digits only.
 * @param {string} phone
 */
export function maskPhone(phone) {
  return `…${String(phone).slice(-4)}`;
}
