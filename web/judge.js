// The judge page: reads a JSON export of both ledgers (web/README.md), shows one order from request
// to settled on both sides, and verifies every signature here in the browser with WebCrypto Ed25519
// over RFC 8785 canonical JSON, the same bytes src/protocol/canonical.js signs. Plain JS, no build.

import { TEXTS } from './texts.js';

/** @typedef {'hi'|'en'} Lang */
/** @typedef {typeof TEXTS['hi']} Texts */
/**
 * @typedef {{seq: number, orderId: string, direction: 'in'|'out'|'local', type: string, msgId: string|null,
 *   body: any, at: string, prevHash: string, hash: string}} Ev
 */
/** @typedef {{agentId: string, publicKey: string, orders: any[], events: Ev[], chain: {ok: boolean, events?: number, brokenAt?: number}}} LedgerExport */
/** @typedef {{v: string, exportedAt: string, jcb: LedgerExport, contractor: LedgerExport}} Export */

const GENESIS = '0'.repeat(64);
const STORAGE_LANG = 'hb-judge-lang';

/** @type {Lang} */
let lang = 'hi';
try {
  const saved = localStorage.getItem(STORAGE_LANG);
  if (saved === 'en' || saved === 'hi') lang = saved;
} catch { /* storage may be unavailable */ }

/** @type {Export|null} */
let current = null;

/** @returns {Texts} */
const T = () => TEXTS[lang];

// --- Canonical JSON (RFC 8785), the same rules as src/protocol/canonical.js ------------------

/** @param {unknown} value @returns {string} */
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalize: numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalize: ${typeof value} is not JSON`);
}

/** @param {string} b64 @returns {Uint8Array} */
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes @returns {Promise<string>} hex sha256 */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies one signed message with the sender's public key text ("ed25519:<base64>").
 * @param {Record<string, unknown>} message with `sig`
 * @param {string} publicKeyText
 * @returns {Promise<'ok'|'bad'|'unsupported'>}
 */
async function verifySignature(message, publicKeyText) {
  const { sig, ...unsigned } = message;
  if (typeof sig !== 'string' || !sig.startsWith('ed25519:') || !publicKeyText.startsWith('ed25519:')) return 'bad';
  let key;
  try {
    key = await crypto.subtle.importKey('raw', /** @type {BufferSource} */ (fromBase64(publicKeyText.slice(8))), { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return 'unsupported';
  }
  try {
    const data = new TextEncoder().encode(canonicalize(unsigned));
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, /** @type {BufferSource} */ (fromBase64(sig.slice(8))), /** @type {BufferSource} */ (data));
    return ok ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

/**
 * Recomputes a ledger's hash chain the way src/ledger/store.js builds it.
 * @param {Ev[]} events
 * @returns {Promise<{ok: true, events: number} | {ok: false, brokenAt: number}>}
 */
async function checkChain(events) {
  let prev = GENESIS;
  for (const e of events) {
    const content = canonicalize({ seq: e.seq, order_id: e.orderId, direction: e.direction, type: e.type, msg_id: e.msgId, body: e.body, at: e.at });
    const hash = await sha256Hex(new TextEncoder().encode(prev + content));
    if (e.prevHash !== prev || hash !== e.hash) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, events: events.length };
}

// --- Formatting (integers only, as in src/i18n/format.js) -----------------------------------

/** @param {number} n */
function groupIndian(n) {
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
}
/** @param {unknown} paise */
function rupees(paise) {
  if (!Number.isSafeInteger(paise)) return '—';
  const p = /** @type {number} */ (paise);
  const abs = Math.abs(p);
  const frac = abs % 100;
  return `${p < 0 ? '-' : ''}₹${groupIndian(Math.trunc(abs / 100))}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}
