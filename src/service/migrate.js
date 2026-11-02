// Moving the data between the one folder of the one-process service (top of src/main.js) and the
// separate folders of the services (top of src/service/config.js), for a person, with the services
// stopped or on COPIES. It only reads the side it comes from and refuses to write over anything, so the
// source stays as it was and is itself the way back. Afterwards it checks what it wrote: each hash chain,
// the same rows and head as the source, every receipt and signature between the agents, each key against
// its public key. It prints counts and row numbers only, no phone, name, key, token or contents.
//
//   node src/service/migrate.js split --from <folder> --env-in <file> --to-prefix <prefix> --env-out <folder>
//     writes <prefix>jcb, <prefix>site, <prefix>supplier, <prefix>router and <env-out>/{jcb,site,supplier,router}.env
//   node src/service/migrate.js back --from-prefix <prefix> --to <folder>
//     writes the one folder again from what the services hold now
//
// Exit 0: done and checked. 1: written but the check found something, or something could not be done.
// 2: wrong use.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { privateKeyFromPem, publicKeyFromText, publicKeyText } from '../protocol/keys.js';
import { openLedger } from '../ledger/store.js';
import { checkLedgers } from '../ledger/integrity.js';
import { openWaStore } from '../wa/store.js';
import { AGENTS } from './config.js';
import { parsePeople } from '../wa/people-file.js';

/** @typedef {import('./config.js').AgentName} AgentName */
const NAMES = /** @type {AgentName[]} */ (Object.keys(AGENTS));
/** The local port of each service; the router keeps the one-process service's port, so Caddy's default stands. */
const PORTS = { jcb: 8081, site: 8082, supplier: 8083 };
const DEFAULT_IDS = { jcb: 'agent:jcb-1', site: 'agent:contractor-1', supplier: 'agent:supplier-1' };
const ID_VARS = { jcb: 'HB_JCB_AGENT_ID', site: 'HB_CONTRACTOR_AGENT_ID', supplier: 'HB_SUPPLIER_AGENT_ID' };
const PEOPLE_AGENT = { jcb: 'jcb', site: 'contractor', supplier: 'supplier' };
const DERIVED = ['HB_DATA_DIR', 'HB_PORT', 'HB_HOST', 'HB_ROUTER_URL', 'HB_AGENT', 'HB_INTERNAL_TOKEN', 'HB_INTERNAL_TOKEN_JCB', 'HB_INTERNAL_TOKEN_SITE', 'HB_INTERNAL_TOKEN_SUPPLIER', 'HB_AGENT_URL_JCB', 'HB_AGENT_URL_SITE', 'HB_AGENT_URL_SUPPLIER'];

/** The ledger and the agent's other files, as named in the one folder and in its own. @param {AgentName} name */
const dbFiles = (name) => [`${AGENTS[name].file}.db`, `${name}.trace.db`, `${name}.learn.db`, `${name}.sites.db`];

/** @param {string} id */
const mediaDir = (id) => join('media', createHash('sha256').update(id).digest('hex'));

/** A settings file: NAME=value lines, values kept exactly as written. @param {string} text */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Copies one SQLite file safely, whatever its write-ahead log still holds. @param {string} from @param {string} to */
async function copyDb(from, to) {
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(source, to);
  } finally {
    source.close();
  }
}

