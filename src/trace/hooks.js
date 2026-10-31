// The few central places the trace listens at, as wrappers that keep every contract as it is: the
// Muse calls (spark, the photo readers, voice), the tools a person's decision runs, the ledger's
// append, and the signed messages leaving over A2A. Each wrapper returns exactly what the wrapped
// function returns (or throws what it throws); the recording beside it is caught and dropped.

import { currentTrace } from './trace.js';
import { paymentChecks } from './payments.js';
import { usualChecks } from './usual.js';

/** @typedef {import('./trace.js').Recorder} Recorder */

const short = (/** @type {unknown} */ s, n = 8) => (typeof s === 'string' ? s.slice(0, n) : null);
const ms = (/** @type {number} */ start) => Math.round(performance.now() - start);
const MODEL_NAME = 'Muse Spark';

/**
 * What a Muse Spark request is for, from its shape: explanations ask for a JSON schema; the
 * read-only questions offer an `answer` tool; everything else is understanding a message.
 * @param {any} req @param {any} res
 */
export function sparkJob(req, res) {
  if (req?.schema) return 'explain';
  const tools = Array.isArray(req?.tools) ? req.tools.map((/** @type {any} */ t) => t?.function?.name) : [];
  if (tools.includes('answer')) return res?.ok && Array.isArray(res.toolCalls) && res.toolCalls.some((/** @type {any} */ c) => c?.name === 'answer') ? 'ask_answer' : 'ask_plan';
  return 'understand';
}

/** The structured output, small: tool + args, or the explanation's length. @param {string} job @param {any} r */
function sparkOutput(job, r) {
  if (!r?.ok) return { ok: false, reason: r?.reason ?? 'error' };
  const calls = Array.isArray(r.toolCalls) ? r.toolCalls : [];
  if (job === 'explain') return { ok: true, explanationChars: typeof r.json?.explanation === 'string' ? [...r.json.explanation].length : 0 };
  if (job === 'ask_answer') {
    const a = calls.find((/** @type {any} */ c) => c?.name === 'answer');
    return { ok: true, tool: 'answer', answerChars: typeof a?.args?.answer === 'string' ? [...a.args.answer].length : 0 };
  }
  return { ok: true, calls: calls.slice(0, 6).map((/** @type {any} */ c) => ({ tool: c?.name, args: c?.args ?? {} })) };
}

/** The title of a model step. @param {string} job @param {any} out */
function sparkTitle(job, out) {
  if (!out.ok) return `${job}: no answer (${out.reason})`;
  if (job === 'understand') return `understand → ${out.calls.map((/** @type {any} */ c) => c.tool).join(', ') || 'nothing'}`;
  if (job === 'ask_plan') return `ask: lookups ${out.calls.map((/** @type {any} */ c) => c.tool).join(', ')}`;
  if (job === 'ask_answer') return `ask: answer written (${out.answerChars} chars)`;
  return `explain: ${out.explanationChars} chars`;
}

/**
 * Muse Spark, traced. The request is not stored (no prompt, no image); its job, the model, the
 * reasoning effort, the latency and the structured output are.
 * @template {(req: any) => Promise<any>} F
 * @param {F} spark @param {Recorder} rec
 * @returns {F}
 */
export function traceSpark(spark, rec) {
  return /** @type {F} */ (async (/** @type {any} */ req) => {
    const start = performance.now();
    const r = await spark(req);
    try {
      const job = sparkJob(req, r);
      const out = sparkOutput(job, r);
      rec.add('model', sparkTitle(job, out), { job, model: r?.model ?? MODEL_NAME, reasoningEffort: req?.reasoningEffort ?? 'default',
        tools: Array.isArray(req?.tools) ? req.tools.length : 0, ...out, tokens: r?.usage ?? null }, { ms: r?.latencyMs ?? ms(start) });
    } catch { /* dropped */ }
    return r;
  });
}