/** @param {unknown} t */
function tenths(t) {
  if (!Number.isSafeInteger(t)) return '—';
  const n = /** @type {number} */ (t);
  return `${Math.trunc(n / 10)}.${Math.abs(n) % 10}`;
}
/** @param {unknown} s @param {number} [head] */
function short(s, head = 10) {
  if (typeof s !== 'string') return '—';
  return s.length <= head + 6 ? s : `${s.slice(0, head)}…${s.slice(-4)}`;
}
/** @param {string} iso */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} IST`;
}

// --- Order state, replayed from the events (same rules as src/ledger/states.js) -------------

/** @param {Ev[]} events */
function stateOf(events) {
  const refused = new Set(events.filter((e) => e.direction === 'in' && e.type === 'REFUSE').map((e) => e.body.body.refers_to));
  let state = 'none';
  let kind = null;
  let currentBill = null;
  for (const e of events) {
    if (e.direction === 'out' && refused.has(e.msgId)) continue;
    const b = e.direction === 'local' ? e.body : e.body.body ?? {};
    switch (e.type) {
      case 'BOOKING_REQUEST': state = 'requested'; kind = b.kind; break;
      case 'BOOKING_REPLY': state = b.answer === 'yes' ? 'booked' : b.answer === 'no' ? 'declined' : 'offered'; break;
      case 'EVIDENCE': if (state === 'booked' && kind === 'jcb_hours') state = 'working'; break;
      case 'DELIVERY': state = 'delivered'; break;
      case 'BILL': case 'CORRECTION': state = 'billed'; currentBill = e.msgId; break;
      case 'ACCEPT': state = 'accepted'; break;
      case 'DISPUTE': state = 'disputed'; break;
      case 'PAYMENT_CLAIM': state = 'payment_claimed'; break;
      case 'SETTLED': state = 'settled'; break;
      default: break;
    }
  }
  return { state, currentBill };
}

// --- Rendering --------------------------------------------------------------------------------

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {HTMLElement} grid @param {string} k @param {string} v @param {boolean} [mono] */
function row(grid, k, v, mono = false) {
  grid.append(el('span', 'k', k), el('span', mono ? 'v mono' : 'v', v));
}

/**
 * The lines of one event's body, per type.
 * @param {Ev} e
 * @param {Texts} t
 * @returns {HTMLElement}
 */
function bodyOf(e, t) {
  const grid = el('div', 'body');
  const b = e.direction === 'local' ? e.body : e.body.body ?? {};
  switch (e.type) {
    case 'BOOKING_REQUEST':
      row(grid, t.site, String(b.site ?? '—'));
      row(grid, t.day, String(b.day ?? '—'));
      if (b.time) row(grid, t.time, String(b.time));
      if (b.hoursTenths !== undefined) row(grid, t.hours, tenths(b.hoursTenths));
      break;
    case 'BOOKING_REPLY':
      row(grid, t.answer, b.answer === 'yes' ? t.yes : b.answer === 'no' ? t.no : t.other_time);
      if (b.day) row(grid, t.day, String(b.day));
      if (b.ratePaise !== undefined) row(grid, t.rate, `${rupees(b.ratePaise)} / ${t.hours}`);
      break;
    case 'EVIDENCE':
      row(grid, t.meter, `${b.which === 'start' ? t.start : b.which === 'end' ? t.end : '—'} ${tenths(b.valueTenths)}`);
      row(grid, t.photo, short(b.sha256, 12), true);
      if (b.takenAt) row(grid, t.taken, when(b.takenAt));
      break;
    case 'BILL':
    case 'CORRECTION': {
      const lines = Array.isArray(b.lines) ? b.lines : [];
      row(grid, t.lines, lines.map((/** @type {any} */ l) => `${l.what}: ${l.hoursTenths !== undefined ? `${tenths(l.hoursTenths)} ${t.hours}` : tenths(l.qtyHundredths)} × ${rupees(l.ratePaise)} = ${rupees(l.amountPaise)}`).join('\n'));
      row(grid, t.total, rupees(b.totalPaise));
      const ev = Array.isArray(b.evidence) ? b.evidence : [];
      row(grid, t.evidence, ev.map((/** @type {any} */ x) => `${x.kind === 'meter' ? t.meter : x.kind} ${x.readValue ?? '—'} — ${short(x.sha256, 12)}`).join('\n'), true);
      if (b.replaces) row(grid, t.replaces, short(b.replaces, 8), true);
      break;
    }
    case 'RECEIPT':
      row(grid, t.receipt_for, short(b.receipt_for, 8), true);
      row(grid, t.entry_hash, short(b.entry_hash, 12), true);
      row(grid, t.chain_head, short(b.chain_head, 12), true);
      break;
    case 'ACCEPT':
      row(grid, t.bill, short(b.bill, 8), true);
      break;
    case 'DISPUTE': {
      const f = b.theirFigure ?? {};
      const figure = f.hoursTenths !== undefined ? `${tenths(f.hoursTenths)} ${t.hours}` : f.totalPaise !== undefined ? rupees(f.totalPaise) : f.qtyHundredths !== undefined ? tenths(f.qtyHundredths) : '—';
      row(grid, t.bill, short(b.bill, 8), true);
      row(grid, t.their, figure);
      row(grid, t.reason, String(b.reason ?? '—'));
      break;
    }
    case 'PAYMENT_CLAIM':
      row(grid, t.bill, short(b.bill, 8), true);
      row(grid, t.amount, rupees(b.amountPaise));
      row(grid, t.utr, String(b.utr ?? '—'), true);
      row(grid, t.paid_on, String(b.paidOn ?? '—'));
      row(grid, t.screenshot, short(b.screenshot?.sha256, 12), true);
      break;
    case 'SETTLED':
      row(grid, t.bill, short(b.bill, 8), true);
      row(grid, t.payment, short(b.payment, 8), true);
      row(grid, t.amount, rupees(b.amountPaise));
      break;
    case 'REFUSE':
      row(grid, t.msg_id, short(b.refers_to, 8), true);
      row(grid, t.code, String(b.code ?? '—'));
      break;
    default:
      row(grid, '', JSON.stringify(b), true);
  }
  return grid;
}

/**
 * @param {Ev} e
 * @param {Texts} t
 * @param {Set<string>} replaced msg ids of bills a correction replaced
 */
function eventCard(e, t, replaced) {
  const li = el('li', `ev ${e.direction}`);
  const isReplaced = e.msgId !== null && replaced.has(e.msgId);
  if (isReplaced) li.classList.add('replaced');
  const head = el('div', 'head');
  head.append(el('span', 'seq', `#${e.seq}`));
  head.append(el('span', 'type', t.types[/** @type {keyof Texts['types']} */ (e.type)] ?? e.type));
  head.append(el('span', 'dir', e.direction === 'in' ? t.dir_in : e.direction === 'out' ? t.dir_out : t.dir_local));
  if (e.direction !== 'local') {
    const badge = el('span', 'badge', t.sig_checking);
    badge.dataset.msg = e.msgId ?? '';
    head.append(badge);
  }
  head.append(el('span', 'when', when(e.at)));
  li.append(head);
  if (isReplaced) li.append(el('div', 'note', t.replaced));
  li.append(bodyOf(e, t));
  const foot = el('div', 'foot');
  const parts = [];
  if (e.direction !== 'local') parts.push(`${t.from} ${e.body.from} → ${e.body.to}`, `${t.msg_id} ${short(e.msgId, 8)}`);
  parts.push(`${t.hash} ${short(e.hash, 12)}`, `${t.prev} ${short(e.prevHash, 12)}`);
  foot.textContent = parts.join('  ·  ');
  li.append(foot);
  return li;
}

