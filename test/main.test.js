import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/main.js';
import { publicKeyText } from '../src/protocol/keys.js';

/** @param {string} dir */
const env = (dir) => ({
  HB_DATA_DIR: dir, HB_BASE_URL: 'https://example.test/',
  HB_WA_JCB_PHONE_NUMBER_ID: 'line-jcb', HB_WA_JCB_APP_SECRET: 's1', HB_WA_JCB_VERIFY_TOKEN: 'v1', HB_WA_JCB_ACCESS_TOKEN: 'a1',
  HB_WA_SITE_PHONE_NUMBER_ID: 'line-site', HB_WA_SITE_APP_SECRET: 's2', HB_WA_SITE_VERIFY_TOKEN: 'v2', HB_WA_SITE_ACCESS_TOKEN: 'a2',
});

test('configuration comes from HB_ variables and the private data folder; keys are made once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-main-'));
  try {
    writeFileSync(join(dir, 'people.json'), JSON.stringify([
      { line: 'jcb', phone: '919000000001', agent: 'jcb', role: 'jcb_owner', name: 'Owner' },
      { line: 'site', phone: '919000000011', agent: 'contractor', role: 'supervisor', name: 'Supervisor' },
    ]));
    const a = loadConfig(env(dir));
    assert.equal(a.baseUrl, 'https://example.test');
    assert.deepEqual(a.people.map((p) => [p.line, p.agent, p.role]), [['line-jcb', 'agent:jcb-1', 'jcb_owner'], ['line-site', 'agent:contractor-1', 'supervisor']]);
    assert.equal(a.agents[0].peerUrls['agent:contractor-1'], 'https://example.test/agents/site');
    // Each side trusts the other's real public key.
    assert.equal(publicKeyText(a.agents[0].peers[0].publicKey), publicKeyText(a.agents[1].privateKey));
    assert.equal(publicKeyText(a.agents[1].peers[0].publicKey), publicKeyText(a.agents[0].privateKey));
    const b = loadConfig(env(dir));
    assert.equal(publicKeyText(b.agents[0].privateKey), publicKeyText(a.agents[0].privateKey), 'the same key on restart');
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'keys', 'jcb.pem')).mode & 0o077, 0);
    assert.throws(() => loadConfig({ ...env(dir), HB_WA_SITE_APP_SECRET: '' }), /HB_WA_SITE_APP_SECRET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('three agents: the contractor has two peers, each seller one; the supplier shares the JCB line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-main-'));
  try {
    writeFileSync(join(dir, 'people.json'), JSON.stringify([
      { line: 'jcb', phone: '919000000001', agent: 'jcb', role: 'jcb_owner', name: 'Owner' },
      { line: 'jcb', phone: '919000000021', agent: 'supplier', role: 'supplier', name: 'Supplier' },
      { line: 'site', phone: '919000000011', agent: 'contractor', role: 'supervisor', name: 'Supervisor' },
    ]));
    const a = loadConfig(env(dir));
    assert.deepEqual(a.agents.map((x) => [x.name, x.kind, x.id]), [['jcb', 'jcb', 'agent:jcb-1'], ['site', 'contractor', 'agent:contractor-1'], ['supplier', 'supplier', 'agent:supplier-1']]);
    assert.deepEqual(a.people.map((p) => [p.line, p.agent, p.role])[1], ['line-jcb', 'agent:supplier-1', 'supplier']);
    const [jcb, site, sup] = a.agents;
    assert.equal(sup.ledgerFile, join(dir, 'supplier.db'));
    assert.deepEqual([site.jcbAgentId, site.supplierAgentId], ['agent:jcb-1', 'agent:supplier-1']);
    assert.deepEqual(site.peerUrls, { 'agent:jcb-1': 'https://example.test/agents/jcb', 'agent:supplier-1': 'https://example.test/agents/supplier' });
    assert.deepEqual(sup.peerUrls, { 'agent:contractor-1': 'https://example.test/agents/site' });
    // Each trusts the other's real key; only the supplier may send a DELIVERY to the contractor.
    const sitePeer = (/** @type {string} */ id) => /** @type {any} */ (site.peers.find((p) => p.id === id));
    assert.equal(publicKeyText(sitePeer('agent:supplier-1').publicKey), publicKeyText(sup.privateKey));
    assert.equal(publicKeyText(sup.peers[0].publicKey), publicKeyText(site.privateKey));
    assert.deepEqual([sitePeer('agent:supplier-1').mayReceiveFrom.has('DELIVERY'), sitePeer('agent:jcb-1').mayReceiveFrom.has('DELIVERY')], [true, false]);
    assert.equal(sup.peers[0].mayReceiveFrom.has('BOOKING_REQUEST'), true);
    assert.equal(jcb.peers.length, 1);
    // The supplier's key is made once and kept.
    assert.equal(publicKeyText(loadConfig(env(dir)).agents[2].privateKey), publicKeyText(sup.privateKey));
    assert.equal(loadConfig({ ...env(dir), HB_SUPPLIER_AGENT_ID: 'agent:supplier-7' }).agents[1].supplierAgentId, 'agent:supplier-7');

    // The supplier role and the supplier agent go together.
    writeFileSync(join(dir, 'people.json'), JSON.stringify([{ line: 'jcb', phone: '919000000021', agent: 'supplier', role: 'jcb_owner', name: 'X' }]));
    assert.throws(() => loadConfig(env(dir)), /role 'supplier'/);
    writeFileSync(join(dir, 'people.json'), JSON.stringify([{ line: 'site', phone: '919000000021', agent: 'contractor', role: 'supplier', name: 'X' }]));
    assert.throws(() => loadConfig(env(dir)), /role 'supplier'/);
    writeFileSync(join(dir, 'people.json'), JSON.stringify([{ line: 'site', phone: '919000000021', agent: 'shop', role: 'supplier', name: 'X' }]));
    assert.throws(() => loadConfig(env(dir)), /agent 'jcb'\|'contractor'\|'supplier'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
