// The WhatsApp Cloud API calls we make for one line: send a text, an image or a document, fetch a
// received photo or voice note. The access token is passed in from the environment by the caller and never logged.

import { createHash } from 'node:crypto';

const MAX_TEXT = 4096;
const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION = 1024;
// WhatsApp's limits for an interactive reply-button message: the body, each title, how many buttons.
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
export const MAX_BUTTON_BODY = 1024;
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTONS = 3;
// WhatsApp's limit for a document.
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const DOCUMENT_MIMES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

/**
 * @param {{phoneNumberId: string, accessToken: string, graphVersion?: string, baseUrl?: string,
 *   fetch?: typeof globalThis.fetch, timeoutMs?: number}} o
 */
export function createCloudClient(o) {
  const doFetch = o.fetch ?? globalThis.fetch;
  const base = `${o.baseUrl ?? 'https://graph.facebook.com'}/${o.graphVersion ?? 'v23.0'}`;
  const auth = { authorization: `Bearer ${o.accessToken}` };
  const timeoutMs = o.timeoutMs ?? 15000;

  /**
   * Uploads the bytes, then sends a message that references that private upload.
   * @param {string} to
   * @param {{bytes: Uint8Array, mime: string, fileName: string}} file
   * @param {(mediaId: string) => Record<string, unknown>} message the type and its object, for the media ID
   * @param {{canSend?: () => boolean}} opts session recheck after the upload
   * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
   */
  async function uploadAndSend(to, file, message, opts) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', file.mime);
    form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.fileName);
    try {
      const upload = await doFetch(`${base}/${o.phoneNumberId}/media`, {
        method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(timeoutMs),
      });
      const uploaded = /** @type {any} */ (await upload.json().catch(() => null));
      if (!upload.ok) return { ok: false, reason: `upload http ${upload.status}` };
      if (typeof uploaded?.id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(uploaded.id)) return { ok: false, reason: 'no media id' };
      if (opts.canSend && !opts.canSend()) return { ok: false, reason: 'outside 24h window' };
      const sent = await doFetch(`${base}/${o.phoneNumberId}/messages`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message(uploaded.id) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result = /** @type {any} */ (await sent.json().catch(() => null));
      if (!sent.ok) return { ok: false, reason: `http ${sent.status}${result?.error?.code ? ` code ${result.error.code}` : ''}` };
      const id = result?.messages?.[0]?.id;
      return typeof id === 'string' ? { ok: true, id } : { ok: false, reason: 'no message id' };
    } catch {
      return { ok: false, reason: 'network' };
    }
  }

  /**
   * One message with no upload: a text, or an interactive one.
   * @param {string} to @param {Record<string, unknown>} message the type and its object
   * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
   */
  async function sendMessage(to, message) {
    let res;
    try {
      res = await doFetch(`${base}/${o.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    const json = /** @type {any} */ (await res.json().catch(() => null));
    if (!res.ok) return { ok: false, reason: `http ${res.status}${json?.error?.code ? ` code ${json.error.code}` : ''}` };
    const id = json?.messages?.[0]?.id;
    return typeof id === 'string' ? { ok: true, id } : { ok: false, reason: 'no message id' };
  }

  return {
    phoneNumberId: o.phoneNumberId,
    /**
     * @param {string} to digits with country code
     * @param {string} body
     * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
     */
    async sendText(to, body) {
      if (!/^\d{6,15}$/.test(to)) return { ok: false, reason: 'bad recipient' };
      if (!body || body.length > MAX_TEXT) return { ok: false, reason: 'text empty or too long' };
      return sendMessage(to, { type: 'text', text: { body, preview_url: false } });
    },

    /**
     * A question with reply buttons. A tap comes back on the webhook as the button's title
     * (src/wa/webhook.js), so a tapped "हाँ" is the same message as a typed one. Nothing goes out
     * for a body or titles WhatsApp would not take.
     * @param {string} to
     * @param {string} body
     * @param {{id: string, title: string}[]} buttons
     * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
     */
    async sendButtons(to, body, buttons) {
      if (!/^\d{6,15}$/.test(to)) return { ok: false, reason: 'bad recipient' };
      if (!body.trim() || body.length > MAX_BUTTON_BODY) return { ok: false, reason: 'body empty or too long' };
      const titles = new Set(buttons.map((b) => b.title));
      if (buttons.length < 1 || buttons.length > MAX_BUTTONS || titles.size !== buttons.length
        || buttons.some((b) => !b.title.trim() || b.title.length > MAX_BUTTON_TITLE || !/^[a-z_]{1,32}$/.test(b.id))) return { ok: false, reason: 'bad buttons' };
      return sendMessage(to, { type: 'interactive', interactive: { type: 'button', body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } });
    },

    /**
     * Upload the exact verified bytes, then reference that private upload in an image message.
     * Meta upload/send shapes: https://whatsappbusiness.com/blog/media-messages-via-app/
     * @param {string} to
     * @param {{bytes: Uint8Array, mime: string, caption: string}} image
     * @param {{canSend?: () => boolean}} [opts] session recheck after the upload
     * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
     */
    async sendImage(to, image, opts = {}) {
      if (!/^\d{6,15}$/.test(to)) return { ok: false, reason: 'bad recipient' };
      // WhatsApp image messages support JPEG/PNG; WebP evidence falls back to its text caption.
      if (!['image/jpeg', 'image/png'].includes(image.mime)) return { ok: false, reason: 'unsupported image MIME' };
      if (!(image.bytes instanceof Uint8Array) || image.bytes.length < 1 || image.bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'image empty or too large' };
      if (typeof image.caption !== 'string' || image.caption.length > MAX_CAPTION) return { ok: false, reason: 'caption too long' };
      if (opts.canSend && !opts.canSend()) return { ok: false, reason: 'outside 24h window' };
      return uploadAndSend(to, { bytes: image.bytes, mime: image.mime, fileName: image.mime === 'image/png' ? 'evidence.png' : 'evidence.jpg' },
        (id) => ({ type: 'image', image: { id, caption: image.caption } }), opts);
    },

    /**
     * The same two calls for a document: the file name is what the person sees on WhatsApp. Nothing
     * goes out for a type, name or size WhatsApp would not take.
     * @param {string} to
     * @param {{bytes: Uint8Array, mime: string, fileName: string, caption: string}} doc
     * @param {{canSend?: () => boolean}} [opts] session recheck after the upload
     * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
     */
    async sendDocument(to, doc, opts = {}) {
      if (!/^\d{6,15}$/.test(to)) return { ok: false, reason: 'bad recipient' };
      if (!DOCUMENT_MIMES.includes(doc.mime)) return { ok: false, reason: 'unsupported document MIME' };
      if (!(doc.bytes instanceof Uint8Array) || doc.bytes.length < 1 || doc.bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'document empty or too large' };
      if (typeof doc.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(doc.fileName)) return { ok: false, reason: 'bad file name' };
      if (typeof doc.caption !== 'string' || doc.caption.length > MAX_CAPTION) return { ok: false, reason: 'caption too long' };
      if (opts.canSend && !opts.canSend()) return { ok: false, reason: 'outside 24h window' };
      return uploadAndSend(to, doc, (id) => ({ type: 'document', document: { id, filename: doc.fileName, caption: doc.caption } }), opts);
    },

    /**
     * Downloads a received media file, refusing anything over the size limit or whose bytes
     * do not match the sha256 Meta announced.
     * @param {string} mediaId
     * @param {{maxBytes?: number, expectedSha256?: string}} [opts]
     * @returns {Promise<{bytes: Buffer, mimeType: string, sha256: string}>}
     */
    async fetchMedia(mediaId, opts = {}) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(mediaId)) throw new Error('wa: bad media id');
      const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
      const metaRes = await doFetch(`${base}/${mediaId}`, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
      if (!metaRes.ok) throw new Error(`wa: media lookup http ${metaRes.status}`);
      const info = /** @type {any} */ (await metaRes.json());
      if (typeof info?.url !== 'string' || !info.url.startsWith('https://')) throw new Error('wa: media has no download url');
      if (Number(info.file_size) > maxBytes) throw new Error('wa: media too large');
      const fileRes = await doFetch(info.url, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
      if (!fileRes.ok) throw new Error(`wa: media download http ${fileRes.status}`);
      const bytes = Buffer.from(await fileRes.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error('wa: media too large');
      const digest = createHash('sha256').update(bytes).digest();
      const sha256 = digest.toString('hex');
      const announced = opts.expectedSha256 ?? (typeof info.sha256 === 'string' ? info.sha256 : undefined);
      if (announced && announced !== sha256 && announced !== digest.toString('base64')) throw new Error('wa: media bytes do not match their sha256');
      return { bytes, mimeType: typeof info.mime_type === 'string' ? info.mime_type : 'application/octet-stream', sha256 };
    },
  };
}