/** @param {string} dir */
function refuseIfUsed(dir) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already has files; nothing was changed`);
}

/** @param {string} dir */
const privateDir = (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 });

/** @param {string} file @param {string} text */
const writePrivate = (file, text) => writeFileSync(file, text, { mode: 0o600, flag: 'wx' });

/** @param {string} file @param {string} table @returns {any[]} every row */
function rows(file, table) {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return /** @type {any[]} */ (db.prepare(`SELECT * FROM ${table}`).all());
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** A new store with these rows in it. @param {string} file @param {Record<string, any[]>} tables */
function writeStore(file, tables) {
  openWaStore(file).close();
  const db = new DatabaseSync(file);
  db.exec('BEGIN');
  for (const [table, list] of Object.entries(tables)) {
    for (const r of list) {
      const keys = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k]));
    }
  }
  db.exec('COMMIT');
  db.close();
}

/** What a source ledger holds, reading only. @param {string} file */
function sourceFacts(file) {
  if (!existsSync(file)) return { rows: 0, head: '0'.repeat(64) };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const last = /** @type {{hash: string} | undefined} */ (db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get());
    const count = /** @type {{n: number}} */ (db.prepare('SELECT count(*) AS n FROM events').get());
    return { rows: Number(count.n), head: last ? last.hash : '0'.repeat(64) };
  } finally {
    db.close();
  }
}

/** @param {string} file */
function ledgerFacts(file) {
  const l = openLedger(file);
  try {
    return { chain: l.verifyChain(), head: l.chainHead() };
  } finally {
    l.close();
  }
}

/**
 * The same check as the running services', over the ledgers just written.
 * @param {{name: AgentName, id: string, file: string, publicKey: import('node:crypto').KeyObject}[]} parts
 * @param {(line: string) => void} print
 * @returns {Promise<boolean>} everything agrees
 */
async function checkAll(parts, print) {
  const opened = parts.map((p) => ({ ...p, ledger: openLedger(p.file) }));
  try {
    let unchecked = 0;
    const others = (/** @type {AgentName} */ n) => (n === 'site' ? parts.filter((p) => p.name !== 'site') : parts.filter((p) => p.name === 'site'));
    const agents = opened.map((a) => ({ name: a.name, id: a.id, ledger: a.ledger, peers: new Map(others(a.name).map((p) => [p.id, { publicKey: p.publicKey }])) }));
    const r = await checkLedgers(agents, { onError: (name, e) => { unchecked += 1; print(`${name}: could not be checked (${e instanceof Error ? e.name : 'error'})`); } });
    print(`check: ${agents.length} ledgers, ${r.receipts} receipts compared, ${r.signaturesChecked} signatures checked`);
    for (const f of r.failures) print(`check: ${f.text}`);
    return r.failures.length === 0 && unchecked === 0 && r.signaturesChecked === r.receipts;
  } finally {
    for (const a of opened) a.ledger.close();
  }
}

/**
 * @param {{from: string, envIn: string, toPrefix: string, envOut: string}} o
 * @param {(line: string) => void} print
 * @returns {Promise<boolean>}
 */
export async function split(o, print) {
  const env = parseEnvFile(readFileSync(o.envIn, 'utf8'));
  const baseUrl = (env.HB_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('the settings file has no HB_BASE_URL');
  const dirOf = (/** @type {string} */ n) => `${o.toPrefix}${n}`;
  for (const n of [...NAMES, 'router']) refuseIfUsed(dirOf(n));
  for (const n of [...NAMES, 'router']) if (existsSync(join(o.envOut, `${n}.env`))) throw new Error(`${n}.env already exists in the settings folder; nothing was changed`);

  // Read everything first: a problem here leaves nothing half written.
  const keyText = /** @type {Record<AgentName, string>} */ ({});
  const peers = /** @type {Record<string, {id: string, publicKey: string, url: string}>} */ ({});
  for (const n of NAMES) {
    keyText[n] = readFileSync(join(o.from, 'keys', `${AGENTS[n].file}.pem`), 'utf8');
    peers[n] = { id: env[ID_VARS[n]] || DEFAULT_IDS[n], publicKey: publicKeyText(privateKeyFromPem(keyText[n])), url: `${baseUrl}/agents/${n}` };
  }
  const peopleRaw = JSON.parse(readFileSync(join(o.from, 'people.json'), 'utf8'));
  /** @type {Record<string, string>} */
  const lineIds = { jcb: env.HB_WA_JCB_PHONE_NUMBER_ID ?? '', site: env.HB_WA_SITE_PHONE_NUMBER_ID ?? '', ...(env.HB_WA_SUPPLIER_PHONE_NUMBER_ID ? { supplier: env.HB_WA_SUPPLIER_PHONE_NUMBER_ID } : {}) };
  const people = parsePeople(peopleRaw, lineIds, { jcb: peers.jcb.id, contractor: peers.site.id, supplier: peers.supplier.id });
  const ownerOf = new Map(people.map((p) => [`${p.line}|${p.phone}`, p.agent]));
  const peersText = JSON.stringify(peers, null, 2);
  const srcWa = join(o.from, 'wa.db');

  // Each agent's own folder.
  let good = true;
  const missed = rows(srcWa, 'wa_missed');
  const told = rows(srcWa, 'wa_integrity_told');
  /** @param {any} r @param {string} id */
  const belongs = (r, id) => ownerOf.get(`${r.line}|${r.phone}`) === id;
  for (const n of NAMES) {
    const dir = dirOf(n);
    privateDir(join(dir, 'keys'));
    writePrivate(join(dir, 'keys', `${AGENTS[n].file}.pem`), keyText[n]);
    writePrivate(join(dir, 'peers.json'), peersText);
    writePrivate(join(dir, 'people.json'), JSON.stringify(peopleRaw.filter((/** @type {any} */ p) => p.agent === PEOPLE_AGENT[n]), null, 2));
    for (const f of dbFiles(n)) if (existsSync(join(o.from, f))) await copyDb(join(o.from, f), join(dir, f));
    const media = mediaDir(peers[n].id);
    if (existsSync(join(o.from, media))) cpSync(join(o.from, media), join(dir, media), { recursive: true });
    const [mine, mineTold] = [missed.filter((r) => belongs(r, peers[n].id)), told.filter((r) => belongs(r, peers[n].id))];
    writeStore(join(dir, 'wa.db'), { wa_missed: mine, wa_integrity_told: mineTold });
    const before = sourceFacts(join(o.from, `${AGENTS[n].file}.db`));
    const after = ledgerFacts(join(dir, `${AGENTS[n].file}.db`));
    const same = before.head === after.head && (!after.chain.ok || before.rows === after.chain.events);
    if (!same || !after.chain.ok) good = false;
    print(`${n}: ledger ${after.chain.ok ? `chain intact, ${after.chain.events} rows` : `CHAIN BROKEN at seq ${after.chain.brokenAt}`}, ${same ? 'same as the source' : 'NOT THE SAME AS THE SOURCE'}; missed notices ${mine.length}, integrity told ${mineTold.length}`);
  }
  const orphans = missed.length + told.length - NAMES.reduce((sum, n) => sum + missed.filter((r) => belongs(r, peers[n].id)).length + told.filter((r) => belongs(r, peers[n].id)).length, 0);
  if (orphans) print(`note: ${orphans} notice rows are for phones no longer in people.json; not carried over`);

  // The router's folder: everyone, no key, no ledger.
  const routerDir = dirOf('router');
  privateDir(routerDir);
  writePrivate(join(routerDir, 'peers.json'), peersText);
  writePrivate(join(routerDir, 'people.json'), JSON.stringify(peopleRaw, null, 2));
  const [seen, windows] = [rows(srcWa, 'wa_seen'), rows(srcWa, 'wa_window')];
  writeStore(join(routerDir, 'wa.db'), { wa_seen: seen, wa_window: windows });
  print(`router: messages seen ${seen.length}, 24-hour windows ${windows.length}`);

  // Settings: each service gets only what it needs. Printed nowhere.
  const pick = (/** @type {RegExp} */ re) => Object.entries(env).filter(([k]) => re.test(k) && !DERIVED.includes(k)).map(([k, v]) => `${k}=${v}`);
  const tokens = Object.fromEntries(NAMES.map((n) => [n, randomBytes(32).toString('hex')]));
  mkdirSync(o.envOut, { recursive: true, mode: 0o700 });
  const routerPort = env.HB_PORT || '8080';
  writePrivate(join(o.envOut, 'router.env'), [`HB_DATA_DIR=${routerDir}`, `HB_PORT=${routerPort}`, 'HB_HOST=127.0.0.1',
    ...pick(/^HB_WA_/), ...NAMES.flatMap((n) => [`HB_INTERNAL_TOKEN_${n.toUpperCase()}=${tokens[n]}`, `HB_AGENT_URL_${n.toUpperCase()}=http://127.0.0.1:${PORTS[n]}`]), ''].join('\n'));
  for (const n of NAMES) {
    writePrivate(join(o.envOut, `${n}.env`), [`HB_AGENT=${n}`, `HB_DATA_DIR=${dirOf(n)}`, `HB_PORT=${PORTS[n]}`, 'HB_HOST=127.0.0.1', `HB_ROUTER_URL=http://127.0.0.1:${routerPort}`, `HB_INTERNAL_TOKEN=${tokens[n]}`,
      ...pick(/^(HB_BASE_URL|HB_EXPORT_TOKEN|HB_TRACE_TEXT|HB_LEARN|HB_WA_[A-Z]+_PHONE_NUMBER_ID|META_API_KEY|META_API_BASE|MUSE_[A-Z_]+)$/),
      ...(n === 'site' ? pick(/^HB_LIMIT_PROCUREMENT_RUPEES$/) : []), ''].join('\n'));
  }

  // Each folder holds one key, and it is the one its peers know.
  for (const n of NAMES) {
    const keys = readdirSync(join(dirOf(n), 'keys'));
    const held = readFileSync(join(dirOf(n), 'keys', `${AGENTS[n].file}.pem`), 'utf8');
    if (keys.length !== 1 || publicKeyText(privateKeyFromPem(held)) !== peers[n].publicKey) {
      good = false;
      print(`${n}: KEY NOT AS IT SHOULD BE`);
    }
  }
  const agreed = await checkAll(NAMES.map((n) => ({ name: n, id: peers[n].id, file: join(dirOf(n), `${AGENTS[n].file}.db`), publicKey: publicKeyFromText(peers[n].publicKey) })), print);
  good = good && agreed;
  print(good ? 'OK: chains intact, every receipt and signature agrees, each folder holds its own key' : 'NOT OK: see above; do not start the services on this');
  return good;
}

