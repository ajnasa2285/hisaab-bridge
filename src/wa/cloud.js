// The WhatsApp Cloud API calls we make for one line: send a text, fetch a received photo or
// voice note. The access token is passed in from the environment by the caller and never logged.

import { createHash } from 'node:crypto';

const MAX_TEXT = 4096;
const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION = 1024;

/**
 * @param {{phoneNumberId: string, accessToken: string, graphVersion?: string, baseUrl?: string,
 *   fetch?: typeof globalThis.fetch, timeoutMs?: number}} o
 */
export function createCloudClient(o) {
  const doFetch = o.fetch ?? globalThis.fetch;
  const base = `${o.baseUrl ?? 'https://graph.facebook.com'}/${o.graphVersion ?? 'v23.0'}`;
  const auth = { authorization: `Bearer ${o.accessToken}` };
  const timeoutMs = o.timeoutMs ?? 15000;

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
      let res;
      try {
        res = await doFetch(`${base}/${o.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, reason: 'network' };
      }
      const json = /** @type {any} */ (await res.json().catch(() => null));
      if (!res.ok) return { ok: false, reason: `http ${res.status}${json?.error?.code ? ` code ${json.error.code}` : ''}` };
      const id = json?.messages?.[0]?.id;
      return typeof id === 'string' ? { ok: true, id } : { ok: false, reason: 'no message id' };
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
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', image.mime);
      form.set('file', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.mime === 'image/png' ? 'evidence.png' : 'evidence.jpg');
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
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image', image: { id: uploaded.id, caption: image.caption } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const result = /** @type {any} */ (await sent.json().catch(() => null));
        if (!sent.ok) return { ok: false, reason: `http ${sent.status}${result?.error?.code ? ` code ${result.error.code}` : ''}` };
        const id = result?.messages?.[0]?.id;
        return typeof id === 'string' ? { ok: true, id } : { ok: false, reason: 'no message id' };
      } catch {
        return { ok: false, reason: 'network' };
      }
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