/** What a photo reader returned, without bytes or names. @param {string} job @param {any} r */
function readerOutput(job, r) {
  if (!r?.ok) return { ok: false, reason: r?.reason ?? 'error' };
  if (job === 'photo_kind') return { ok: true, kind: r.kind, clear: r.clear };
  if (job === 'meter') return r.kind === 'hour_meter' ? { ok: true, kind: r.kind, raw: r.raw, valueTenths: r.valueTenths, clear: r.clear, dashClock: r.dashClock ?? null } : { ok: true, kind: r.kind };
  if (job === 'upi') {
    return r.kind === 'upi_payment'
      ? { ok: true, kind: r.kind, amountPaise: r.amountPaise, utr: r.utr, status: r.status, date: r.date, clock: r.clock ?? null, clear: r.clear }
      : { ok: true, kind: r.kind };
  }
  if (job === 'challan') {
    return r.kind === 'challan'
      ? { ok: true, kind: r.kind, challanNo: r.challanNo, items: (r.items ?? []).map((/** @type {any} */ i) => ({ name: i.name, qtyHundredths: i.qtyHundredths, unit: i.unit })), clear: r.clear, signed: r.signed ?? null }
      : { ok: true, kind: r.kind };
  }
  if (job === 'same_meter') return { ok: true, same: r.same };
  if (job === 'cash_receipt') return r.kind === 'cash_receipt'
    ? { ok: true, kind: r.kind, amountPaise: r.amountPaise, date: r.date, receiverMark: r.receiverMark, clear: r.clear }
    : { ok: true, kind: r.kind };
  return { ok: true };
}

/** @param {string} job @param {any} out */
function readerTitle(job, out) {
  if (!out.ok) return `${job}: no reading (${out.reason})`;
  if (job === 'photo_kind') return `photo kind: ${out.kind}${out.clear ? '' : ' (unsure)'}`;
  if (job === 'meter' && out.kind === 'hour_meter') return `meter reads ${out.raw ?? '?'}${out.clear ? '' : ' (unclear)'}`;
  if (job === 'upi' && out.kind === 'upi_payment') return `UPI receipt: ${out.amountPaise === null ? '?' : `₹${out.amountPaise / 100}`} ${out.status ?? ''}`.trim();
  if (job === 'challan' && out.kind === 'challan') return `challan ${out.challanNo ?? '?'}: ${out.items.length} item(s)`;
  if (job === 'same_meter') return `same machine as the other meter photo: ${out.same}`;
  if (job === 'cash_receipt' && out.kind === 'cash_receipt') return `cash receipt: ${out.amountPaise === null ? '?' : `₹${out.amountPaise / 100}`}${out.clear ? '' : ' (unclear)'}`;
  return `${job}: ${out.kind ?? 'read'}`;
}

/**
 * A photo reader (meter, UPI, challan, photo kind), traced. The image never reaches the trace.
 * @template {(image: any) => Promise<any>} F
 * @param {'photo_kind' | 'meter' | 'upi' | 'challan' | 'same_meter' | 'cash_receipt'} job @param {F | undefined} reader @param {Recorder} rec
 * @returns {F | undefined}
 */
export function traceReader(job, reader, rec) {
  if (!reader) return undefined;
  // The second argument is the reader's own (the correction memory): it must reach the reader.
  return /** @type {F} */ (async (/** @type {any} */ image, /** @type {any} */ opts) => {
    const start = performance.now();
    const r = await /** @type {any} */ (reader)(image, opts);
    try {
      const out = readerOutput(job, r);
      rec.add('model', readerTitle(job, out), { job, model: r?.model ?? MODEL_NAME, reasoningEffort: 'default', vision: true, ...out }, { ms: r?.latencyMs ?? ms(start) });
    } catch { /* dropped */ }
    return r;
  });
}

/**
 * Muse Voice Transcribe, traced: the length of what was said, and the words only when kept.
 * @template {(req: any) => Promise<any>} F
 * @param {F | undefined} transcribe @param {Recorder} rec
 * @returns {F | undefined}
 */
