// Three agents and a router in four separate processes, nothing shared but HTTP: the same steps people
// take on WhatsApp, the public addresses, what is refused, what happens when a service dies, and the
// ledger check across services. Models and the Graph API are stand-ins; invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../../src/i18n/index.js';
import { openLedger } from '../../src/ledger/store.js';
import { generateKeys, publicKeyText } from '../../src/protocol/keys.js';
import { agentCardJson } from '../../src/transport/a2a.js';
import { loadConfig } from '../../src/main.js';
import { parseEnvFile, split } from '../../src/service/migrate.js';
import { signedRequest } from '../../src/service/receipt-check.js';
import { rewriteRow } from '../ledger/forge.js';
import { CONTRACTOR, EXPORT_TOKEN, OPERATOR, OWNER, STRANGER, SUPERVISOR, SUPPLIER, inventOneFolder, jcbJob, makeDirs, startServices } from './harness.js';

const LONG = { timeout: 240_000 };
const ALARM = t('common.records_disagree');
const TRY_AGAIN = t('common.try_again');
const AGENT_JS = fileURLToPath(new URL('../../src/service/agent.js', import.meta.url));

/** @param {string} url @param {string} token @param {any} body */
const internal = (url, token, body) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a whole JCB job across the processes: booking, meter, bill, accept, payment, settled; both ledgers agree and no one holds another\'s key', LONG, async (tc) => {
  const s = await startServices(tc);
  await jcbJob(s);
  const [jcb, site, supplier] = await Promise.all(['jcb', 'site', 'supplier'].map((n) => s.exportOf(n)));
  assert.equal(jcb.orders.length, 1, s.sent.map((/** @type {any} */ x) => `${x.to.slice(-4)}: ${x.text}`).join('\n'));
  assert.equal(supplier.orders.length, 0);
  const orderId = jcb.orders[0].order_id;
  assert.equal(site.orders[0].order_id, orderId);
  const types = jcb.events.map((/** @type {any} */ e) => e.type);
  for (const want of ['BOOKING_REQUEST', 'BOOKING_REPLY', 'BILL', 'ACCEPT', 'PAYMENT_CLAIM', 'SETTLED']) assert.ok(types.includes(want), `${want} in ${types.join(' ')}`);
  assert.ok(jcb.chain.ok && site.chain.ok);
  assert.deepEqual([jcb.refs[orderId], site.refs[orderId]], ['J-1', 'J-1']);
  const signed = (/** @type {any} */ side) => side.events.filter((/** @type {any} */ e) => e.direction !== 'local' && e.type !== 'RECEIPT').map((/** @type {any} */ e) => e.msgId).sort();
  assert.deepEqual(signed(jcb), signed(site), 'both sides hold the same signed messages');
  assert.ok(s.sent.some((/** @type {any} */ x) => x.to === CONTRACTOR && x.line === 'line-site'));
  assert.ok(s.sent.some((/** @type {any} */ x) => x.to === OWNER && x.line === 'line-jcb'));
  for (const [name, pem] of [['jcb', 'jcb.pem'], ['site', 'contractor.pem'], ['supplier', 'supplier.pem']]) {
    assert.deepEqual(readdirSync(join(`${s.dirs.prefix}${name}`, 'keys')), [pem]);
  }
  assert.throws(() => readdirSync(join(`${s.dirs.prefix}router`, 'keys')), /ENOENT/, 'the router has no key at all');
});

