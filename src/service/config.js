// Configuration of the separate services (deploy/aws/SPLIT.md): one for each agent, one router. Each
// reads its own data folder and nothing else; the one-process service keeps src/main.js.
//
// Agent's data folder (HB_DATA_DIR), private to that agent's system user:
//   keys/<own>.pem     its Ed25519 private key and no other: jcb.pem, contractor.pem or supplier.pem
//   peers.json         {jcb|site|supplier: {id, publicKey, url}}: public keys and A2A addresses, its own too
//   people.json        only this agent's people (the shape at the top of src/main.js)
//   the ledger and the rest, named as in the one data folder: <jcb|contractor|supplier>.db, <name>.trace.db,
//   <name>.learn.db, <name>.sites.db, media/, and a wa.db with this agent's missed and integrity notices
//
// Router's data folder: people.json (everyone), peers.json, wa.db (messages seen, 24-hour windows). No key.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyFromPem, publicKeyFromText, publicKeyText } from '../protocol/keys.js';
import { TO_CONTRACTOR, TO_CONTRACTOR_FROM_SUPPLIER, TO_SELLER, TO_SUPPLIER } from '../protocol/peer-rules.js';
import { parsePeople } from '../wa/people-file.js';

/** @typedef {'jcb' | 'site' | 'supplier'} AgentName */
/** @typedef {{id: string, publicKey: import('node:crypto').KeyObject, url: string}} PeerEntry */

/** @type {Record<AgentName, {kind: 'jcb' | 'contractor' | 'supplier', title: string, file: string}>} */
export const AGENTS = {
  jcb: { kind: 'jcb', title: 'JCB Hisaab', file: 'jcb' },
  site: { kind: 'contractor', title: 'Site Hisaab', file: 'contractor' },
  supplier: { kind: 'supplier', title: 'Supplier Hisaab', file: 'supplier' },
};
const NAMES = /** @type {AgentName[]} */ (Object.keys(AGENTS));
// Who an agent deals with and what it accepts from them. The sellers never talk to each other.
/** @type {Record<AgentName, Partial<Record<AgentName, import('../protocol/messages.js').MessageType[]>>>} */
const DEALS = {
  jcb: { site: TO_SELLER },
  site: { jcb: TO_CONTRACTOR, supplier: TO_CONTRACTOR_FROM_SUPPLIER },
  supplier: { site: TO_SUPPLIER },
};
const MIN_TOKEN = 32;

/** @param {Record<string, string | undefined>} env @param {string} name */
function need(env, name) {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`config: ${name} is not set`);
  return v.trim();
}

/** @param {Record<string, string | undefined>} env @param {string} name */
function token(env, name) {
  const v = need(env, name);
  if (v.length < MIN_TOKEN) throw new Error(`config: ${name} must be at least ${MIN_TOKEN} characters`);
  return v;
}

/** Group or others can read this: not a private folder or key. Not meaningful on Windows. @param {string} path */
function assertOwnerOnly(path) {
  if (process.platform === 'win32') return;
  if (statSync(path).mode & 0o077) throw new Error(`config: ${path} must be readable by its owner only`);
}

/** @param {string} dataDir @returns {Record<AgentName, PeerEntry>} */
function readPeers(dataDir) {
  const raw = JSON.parse(readFileSync(join(dataDir, 'peers.json'), 'utf8'));
  const out = /** @type {Record<AgentName, PeerEntry>} */ ({});
  for (const n of NAMES) {
    const p = raw?.[n];
    if (typeof p?.id !== 'string' || typeof p.publicKey !== 'string' || typeof p.url !== 'string') throw new Error(`config: peers.json has no good entry for ${n}`);
    out[n] = { id: p.id, publicKey: publicKeyFromText(p.publicKey), url: p.url.replace(/\/+$/, '') };
  }
  const keys = new Set(NAMES.map((n) => publicKeyText(out[n].publicKey)));
  if (keys.size !== NAMES.length || new Set(NAMES.map((n) => out[n].id)).size !== NAMES.length) throw new Error('config: peers.json names one agent or key twice');
  return out;
}

/**
 * The only place an agent service reads a private key, and it can read only its own: the file name comes
 * from HB_AGENT, a key that is not the one peers.json names for it stops the start, and so does any other
 * key in the folder. A service never makes a key, or a wrong folder would quietly become a new identity.
 * @param {string} dataDir @param {AgentName} name @param {PeerEntry} own
 */
function loadOwnKey(dataDir, name, own) {
  const dir = join(dataDir, 'keys');
  const file = `${AGENTS[name].file}.pem`;
  let present;
  try {
    present = readdirSync(dir);
  } catch {
    throw new Error(`config: ${name} has no keys folder`);
  }
  const other = present.filter((f) => f !== file);
  if (other.length) throw new Error(`config: ${name} refuses to start: only its own key belongs in its keys folder, found another file there`);
  if (!present.includes(file)) throw new Error(`config: ${name} refuses to start: its private key is missing (a service never makes one)`);
  assertOwnerOnly(join(dir, file));
  const key = privateKeyFromPem(readFileSync(join(dir, file), 'utf8'));
  if (publicKeyText(key) !== publicKeyText(own.publicKey)) throw new Error(`config: ${name} refuses to start: that private key is not this agent's`);
  return key;
}

