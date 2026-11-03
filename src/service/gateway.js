// An agent service's way to WhatsApp: everything goes through the router, which alone holds the
// access tokens and knows who is inside their 24-hour window. Same answers as src/wa/wa.js, so the
// agent's code cannot tell the difference: a router that cannot be reached is one more reason a notice
// did not go, and such a notice is kept and told again when the person next writes (src/app.js).

import { postJson } from './internal.js';

// Longer than the router's own worst case for one send (an upload and a message, 15 seconds each).
const SEND_TIMEOUT_MS = 60 * 1000;
const MEDIA_TIMEOUT_MS = 60 * 1000;

/** @typedef {{ok: true, id: string} | {ok: false, reason: string}} Sent */
/**
 * @typedef {{
 *   lineIds: string[],
 *   handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>,
 *   send: (line: string, phone: string, text: string, opts?: {token?: string}) => Promise<Sent>,
 *   sendImage: (line: string, phone: string, image: {bytes: Uint8Array, mime: string, caption: string}) => Promise<Sent>,
 *   sendDocument: (line: string, phone: string, doc: {bytes: Uint8Array, mime: string, fileName: string, caption: string}) => Promise<Sent>,
 *   fetchMedia: (line: string, mediaId: string) => Promise<{bytes: Buffer, mimeType: string, sha256: string}>,
 * }} Gateway
 */

/**
 * @param {{routerUrl: string, token: string, lineIds: string[]}} o
 * @returns {Gateway}
 */
export function createGateway(o) {
  /** @param {any} body @returns {Promise<Sent>} */
  async function send(body) {
    try {
      const r = await postJson(`${o.routerUrl}/internal/wa/send`, o.token, body, { timeoutMs: SEND_TIMEOUT_MS });
      if (r.status === 200 && typeof r.json?.ok === 'boolean') return r.json;
      return { ok: false, reason: `router http ${r.status}` };
    } catch {
      return { ok: false, reason: 'router unreachable' };
    }
  }
  return {
    lineIds: o.lineIds,
    // The webhooks are the router's.
    handle: async () => false,
    send: (line, phone, text, opts) => send({ kind: 'text', line, phone, text, ...(opts?.token ? { token: opts.token } : {}) }),
    sendImage: (line, phone, image) => send({ kind: 'image', line, phone, mime: image.mime, caption: image.caption, bytes: Buffer.from(image.bytes).toString('base64') }),
    sendDocument: (line, phone, doc) => send({ kind: 'document', line, phone, mime: doc.mime, caption: doc.caption, fileName: doc.fileName, bytes: Buffer.from(doc.bytes).toString('base64') }),
    async fetchMedia(line, mediaId) {
      const r = await postJson(`${o.routerUrl}/internal/wa/media`, o.token, { line, mediaId }, { timeoutMs: MEDIA_TIMEOUT_MS });
      if (r.status !== 200 || r.json?.ok !== true) throw new Error(r.json?.tooLarge ? 'wa: media too large' : `wa: media through the router failed (${r.status})`);
      return { bytes: Buffer.from(r.json.bytes, 'base64'), mimeType: r.json.mimeType, sha256: r.json.sha256 };
    },
  };
}