test('the public addresses stay what they were, and nothing internal shows through the front door', LONG, async (tc) => {
  const s = await startServices(tc);
  const { base } = s;
  assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
  assert.equal((await fetch(`${base}/judge`, { redirect: 'manual' })).status, 302);
  const page = await fetch(`${base}/judge/`);
  assert.equal(page.status, 200, 'the judge page');
  assert.match(String(page.headers.get('content-security-policy')), /default-src 'self'/);
  for (const ok of ['/judge/judge.js', '/judge/sample/export.json', '/judge/results/', '/src/ledger/payments.js', '/src/ledger/usual.js', '/src/ledger/cross-check.js']) assert.equal((await fetch(base + ok)).status, 200, ok);
  for (const no of ['/src/ledger/store.js', '/src/app.js', '/src/service/config.js', '/judge/serve.js', '/judge/..%2f..%2fpackage.json', '/package.json', '/internal/wa/send', '/internal/wa/inbound', '/agents/nobody/export', '/agents/nobody/.well-known/agent-card.json']) {
    assert.equal((await fetch(base + no)).status, 404, no);
  }
  // The cards are the ones the one-process service gives for the same keys.
  const one = loadConfig(parseEnvFile(readFileSync(join(s.dirs.one, 'hisaab.env'), 'utf8')));
  for (const a of one.agents) {
    const card = await (await fetch(`${base}/agents/${a.name}/.well-known/agent-card.json`)).json();
    assert.deepEqual(card, agentCardJson({ id: a.id, name: a.title, description: a.title, baseUrl: `${base}/agents/${a.name}`, publicKeyText: publicKeyText(a.privateKey) }), a.name);
  }
  for (const name of ['jcb', 'site', 'supplier']) {
    for (const what of ['export', 'trace']) {
      assert.equal((await fetch(`${base}/agents/${name}/${what}`)).status, 404, `${name} ${what} without the token`);
      assert.equal((await fetch(`${base}/agents/${name}/${what}`, { headers: { authorization: 'Bearer wrong' } })).status, 404);
      assert.equal((await fetch(`${base}/agents/${name}/${what}`, { headers: { authorization: `Bearer ${EXPORT_TOKEN}` } })).status, 200);
    }
  }
  // The webhook handshake.
  assert.equal(await (await fetch(`${base}/wa/jcb/webhook?hub.mode=subscribe&hub.verify_token=verify-jcb&hub.challenge=abc123`)).text(), 'abc123');
  assert.equal((await fetch(`${base}/wa/jcb/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`)).status, 403);
  // The ledger check's address answers only a signed request from an agent it deals with.
  assert.equal((await fetch(`${base}/agents/site/receipt-check`, { method: 'POST', body: '{}' })).status, 404);
  const stranger = { id: 'agent:jcb-1', privateKey: generateKeys().privateKey };
  assert.equal((await fetch(`${base}/agents/site/receipt-check`, { method: 'POST', body: JSON.stringify(signedRequest(stranger, 'agent:contractor-1', Date.now())) })).status, 404, 'a right name, another key');
});

test('a forged webhook is refused and reaches no agent; a repeated message is handled once; a stranger is told once', LONG, async (tc) => {
  const s = await startServices(tc);
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'line-site' },
    messages: [{ from: CONTRACTOR, id: 'wamid.forged', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'मदद' } }] } }] }] });
  const forged = await fetch(`${s.base}/wa/site/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'not-the-secret').update(body).digest('hex')}` }, body });
  assert.equal(forged.status, 401);
  assert.equal((await fetch(`${s.base}/wa/site/webhook`, { method: 'POST', body })).status, 401);
  await s.settle();
  assert.equal(s.sent.length, 0);

  const good = { 'x-hub-signature-256': `sha256=${createHmac('sha256', s.secret.site).update(body).digest('hex')}` };
  for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${s.base}/wa/site/webhook`, { method: 'POST', headers: good, body })).status, 200);
  await s.settle();
  assert.deepEqual(s.sent.map((/** @type {any} */ x) => x.text), [t('help.contractor')], 'three deliveries, one handling');

  await s.say(STRANGER, 'नमस्ते');
  await s.say(STRANGER, 'नमस्ते');
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === STRANGER).length, 1);
  assert.equal(s.lastTo(STRANGER), t('wa.unknown_sender'));
});

test('the calls between services: a wrong token is refused, and an agent cannot write as another or read another\'s photos', LONG, async (tc) => {
  const s = await startServices(tc);
  const router = `http://127.0.0.1:${s.ports.HB_PORT}`;
  const token = s.settings('jcb').HB_INTERNAL_TOKEN;
  await s.say(CONTRACTOR, 'मदद');
  await s.say(OWNER, 'मदद');
  const before = s.sent.length;
  assert.equal((await internal(`${router}/internal/wa/send`, 'wrong', { kind: 'text', line: 'line-jcb', phone: OWNER, text: 'x' })).status, 404);
  assert.equal((await internal(`http://127.0.0.1:${s.ports.HB_PORT_JCB}/internal/wa/inbound`, 'wrong', { msg: {} })).status, 404);
  assert.equal((await internal(`http://127.0.0.1:${s.ports.HB_PORT_JCB}/internal/wa/inbound`, s.settings('site').HB_INTERNAL_TOKEN, { msg: {} })).status, 404, 'one agent\'s token is not another\'s');
  const other = await (await internal(`${router}/internal/wa/send`, token, { kind: 'text', line: 'line-site', phone: CONTRACTOR, text: 'x' })).json();
  assert.equal(other.ok, false, 'the contractor is not the JCB agent\'s person');
  const noMedia = await (await internal(`${router}/internal/wa/media`, token, { line: 'line-jcb', mediaId: 'media-other' })).json();
  assert.equal(noMedia.ok, false, 'no message of its own carries this photo');
  assert.equal(s.sent.length, before, 'nothing went out');
  const own = await (await internal(`${router}/internal/wa/send`, token, { kind: 'text', line: 'line-jcb', phone: OWNER, text: 'x' })).json();
  assert.equal(own.ok, true);
});