/** Line name to phone_number_id: not secret, and all an agent knows of a line. @param {Record<string, string | undefined>} env */
function lineIdsOf(env) {
  /** @type {Record<string, string>} */
  const ids = { jcb: need(env, 'HB_WA_JCB_PHONE_NUMBER_ID'), site: need(env, 'HB_WA_SITE_PHONE_NUMBER_ID') };
  if (env.HB_WA_SUPPLIER_PHONE_NUMBER_ID) ids.supplier = env.HB_WA_SUPPLIER_PHONE_NUMBER_ID;
  return ids;
}

/** @param {Record<AgentName, PeerEntry>} peers */
const agentIdsOf = (peers) => ({ jcb: peers.jcb.id, contractor: peers.site.id, supplier: peers.supplier.id });

/**
 * One agent's service.
 * @param {Record<string, string | undefined>} env
 */
export function loadAgentConfig(env) {
  const name = /** @type {AgentName} */ (env.HB_AGENT?.trim());
  if (!NAMES.includes(name)) throw new Error("config: HB_AGENT must be 'jcb', 'site' or 'supplier'");
  // The lines' secrets are the router's. Finding one here means the settings were copied wrong.
  for (const k of Object.keys(env)) if (/^HB_WA_[A-Z]+_(APP_SECRET|ACCESS_TOKEN|VERIFY_TOKEN)$/.test(k) && env[k]) throw new Error(`config: ${k} belongs to the router, not to an agent`);
  const dataDir = need(env, 'HB_DATA_DIR');
  const baseUrl = need(env, 'HB_BASE_URL').replace(/\/+$/, '');
  assertOwnerOnly(dataDir);
  const shape = AGENTS[name];
  const directory = readPeers(dataDir);
  const privateKey = loadOwnKey(dataDir, name, directory[name]);
  const deals = /** @type {[AgentName, import('../protocol/messages.js').MessageType[]][]} */ (Object.entries(DEALS[name]));
  const peers = deals.map(([n, types]) => ({ id: directory[n].id, publicKey: directory[n].publicKey, mayReceiveFrom: new Set(types) }));
  const lineIds = lineIdsOf(env);
  const people = parsePeople(JSON.parse(readFileSync(join(dataDir, 'people.json'), 'utf8')), lineIds, agentIdsOf(directory));
  if (people.some((p) => p.agent !== directory[name].id)) throw new Error(`config: ${name}'s people.json must list only its own people`);
  /** @type {import('../agents/office.js').Limits} */
  const limits = {};
  const rupees = env.HB_LIMIT_PROCUREMENT_RUPEES?.trim();
  if (rupees) {
    if (!/^\d{1,9}$/.test(rupees)) throw new Error('config: HB_LIMIT_PROCUREMENT_RUPEES must be whole rupees, digits only');
    limits.procurementPaise = Number(rupees) * 100;
  }
  return {
    name,
    port: Number(env.HB_PORT ?? 8081),
    host: env.HB_HOST || '127.0.0.1',
    baseUrl,
    dataDir,
    routerUrl: need(env, 'HB_ROUTER_URL').replace(/\/+$/, ''),
    internalToken: token(env, 'HB_INTERNAL_TOKEN'),
    exportToken: env.HB_EXPORT_TOKEN || undefined,
    traceText: env.HB_TRACE_TEXT === '1',
    waStoreFile: join(dataDir, 'wa.db'),
    lineIds: Object.values(lineIds),
    people,
    self: directory[name],
    peerDirectory: deals.map(([n]) => ({ name: /** @type {string} */ (n), ...directory[n] })),
    agent: {
      name, kind: shape.kind, id: directory[name].id, title: shape.title, privateKey, ledgerFile: join(dataDir, `${shape.file}.db`),
      peers,
      peerUrls: Object.fromEntries(deals.map(([n]) => [directory[n].id, directory[n].url])),
      ...(name === 'site' ? { jcbAgentId: directory.jcb.id, supplierAgentId: directory.supplier.id, limits } : {}),
    },
  };
}

/**
 * The router.
 * @param {Record<string, string | undefined>} env
 */
export function loadRouterConfig(env) {
  const dataDir = need(env, 'HB_DATA_DIR');
  assertOwnerOnly(dataDir);
  try {
    readdirSync(join(dataDir, 'keys'));
    throw new Error('config: the router holds no private key, and its folder has a keys folder');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  const directory = readPeers(dataDir);
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
  if (env.HB_WA_SUPPLIER_PHONE_NUMBER_ID) lines.push(line('SUPPLIER', 'supplier'));
  const people = parsePeople(JSON.parse(readFileSync(join(dataDir, 'people.json'), 'utf8')), lineIdsOf(env), agentIdsOf(directory));
  const agents = [
    { name: 'jcb', id: directory.jcb.id, url: env.HB_AGENT_URL_JCB || 'http://127.0.0.1:8081', token: token(env, 'HB_INTERNAL_TOKEN_JCB') },
    { name: 'site', id: directory.site.id, url: env.HB_AGENT_URL_SITE || 'http://127.0.0.1:8082', token: token(env, 'HB_INTERNAL_TOKEN_SITE') },
    { name: 'supplier', id: directory.supplier.id, url: env.HB_AGENT_URL_SUPPLIER || 'http://127.0.0.1:8083', token: token(env, 'HB_INTERNAL_TOKEN_SUPPLIER') },
  ];
  if (new Set(agents.map((a) => a.token)).size !== agents.length) throw new Error('config: each agent needs its own internal token');
  return {
    port: Number(env.HB_PORT ?? 8080),
    host: env.HB_HOST || '127.0.0.1',
    waStoreFile: join(dataDir, 'wa.db'),
    lines,
    people,
    agents,
  };
}
