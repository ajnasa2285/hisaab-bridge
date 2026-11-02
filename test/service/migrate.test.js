// Moving the data, on invented data with real orders in it: from the one folder to the services' folders
// and back, what lands where, what is checked, and that nothing is overwritten. Then a one-process
// service and the check script run on what came back. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkFiles } from '../../src/ledger/check-files.js';
import { openLedger } from '../../src/ledger/store.js';
import { openWaStore } from '../../src/wa/store.js';
import { loadConfig } from '../../src/main.js';
import { back, parseEnvFile, run, split } from '../../src/service/migrate.js';
import { generateKeys, privateKeyFromPem, publicKeyFromText, publicKeyText, signMessage } from '../../src/protocol/keys.js';
import { rewriteRow } from '../ledger/forge.js';
import { CONTRACTOR, OWNER, STRANGER, TWO_LINES, inventOneFolder, makeDirs } from './harness.js';

const ORDER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-30T02:30:00.000Z';

/** A receipt between JCB and site, with its rows in both ledgers, as the agents would write them. @param {string} dir */
function inventOrder(dir) {
  const keyOf = (/** @type {string} */ f) => privateKeyFromPem(readFileSync(join(dir, 'keys', `${f}.pem`), 'utf8'));
  const [jcb, site] = [openLedger(join(dir, 'jcb.db')), openLedger(join(dir, 'contractor.db'))];
  const request = signMessage({ type: 'NOTE_TEST', msg_id: 'm-1', order_id: ORDER, from: 'agent:contractor-1', to: 'agent:jcb-1', body: { site: 'Rampur' } }, keyOf('contractor'));
  jcb.ensureOrder({ orderId: ORDER, kind: 'jcb_hours', counterparty: 'agent:contractor-1', site: 'Rampur', at: AT });
  site.ensureOrder({ orderId: ORDER, kind: 'jcb_hours', counterparty: 'agent:jcb-1', site: 'Rampur', at: AT });
  // Written directly: this file is about moving rows, and the rows' meaning is tested elsewhere.
  const write = (/** @type {any} */ l, /** @type {any} */ e) => {
    const head = l.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get();
    const seq = head ? head.seq + 1 : 1;
    const prev = head ? head.hash : '0'.repeat(64);
    l.db.prepare('INSERT INTO events (seq, order_id, direction, type, msg_id, body_json, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(seq, ORDER, e.direction, e.type, e.msgId, JSON.stringify(e.body), AT, prev, 'x'.repeat(64));
    rewriteRow(l, seq, () => {});
    return l.db.prepare('SELECT hash FROM events WHERE seq = ?').get(seq).hash;
  };
  write(site, { direction: 'out', type: 'NOTE_TEST', msgId: 'm-1', body: request });
  const entry = write(jcb, { direction: 'in', type: 'NOTE_TEST', msgId: 'm-1', body: request });
  const receipt = signMessage({ type: 'RECEIPT', msg_id: 'r-1', order_id: ORDER, from: 'agent:jcb-1', to: 'agent:contractor-1', body: { receipt_for: 'm-1', entry_hash: entry, chain_head: entry } }, keyOf('jcb'));
  write(site, { direction: 'in', type: 'RECEIPT', msgId: 'r-1', body: receipt });
  jcb.close();
  site.close();
}

/** @param {string} dir */
function inventWa(dir) {
  const store = openWaStore(join(dir, 'wa.db'));
  store.firstTime('wamid.1', 1);
  store.firstTime('wamid.2', 2);
  store.touch('line-jcb', OWNER, 5);
  store.touch('line-site', CONTRACTOR, 6);
  store.missed('line-jcb', OWNER, 'J-1', 'jcb.some_notice', 7);
  store.missed('line-site', CONTRACTOR, 'J-1', 'site.some_notice', 8);
  store.missed('line-site', STRANGER, 'J-9', 'gone', 9);
  store.markIntegrityTold('line-site', CONTRACTOR, 'chain:jcb:1', 10);
  store.close();
}

/** @param {string} file @param {string} table */
const count = (file, table) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const n = /** @type {any} */ (db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
  db.close();
  return Number(n);
};

test('split: each service\'s folder holds its own and no more, the settings are divided, the source is untouched; back: one folder again', async (tc) => {
  const dirs = makeDirs('hb-migrate-');
  tc.after(() => rmSync(dirs.root, { recursive: true, force: true }));
  const envIn = inventOneFolder(dirs.one, 'https://example.test/');
  inventOrder(dirs.one);
  inventWa(dirs.one);
  // Files of the agent's own beside the ledger.
  new DatabaseSync(join(dirs.one, 'jcb.trace.db')).close();
  new DatabaseSync(join(dirs.one, 'site.learn.db')).close();
  const mediaOf = (/** @type {string} */ id) => join('media', createHash('sha256').update(id).digest('hex'));
  mkdirSync(join(dirs.one, mediaOf('agent:jcb-1')), { recursive: true });
  writeFileSync(join(dirs.one, mediaOf('agent:jcb-1'), 'photo'), 'bytes');
  const hashOf = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const sourceBefore = hashOf(join(dirs.one, 'contractor.db'));

  /** @type {string[]} */
  const said = [];
  const ok = await split({ from: dirs.one, envIn, toPrefix: dirs.prefix, envOut: dirs.env }, (l) => { said.push(l); });
  assert.equal(ok, true, said.join('\n'));
  assert.match(said.join('\n'), /1 receipts compared, 1 signatures checked/);
  assert.doesNotMatch(said.join('\n'), /9190000|Rampur|PRIVATE|BEGIN/, 'counts only');
  assert.match(said.join('\n'), /1 notice rows are for phones no longer/);
  assert.equal(hashOf(join(dirs.one, 'contractor.db')), sourceBefore, 'the source is not written');
  const of = (/** @type {string} */ n) => `${dirs.prefix}${n}`;

  assert.deepEqual(readdirSync(join(of('jcb'), 'keys')), ['jcb.pem']);
  assert.deepEqual(readdirSync(join(of('site'), 'keys')), ['contractor.pem']);
  assert.deepEqual(readdirSync(join(of('supplier'), 'keys')), ['supplier.pem']);
  assert.ok(!existsSync(join(of('router'), 'keys')));
  assert.ok(!existsSync(join(of('jcb'), 'contractor.db')) && !existsSync(join(of('site'), 'jcb.db')), 'no one holds another\'s ledger');
  assert.ok(!readdirSync(of('router')).some((f) => /^(jcb|contractor|supplier)\.db/.test(f)), 'the router holds no ledger');
  assert.ok(existsSync(join(of('jcb'), 'jcb.trace.db')) && existsSync(join(of('site'), 'site.learn.db')));
  assert.equal(readFileSync(join(of('jcb'), mediaOf('agent:jcb-1'), 'photo'), 'utf8'), 'bytes');
  if (process.platform !== 'win32') {
    assert.equal(statSync(of('jcb')).mode & 0o077, 0);
    assert.equal(statSync(join(of('jcb'), 'keys', 'jcb.pem')).mode & 0o077, 0);
    assert.equal(statSync(join(dirs.env, 'router.env')).mode & 0o077, 0);
  }

  // WhatsApp state: seen and windows with the router, missed and told with the agent of that person.
  assert.deepEqual([count(join(of('router'), 'wa.db'), 'wa_seen'), count(join(of('router'), 'wa.db'), 'wa_window'), count(join(of('router'), 'wa.db'), 'wa_missed')], [2, 2, 0]);
  assert.deepEqual([count(join(of('jcb'), 'wa.db'), 'wa_missed'), count(join(of('jcb'), 'wa.db'), 'wa_seen')], [1, 0]);
  assert.deepEqual([count(join(of('site'), 'wa.db'), 'wa_missed'), count(join(of('site'), 'wa.db'), 'wa_integrity_told')], [1, 1]);
  assert.equal(count(join(of('supplier'), 'wa.db'), 'wa_missed'), 0);

  // People and peers.
  assert.deepEqual(JSON.parse(readFileSync(join(of('site'), 'people.json'), 'utf8')).map((/** @type {any} */ p) => p.agent), ['contractor', 'contractor']);
  assert.equal(JSON.parse(readFileSync(join(of('router'), 'people.json'), 'utf8')).length, 5);
  const peers = JSON.parse(readFileSync(join(of('supplier'), 'peers.json'), 'utf8'));
  assert.deepEqual(Object.keys(peers), ['jcb', 'site', 'supplier']);
  assert.equal(peers.site.url, 'https://example.test/agents/site');
  assert.equal(peers.jcb.publicKey, publicKeyText(privateKeyFromPem(readFileSync(join(dirs.one, 'keys', 'jcb.pem'), 'utf8'))));
  assert.doesNotMatch(JSON.stringify(peers), /PRIVATE/);

  // Settings: tokens and app secrets with the router, the model key with the agents, the limit with the site.
  const env = (/** @type {string} */ n) => parseEnvFile(readFileSync(join(dirs.env, `${n}.env`), 'utf8'));
  assert.equal(env('router').HB_WA_JCB_ACCESS_TOKEN, 'tok-jcb');
  assert.equal(env('router').META_API_KEY, undefined);
  assert.equal(env('router').HB_EXPORT_TOKEN, undefined);
  for (const n of ['jcb', 'site', 'supplier']) {
    const e = env(n);
    assert.equal(e.HB_AGENT, n);
    assert.equal(e.META_API_KEY, 'meta-test-key-not-real');
    assert.equal(e.HB_WA_JCB_PHONE_NUMBER_ID, 'line-jcb');
    for (const k of Object.keys(e)) assert.doesNotMatch(k, /APP_SECRET|ACCESS_TOKEN|VERIFY_TOKEN/);
    assert.equal(e.HB_INTERNAL_TOKEN, env('router')[`HB_INTERNAL_TOKEN_${n.toUpperCase()}`]);
    assert.ok(e.HB_INTERNAL_TOKEN.length >= 32);
  }
  assert.notEqual(env('jcb').HB_INTERNAL_TOKEN, env('site').HB_INTERNAL_TOKEN);

  // Never over what is there.
  /** @type {string[]} */
  const again = [];
  assert.equal(await run(['split', '--from', dirs.one, '--env-in', envIn, '--to-prefix', dirs.prefix, '--env-out', dirs.env], (l) => { again.push(l); }), 1);
  assert.match(again.join('\n'), /already has files; nothing was changed/);
  assert.equal(await run(['nonsense'], () => {}), 2);

  // Work after the split lands in the way back: a new missed notice in an agent, a new window at the router.
  const siteStore = openWaStore(join(of('site'), 'wa.db'));
  siteStore.missed('line-site', CONTRACTOR, 'J-2', 'later', 11);
  siteStore.close();
  const routerStore = openWaStore(join(of('router'), 'wa.db'));
  routerStore.firstTime('wamid.3', 12);
  routerStore.close();
  const oneAgain = join(dirs.root, 'one-again');
  /** @type {string[]} */
  const backSaid = [];
  assert.equal(await back({ fromPrefix: dirs.prefix, to: oneAgain }, (l) => { backSaid.push(l); }), true, backSaid.join('\n'));
  assert.deepEqual([count(join(oneAgain, 'wa.db'), 'wa_seen'), count(join(oneAgain, 'wa.db'), 'wa_window'), count(join(oneAgain, 'wa.db'), 'wa_missed'), count(join(oneAgain, 'wa.db'), 'wa_integrity_told')], [3, 2, 3, 1]);
  assert.deepEqual(readdirSync(join(oneAgain, 'keys')).sort(), ['contractor.pem', 'jcb.pem', 'supplier.pem']);
  const { HB_DATA_DIR: _old, ...rest } = parseEnvFile(readFileSync(envIn, 'utf8'));
  const one = loadConfig({ ...rest, HB_DATA_DIR: oneAgain });
  assert.equal(publicKeyText(one.agents[0].privateKey), publicKeyText(publicKeyFromText(peers.jcb.publicKey)), 'the same identity');
  assert.equal(one.people.length, 5);
  /** @type {string[]} */
  const checked = [];
  assert.equal(await checkFiles([`jcb=${join(oneAgain, 'jcb.db')}`, `site=${join(oneAgain, 'contractor.db')}`, `site.key=${peers.site.publicKey}`, `jcb.key=${peers.jcb.publicKey}`], (l) => { checked.push(l); }), 0, checked.join('\n'));
  // The same refusal going back.
  assert.equal(await run(['back', '--from-prefix', dirs.prefix, '--to', oneAgain], () => {}), 1);
});

test('three lines: a person on two lines has their notices split by line, to the agent they belong to there', async (tc) => {
  const dirs = makeDirs('hb-migrate-three-');
  tc.after(() => rmSync(dirs.root, { recursive: true, force: true }));
  const envIn = inventOneFolder(dirs.one, 'https://example.test', { threeLines: true });
  const store = openWaStore(join(dirs.one, 'wa.db'));
  store.touch('line-jcb', TWO_LINES, 5);
  store.touch('line-sup', TWO_LINES, 6);
  store.missed('line-jcb', TWO_LINES, 'J-1', 'on.jcb', 7);
  store.missed('line-sup', TWO_LINES, 'P-1', 'on.supplier', 8);
  store.markIntegrityTold('line-sup', TWO_LINES, 'chain:supplier:1', 9);
  store.close();
  /** @type {string[]} */
  const said = [];
  assert.equal(await split({ from: dirs.one, envIn, toPrefix: dirs.prefix, envOut: dirs.env }, (l) => { said.push(l); }), true, said.join('\n'));
  const take = (/** @type {string} */ n, /** @type {string} */ line) => {
    const s = openWaStore(join(`${dirs.prefix}${n}`, 'wa.db'));
    const rows = s.takeMissed(line, TWO_LINES);
    s.close();
    return rows.map((r) => r.ref);
  };
  assert.deepEqual([take('jcb', 'line-jcb'), take('jcb', 'line-sup'), take('supplier', 'line-sup'), take('supplier', 'line-jcb')], [['J-1'], [], ['P-1'], []]);
  assert.equal(count(join(`${dirs.prefix}supplier`, 'wa.db'), 'wa_integrity_told'), 1);
  assert.equal(count(join(`${dirs.prefix}jcb`, 'wa.db'), 'wa_integrity_told'), 0);
  assert.equal(count(join(`${dirs.prefix}router`, 'wa.db'), 'wa_window'), 2, 'two windows, one per line');
  const env = (/** @type {string} */ n) => parseEnvFile(readFileSync(join(dirs.env, `${n}.env`), 'utf8'));
  assert.equal(env('router').HB_WA_SUPPLIER_ACCESS_TOKEN, 'tok-sup');
  assert.equal(env('jcb').HB_WA_SUPPLIER_PHONE_NUMBER_ID, 'line-sup');
  assert.equal(env('supplier').HB_WA_SUPPLIER_ACCESS_TOKEN, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(`${dirs.prefix}jcb`, 'people.json'), 'utf8')).filter((/** @type {any} */ p) => p.phone === TWO_LINES).map((/** @type {any} */ p) => p.line), ['jcb']);
});