test('a dead agent: the person is told to send it again, others go on, and it works once the agent is back', LONG, async (tc) => {
  const s = await startServices(tc);
  await s.say(OWNER, 'मदद');
  await s.say(CONTRACTOR, 'मदद');
  await s.kill('jcb');
  await s.say(OWNER, 'मदद');
  assert.equal(s.lastTo(OWNER), TRY_AGAIN);
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === OWNER && x.text === TRY_AGAIN).length, 1, 'told once');
  await s.say(CONTRACTOR, 'मदद');
  assert.equal(s.lastTo(CONTRACTOR), t('help.contractor'), 'the other agents are not touched');
  await s.start('jcb');
  await s.say(OWNER, 'मदद');
  assert.equal(s.lastTo(OWNER), t('help.jcb_owner'));

  // A dead router: the agents stay up, and a notice that cannot go is told again when the person next writes.
  await s.say(SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
  await s.kill('router');
  assert.equal((await fetch(`${s.base}/health`)).status, 502, 'the front door says so; Meta keeps a message and sends it again');
  assert.equal((await fetch(`http://127.0.0.1:${s.ports.HB_PORT_SITE}/health`)).status, 200, 'the agent stays up');
  // As the router would hand it over: the contractor's OK, written just before the router went.
  const okMessage = { phoneNumberId: 'line-site', from: CONTRACTOR, msgId: 'wamid.direct', atMs: Date.now(), kind: 'text', text: 'ok J-1' };
  const before = s.sent.length;
  await internal(`http://127.0.0.1:${s.ports.HB_PORT_SITE}/internal/wa/inbound`, s.settings('site').HB_INTERNAL_TOKEN, { msg: okMessage });
  await s.settle();
  assert.equal(s.sent.length, before, 'nothing can go out');
  assert.equal((await s.exportOf('jcb')).orders.length, 1, 'the request reached the JCB agent all the same');
  await s.start('router');
  await s.say(OWNER, 'मदद');
  const told = s.sent.slice(before).filter((/** @type {any} */ x) => x.to === OWNER).map((/** @type {any} */ x) => x.text);
  assert.ok(told[0].includes('Shivpuri') && told[0].includes('J-1'), `the window survived in the router's wa.db and the notice in the agent's: ${told.join(' / ')}`);
  assert.equal(told.at(-1), t('help.jcb_owner'));
});

