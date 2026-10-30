// What happens inside one agent, step by step, for the judge page's "inside the agent" view: which
// Muse model was asked what and what it returned, which code checks ran, who decided, which signed
// message went where and which ledger row was written. A working log, kept apart from everything
// that counts: its own SQLite file, never in the hash chain, never in a protocol message, never read
// by an agent to decide anything. Append-only in use; only the oldest rows beyond the retention are
// dropped.
//
// Privacy: no phone (a conversation is a keyed hash of the person), no key, no image or audio bytes.
// A person's own words are kept only when HB_TRACE_TEXT=1 (the demo), with every run of 8 or more
// digits masked; a UTR is shown only in its own field. A trace failure is caught and dropped: it never
// changes what an agent does or says.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';

export const KEEP = 2000;
export const KINDS = /** @type {const} */ (['received', 'model', 'check', 'decision', 'signed_out', 'signed_in', 'ledger', 'reply']);
/** @typedef {typeof KINDS[number]} Kind */
/**
 * @typedef {{id: number, at: string, agent: string, orderId: string | null, ref: string | null, convo: string | null,
 *   kind: Kind, title: string, detail: Record<string, any>, ms: number | null}} TraceEntry
 */
/**
 * The handling of one message (from a person, or from the other agent). Everything recorded while it
 * runs carries its conversation, and its order once one is known.
 * @typedef {{rec: Recorder, convo: string | null, handling: string, role?: string | null, text?: string | null,
 *   startMs: number, orderId?: string | null, ref?: string | null}} TraceContext
 */
/** @typedef {ReturnType<typeof openTrace>} Recorder */

const als = new AsyncLocalStorage();
// Fields written by code, never by a person: kept as they are (a UTR, fingerprints, hashes, ids).
const VERBATIM = new Set(['utr', 'hash', 'prev', 'sha256', 'msg', 'receipt', 'model']);
const MAX_STRING = 400;
const ATTACH_WINDOW_MS = 30 * 60 * 1000;

/** Every run of 8 or more digits (Latin or Devanagari) masked. @param {string} s */
export function maskDigits(s) {
  return s.replace(/[0-9०-९]{8,}/gu, (m) => '•'.repeat(m.length));
}

/**
 * A small, safe copy of a detail: strings masked and cut, bytes and binary dropped, depth bounded.
 * @param {unknown} v @param {string} [key] @param {number} [depth]
 * @returns {unknown}
 */
