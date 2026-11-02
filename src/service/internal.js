// Calls between the router and an agent service on the same machine: plain HTTP on localhost, one
// long random token per agent, known to that agent and the router only. These paths are not in the
// Caddyfile, so nothing outside the machine reaches them, and the token keeps other local programs out.
// Built on node:http rather than fetch, because a person's message can take minutes to handle and
// fetch gives up on an answer after five.

import { request } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

// One image or document in base64, plus the envelope.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Constant-time comparison of two strings of any length. @param {string} a @param {string} b */
export function safeEqual(a, b) {
  const h = (/** @type {string} */ x) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(a), h(b));
}

/** The bearer token of a request, or ''. @param {import('node:http').IncomingMessage} req */
export function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m ? m[1] : '';
}

/**
 * @param {import('node:http').IncomingMessage} req @param {number} [maxBytes]
 * @returns {Promise<any>} the parsed JSON body; rejects when too large or not JSON
 */
export function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * POST to another service on this machine.
 * @param {string} url @param {string} token @param {unknown} body
 * @param {{timeoutMs: number}} o
 * @returns {Promise<{status: number, json: any}>} rejects when nothing came back: `code` on the error says why
 */
export function postJson(url, token, body, o) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(o.timeoutMs),
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        if (!res.complete) { reject(new Error('answer cut short')); return; }
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* an answer with no JSON: the status says enough */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}