test('a notice to someone outside the 24-hour window is kept by the agent and told when they next write; a window is the router\'s', LONG, async (tc) => {
  const s = await startServices(tc);
  await s.say(CONTRACTOR, 'मदद');
  await s.say(SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
  await s.say(CONTRACTOR, 'ok J-1');
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === OWNER).length, 0, 'the owner has not written: nothing may go');
  const jcb = await s.exportOf('jcb');
  assert.equal(jcb.orders.length, 1, 'the request reached the JCB agent all the same');
  await s.say(OPERATOR, 'मदद');
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === OWNER).length, 0);
  await s.say(OWNER, 'मदद');
  const told = s.sent.filter((/** @type {any} */ x) => x.to === OWNER).map((/** @type {any} */ x) => x.text);
  assert.ok(told[0].includes('Shivpuri') && told[0].includes('J-1'), told.join('\n'));
  assert.equal(told.at(-1), t('help.jcb_owner'), 'then their own message is answered');
});

test('the ledger check across services: a rewritten ledger is caught by the other agent\'s receipts, each owner concerned is told once, healthy is silent', LONG, async (tc) => {
  const s = await startServices(tc, { checkMs: 1500 });
  await jcbJob(s);
  await s.settle();
  await s.say(SUPPLIER, 'मदद');
  const before = s.sent.length;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(s.sent.length, before, 'healthy checks send nothing');
  const out = (/** @type {string} */ name) => s.children.get(name)?.output.join('') ?? '';
  assert.match(out('jcb'), /integrity: ok, 2 ledgers, [1-9]\d* receipts compared/);
  assert.match(out('site'), /integrity: ok, 3 ledgers, [1-9]\d* receipts compared/);
  assert.match(out('supplier'), /integrity: ok, 2 ledgers, 0 receipts compared/);
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.text === ALARM).length, 0);

  // Someone with the file rewrites the JCB ledger, recomputing every hash: its own chain still verifies.
  await s.kill('jcb');
  const file = join(`${s.dirs.prefix}jcb`, 'jcb.db');
  const ledger = openLedger(file);
  rewriteRow(ledger, 1, (m) => { m.body.site = 'Elsewhere'; });
  assert.equal(ledger.verifyChain().ok, true);
  ledger.close();
  await s.start('jcb');
  await new Promise((r) => setTimeout(r, 4000));
  await s.settle();
  const alarms = (/** @type {string} */ phone) => s.sent.filter((/** @type {any} */ x) => x.to === phone && x.text === ALARM).length;
  assert.equal(alarms(CONTRACTOR), 1, `the contractor is told once: ${out('site').slice(-400)}`);
  assert.equal(alarms(OWNER), 1, `the JCB owner is told once: ${out('jcb').slice(-400)}`);
  assert.equal(alarms(SUPPLIER), 0, 'the supplier is not concerned');
  assert.equal(alarms(SUPERVISOR), 0);
  assert.match(out('site'), /integrity: \d+ problem\(s\).*site seq \d+, receipt from jcb: (entry|head)_missing/);
  for (const name of ['jcb', 'site', 'supplier', 'router']) assert.doesNotMatch(out(name), /9190000|Elsewhere|Shivpuri/, name);

  // Told once across a restart, too: the agent keeps what it told in its own wa.db.
  await s.kill('site');
  await s.start('site');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(alarms(CONTRACTOR), 1);
});

test('at start the other agents may not be up: the check is tried again and finds a rewritten ledger', LONG, async (tc) => {
  const s = await startServices(tc);
  await jcbJob(s);
  await s.say(OWNER, 'मदद');
  await s.kill('site');
  await s.kill('jcb');
  const ledger = openLedger(join(`${s.dirs.prefix}jcb`, 'jcb.db'));
  rewriteRow(ledger, 1, (m) => { m.body.site = 'Elsewhere'; });
  ledger.close();
  await s.start('jcb');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === OWNER && x.text === ALARM).length, 0, 'the JCB agent alone cannot see it: only the other side holds the receipts');
  await s.start('site');
  for (let i = 0; i < 100 && !s.sent.some((/** @type {any} */ x) => x.to === OWNER && x.text === ALARM); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.sent.filter((/** @type {any} */ x) => x.to === OWNER && x.text === ALARM).length, 1);
});