export function clean(v, key = '', depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    return VERBATIM.has(key) ? s : maskDigits(s);
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (v instanceof Uint8Array || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return null;
  // Deep enough for a tool call's arguments: detail → calls → call → args → items → item → its fields.
  if (depth > 7) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, key, depth + 1));
  if (typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) {
      if (k === 'bytes' || k === 'image' || k === 'images' || k === 'audio' || k === 'phone') continue;
      out[k] = clean(x, k, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * One agent's trace.
 * @param {{file?: string, agent: string, keep?: number, text?: boolean, now?: () => number, secret?: Uint8Array | string}} o
 *   file: its own SQLite file (default in memory); text: keep people's words (HB_TRACE_TEXT=1);
 *   secret: the key for conversation ids (stable across restarts when given)
 */
export function openTrace(o) {
  const db = new DatabaseSync(o.file ?? ':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS trace (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, at_ms INTEGER NOT NULL, agent TEXT NOT NULL, order_id TEXT, ref TEXT,
    convo TEXT, handling TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, detail_json TEXT NOT NULL, ms INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS trace_order ON trace (order_id, id)');
  const keep = o.keep ?? KEEP;
  const now = o.now ?? Date.now;
  const secret = o.secret ?? randomBytes(32);
  const q = {
    insert: db.prepare('INSERT INTO trace (at, at_ms, agent, order_id, ref, convo, handling, kind, title, detail_json, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    trim: db.prepare('DELETE FROM trace WHERE id <= ?'),
    attachHandling: db.prepare('UPDATE trace SET order_id = ? WHERE handling = ? AND order_id IS NULL'),
    // The person's previous message, when the model understood it into a step that waits for them
    // (a read-back): the "हाँ" that creates the order answers that message.
    previous: db.prepare(`SELECT handling FROM trace WHERE convo = ? AND handling != ? AND kind = 'received' AND at_ms >= ? ORDER BY id DESC LIMIT 1`),
    understood: db.prepare(`SELECT 1 FROM trace WHERE handling = ? AND kind = 'model' AND order_id IS NULL LIMIT 1`),
    tagRef: db.prepare('UPDATE trace SET ref = ? WHERE handling = ? AND order_id IS NULL'),
    since: db.prepare('SELECT * FROM trace WHERE at >= ? ORDER BY id'),
  };

  /** The context of the handling now running, when it belongs to this agent. @returns {TraceContext | null} */
  const mine = () => {
    const c = /** @type {TraceContext | undefined} */ (als.getStore());
    return c && c.rec === rec ? c : null;
  };

  const rec = {
    agent: o.agent,
    text: !!o.text,
    /** A person's conversation id: a keyed hash, never the phone. @param {{agent: string, line: string, phone: string}} p */
    convoOf(p) {
      return `c-${createHmac('sha256', secret).update(`${p.agent}|${p.line}|${p.phone}`).digest('hex').slice(0, 10)}`;
    },
    /** Milliseconds since the handling now running began, or null outside one. */
    sinceStart() {
      const c = mine();
      return c ? Math.round(performance.now() - c.startMs) : null;
    },
    /** A person's words, only when kept, with long digit runs masked. @param {string | null | undefined} s */
    words(s) {
      return rec.text && typeof s === 'string' ? maskDigits(s.slice(0, MAX_STRING)) : null;
    },
    /**
     * Records one entry. Never throws.
     * @param {Kind} kind @param {string} title @param {Record<string, any>} [detail]
     * @param {{orderId?: string | null, ref?: string | null, ms?: number | null, convo?: string | null}} [at]
     */
    add(kind, title, detail = {}, at = {}) {
      try {
        const c = mine();
        const orderId = at.orderId ?? c?.orderId ?? null;
        const t = now();
        const r = q.insert.run(new Date(t).toISOString(), t, o.agent, orderId, at.ref ?? (orderId === null ? c?.ref ?? null : null), at.convo ?? c?.convo ?? null, c?.handling ?? null,
          kind, maskDigits(String(title)).slice(0, 200), JSON.stringify(clean(detail)), Number.isFinite(at.ms) ? Math.round(/** @type {number} */ (at.ms)) : null);
        const id = Number(r.lastInsertRowid);
        if (id > keep) q.trim.run(id - keep);
      } catch { /* A trace never breaks the agent. */ }
    },
    /**
     * An order is known for the handling now running: its earlier entries get it, and so do this
     * person's entries from before the order existed (the request and its read-back).
     * @param {string} orderId @param {{created?: boolean}} [o2]
     */
    attach(orderId, o2 = {}) {
      try {
        const c = mine();
        if (!c) return;
        c.orderId = orderId;
        q.attachHandling.run(orderId, c.handling);
        if (o2.created && c.convo) {
          const prev = /** @type {{handling: string} | undefined} */ (q.previous.get(c.convo, c.handling, now() - ATTACH_WINDOW_MS));
          if (prev && q.understood.get(prev.handling)) q.attachHandling.run(orderId, prev.handling);
        }
      } catch { /* dropped */ }
    },
    /**
     * A step held under a reference before its order exists (an approval): the handling's entries
     * without an order carry the reference, and join the order once the reference is bound.
     * @param {string} ref
     */
    tagRef(ref) {
      try {
        const c = mine();
        if (!c) return;
        c.ref = ref;
        q.tagRef.run(ref, c.handling);
      } catch { /* dropped */ }
    },
    /**
     * Entries in order, optionally since an instant and for one order (by id, or by the reference an
     * entry was held under).
     * @param {{since?: string, orderId?: string, ref?: string}} [f]
     * @returns {TraceEntry[]}
     */
    list(f = {}) {
      const rows = /** @type {any[]} */ (q.since.all(f.since ?? ''));
      return rows.filter((r) => f.orderId === undefined || r.order_id === f.orderId || (r.order_id === null && f.ref !== undefined && r.ref === f.ref)).map((r) => ({
        id: r.id, at: r.at, agent: r.agent, orderId: r.order_id ?? null, ref: r.ref ?? null, convo: r.convo ?? null,
        kind: r.kind, title: r.title, detail: JSON.parse(r.detail_json), ms: r.ms ?? null,
      }));
    },
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
  return rec;
}

let handlings = 0;

/**
 * Runs fn as one handling of this agent; whatever it records carries the conversation and order.
 * @template T
 * @param {Recorder | undefined} rec
 * @param {{convo?: string | null, role?: string | null, text?: string | null, orderId?: string | null}} c
 * @param {() => T} fn
 * @returns {T}
 */
export function withTrace(rec, c, fn) {
  if (!rec) return fn();
  handlings += 1;
  /** @type {TraceContext} */
  const ctx = { rec, convo: c.convo ?? null, handling: `h${Date.now().toString(36)}${handlings}`, role: c.role ?? null, text: c.text ?? null,
    startMs: performance.now(), orderId: c.orderId ?? null };
  return als.run(ctx, fn);
}

/** The handling now running, if any. @returns {TraceContext | null} */
export function currentTrace() {
  return /** @type {TraceContext | undefined} */ (als.getStore()) ?? null;
}

/**
 * A named code check with its figures, recorded on the trace of the handling now running. Called at
 * the place the check is made; it only records, never changes the outcome, and never throws.
 * @param {string} title e.g. "meter end above start"
 * @param {boolean} pass
 * @param {Record<string, any>} [figures]
 * @param {string | null} [orderId]
 */
export function traceCheck(title, pass, figures = {}, orderId = null) {
  try {
    const c = currentTrace();
    if (c) c.rec.add('check', title, { pass, ...figures }, orderId ? { orderId } : {});
  } catch { /* dropped */ }
}