export function traceTranscribe(transcribe, rec) {
  if (!transcribe) return undefined;
  return /** @type {F} */ (async (/** @type {any} */ req) => {
    const start = performance.now();
    const r = await transcribe(req);
    try {
      const text = r?.ok && typeof r.text === 'string' ? r.text : '';
      rec.add('model', r?.ok ? `transcribe: ${[...text].length} chars` : `transcribe: no text (${r?.reason})`,
        { job: 'transcribe', model: r?.model ?? 'Muse Voice Transcribe', reasoningEffort: null, ok: !!r?.ok, chars: [...text].length,
          ...(rec.text && text ? { transcript: rec.words(text) } : {}) }, { ms: r?.latencyMs ?? ms(start) });
    } catch { /* dropped */ }
    return r;
  });
}

/**
 * The tools a person's steps run, traced: a committing step is a person's decision, recorded with
 * who decided (the person of the handling now running), for whom, and their exact short reply (when
 * words are kept). The tool objects are copies; the agent's own stay untouched.
 * @param {Record<string, import('../agents/common.js').Tool>} tools @param {Recorder} rec
 * @returns {Record<string, import('../agents/common.js').Tool>}
 */
export function traceTools(tools, rec) {
  /** @type {Record<string, import('../agents/common.js').Tool>} */
  const out = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.commits) { out[name] = tool; continue; }
    out[name] = {
      ...tool,
      // Recorded before the step runs, so it stands before the signed message it causes; whether the
      // step went through shows in what follows (the ledger row, or the reply's key).
      run(person, args) {
        try {
          const c = currentTrace();
          const by = c?.rec === rec && c.role ? c.role : person.role;
          const reply = c?.rec === rec ? rec.words(c.text) : null;
          rec.add('decision', `${by}${reply ? ` "${reply.slice(0, 40)}"` : ''} → ${name}${by !== person.role ? ` (for the ${person.role})` : ''}`,
            { role: by, ...(by !== person.role ? { onBehalfOf: person.role } : {}), reply, tool: name },
            { orderId: typeof args?.orderId === 'string' ? args.orderId : null });
        } catch { /* dropped */ }
        return tool.run(person, args);
      },
    };
  }
  return out;
}

/**
 * The ledger's append and order creation, traced on the instance: each written event is one entry
 * (sequence, hash prefix, previous hash prefix), and the order of the handling now running becomes
 * known (a new order also takes this person's entries from before it existed).
 * @param {ReturnType<typeof import('../ledger/store.js').openLedger>} ledger @param {Recorder} rec
 */
export function traceLedger(ledger, rec) {
  const append = ledger.append.bind(ledger);
  const ensureOrder = ledger.ensureOrder.bind(ledger);
  /** @type {any} */ (ledger).ensureOrder = (/** @type {any} */ o) => {
    const existed = (() => { try { return ledger.order(o?.orderId ?? o?.order_id) !== null; } catch { return true; } })();
    const r = ensureOrder(o);
    try {
      const id = o?.orderId ?? o?.order_id;
      if (!existed && typeof id === 'string' && ledger.order(id) !== null) rec.attach(id, { created: true });
    } catch { /* dropped */ }
    return r;
  };
  /** @type {any} */ (ledger).append = (/** @type {any} */ e) => {
    const r = append(e);
    try {
      if (r) {
        rec.attach(r.orderId);
        const kind = r.direction === 'local' ? (r.body?.kind ?? '') : '';
        rec.add('ledger', `#${r.seq} ${r.type}${kind ? ` (${kind})` : ''} ${r.direction} · ${short(r.hash, 7)}`,
          { seq: r.seq, type: r.type, direction: r.direction, msg: short(r.msgId), hash: short(r.hash, 12), prev: short(r.prevHash, 12) },
          { orderId: r.orderId });
        const counterparty = ledger.order(r.orderId)?.counterparty;
        const orders = ledger.orders().filter((o) => o.counterparty === counterparty)
          .map((o) => ({ orderId: String(o.order_id), events: ledger.events(String(o.order_id)) }));
        for (const check of paymentChecks(r, orders)) rec.add('check', check.title, check.detail, { orderId: check.orderId });
        for (const check of usualChecks(r, orders.flatMap((o) => o.events))) rec.add('check', check.title, check.detail, { orderId: check.orderId });
      }
    } catch { /* dropped */ }
    return r;
  };
  return ledger;
}

