// The WhatsApp side of the server: one webhook path per line (each line is its own Meta app with
// its own app secret), signature checked on the raw bytes before anything is parsed, each message
// handled once, routed to {agent, role}, and replies sent only inside the 24-hour window.
//
//   GET  /wa/<line name>/webhook   Meta's subscription handshake
//   POST /wa/<line name>/webhook   messages
//
// What a message means is decided by the agents (src/agents/), never here.

import { handshake, maskPhone, parseFailedStatuses, parseInbound, signatureIsValid } from './webhook.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** @typedef {import('./webhook.js').Inbound} Inbound */
/** @typedef {import('./directory.js').Person} Person */
/** @typedef {ReturnType<typeof import('./cloud.js').createCloudClient>} CloudClient */
/** @typedef {{name: string, phoneNumberId: string, appSecret: string, verifyToken: string, client: CloudClient}} Line */

/**
 * @param {{
 *   lines: Line[],
 *   directory: ReturnType<typeof import('./directory.js').createDirectory>,
 *   store: ReturnType<typeof import('./store.js').openWaStore>,
 *   onMessage: (msg: Inbound, person: Person) => Promise<void> | void,
 *   unknownReply: () => string,
 *   failureReply?: (error: unknown) => string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} o
 */
export function createWa(o) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  /** @type {Map<string, Line>} */
  const byName = new Map(o.lines.map((l) => [l.name, l]));
  /** @type {Map<string, Line>} */
  const byId = new Map(o.lines.map((l) => [l.phoneNumberId, l]));
  // Unknown senders get one reply per process and are never written to the store.
  /** @type {Set<string>} */
  const repliedUnknown = new Set();

  /**
   * Sends a text on a line, only while the person's 24-hour window is open.
   * @param {string} phoneNumberId
   * @param {string} phone
   * @param {string} text
   * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
   */
  async function send(phoneNumberId, phone, text) {
    const line = byId.get(phoneNumberId);
    if (!line) return { ok: false, reason: 'unknown line' };
    if (!o.store.windowOpen(phoneNumberId, phone, now())) return { ok: false, reason: 'outside 24h window' };
    const r = await line.client.sendText(phone, text);
    if (!r.ok) log(`wa ${line.name}: send to ${maskPhone(phone)} failed: ${r.reason}`);
    return r;
  }

  /**
   * Images have the same session boundary as texts; no media is uploaded outside the window.
   * @param {string} phoneNumberId
   * @param {string} phone
   * @param {{bytes: Uint8Array, mime: string, caption: string}} image
   * @returns {Promise<{ok: true, id: string} | {ok: false, reason: string}>}
   */
  async function sendImage(phoneNumberId, phone, image) {
    const line = byId.get(phoneNumberId);
    if (!line) return { ok: false, reason: 'unknown line' };
    if (!o.store.windowOpen(phoneNumberId, phone, now())) return { ok: false, reason: 'outside 24h window' };
    const r = await line.client.sendImage(phone, image, { canSend: () => o.store.windowOpen(phoneNumberId, phone, now()) });
    if (!r.ok) log(`wa ${line.name}: image to ${maskPhone(phone)} failed: ${r.reason}`);
    return r;
  }

  /** @param {Line} line @param {Inbound} msg */
  async function dispatch(line, msg) {
    if (msg.phoneNumberId !== line.phoneNumberId) {
      log(`wa ${line.name}: message for another line ignored`);
      return;
    }
    const person = o.directory.route(line.phoneNumberId, msg.from);
    if (!person) {
      const key = `${line.phoneNumberId}|${msg.from}`;
      if (repliedUnknown.has(key)) return;
      repliedUnknown.add(key);
      log(`wa ${line.name}: unknown sender ${maskPhone(msg.from)}`);
      const r = await line.client.sendText(msg.from, o.unknownReply());
      if (!r.ok) log(`wa ${line.name}: reply to unknown failed: ${r.reason}`);
      return;
    }
    if (!o.store.firstTime(msg.msgId, now())) return;
    o.store.touch(line.phoneNumberId, msg.from, msg.atMs || now());
    try {
      await o.onMessage(msg, person);
    } catch (e) {
      log(`wa ${line.name}: handling ${msg.kind} from ${person.role} ${maskPhone(msg.from)} failed: ${e instanceof Error ? e.message : 'error'}`);
      // Never silent: the message is not handled again, so the person is told to send it again, once.
      if (o.failureReply) {
        try { await send(line.phoneNumberId, msg.from, o.failureReply(e)); } catch { log(`wa ${line.name}: failure reply to ${maskPhone(msg.from)} not sent`); }
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true when the request was ours
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://local');
    const m = /^\/wa\/([a-z0-9-]{1,32})\/webhook$/.exec(url.pathname);
    if (!m) return false;
    const line = byName.get(m[1]);
    if (!line) {
      res.writeHead(404).end();
      return true;
    }
    if (req.method === 'GET') {
      const challenge = handshake(url.searchParams, line.verifyToken);
      if (challenge === null) res.writeHead(403).end();
      else res.writeHead(200, { 'content-type': 'text/plain' }).end(challenge);
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return true;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return true;
    }
    if (!signatureIsValid(raw, req.headers['x-hub-signature-256'], line.appSecret)) {
      log(`wa ${line.name}: bad signature refused`);
      res.writeHead(401).end();
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return true;
    }
    // Answer Meta first so it does not re-deliver while we work; repeats are dropped by msg id anyway.
    res.writeHead(200).end();
    for (const f of parseFailedStatuses(payload)) log(`wa ${line.name}: delivery to ${maskPhone(f.recipient)} failed: ${f.code ?? '-'} ${f.title}`);
    for (const msg of parseInbound(payload)) await dispatch(line, msg);
    return true;
  }

  return { handle, send, sendImage };
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<Buffer>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