/**
 * @param {HTMLElement} section
 * @param {LedgerExport} side
 * @param {Texts} t
 * @param {{ok: boolean, brokenAt?: number}} chain
 */
function renderLedger(section, side, t, chain) {
  const meta = /** @type {HTMLElement} */ (section.querySelector('.meta'));
  meta.replaceChildren();
  /** @param {string} k @param {string} v @param {boolean} [bad] */
  const add = (k, v, bad = false) => {
    meta.append(el('dt', undefined, k));
    const dd = el('dd', bad ? 'bad' : undefined, v);
    if (bad) dd.style.color = 'var(--bad)';
    meta.append(dd);
  };
  add(t.agent, side.agentId);
  add(t.key, short(side.publicKey, 16));
  const signed = side.events.filter((e) => e.direction !== 'local').length;
  add(t.events, `${side.events.length} (${t.signed}: ${signed})`);
  add(t.chain, chain.ok ? t.chain_ok : t.chain_broken.replace('{n}', String(chain.brokenAt)), !chain.ok);
  const { state } = stateOf(side.events);
  add(t.state, t.states[/** @type {keyof Texts['states']} */ (state)] ?? state);

  const replaced = new Set(side.events.filter((e) => e.type === 'CORRECTION').map((e) => String(e.body.body?.replaces)));
  const list = /** @type {HTMLElement} */ (section.querySelector('.events'));
  list.replaceChildren(...side.events.map((e) => eventCard(e, t, replaced)));
}

/**
 * Fills the badge of every signed message from the verification map, verifying what is new.
 * @param {Export} x
 */
