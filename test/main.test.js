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
    // Approval limits: whole rupees to paise on the contractor's agent only; unset means none; anything else stops the start.
    assert.deepEqual(a.agents[1].limits, {});
    const limited = loadConfig({ ...env(dir), HB_LIMIT_PROCUREMENT_RUPEES: '10000', HB_LIMIT_PAYMENT_RUPEES: ' 0 ' });
    assert.deepEqual(limited.agents[1].limits, { procurementPaise: 1000000, paymentPaise: 0 });
    assert.equal(/** @type {any} */ (limited.agents[0]).limits, undefined);
    for (const bad of ['10,000', '-5', '1.5', 'ten']) assert.throws(() => loadConfig({ ...env(dir), HB_LIMIT_PROCUREMENT_RUPEES: bad }), /HB_LIMIT_PROCUREMENT_RUPEES/, bad);
    assert.throws(() => loadConfig({ ...env(dir), HB_LIMIT_PAYMENT_RUPEES: '5k' }), /HB_LIMIT_PAYMENT_RUPEES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