test('split stops the start of the services when a ledger was rewritten or a key is wrong: told, not hidden', async (tc) => {
  const dirs = makeDirs('hb-migrate-bad-');
  tc.after(() => rmSync(dirs.root, { recursive: true, force: true }));
  const envIn = inventOneFolder(dirs.one, 'https://example.test');
  inventOrder(dirs.one);
  const ledger = openLedger(join(dirs.one, 'jcb.db'));
  rewriteRow(ledger, 1, (m) => { m.body.site = 'Elsewhere'; });
  ledger.close();
  /** @type {string[]} */
  const said = [];
  assert.equal(await split({ from: dirs.one, envIn, toPrefix: dirs.prefix, envOut: dirs.env }, (l) => { said.push(l); }), false);
  assert.match(said.at(-1) ?? '', /^NOT OK/);
  assert.match(said.join('\n'), /receipt from jcb: (entry|head)_missing/);
  assert.doesNotMatch(said.join('\n'), /Elsewhere/);

  // A missing key leaves nothing half written.
  const second = makeDirs('hb-migrate-nokey-');
  tc.after(() => rmSync(second.root, { recursive: true, force: true }));
  const envSecond = inventOneFolder(second.one, 'https://example.test');
  rmSync(join(second.one, 'keys', 'supplier.pem'));
  /** @type {string[]} */
  const out = [];
  assert.equal(await run(['split', '--from', second.one, '--env-in', envSecond, '--to-prefix', second.prefix, '--env-out', second.env], (l) => { out.push(l); }), 1);
  assert.ok(!existsSync(`${second.prefix}jcb`), 'nothing written');
  assert.ok(generateKeys());
});
