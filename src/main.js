// Starting the service: configuration from the environment and from private files in the data
// folder on the server, never from the repository. Every variable carries the HB_ prefix so it
// cannot pick up another program's settings on a shared machine.
//
// Data folder (HB_DATA_DIR), private to the server:
//   keys/jcb.pem, keys/contractor.pem, keys/supplier.pem
//                                       Ed25519 private keys (created on first start, mode 600)
//   people.json                         who is who: [{line: 'jcb'|'site'|'supplier', phone, agent: 'jcb'|'contractor'|'supplier', role, name, site?}]
//                                       (site, optional: where this person usually works, e.g. a supervisor's one site;
//                                       a JCB or material request that names no site is for this one)
//                                       (a supplier's people have role 'supplier', on the supplier's own line when
//                                       HB_WA_SUPPLIER_* is set, otherwise on a shared line)
//   jcb.db, contractor.db, supplier.db, wa.db   the ledgers and the WhatsApp store
//
// Approval limit for the contractor's supervisor (docs/BUILD2.md section 3), whole rupees, optional:
// HB_LIMIT_PROCUREMENT_RUPEES (JCB and material requests). Unset means every such step of a supervisor
// waits for the contractor. Payments are the contractor's own step, so they have no limit.

import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeys, privateKeyFromPem, publicKeyText } from './protocol/keys.js';
import { createApp } from './app.js';
import { listModels, museSpark, transcribe } from './meta/client.js';
import { readMeter } from './readers/meter.js';
import { readUpi } from './readers/upi.js';
import { readChallan } from './readers/challan.js';
import { classifyPhoto } from './readers/photo.js';
import { sameMeter } from './readers/same-meter.js';

/** @typedef {import('./protocol/messages.js').MessageType} MessageType */

/** What a seller (the JCB agent or the supplier agent) accepts from the contractor's agent. @type {MessageType[]} */
const TO_SELLER = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'CANCEL', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST', 'EVIDENCE'];
/** @type {MessageType[]} */
const TO_CONTRACTOR = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'CANCEL', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST', 'EVIDENCE'];
/** Only the supplier delivers (material, with a challan). @type {MessageType[]} */
const TO_CONTRACTOR_FROM_SUPPLIER = [...TO_CONTRACTOR, 'DELIVERY'];
/** Only the supplier is told the site's signed copy of its challan. @type {MessageType[]} */
const TO_SUPPLIER = [...TO_SELLER, 'SITE_RECEIPT'];

/** @param {Record<string, string | undefined>} env @param {string} name */
function need(env, name) {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`config: ${name} is not set`);
  return v.trim();
}

/**
 * An optional limit in whole rupees, as paise. Anything but digits stops the start.
 * @param {Record<string, string | undefined>} env @param {string} name
 * @returns {number | undefined}
 */