test('one shared WhatsApp number on both lines: each person still reaches their own agent, and replies go out on it', LONG, async (tc) => {
  const s = await startServices(tc, { sharedNumber: true });
  await s.say(OWNER, 'मदद');
  await s.say(SUPPLIER, 'मदद');
  await s.say(CONTRACTOR, 'मदद');
  assert.deepEqual([s.lastTo(OWNER), s.lastTo(SUPPLIER), s.lastTo(CONTRACTOR)], [t('help.jcb_owner'), t('help.supplier'), t('help.contractor')]);
  assert.ok(s.sent.every((/** @type {any} */ x) => x.line === 'line-site'));
  await s.say(SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
  await s.say(CONTRACTOR, 'ok J-1');
  assert.ok(s.lastTo(OWNER).includes('Shivpuri'), s.lastTo(OWNER));
});

test('an agent cannot start with another\'s key: wrong key, a second key in its folder, a missing key, the lines\' secrets, or someone else\'s people', LONG, async () => {
  const dirs = makeDirs('hb-keys-');
  try {
    const envIn = inventOneFolder(dirs.one, 'https://example.test');
    const lines = /** @type {string[]} */ ([]);
    assert.equal(await split({ from: dirs.one, envIn, toPrefix: dirs.prefix, envOut: dirs.env }, (l) => { lines.push(l); }), true, lines.join('\n'));
    /** The real entry point, in its own process. @param {string} name @param {Record<string, string>} [extra] */
    const start = (name, extra = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', AGENT_JS], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...parseEnvFile(readFileSync(join(dirs.env, `${name}.env`), 'utf8')), HB_PORT: '0', ...extra }, encoding: 'utf8', timeout: 20_000 });
    const jcbDir = `${dirs.prefix}jcb`;
    const own = join(jcbDir, 'keys', 'jcb.pem');
    const keep = readFileSync(own);
    const refuse = (/** @type {RegExp} */ why, /** @type {Record<string, string>} */ extra = {}) => {
      const r = start('jcb', extra);
      assert.equal(r.status, 1, `exit: ${r.status} ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, why);
      assert.doesNotMatch(r.stderr, /BEGIN PRIVATE|tok-/, 'no secret in the message');
    };

    // Another agent's key under its own file name.
    copyFileSync(join(`${dirs.prefix}site`, 'keys', 'contractor.pem'), own);
    refuse(/not this agent's/);
    writeFileSync(own, keep);
    // A second key beside its own.
    copyFileSync(join(`${dirs.prefix}site`, 'keys', 'contractor.pem'), join(jcbDir, 'keys', 'contractor.pem'));
    refuse(/only its own key/);
    rmSync(join(jcbDir, 'keys', 'contractor.pem'));
    // Told it is another agent, in this agent's folder.
    refuse(/only its own key|missing/, { HB_AGENT: 'site' });
    // No key: it does not make one.
    rmSync(own);
    refuse(/missing/);
    assert.deepEqual(readdirSync(join(jcbDir, 'keys')), []);
    writeFileSync(own, keep, { mode: 0o600 });
    // The lines' secrets are not its business.
    refuse(/belongs to the router/, { HB_WA_JCB_ACCESS_TOKEN: 'tok' });
    refuse(/HB_AGENT must be/, { HB_AGENT: 'nobody' });
    // Another agent's people.
    const people = JSON.parse(readFileSync(join(jcbDir, 'people.json'), 'utf8'));
    writeFileSync(join(jcbDir, 'people.json'), JSON.stringify([...people, { line: 'site', phone: CONTRACTOR, agent: 'contractor', role: 'contractor', name: 'x' }]));
    refuse(/only its own people/);
    writeFileSync(join(jcbDir, 'people.json'), JSON.stringify(people));
    // And the right things in the right place do start (and are stopped by the time limit).
    const ok = start('jcb', { HB_ROUTER_URL: 'http://127.0.0.1:9', META_API_KEY: '' });
    assert.notEqual(ok.status, 1, ok.stderr);
    assert.match(ok.stdout, /agent jcb listening/);
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