async function verifyAll(x) {
  const keys = new Map([[x.jcb.agentId, x.jcb.publicKey], [x.contractor.agentId, x.contractor.publicKey]]);
  for (const [side, sectionId] of /** @type {const} */ ([[x.jcb, 'ledger-jcb'], [x.contractor, 'ledger-contractor']])) {
    // The same message id sits in both ledgers; each side's badge shows that side's own check.
    const section = /** @type {HTMLElement} */ (document.getElementById(sectionId));
    for (const e of side.events) {
      if (e.direction === 'local' || e.msgId === null) continue;
      // Verified afresh on every render: the page must never trust a result it computed earlier
      // for a message whose bytes may have changed (another export loaded, a tampered copy).
      const key = keys.get(e.body.from);
      const result = key ? await verifySignature(e.body, key) : 'bad';
      for (const badge of section.querySelectorAll(`.badge[data-msg="${e.msgId}"]`)) {
        const b = /** @type {HTMLElement} */ (badge);
        const t = T();
        b.textContent = result === 'ok' ? t.sig_ok : result === 'bad' ? t.sig_bad : t.sig_unsupported;
        b.classList.toggle('bad', result !== 'ok');
      }
    }
  }
}

/** @param {Export} x */
async function render(x) {
  const t = T();
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-t]')) {
    const key = /** @type {keyof Texts} */ (/** @type {HTMLElement} */ (n).dataset.t);
    const v = t[key];
    if (typeof v === 'string') n.textContent = v;
  }
  /** @type {HTMLElement} */ (document.getElementById('lang')).textContent = t.toggle;

  const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
  const order = x.contractor.orders[0] ?? x.jcb.orders[0];
  const req = x.contractor.events.find((e) => e.type === 'BOOKING_REQUEST');
  const b = req?.body?.body ?? {};
  /** @type {HTMLElement} */ (document.getElementById('order')).textContent = order ? `${order.site} · ${b.day ?? '—'} · ${short(order.order_id, 8)}` : '—';
  /** @type {HTMLElement} */ (document.getElementById('exported')).textContent = x.exportedAt ? when(x.exportedAt) : '—';
  summary.hidden = false;

  const [jcbChain, siteChain] = await Promise.all([checkChain(x.jcb.events), checkChain(x.contractor.events)]);
  renderLedger(/** @type {HTMLElement} */ (document.getElementById('ledger-jcb')), x.jcb, t, jcbChain);
  renderLedger(/** @type {HTMLElement} */ (document.getElementById('ledger-contractor')), x.contractor, t, siteChain);
  await verifyAll(x);
}

// --- Results panel: eval/results/*.json when the server lists them, else "—" -----------------

/** @param {unknown} r a {numerator, denominator, basisPoints} ratio */
function ratio(r) {
  const x = /** @type {any} */ (r);
  if (!x || !Number.isSafeInteger(x.numerator) || !Number.isSafeInteger(x.denominator)) return '—';
  const pct = Number.isSafeInteger(x.basisPoints) ? ` (${Math.trunc(x.basisPoints / 100)}.${String(x.basisPoints % 100).padStart(2, '0')}%)` : '';
  return `${x.numerator} / ${x.denominator}${pct}`;
}
/** @param {unknown} v */
const count = (v) => (Number.isSafeInteger(v) ? String(v) : '—');

/**
 * The rows of one results file, in the shape Astra's eval writes (aggregate numbers only).
 * Fields the page does not know are listed after, as they are.
 * @param {Record<string, any>} d
 * @param {Texts} t
 * @returns {[string, string][]}
 */
