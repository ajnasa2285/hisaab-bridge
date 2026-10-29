// "Inside the agent" on the judge page: how one agent's trace entries (src/trace/, served at
// /agents/<name>/trace) read as a timeline. Pure functions only (no DOM), so they are tested in node
// (test/web/trace-view.test.js); judge.js turns the rows into elements.

/** @typedef {typeof import('./texts.js').TEXTS['hi']} Texts */
/**
 * @typedef {{id: number, at: string, agent: string, orderId: string|null, ref: string|null, convo: string|null,
 *   kind: string, title: string, detail: Record<string, any>, ms: number|null}} TraceEntry
 */
/**
 * One timeline row: an icon, the kind's label, the entry's own title, a line of figures, whether it
 * is Meta's model at work, a ✓/✗/⏸ state, and the ledger row it points to (by sequence number).
 * @typedef {{id: number, icon: string, cls: string, label: string, text: string, extra: string, meta: boolean,
 *   mark: '' | 'ok' | 'bad' | 'held', seq: number | null, at: string}} TraceRow
 */

export const ICONS = /** @type {Record<string, string>} */ ({
  received: '📩', model: '✨', check: '🔎', decision: '🙋', signed_out: '📤', signed_in: '📥', ledger: '📒', reply: '💬',
});

/** "812 ms", "2.1 s". @param {number | null | undefined} ms */
export function duration(ms) {
  if (!Number.isFinite(ms) || /** @type {number} */ (ms) < 0) return '';
  const v = /** @type {number} */ (ms);
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

/** The entries of one order, oldest first. @param {TraceEntry[] | undefined} entries @param {string} orderId */
export function orderTrace(entries, orderId) {
  return (entries ?? []).filter((e) => e && e.orderId === orderId).sort((a, b) => a.id - b.id);
}

/**
 * The ledger row an entry points to: a written row by its sequence number; a signed message by its
 * message id among this side's events of the order.
 * @param {TraceEntry} e @param {{seq: number, msgId: string|null}[]} events
 * @returns {number | null}
 */
export function seqOf(e, events) {
  if (e.kind === 'ledger' && Number.isSafeInteger(e.detail?.seq)) return e.detail.seq;
  const msg = e.detail?.msg;
  if ((e.kind === 'signed_out' || e.kind === 'signed_in') && typeof msg === 'string' && msg.length >= 6) {
    return events.find((x) => typeof x.msgId === 'string' && x.msgId.startsWith(msg))?.seq ?? null;
  }
  return null;
}

/**
 * One entry as a timeline row.
 * @param {TraceEntry} e @param {Texts} t @param {{seq: number, msgId: string|null}[]} [events]
 * @returns {TraceRow}
 */
export function traceRow(e, t, events = []) {
  const d = e.detail ?? {};
  const label = t.trace_kinds[/** @type {keyof Texts['trace_kinds']} */ (e.kind)] ?? e.kind;
  /** @type {TraceRow['mark']} */
  let mark = '';
  const extra = [];
  let meta = false;
  if (e.kind === 'model') {
    meta = true;
    const job = t.trace_jobs[/** @type {keyof Texts['trace_jobs']} */ (d.job)] ?? d.job;
    extra.push(`${t.meta_model}: ${d.model ?? 'Muse'}`, job);
    if (d.reasoningEffort && d.reasoningEffort !== 'default') extra.push(`effort ${d.reasoningEffort}`);
    if (d.vision) extra.push('vision');
    mark = d.ok === false ? 'bad' : '';
  } else if (e.kind === 'check') {
    mark = d.name === 'approval' && d.held ? 'held' : d.pass ? 'ok' : 'bad';
  } else if (e.kind === 'decision') {
    extra.push(d.onBehalfOf ? `${d.role} (${d.onBehalfOf})` : String(d.role ?? ''));
  } else if (e.kind === 'signed_out') {
    mark = d.verified ? 'ok' : 'bad';
    extra.push(`${d.type ?? ''} → ${d.to ?? ''}`, d.receipt ? `receipt ${d.receipt}` : '');
  } else if (e.kind === 'signed_in') {
    mark = d.verified ? 'ok' : 'bad';
    extra.push(`${d.type ?? ''} ← ${d.from ?? ''}`, d.msg ? `msg ${d.msg}` : '');
  } else if (e.kind === 'ledger') {
    extra.push(`#${d.seq}`, `hash ${d.hash ?? ''}`, `prev ${d.prev ?? ''}`);
  } else if (e.kind === 'received') {
    if (typeof d.text === 'string' && d.text) extra.push(`“${d.text}”`);
  } else if (e.kind === 'reply') {
    extra.push(String(d.key ?? ''));
  }
  const ms = duration(e.ms);
  if (ms) extra.push(ms);
  return {
    id: e.id, icon: mark === 'held' ? '⏸' : ICONS[e.kind] ?? '•', cls: `tr ${e.kind}${meta ? ' muse' : ''}${mark ? ` ${mark}` : ''}`,
    label, text: e.title, extra: extra.filter(Boolean).join(' · '), meta, mark, seq: seqOf(e, events), at: e.at,
  };
}

/**
 * The per-order summary: Muse calls, total model time, checks passed of all, people's decisions.
 * @param {TraceEntry[]} entries
 */
export function traceSummary(entries) {
  const models = entries.filter((e) => e.kind === 'model');
  const checks = entries.filter((e) => e.kind === 'check');
  return {
    muse: models.length,
    modelMs: models.reduce((s, e) => s + (Number.isFinite(e.ms) ? /** @type {number} */ (e.ms) : 0), 0),
    checks: checks.length,
    passed: checks.filter((e) => e.detail?.pass || (e.detail?.name === 'approval' && e.detail?.held)).length,
    decisions: entries.filter((e) => e.kind === 'decision').length,
  };
}

/** The summary as one line in the page's language. @param {ReturnType<typeof traceSummary>} s @param {Texts} t */
export function summaryText(s, t) {
  return t.inside_summary.replace('{muse}', String(s.muse)).replace('{ms}', duration(s.modelMs) || '0 ms')
    .replace('{pass}', String(s.passed)).replace('{checks}', String(s.checks)).replace('{decisions}', String(s.decisions));
}

/** Is this a trace list the page can show? @param {unknown} x @returns {x is TraceEntry[]} */
export function isTrace(x) {
  return Array.isArray(x) && x.every((e) => !!e && typeof e === 'object' && Number.isSafeInteger(e.id) && typeof e.kind === 'string' && typeof e.title === 'string');
}
