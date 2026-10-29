// The whole service (src/app.js) with three agents, WhatsApp in and out through stand-ins, the agents
// talking over their real A2A endpoints, and stand-in Muse readers: for the trace tests. Invented
// people and numbers only (phones 9190000000xx).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, publicKeyFromText, publicKeyText } from '../../src/protocol/keys.js';
import { createApp } from '../../src/app.js';

export const OWNER = '919000000001';
export const OPERATOR = '919000000002';
export const SUPERVISOR = '919000000011';
export const CONTRACTOR = '919000000012';
export const SUPPLIER = '919000000021';
export const TOKEN = 'test-export-token';
export const API_KEY = 'meta-test-key-not-real-0001';
/** Bytes every stand-in photo carries; they must never reach a trace. */
export const PHOTO_MARK = 'PHOTO-BYTES-MARK-919000000099';

/**
 * @param {{traceText?: boolean, spark?: (req: any) => Promise<any>, dataDir?: boolean}} [o]
 */
export async function startService(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-trace-'));
  /** @type {{to: string, line: string, text: string}[]} */
  const sent = [];
  /** @type {typeof globalThis.fetch} */
  const fakeGraph = async (input, init) => {
    const url = String(input);
    const media = /\/(media-[a-z0-9-]+)$/.exec(url);
    if (media) return Response.json({ url: `https://lookaside.example/${media[1]}`, mime_type: 'image/jpeg', file_size: 40 });
    if (url.startsWith('https://lookaside.example/')) return new Response(new TextEncoder().encode(`${PHOTO_MARK}:${url}`));
    const body = JSON.parse(String(init?.body ?? '{}'));
    const line = /\/(line-[a-z]+)\/messages$/.exec(url)?.[1] ?? '?';
    sent.push({ to: body.to, line, text: body.text?.body ?? body.image?.caption ?? '' });
    return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
  };
  /** What the stand-in Muse Spark proposes next (understanding a message), and what the readers return. */
  const model = { calls: /** @type {{name: string, args: any}[]} */ ([]), kind: 'meter', meters: /** @type {number[]} */ ([]), upiPaise: 0 };
  const spark = o.spark ?? (async (/** @type {any} */ req) => {
    if (req.schema) return { ok: true, json: { explanation: 'x' }, text: '', toolCalls: [], model: 'muse-spark-1.2', latencyMs: 5, usage: { input_tokens: 1, output_tokens: 1 } };
    return { ok: true, toolCalls: model.calls, model: 'muse-spark-1.2', latencyMs: 7, usage: { input_tokens: 10, output_tokens: 5 } };
  });

  /** @type {any} */
  let app = null;
  const server = createServer(async (req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const jk = generateKeys();
  const ck = generateKeys();
  const sk = generateKeys();
  const peer = (/** @type {string} */ id, /** @type {any} */ key, /** @type {any[]} */ types) => ({ id, publicKey: publicKeyFromText(publicKeyText(key)), mayReceiveFrom: new Set(types) });
  const toSeller = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'RECEIPT', 'REFUSE'];
  const toSite = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'RECEIPT', 'REFUSE'];
  const previousKey = process.env.META_API_KEY;
  process.env.META_API_KEY = API_KEY;
  app = createApp({
    baseUrl: base,
    dataDir: o.dataDir ? dir : undefined,
    agents: [
      { name: 'jcb', kind: 'jcb', id: 'agent:jcb-1', title: 'JCB', privateKey: jk.privateKey, ledgerFile: join(dir, 'jcb.db'),
        peers: [peer('agent:contractor-1', ck.publicKey, toSeller)], peerUrls: { 'agent:contractor-1': `${base}/agents/site` } },
      { name: 'site', kind: 'contractor', id: 'agent:contractor-1', title: 'Site', privateKey: ck.privateKey, ledgerFile: join(dir, 'site.db'),
        peers: [peer('agent:jcb-1', jk.publicKey, toSite), peer('agent:supplier-1', sk.publicKey, [...toSite, 'DELIVERY'])],
        peerUrls: { 'agent:jcb-1': `${base}/agents/jcb`, 'agent:supplier-1': `${base}/agents/supplier` }, jcbAgentId: 'agent:jcb-1', supplierAgentId: 'agent:supplier-1' },
      { name: 'supplier', kind: 'supplier', id: 'agent:supplier-1', title: 'Supplier', privateKey: sk.privateKey, ledgerFile: join(dir, 'supplier.db'),
        peers: [peer('agent:contractor-1', ck.publicKey, [...toSeller, 'SITE_RECEIPT'])], peerUrls: { 'agent:contractor-1': `${base}/agents/site` } },
    ],
    lines: [
      { name: 'jcb', phoneNumberId: 'line-jcb', appSecret: 'secret-jcb', verifyToken: 'v1', accessToken: 'tok-jcb' },
      { name: 'site', phoneNumberId: 'line-site', appSecret: 'secret-site', verifyToken: 'v2', accessToken: 'tok-site' },
    ],
    people: [
      { line: 'line-jcb', phone: OWNER, agent: 'agent:jcb-1', role: 'jcb_owner', name: 'Owner' },
      { line: 'line-jcb', phone: OPERATOR, agent: 'agent:jcb-1', role: 'operator', name: 'Operator' },
      { line: 'line-jcb', phone: SUPPLIER, agent: 'agent:supplier-1', role: 'supplier', name: 'Supplier' },
      { line: 'line-site', phone: SUPERVISOR, agent: 'agent:contractor-1', role: 'supervisor', name: 'Supervisor' },
      { line: 'line-site', phone: CONTRACTOR, agent: 'agent:contractor-1', role: 'contractor', name: 'Contractor' },
    ],
    waStoreFile: join(dir, 'wa.db'),
    spark,
    classifyPhoto: async () => ({ ok: true, kind: /** @type {any} */ (model.kind), clear: true, model: 'muse-spark-1.2', latencyMs: 4 }),
    readMeter: async () => {
      const v = /** @type {number} */ (model.meters.shift());
      return { ok: true, kind: 'hour_meter', raw: (v / 10).toFixed(1), valueTenths: v, clear: true, dashClock: null, model: 'muse-spark-1.2', latencyMs: 9 };
    },
    readUpi: async () => ({ ok: true, kind: 'upi_payment', amountPaise: model.upiPaise, date: '2026-10-30', time: null, clock: '14:05', utr: '000011112222',
      status: 'success', payeeName: 'Payee', payeeVpa: 'payee@upi', payerName: 'Payer', clear: true, model: 'muse-spark-1.2', latencyMs: 8 }),
    readChallan: async () => ({ ok: true, kind: 'challan', challanNo: '412', date: null, vehicle: null, clear: true, signed: null,
      items: [{ name: 'सीमेंट', qtyHundredths: 5000, unit: 'बोरी', raw: 'सीमेंट 50 बोरी' }], model: 'muse-spark-1.2', latencyMs: 6 }),
    fetch: fakeGraph,
    exportToken: TOKEN,
    traceText: o.traceText ?? false,
    log: () => {},
  });

  const who = /** @type {Record<string, [string, string, string]>} */ ({
    [OWNER]: ['jcb', 'line-jcb', 'secret-jcb'], [OPERATOR]: ['jcb', 'line-jcb', 'secret-jcb'], [SUPPLIER]: ['jcb', 'line-jcb', 'secret-jcb'],
    [SUPERVISOR]: ['site', 'line-site', 'secret-site'], [CONTRACTOR]: ['site', 'line-site', 'secret-site'],
  });
  let n = 0;
  /** @param {string} from @param {string | null} text @param {string} [mediaId] */
  async function say(from, text, mediaId) {
    n += 1;
    const [name, line, secret] = who[from];
    const m = text === null ? { type: 'image', image: { id: mediaId ?? `media-${n}`, mime_type: 'image/jpeg' } } : { type: 'text', text: { body: text } };
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: line }, messages: [{ from, id: `wamid.t${n}`, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }],
    });
    const r = await fetch(`${base}/wa/${name}/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
    assert.equal(r.status, 200);
    await settle();
  }
  /** Lets the agents' notices over A2A finish (they run after the answer). */
  async function settle() {
    let last = -1;
    for (let i = 0; i < 60 && last !== sent.length; i += 1) {
      last = sent.length;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  const lastTo = (/** @type {string} */ phone) => sent.filter((s) => s.to === phone).at(-1)?.text ?? '';
  /** Says "हाँ" when the last message to this person is a yes/no question. @param {string} phone */
  async function yesIfAsked(phone) {
    if (/हाँ \/ नहीं|"हाँ"/u.test(lastTo(phone))) await say(phone, 'हाँ');
  }
  /** @param {string} name @param {string} [query] @param {string} [token] */
  const trace = async (name, query = '', token = TOKEN) => fetch(`${base}/agents/${name}/trace${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  return {
    app, base, sent, model, say, settle, lastTo, yesIfAsked, trace, dir,
    async close() {
      app.close();
      await new Promise((r) => server.close(() => r(undefined)));
      rmSync(dir, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = previousKey;
    },
  };
}

/**
 * A whole JCB job over WhatsApp: the supervisor's request held for the contractor's OK, the owner's
 * "हाँ 1200", start and end meter photos read and recorded at once, the bill, the contractor's "हाँ",
 * the UPI screenshot and the owner's confirmation. Returns the order id.
 * @param {Awaited<ReturnType<typeof startService>>} s
 */
export async function jcbJob(s) {
  for (const p of [OWNER, OPERATOR, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
  s.model.calls = [{ name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }];
  await s.say(SUPERVISOR, 'kal 8 baje Shivpuri JCB 6 ghante');
  await s.say(CONTRACTOR, 'ok J-1');
  s.model.calls = [];
  await s.say(OWNER, 'हाँ 1200');
  s.model.kind = 'meter';
  s.model.meters = [12345, 12406];
  await s.say(OPERATOR, null);
  await s.yesIfAsked(OPERATOR);
  await s.say(OPERATOR, null);
  await s.yesIfAsked(OPERATOR);
  await s.say(OWNER, 'बिल');
  await s.yesIfAsked(OWNER);
  await s.yesIfAsked(CONTRACTOR);
  s.model.kind = 'upi';
  s.model.upiPaise = 732000;
  await s.say(CONTRACTOR, null);
  await s.yesIfAsked(CONTRACTOR);
  await s.yesIfAsked(OWNER);
  const site = s.app.agent('agent:contractor-1');
  return /** @type {string} */ (site.core.ledger.orders().find((/** @type {any} */ o) => o.kind === 'jcb_hours').order_id);
}

/**
 * A whole material job: the supervisor's order held for the contractor's OK, the supplier's "हाँ 350",
 * the challan photo, the site's count, the bill, the contractor's "हाँ", the UPI screenshot and the
 * supplier's confirmation. Returns the order id.
 * @param {Awaited<ReturnType<typeof startService>>} s
 */
export async function materialJob(s) {
  for (const p of [SUPPLIER, SUPERVISOR, CONTRACTOR]) await s.say(p, 'मदद');
  s.model.calls = [{ name: 'request_material', args: { site: 'Shivpuri', day: 'tomorrow', time: null, items: [{ name: 'सीमेंट', quantity: '50', unit: 'बोरी' }] } }];
  await s.say(SUPERVISOR, 'kal Shivpuri cement 50 bori');
  await s.say(CONTRACTOR, 'ok P-1');
  s.model.calls = [];
  await s.say(SUPPLIER, 'हाँ 350');
  s.model.kind = 'challan';
  await s.say(SUPPLIER, null);
  await s.yesIfAsked(SUPPLIER);
  await s.yesIfAsked(SUPERVISOR);
  await s.say(SUPPLIER, 'बिल');
  await s.yesIfAsked(SUPPLIER);
  await s.yesIfAsked(CONTRACTOR);
  s.model.kind = 'upi';
  s.model.upiPaise = 1750000;
  await s.say(CONTRACTOR, null);
  await s.yesIfAsked(CONTRACTOR);
  await s.yesIfAsked(SUPPLIER);
  const site = s.app.agent('agent:contractor-1');
  return /** @type {string} */ (site.core.ledger.orders().find((/** @type {any} */ o) => o.kind === 'material').order_id);
}
