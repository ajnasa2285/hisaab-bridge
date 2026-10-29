import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { generateKeys } from '../src/protocol/keys.js';
import { TYPES } from '../src/protocol/messages.js';
import { runTool } from '../src/agents/common.js';

test('app exchanges evidence over real A2A, sends WhatsApp image and exports signed metadata only', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-app-evidence-'));
  const keys = [generateKeys(), generateKeys()];
  const ids = ['agent:contractor-1', 'agent:supplier-1'];
  /** @type {any[]} */ const sent = [];
  /** @type {any[]} */ const uploads = [];
  /** @type {any[]} */ const reads = [];
  /** @type {ReturnType<typeof createApp>} */ let app;
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const contractor = { agent: ids[0], role: /** @type {const} */ ('contractor'), name: 'Invented', phone: '919000000011', line: 'line-site' };
  const supplier = { agent: ids[1], role: /** @type {const} */ ('supplier'), name: 'Invented', phone: '919000000021', line: 'line-supplier' };
  app = createApp({ baseUrl, dataDir, waStoreFile: join(dataDir, 'wa.db'), exportToken: 'invented-export',
    agents: ids.map((id, i) => ({ id, name: i === 0 ? 'site' : 'supplier', kind: i === 0 ? 'contractor' : 'supplier', title: 'Invented',
      privateKey: keys[i].privateKey, ledgerFile: join(dataDir, `${i}.db`), jcbAgentId: 'agent:jcb-1', supplierAgentId: ids[1],
      peers: [{ id: ids[1-i], publicKey: keys[1-i].publicKey, mayReceiveFrom: new Set(TYPES) }],
      peerUrls: { [ids[1-i]]: `${baseUrl}/agents/${i === 0 ? 'supplier' : 'site'}` } })),
    lines: [{ name: 'site', phoneNumberId: 'line-site', appSecret: 'invented-secret', verifyToken: 'invented-verify', accessToken: 'invented-access' }],
    people: [contractor], log: () => {},
    spark: async () => ({ ok: true, json: { explanation: 'सप्लायर के चालान पर 50 बोरी दर्ज है।' }, toolCalls: [] }),
    readChallan: async (image) => { reads.push(image); return { ok: true, kind: 'challan', challanNo: '701', date: '2026-10-29', clear: true,
      items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी', raw: '50' }] }; },
    fetch: async (input, init) => {
      if (String(input).endsWith('/media')) { uploads.push(init?.body); return Response.json({ id: 'invented-upload' }); }
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
    },
  });
  try {
    const site = /** @type {NonNullable<ReturnType<typeof app.agent>>} */ (app.agent(ids[0]));
    const sup = /** @type {NonNullable<ReturnType<typeof app.agent>>} */ (app.agent(ids[1]));
    const items = [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी' }];
    assert.equal((await runTool(site.agent.tools, contractor, { tool: 'request_material', args: { site: 'Invented Site', day: '2026-10-29', items } })).ok, true);
    const orderId = site.core.ledger.orders()[0].order_id;
    assert.equal((await runTool(sup.agent.tools, supplier, { tool: 'reply_order', args: { orderId, answer: 'yes', ratesPaise: [35000] } })).ok, true);
    const bytes = Buffer.from('invented app challan bytes');
    const image = sup.core.mediaStore.put({ bytes, mime: 'image/png' });
    assert.equal((await runTool(sup.agent.tools, supplier, { tool: 'record_delivery', args: { orderId, items, sha256: image.sha256, challanNo: '701' } })).ok, true);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'invented', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'line-site' }, messages: [{ from: contractor.phone, id: 'wamid.evidence-command', timestamp: String(Math.floor(Date.now()/1000)), type: 'text', text: { body: 'सबूत P-1' } }],
    } }] }] });
    const response = await fetch(`${baseUrl}/wa/site/webhook`, { method: 'POST', body,
      headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'invented-secret').update(body).digest('hex')}` } });
    assert.equal(response.status, 200);
    for (let n = 0; n < 100 && !sent.some((m) => m.text?.body?.includes('सबूत मिल गया')); n += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(uploads.length, 1);
    assert.equal(sent.filter((m) => m.type === 'image').length, 1);
    assert.match(sent.find((m) => m.type === 'image').image.caption, /फ़ोटो वही है जो दर्ज हुई थी/);
    assert.equal(reads.length, 1);
    assert.deepEqual(Buffer.from(reads[0].bytes), bytes);
    const exported = await (await fetch(`${baseUrl}/agents/site/export`, { headers: { authorization: 'Bearer invented-export' } })).json();
    assert.equal(exported.chain.ok, true);
    assert.doesNotMatch(JSON.stringify(exported), /"bytes"|invented app challan bytes/);
    assert.equal(exported.events.some((/** @type {any} */ e) => e.direction === 'in' && e.type === 'EVIDENCE'), true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