/**
 * The transport to the other agent, timed: how long the A2A round trip took and what came back.
 * Kept by message id for the link wrapper, which knows whether the answer verified.
 * @template {(baseUrl: string, m: any) => Promise<unknown>} F
 * @param {F} transport @param {Map<string, {ms: number, answer: string | null, receipt: string | null}>} trips
 * @returns {F}
 */
export function traceTransport(transport, trips) {
  return /** @type {F} */ (async (/** @type {string} */ url, /** @type {any} */ m) => {
    const start = performance.now();
    try {
      const a = /** @type {any} */ (await transport(url, m));
      try {
        trips.set(m?.msg_id, { ms: ms(start), answer: typeof a?.type === 'string' ? a.type : null, receipt: short(a?.msg_id) });
        if (trips.size > 200) trips.delete(/** @type {string} */ (trips.keys().next().value));
      } catch { /* dropped */ }
      return a;
    } catch (err) {
      try { trips.set(m?.msg_id, { ms: ms(start), answer: null, receipt: null }); } catch { /* dropped */ }
      throw err;
    }
  });
}

/**
 * The link's sends, traced: each signed message that left, to whom, the round trip, and whether the
 * signed answer verified and was written (a receipt) or refused.
 * @param {ReturnType<typeof import('../agents/link.js').createLink>} link @param {Recorder} rec
 * @param {Map<string, {ms: number, answer: string | null, receipt: string | null}>} trips
 */
export function traceLink(link, rec, trips) {
  /** @param {import('../agents/link.js').Delivery} d @param {boolean} [again] */
  const note = (d, again = false) => {
    try {
      if (!('message' in d) || !d.message) return;
      const m = d.message;
      const trip = trips.get(m.msg_id);
      trips.delete(m.msg_id);
      const verdict = d.ok ? 'receipt ✓' : d.reason === 'refused' ? `refused (${'code' in d ? d.code : ''})` : d.reason;
      rec.add('signed_out', `${m.type} → ${m.to} · ${verdict}${again ? ' (again)' : ''}`,
        { type: m.type, msg: short(m.msg_id), to: m.to, signed: true, answer: trip?.answer ?? null, receipt: trip?.receipt ?? null,
          verified: d.ok, reason: d.ok ? null : d.reason, ...(d.ok && d.evidence ? { evidence: true } : {}) },
        { orderId: m.order_id, ms: trip?.ms ?? null });
    } catch { /* dropped */ }
  };
  return {
    ...link,
    /** @param {Parameters<typeof link.send>[0]} msg */
    async send(msg) {
      const d = await link.send(msg);
      note(d);
      return d;
    },
    /** @param {Parameters<typeof link.deliver>[0]} m */
    async deliver(m) {
      const d = await link.deliver(m);
      note(d, true);
      return d;
    },
    async retryPending() {
      const ds = await link.retryPending();
      for (const d of ds) note(d, true);
      return ds;
    },
  };
}

/**
 * The receiving side's verdict on one incoming message (createA2AHandler's onReceived): verified and
 * written, a repeat, or refused with its code, and how long checking and writing took.
 * @param {Recorder} rec
 * @returns {(incoming: any, r: {answer: any, applied: boolean, message: any}, took: number) => void}
 */
export function traceReceived(rec) {
  return (incoming, r, took) => {
    try {
      const m = r.message ?? incoming;
      // A request failing sender authentication gets an unsigned error instead of a REFUSE.
      const refused = r.answer?.type === 'REFUSE' || r.answer?.type === 'ERROR';
      const code = refused ? r.answer?.body?.code ?? r.answer?.code ?? null : null;
      rec.add('signed_in', `${m?.type ?? '?'} ← ${m?.from ?? '?'} · ${refused ? `refused (${code})` : r.applied ? 'signature verified ✓' : 'repeat, not applied twice, fresh receipt'}`,
        { type: m?.type ?? null, msg: short(m?.msg_id), from: m?.from ?? null, verified: !refused, applied: r.applied, answer: r.answer?.type ?? null, code },
        { orderId: typeof m?.order_id === 'string' ? m.order_id : null, ms: took });
    } catch { /* dropped */ }
  };
}
