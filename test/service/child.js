// One real service in a child process, as src/service/agent.js and router.js start it, with only the
// outside world stood in for: the Muse models (below) and the Graph API's address (a stand-in server
// run by the test). Everything is invented.

import { startAgent } from '../../src/service/agent.js';
import { startRouter } from '../../src/service/router.js';

/** A photo's bytes say what it shows: "meter:12345" or "upi:732000"; "meter:99894:unsure", a reading the reader is not sure of. @param {{bytes: Uint8Array}} image */
const shown = (image) => {
  const [kind, value, unsure] = Buffer.from(image.bytes).toString('utf8').split(':');
  return { kind, value: Number(value), unsure: unsure === 'unsure' };
};
const STAND_IN = { model: 'muse-spark-1.3', latencyMs: 1 };

/** @type {any} */
const models = {
  // The stand-in understands one sentence: the JCB request the tests send.
  spark: async (/** @type {any} */ req) => {
    if (req.schema) return { ok: true, json: { explanation: 'x' }, text: '', toolCalls: [], usage: { input_tokens: 1, output_tokens: 1 }, ...STAND_IN };
    const calls = /Shivpuri JCB/.test(String(req.text)) ? [{ name: 'request_jcb', args: { site: 'Shivpuri', day: 'tomorrow', time: '8', hours: '6' } }] : [];
    return { ok: true, toolCalls: calls, usage: { input_tokens: 1, output_tokens: 1 }, ...STAND_IN };
  },
  classifyPhoto: async (/** @type {any} */ image) => ({ ok: true, kind: shown(image).kind, clear: true, ...STAND_IN }),
  readMeter: async (/** @type {any} */ image) => {
    const { value: v, unsure } = shown(image);
    return { ok: true, kind: 'hour_meter', raw: (v / 10).toFixed(1), valueTenths: unsure ? null : v, clear: !unsure, dashClock: null, ...STAND_IN };
  },
  readUpi: async (/** @type {any} */ image) => ({ ok: true, kind: 'upi_payment', amountPaise: shown(image).value, date: '2026-10-30', time: null, clock: '14:05', utr: '000011112222',
    status: 'success', payeeName: 'Payee', payeeVpa: 'payee@upi', payerName: 'Payer', clear: true, ...STAND_IN }),
  readChallan: async () => ({ ok: false, transient: false, reason: 'no challan in these tests', latencyMs: 1 }),
  readCashReceipt: async () => ({ ok: false, transient: false, reason: 'no cash receipt in these tests', latencyMs: 1 }),
  sameMeter: async () => ({ ok: true, same: 'same', ...STAND_IN }),
  checkRetryMs: Number(process.env.TEST_CHECK_RETRY_MS || 500),
};

if (process.argv[2] === 'router') {
  // The Graph API's addresses, turned to the stand-in the test runs.
  /** @type {typeof globalThis.fetch} */
  const toStandIn = (url, init) => globalThis.fetch(String(url).replace(/^https:\/\/graph\.(facebook\.com|test)/, String(process.env.TEST_GRAPH_URL)), init);
  startRouter(process.env, { fetch: toStandIn, refusedRetryMs: 100 });
} else {
  startAgent(process.env, { ...models, ...(process.env.TEST_CHECK_MS ? { integrityCheckMs: Number(process.env.TEST_CHECK_MS) } : {}) });
}