/**
 * @param {{fromPrefix: string, to: string}} o
 * @param {(line: string) => void} print
 * @returns {Promise<boolean>}
 */
export async function back(o, print) {
  const dirOf = (/** @type {string} */ n) => `${o.fromPrefix}${n}`;
  refuseIfUsed(o.to);
  const peers = JSON.parse(readFileSync(join(dirOf('router'), 'peers.json'), 'utf8'));
  privateDir(join(o.to, 'keys'));
  copyFileSync(join(dirOf('router'), 'people.json'), join(o.to, 'people.json'));
  /** @type {any[]} */
  const [missed, told] = [[], []];
  for (const n of NAMES) {
    const dir = dirOf(n);
    const pem = `${AGENTS[n].file}.pem`;
    writePrivate(join(o.to, 'keys', pem), readFileSync(join(dir, 'keys', pem), 'utf8'));
    for (const f of dbFiles(n)) if (existsSync(join(dir, f))) await copyDb(join(dir, f), join(o.to, f));
    const media = mediaDir(peers[n].id);
    if (existsSync(join(dir, media))) cpSync(join(dir, media), join(o.to, media), { recursive: true });
    missed.push(...rows(join(dir, 'wa.db'), 'wa_missed'));
    told.push(...rows(join(dir, 'wa.db'), 'wa_integrity_told'));
    const facts = ledgerFacts(join(o.to, `${AGENTS[n].file}.db`));
    print(`${n}: ledger ${facts.chain.ok ? `chain intact, ${facts.chain.events} rows` : `CHAIN BROKEN at seq ${facts.chain.brokenAt}`}`);
  }
  const routerWa = join(dirOf('router'), 'wa.db');
  writeStore(join(o.to, 'wa.db'), { wa_seen: rows(routerWa, 'wa_seen'), wa_window: rows(routerWa, 'wa_window'), wa_missed: missed, wa_integrity_told: told });
  const good = await checkAll(NAMES.map((n) => ({ name: n, id: peers[n].id, file: join(o.to, `${AGENTS[n].file}.db`), publicKey: publicKeyFromText(peers[n].publicKey) })), print);
  print(good ? 'OK: chains intact, every receipt and signature agrees' : 'NOT OK: see above');
  return good;
}

/** @param {string[]} args @returns {Record<string, string>} */
function options(args) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) return {};
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

/**
 * @param {string[]} args @param {(line: string) => void} print
 * @returns {Promise<number>} the exit code
 */
export async function run(args, print) {
  const a = options(args.slice(1));
  try {
    if (args[0] === 'split' && a.from && a['env-in'] && a['to-prefix'] && a['env-out']) return (await split({ from: a.from, envIn: a['env-in'], toPrefix: a['to-prefix'], envOut: a['env-out'] }, print)) ? 0 : 1;
    if (args[0] === 'back' && a['from-prefix'] && a.to) return (await back({ fromPrefix: a['from-prefix'], to: a.to }, print)) ? 0 : 1;
  } catch (e) {
    print(`stopped: ${e instanceof Error ? e.message : 'error'}`);
    return 1;
  }
  print('use: migrate.js split --from <folder> --env-in <file> --to-prefix <prefix> --env-out <folder>');
  print('     migrate.js back --from-prefix <prefix> --to <folder>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), (l) => { console.log(l); });
}