function resultRows(d, t) {
  const r = t.result;
  /** @type {[string, string][]} */
  const rows = [
    [r.planned, `${count(d.evaluated)} / ${count(d.planned)}`],
    [r.labeled, `${count(d.labeled)} (${r.unlabeled} ${count(d.unlabeled)})`],
    [r.confident, count(d.confident)],
    [r.unclear, ratio(d.unclearRate)],
    [r.not_meter, count(d.notMeter)],
    [r.failures, ratio(d.failureRate)],
    [r.exact, ratio(d.exactAccuracy)],
    [r.value, ratio(d.valueAccuracy)],
    [r.classification, ratio(d.classificationAccuracy)],
    [r.dash_clock, ratio(d.dashClockAccuracy)],
    [r.wrong_confident, d.wrongButConfidentCount === null || d.wrongButConfidentCount === undefined ? `— (${r.assessed} ${count(d.assessedConfident)}, ${r.unassessed} ${count(d.unassessedConfident)})` : count(d.wrongButConfidentCount)],
    [r.latency, d.latencyMs ? `p50 ${count(d.latencyMs.p50)} ms · p95 ${count(d.latencyMs.p95)} ms · n ${count(d.latencyMs.count)}` : '—'],
    [r.tokens, d.cost ? `${count(d.cost.inputTokens)} ${r.in} · ${count(d.cost.outputTokens)} ${r.out}` : '—'],
    [r.cost, d.cost && Number.isSafeInteger(d.cost.knownCostNanoUsd) ? `$${(d.cost.knownCostNanoUsd / 1e9).toFixed(4)}${d.cost.costIsComplete ? '' : ' +?'} (${d.cost.pricingDate ?? '—'})` : '—'],
    [r.split, `${d.splitFrozen ? t.yes : t.no} · ${r.prompts_changed} ${d.promptsChangedSinceHeldout ? t.yes : t.no} · ${r.rescored} ${d.rescored ? t.yes : t.no}`],
  ];
  const known = new Set(['reader', 'dateIST', 'partition', 'model', 'status', 'splitFrozen', 'promptsChangedSinceHeldout', 'rescored', 'planned', 'notRun', 'evaluated', 'labeled', 'unlabeled', 'failures', 'confident', 'unclear', 'notMeter', 'exactAccuracy', 'valueAccuracy', 'classificationAccuracy', 'dashClockAccuracy', 'wrongButConfidentCount', 'assessedConfident', 'unassessedConfident', 'unclearRate', 'failureRate', 'latencyMs', 'cost']);
  for (const [k, v] of Object.entries(d)) if (!known.has(k)) rows.push([k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)]);
  return rows;
}

async function renderResults() {
  const t = T();
  const host = /** @type {HTMLElement} */ (document.getElementById('results-body'));
  try {
    const list = await fetch('../eval/results/').then((r) => (r.ok ? r.json() : null));
    if (!Array.isArray(list) || list.length === 0) throw new Error('none');
    host.replaceChildren();
    for (const name of list.filter((n) => typeof n === 'string' && n.endsWith('.json'))) {
      const data = await fetch(`../eval/results/${name}`).then((r) => (r.ok ? r.json() : null));
      if (!data || typeof data !== 'object') continue;
      host.append(el('h3', undefined, `${data.reader ?? name} · ${data.dateIST ?? '—'} · ${data.partition ?? '—'} · ${data.model ?? '—'} · ${data.status ?? '—'}`));
      const table = el('table');
      for (const [label, value] of resultRows(data, t)) {
        const tr = el('tr');
        tr.append(el('th', undefined, label), el('td', undefined, value));
        table.append(tr);
      }
      host.append(table);
    }
    if (host.childElementCount === 0) host.textContent = t.results_none;
  } catch {
    host.textContent = t.results_none;
  }
}

// --- Wiring -----------------------------------------------------------------------------------

/** @param {string} text */
function notice(text) {
  const n = /** @type {HTMLElement} */ (document.getElementById('notice'));
  n.textContent = text;
  n.hidden = text === '';
}

/** @param {unknown} x @returns {x is Export} */
const isExport = (x) => !!x && typeof x === 'object' && 'jcb' in x && 'contractor' in x;

async function loadDefault() {
  try {
    const x = await fetch('sample/export.json').then((r) => (r.ok ? r.json() : null));
    if (!isExport(x)) throw new Error('shape');
    current = x;
    notice('');
    await render(x);
  } catch {
    notice(T().no_export);
  }
}

/** @type {HTMLButtonElement} */ (document.getElementById('lang')).addEventListener('click', () => {
  lang = lang === 'hi' ? 'en' : 'hi';
  try { localStorage.setItem(STORAGE_LANG, lang); } catch { /* ignore */ }
  if (current) void render(current); else notice(T().no_export);
  void renderResults();
});

/** @type {HTMLInputElement} */ (document.getElementById('file')).addEventListener('change', async (ev) => {
  const file = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
  if (!file) return;
  try {
    const x = JSON.parse(await file.text());
    if (!isExport(x)) throw new Error('shape');
    current = x;
    notice('');
    await render(x);
  } catch {
    notice(T().no_export);
  }
});

await loadDefault();
await renderResults();