function limitPaise(env, name) {
  const v = env[name]?.trim();
  if (!v) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new Error(`config: ${name} must be whole rupees, digits only`);
  return Number(v) * 100;
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
  const supId = env.HB_SUPPLIER_AGENT_ID ?? 'agent:supplier-1';
  const jcbKey = loadOrCreateKey(join(dataDir, 'keys', 'jcb.pem'));
  const siteKey = loadOrCreateKey(join(dataDir, 'keys', 'contractor.pem'));
  const supKey = loadOrCreateKey(join(dataDir, 'keys', 'supplier.pem'));

  /** @param {'JCB' | 'SITE' | 'SUPPLIER'} which @param {string} name */
  const line = (which, name) => ({
    name,
    phoneNumberId: need(env, `HB_WA_${which}_PHONE_NUMBER_ID`),
    appSecret: need(env, `HB_WA_${which}_APP_SECRET`),
    verifyToken: need(env, `HB_WA_${which}_VERIFY_TOKEN`),
    accessToken: need(env, `HB_WA_${which}_ACCESS_TOKEN`),
    graphVersion: env.HB_WA_GRAPH_VERSION || undefined,
  });
  const lines = [line('JCB', 'jcb'), line('SITE', 'site')];
  // The supplier's own number is optional; without it the supplier's people share another line.
  if (env.HB_WA_SUPPLIER_PHONE_NUMBER_ID) lines.push(line('SUPPLIER', 'supplier'));
  /** @type {import('./agents/office.js').Limits} */
  const limits = {};
  const procurementPaise = limitPaise(env, 'HB_LIMIT_PROCUREMENT_RUPEES');
  if (procurementPaise !== undefined) limits.procurementPaise = procurementPaise;
  /** @type {Record<string, string>} */
  const lineIds = Object.fromEntries(lines.map((l) => [l.name, l.phoneNumberId]));
  const agentIds = { jcb: jcbId, contractor: siteId, supplier: supId };

  const raw = JSON.parse(readFileSync(join(dataDir, 'people.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('config: people.json must be a list');
  const people = raw.map((p, i) => {
    const lineId = Object.hasOwn(lineIds, p?.line) ? lineIds[p.line] : undefined;
    const agent = /** @type {Record<string, string>} */ (agentIds)[p?.agent];
    if (!lineId || !agent) throw new Error(`config: people.json entry ${i + 1} needs line ${Object.keys(lineIds).map((n) => `'${n}'`).join('|')} and agent 'jcb'|'contractor'|'supplier'`);
    // The supplier agent has one role, and that role belongs to no other agent.
    if ((p.agent === 'supplier') !== (p.role === 'supplier')) throw new Error(`config: people.json entry ${i + 1}: role 'supplier' goes with agent 'supplier' and only with it`);
    // Optional: the site this person usually works on; a request that names no site is for it.
    const site = p.site === undefined || p.site === null ? undefined : String(p.site).trim();
    if (site !== undefined && (!site || site.length > 80)) throw new Error(`config: people.json entry ${i + 1}: site must be a name of 1 to 80 characters`);
    return { line: lineId, phone: String(p.phone), agent, role: p.role, name: String(p.name ?? ''), ...(site ? { site } : {}) };
  });

  return {
    port: Number(env.HB_PORT ?? 8080),
    // Only the reverse proxy on the same machine reaches the service unless told otherwise.
    host: env.HB_HOST || '127.0.0.1',
    baseUrl,
    dataDir,
    exportToken: env.HB_EXPORT_TOKEN || undefined,
    // The trace keeps people's own words only when this is 1 (the demo); digits masked either way.
    traceText: env.HB_TRACE_TEXT === '1',
    waStoreFile: join(dataDir, 'wa.db'),
    lines,
    people,
    agents: [
      {
        name: 'jcb', kind: /** @type {const} */ ('jcb'), id: jcbId, title: 'JCB Hisaab', privateKey: jcbKey, ledgerFile: join(dataDir, 'jcb.db'),
        peers: [{ id: siteId, publicKey: createPublicKey(siteKey), mayReceiveFrom: new Set(TO_SELLER) }],
        peerUrls: { [siteId]: `${baseUrl}/agents/site` },
      },
      {
        name: 'site', kind: /** @type {const} */ ('contractor'), id: siteId, title: 'Site Hisaab', privateKey: siteKey, ledgerFile: join(dataDir, 'contractor.db'),
        peers: [
          { id: jcbId, publicKey: createPublicKey(jcbKey), mayReceiveFrom: new Set(TO_CONTRACTOR) },
          { id: supId, publicKey: createPublicKey(supKey), mayReceiveFrom: new Set(TO_CONTRACTOR_FROM_SUPPLIER) },
        ],
        peerUrls: { [jcbId]: `${baseUrl}/agents/jcb`, [supId]: `${baseUrl}/agents/supplier` },
        jcbAgentId: jcbId,
        supplierAgentId: supId,
        limits,
      },
      {
        name: 'supplier', kind: /** @type {const} */ ('supplier'), id: supId, title: 'Supplier Hisaab', privateKey: supKey, ledgerFile: join(dataDir, 'supplier.db'),
        peers: [{ id: siteId, publicKey: createPublicKey(siteKey), mayReceiveFrom: new Set(TO_SUPPLIER) }],
        peerUrls: { [siteId]: `${baseUrl}/agents/site` },
      },
    ],
  };
}

async function main() {
  const cfg = loadConfig(process.env);
  const app = createApp({ ...cfg, spark: museSpark, readMeter, sameMeter, readUpi, readChallan, classifyPhoto, transcribe });
  const server = createServer((req, res) => {
    app.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`hisaab-bridge listening on ${cfg.host}:${cfg.port}; agents: ${cfg.agents.map((a) => `${a.id} ${publicKeyText(a.privateKey)}`).join(', ')}`);
  });
  // A wrong Meta setting would otherwise only show as "try again" replies: say it once at start.
  const models = await listModels();
  const want = [process.env.MUSE_SPARK_MODEL, process.env.MUSE_TRANSCRIBE_MODEL];
  if (!models.ok) console.error(`meta: not usable (${models.reason}); check META_API_KEY and META_API_BASE`);
  else for (const m of want) if (!m || !models.models.includes(m)) console.error(`meta: model "${m ?? ''}" is not in the catalog; check MUSE_SPARK_MODEL / MUSE_TRANSCRIBE_MODEL`);
  const stop = () => server.close(() => {
    app.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
