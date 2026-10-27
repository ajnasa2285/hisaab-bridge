// Starting the service: configuration from the environment and from private files in the data
// folder on the server, never from the repository. Every variable carries the HB_ prefix so it
// cannot pick up another program's settings on a shared machine.
//
// Data folder (HB_DATA_DIR), private to the server:
//   keys/jcb.pem, keys/contractor.pem   Ed25519 private keys (created on first start, mode 600)
//   people.json                         who is who: [{line: 'jcb'|'site', phone, agent: 'jcb'|'contractor', role, name}]
//   jcb.db, contractor.db, wa.db        the ledgers and the WhatsApp store

import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeys, privateKeyFromPem, publicKeyText } from './protocol/keys.js';
import { createApp } from './app.js';
import { museSpark } from './meta/client.js';
import { readMeter } from './readers/meter.js';

/** @typedef {import('./protocol/messages.js').MessageType} MessageType */

/** @type {MessageType[]} */
const TO_JCB = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
/** @type {MessageType[]} */
const TO_CONTRACTOR = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'RECEIPT', 'REFUSE'];

/** @param {Record<string, string | undefined>} env @param {string} name */
function need(env, name) {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`config: ${name} is not set`);
  return v.trim();
}

/** The agent's private key, created once. @param {string} file */
function loadOrCreateKey(file) {
  if (!existsSync(file)) {
    const { privateKey } = generateKeys();
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  return privateKeyFromPem(readFileSync(file, 'utf8'));
}

/**
 * Everything createApp needs except the model functions.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env) {
  const dataDir = need(env, 'HB_DATA_DIR');
  const baseUrl = need(env, 'HB_BASE_URL').replace(/\/+$/, '');
  mkdirSync(join(dataDir, 'keys'), { recursive: true, mode: 0o700 });
  const jcbId = env.HB_JCB_AGENT_ID ?? 'agent:jcb-1';
  const siteId = env.HB_CONTRACTOR_AGENT_ID ?? 'agent:contractor-1';
  const jcbKey = loadOrCreateKey(join(dataDir, 'keys', 'jcb.pem'));
  const siteKey = loadOrCreateKey(join(dataDir, 'keys', 'contractor.pem'));

  /** @param {'JCB' | 'SITE'} which @param {string} name */
  const line = (which, name) => ({
    name,
    phoneNumberId: need(env, `HB_WA_${which}_PHONE_NUMBER_ID`),
    appSecret: need(env, `HB_WA_${which}_APP_SECRET`),
    verifyToken: need(env, `HB_WA_${which}_VERIFY_TOKEN`),
    accessToken: need(env, `HB_WA_${which}_ACCESS_TOKEN`),
    graphVersion: env.HB_WA_GRAPH_VERSION || undefined,
  });
  const lines = [line('JCB', 'jcb'), line('SITE', 'site')];
  const lineIds = { jcb: lines[0].phoneNumberId, site: lines[1].phoneNumberId };
  const agentIds = { jcb: jcbId, contractor: siteId };

  const raw = JSON.parse(readFileSync(join(dataDir, 'people.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('config: people.json must be a list');
  const people = raw.map((p, i) => {
    const lineId = /** @type {Record<string, string>} */ (lineIds)[p?.line];
    const agent = /** @type {Record<string, string>} */ (agentIds)[p?.agent];
    if (!lineId || !agent) throw new Error(`config: people.json entry ${i + 1} needs line 'jcb'|'site' and agent 'jcb'|'contractor'`);
    return { line: lineId, phone: String(p.phone), agent, role: p.role, name: String(p.name ?? '') };
  });

  return {
    port: Number(env.HB_PORT ?? 8080),
    baseUrl,
    exportToken: env.HB_EXPORT_TOKEN || undefined,
    waStoreFile: join(dataDir, 'wa.db'),
    lines,
    people,
    agents: [
      {
        name: 'jcb', kind: /** @type {const} */ ('jcb'), id: jcbId, title: 'JCB Hisaab', privateKey: jcbKey, ledgerFile: join(dataDir, 'jcb.db'),
        peers: [{ id: siteId, publicKey: createPublicKey(siteKey), mayReceiveFrom: new Set(TO_JCB) }],
        peerUrls: { [siteId]: `${baseUrl}/agents/site` },
      },
      {
        name: 'site', kind: /** @type {const} */ ('contractor'), id: siteId, title: 'Site Hisaab', privateKey: siteKey, ledgerFile: join(dataDir, 'contractor.db'),
        peers: [{ id: jcbId, publicKey: createPublicKey(jcbKey), mayReceiveFrom: new Set(TO_CONTRACTOR) }],
        peerUrls: { [jcbId]: `${baseUrl}/agents/jcb` },
        jcbAgentId: jcbId,
      },
    ],
  };
}

async function main() {
  const cfg = loadConfig(process.env);
  const app = createApp({ ...cfg, spark: museSpark, readMeter });
  const server = createServer((req, res) => {
    app.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.listen(cfg.port, () => {
    console.log(`hisaab-bridge listening on ${cfg.port}; agents: ${cfg.agents.map((a) => `${a.id} ${publicKeyText(a.privateKey)}`).join(', ')}`);
  });
  const stop = () => server.close(() => {
    app.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
