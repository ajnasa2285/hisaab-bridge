// Carrying our signed messages over A2A 1.0 with the official SDK (@a2a-js/sdk): one JSON-RPC
// `SendMessage` per message, our message travelling as a `data` part; the answer (our signed
// RECEIPT or REFUSE) comes back as a `data` part of the agent's reply message. Each agent publishes
// an Agent Card at /.well-known/agent-card.json naming its id and public key.
//
// A2A is only the envelope: whether a message is genuine and fits the order is decided by
// src/protocol (signature, addressee, expiry, repeats) and src/ledger (states), never by the transport.

import { randomUUID } from 'node:crypto';
import { AgentCard, Extensions, Message } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, defaultServerCallContextBuilder } from '@a2a-js/sdk/server';
import { ClientFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { receive } from '../protocol/exchange.js';

export const EXTENSION_URI = 'https://github.com/ajnasa2285/hisaab-bridge/blob/main/docs/CONTRACTS.md#4-messages-srcprotocol';
const MEDIA_TYPE = 'application/json';
// One 5 MiB photo encoded as base64, plus the bounded signed/A2A envelopes.
const MAX_BODY_BYTES = 7 * 1024 * 1024;

/**
 * @param {{id: string, name: string, description: string, baseUrl: string, publicKeyText: string}} o
 * @returns {Record<string, any>} the Agent Card as A2A JSON
 */
export function agentCardJson(o) {
  return {
    name: o.name,
    description: o.description,
    version: '0.1.0',
    supportedInterfaces: [{ url: `${o.baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{
        uri: EXTENSION_URI,
        description: 'Hisaab Bridge: signed orders, bills, disputes and payments between two businesses',
        required: true,
        params: { agent_id: o.id, public_key: o.publicKeyText },
      }],
    },
    defaultInputModes: [MEDIA_TYPE],
    defaultOutputModes: [MEDIA_TYPE],
    skills: [{
      id: 'hisaab-bridge',
      name: 'Hisaab Bridge ledger',
      description: 'Receives signed booking requests, bills, disputes and payment claims and answers with a signed receipt.',
      tags: ['ledger', 'billing', 'construction'],
    }],
  };
}

/**
 * The first data part of an A2A message, as plain JSON.
 * @param {any} sdkMessage an SDK Message object
 * @returns {unknown}
 */
function dataPart(sdkMessage) {
  const json = /** @type {any} */ (Message.toJSON(sdkMessage));
  const part = Array.isArray(json.parts) ? json.parts.find((/** @type {any} */ p) => p && p.data !== undefined) : undefined;
  return part ? part.data : undefined;
}

/**
 * @param {string} role 'ROLE_USER' | 'ROLE_AGENT'
 * @param {unknown} data
 * @param {string} contextId
 */
function a2aMessage(role, data, contextId) {
  return Message.fromJSON({
    messageId: randomUUID(),
    contextId,
    role,
    parts: [{ data, mediaType: MEDIA_TYPE }],
    extensions: [EXTENSION_URI],
  });
}

/**
 * The receiving side: a handler for POST /a2a and GET /.well-known/agent-card.json.
 * @param {Parameters<typeof receive>[0]} agent
 * @param {Record<string, any>} cardJson from agentCardJson
 * @param {{onApplied?: (message: import('../protocol/messages.js').Message) => void,
 *   onReceived?: (incoming: unknown, r: ReturnType<typeof receive>, ms: number) => void}} [hooks]
 *   onApplied runs after a message has been written for the first time (e.g. to tell the owner);
 *   onReceived (optional, an observer such as the trace) sees every verdict, refusals included
 */
export function createA2AHandler(agent, cardJson, hooks = {}) {
  /** @type {import('@a2a-js/sdk/server').AgentExecutor} */
  const executor = {
    async execute(ctx, bus) {
      const incoming = dataPart(ctx.userMessage);
      const start = performance.now();
      const r = receive(agent, incoming);
      if (hooks.onReceived) {
        try {
          hooks.onReceived(incoming, r, Math.round(performance.now() - start));
        } catch {
          // An observer never changes the answer.
        }
      }
      bus.publish(AgentEvent.message(a2aMessage('ROLE_AGENT', r.answer, ctx.contextId)));
      bus.finished();
      if (r.applied && r.message && hooks.onApplied) {
        try {
          hooks.onApplied(r.message);
        } catch {
          // A notification failure never undoes a written message; the caller logs its own errors.
        }
      }
    },
    async cancelTask() {},
  };
  const card = AgentCard.fromJSON(cardJson);
  const rpc = new JsonRpcTransportHandler(new DefaultRequestHandler(card, new InMemoryTaskStore(), executor));

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true when the request was ours
   */
  return async function handle(req, res) {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path.endsWith('/.well-known/agent-card.json')) {
      sendJson(res, 200, cardJson);
      return true;
    }
    if (req.method !== 'POST' || !path.endsWith('/a2a')) return false;
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 413, { error: 'too large' });
      return true;
    }
    // The client must declare our extension (A2A-Extensions header), since the card marks it required.
    const header = req.headers['a2a-extensions'];
    const context = defaultServerCallContextBuilder({
      extensions: Extensions.parseServiceParameter(Array.isArray(header) ? header.join(',') : header),
      user: undefined,
      headers: req.headers,
      requestedVersion: String(req.headers['a2a-version'] ?? '1.0'),
    });
    const result = await rpc.handle(body, context);
    if (typeof (/** @type {any} */ (result))[Symbol.asyncIterator] === 'function') {
      sendJson(res, 400, { error: 'streaming not supported' });
      return true;
    }
    res.setHeader('A2A-Version', '1.0');
    sendJson(res, 200, result);
    return true;
  };
}

/**
 * The sending side: delivers one signed message to another agent and returns its signed answer.
 * @param {string} baseUrl the other agent's base URL (its Agent Card lives under it)
 * @param {import('../protocol/messages.js').Message} message
 * @param {{timeoutMs?: number}} [o]
 * @returns {Promise<unknown>} the answer (a signed RECEIPT or REFUSE), to be checked by recordAnswer
 */
export async function sendToAgent(baseUrl, message, o = {}) {
  // The SDK resolves the card path relative to the base URL, so an agent under a path
  // (https://host/agents/jcb) needs the trailing slash or the last segment is dropped.
  const client = await new ClientFactory().createFromUrl(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const result = await client.sendMessage(
    /** @type {any} */ ({ message: a2aMessage('ROLE_USER', message, message.order_id) }),
    { signal: AbortSignal.timeout(o.timeoutMs ?? 15000), serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION_URI)) },
  );
  const r = /** @type {any} */ (result);
  // The SDK returns either a Message or a Task; our agent always answers with a Message.
  const msg = r && r.parts ? r : r && r.message ? r.message : r && r.payload && r.payload.value ? r.payload.value : null;
  if (!msg) throw new Error('a2a: the other agent answered without a message');
  return dataPart(msg);
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
