// The judge page: reads a JSON export of the ledgers (web/README.md), shows every order from
// request to settled with the contractor's ledger beside the counterparty's (JCB for J orders,
// supplier for P orders), and verifies every signature here in the browser with WebCrypto Ed25519
// over RFC 8785 canonical JSON, the same bytes src/protocol/canonical.js signs. Plain JS, no build.
//
// Sources: the bundled sample (default), a file from disk, or the live ledgers of the server the
// page is served from (`../agents/<name>/export` with the access key as a Bearer header). The key
// lives in sessionStorage only: never in the address, never in localStorage.
//
// Inside the agent: under each side's column, that agent's own trace for the order (every Muse call,
// every code check, every decision, each signed message linked to its ledger row), from the export's
// `trace` or live from `../agents/<name>/trace`; "live" polls every 3 s while a key is entered.

import { TEXTS } from './texts.js';
import { isTrace, orderTrace, summaryText, traceRow, traceSummary } from './trace-view.js';
import { paymentPanel } from './payments-view.js';
import { stateOf } from './order-state.js';
import { usualPanels } from './usual-view.js';

/** @typedef {'hi'|'en'} Lang */
/** @typedef {typeof TEXTS['hi']} Texts */
/**
 * @typedef {{seq: number, orderId: string, direction: 'in'|'out'|'local', type: string, msgId: string|null,
 *   body: any, at: string, prevHash: string, hash: string}} Ev
 */
/** @typedef {{order_id: string, kind: string, counterparty: string, site: string, created_at: string}} Order */
/** @typedef {import('./trace-view.js').TraceEntry} TraceEntry */
/** @typedef {{agentId: string, publicKey: string, orders: Order[], events: Ev[], chain: {ok: boolean, events?: number, brokenAt?: number}, refs?: Record<string, string>, trace?: TraceEntry[]}} LedgerExport */
/** @typedef {'jcb'|'contractor'|'supplier'} SideName */
/** @typedef {{v: string, exportedAt: string, jcb?: LedgerExport|null, contractor?: LedgerExport|null, supplier?: LedgerExport|null}} Export */
/** @typedef {{kind: 'sample'|'file'|'live', missing: SideName[]}} Source */

const GENESIS = '0'.repeat(64);
const STORAGE_LANG = 'hb-judge-lang';
const SESSION_KEY = 'hb-judge-key';
/** The server's agent names per side (src/app.js). @type {Record<SideName, string>} */
const AGENT_PATH = { jcb: 'jcb', contractor: 'site', supplier: 'supplier' };
/** @type {SideName[]} */
const SIDES = ['jcb', 'contractor', 'supplier'];
const LIVE_MS = 3000;

/** @type {Lang} */
let lang = 'hi';
try {
  const saved = localStorage.getItem(STORAGE_LANG);
  if (saved === 'en' || saved === 'hi') lang = saved;
} catch { /* storage may be unavailable */ }

/** @type {Export|null} */
let current = null;
/** @type {Source} */
let source = { kind: 'sample', missing: [] };

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
/** A quantity in hundredths: 5000 → "50", 250 → "2.5", 1234 → "12.34". @param {unknown} h */
function hundredths(h) {
  if (!Number.isSafeInteger(h)) return '—';
  const n = /** @type {number} */ (h);
  const frac = Math.abs(n) % 100;
  const whole = `${n < 0 ? '-' : ''}${Math.trunc(Math.abs(n) / 100)}`;
  if (frac === 0) return whole;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
/** @param {unknown} it an item {name, qtyHundredths, unit} */
function itemText(it) {
  const x = /** @type {any} */ (it) ?? {};
  return `${x.name ?? '—'} ${hundredths(x.qtyHundredths)} ${x.unit ?? ''}`.trim();
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

// --- Rendering --------------------------------------------------------------------------------

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {HTMLElement} grid @param {string} k @param {string} v @param {string} [cls] extra classes on the value */
function row(grid, k, v, cls = '') {
  grid.append(el('span', 'k', k), el('span', `v${cls ? ` ${cls}` : ''}`, v));
}

/** @param {HTMLElement} grid @param {Texts} t @param {any[]} lines */
function billLines(grid, t, lines) {
  row(grid, t.lines, lines.map((/** @type {any} */ l) => {
    const qty = l.hoursTenths !== undefined ? `${tenths(l.hoursTenths)} ${t.hours}` : hundredths(l.qtyHundredths);
    // A material line with GST (30 Oct): taxable value + GST at its rate = the line's amount.
    if (typeof l.gstPercent === 'number' && Number.isSafeInteger(l.taxablePaise) && Number.isSafeInteger(l.gstPaise)) {
      return `${l.what}: ${qty} × ${rupees(l.ratePaise)} = ${rupees(l.taxablePaise)} + GST ${l.gstPercent}% ${rupees(l.gstPaise)} = ${rupees(l.amountPaise)}`;
    }
    return `${l.what}: ${qty} × ${rupees(l.ratePaise)} = ${rupees(l.amountPaise)}`;
  }).join('\n'));
}

/**
 * What the page knows about the order around one event: the signed DELIVERY (to set the site's
 * count against the challan).
 * @typedef {{delivery: any|null}} OrderCtx
 */

/**
 * The lines of one event's body, per type.
 * @param {Ev} e
 * @param {Texts} t
 * @param {OrderCtx} ctx
 * @returns {HTMLElement}
 */
function bodyOf(e, t, ctx) {
  const grid = el('div', 'body');
  const b = e.direction === 'local' ? e.body ?? {} : e.body.body ?? {};
  switch (e.type) {
    case 'BOOKING_REQUEST':
      row(grid, t.kind, b.kind === 'material' ? t.kind_material : t.kind_jcb);
      row(grid, t.site, String(b.site ?? '—'));
      row(grid, t.day, String(b.day ?? '—'));
      if (b.time) row(grid, t.time, String(b.time));
      if (b.hoursTenths !== undefined) row(grid, t.hours, tenths(b.hoursTenths));
      if (Array.isArray(b.items)) row(grid, t.items, b.items.map(itemText).join('\n'));
      break;
    case 'BOOKING_REPLY':
      row(grid, t.answer, b.answer === 'yes' ? t.yes : b.answer === 'no' ? t.no : t.other_time);
      if (b.day) row(grid, t.day, String(b.day));
      if (b.time) row(grid, t.time, String(b.time));
      if (b.ratePaise !== undefined) row(grid, t.rate, `${rupees(b.ratePaise)} / ${t.hours}`);
      if (Array.isArray(b.rates)) row(grid, t.rates, b.rates.map((/** @type {any} */ r) => `${r.name}: ${rupees(r.ratePaise)} / ${r.unit}${typeof r.gstPercent === 'number' ? ` + GST ${r.gstPercent}%` : ''}`).join('\n'));
      break;
    case 'EVIDENCE':
      row(grid, t.meter, `${b.which === 'start' ? t.start : b.which === 'end' ? t.end : '—'} ${tenths(b.valueTenths)}`);
      row(grid, t.photo, short(b.sha256, 12), 'mono');
      if (b.takenAt) row(grid, t.taken, when(b.takenAt));
      break;
    case 'DELIVERY':
      row(grid, t.items, (Array.isArray(b.items) ? b.items : []).map(itemText).join('\n'));
      row(grid, t.challan_no, String(b.challan?.number ?? '—'));
      row(grid, t.challan_hash, short(b.challan?.sha256, 12), 'mono');
      if (b.deliveredAt) row(grid, t.delivered_at, when(b.deliveredAt));
      if (Number.isSafeInteger(b.grandTotalPaise)) row(grid, t.invoice_total, rupees(b.grandTotalPaise));
      break;
    case 'NOTE': {
      if (b.kind !== 'site_count') { row(grid, '', JSON.stringify(b), 'mono'); break; }
      const items = Array.isArray(b.items) ? b.items : [];
      const delivered = Array.isArray(ctx.delivery?.items) ? ctx.delivery.items : [];
      for (const it of items) {
        const match = delivered.find((/** @type {any} */ d) => d.name === it.name && d.unit === it.unit);
        if (!match) { row(grid, t.site_count, `${itemText(it)} (${t.no_delivery})`); continue; }
        const same = match.qtyHundredths === it.qtyHundredths;
        row(grid, t.site_count, `${itemText(it)} — ${t.vs_challan} ${hundredths(match.qtyHundredths)} ${it.unit ?? ''}: ${same ? t.matches : t.differs}`, same ? 'same' : 'diff');
      }
      break;
    }
    case 'BILL':
    case 'CORRECTION': {
      billLines(grid, t, Array.isArray(b.lines) ? b.lines : []);
      row(grid, t.total, rupees(b.totalPaise));
      const ev = Array.isArray(b.evidence) ? b.evidence : [];
      row(grid, t.evidence, ev.map((/** @type {any} */ x) => `${x.kind === 'meter' ? t.meter : x.kind === 'challan' ? t.challan : x.kind} ${x.readValue ?? '—'} — ${short(x.sha256, 12)}`).join('\n'), 'mono');
      if (b.replaces) row(grid, t.replaces, short(b.replaces, 8), 'mono');
      break;
    }
    case 'RECEIPT':
      row(grid, t.receipt_for, short(b.receipt_for, 8), 'mono');
      row(grid, t.entry_hash, short(b.entry_hash, 12), 'mono');
      row(grid, t.chain_head, short(b.chain_head, 12), 'mono');
      break;
    case 'ACCEPT':
      row(grid, t.bill, short(b.bill, 8), 'mono');
      break;
    case 'DISPUTE': {
      const f = b.theirFigure ?? {};
      const figure = f.hoursTenths !== undefined ? `${tenths(f.hoursTenths)} ${t.hours}` : f.totalPaise !== undefined ? rupees(f.totalPaise) : f.qtyHundredths !== undefined ? `${t.qty} ${hundredths(f.qtyHundredths)}` : '—';
      row(grid, t.bill, short(b.bill, 8), 'mono');
      row(grid, t.their, figure);
      row(grid, t.reason, String(b.reason ?? '—'));
      break;
    }
    case 'PAYMENT_CLAIM':
    case 'PAYMENT_RECEIVED':
      if (b.bill) row(grid, t.bill, short(b.bill, 8), 'mono');
      else row(grid, t.payment, t.payment_advance);
      row(grid, t.amount, rupees(b.amountPaise));
      row(grid, t.payment_method, b.method === 'cash' ? t.payment_cash : 'UPI');
      if (b.utr) row(grid, t.utr, String(b.utr), 'mono');
      if (b.paidOn || b.receivedOn) row(grid, t.paid_on, String(b.paidOn ?? b.receivedOn));
      if (b.paidAt) row(grid, t.time, String(b.paidAt));
      if (b.screenshot?.sha256) row(grid, t.photo, short(b.screenshot.sha256, 12), 'mono');
      if (b.group) row(grid, t.payment_group, rupees(b.group.totalPaise));
      break;
    case 'PAYMENT_ACK':
      row(grid, t.payment, short(b.payment, 8), 'mono');
      row(grid, t.amount, rupees(b.amountPaise));
      row(grid, t.answer, b.received === true ? t.payment_confirmed : t.payment_denied);
      break;
    case 'SETTLED':
      row(grid, t.bill, short(b.bill, 8), 'mono');
      row(grid, t.payment, Array.isArray(b.payments) ? b.payments.map((/** @type {string} */ id) => short(id, 8)).join(', ') : short(b.payment, 8), 'mono');
      row(grid, t.amount, rupees(b.amountPaise));
      break;
    case 'REFUSE':
      row(grid, t.msg_id, short(b.refers_to, 8), 'mono');
      row(grid, t.code, String(b.code ?? '—'));
      break;
    default:
      row(grid, '', JSON.stringify(b), 'mono');
  }
  return grid;
}

/** @param {Ev} e @param {Texts} t */
function typeLabel(e, t) {
  const b = e.direction === 'local' ? e.body ?? {} : e.body.body ?? {};
  const types = /** @type {Record<string, string>} */ (t.types);
  if (e.type === 'BOOKING_REQUEST' && b.kind === 'material') return types.MATERIAL_REQUEST;
  if (e.type === 'NOTE' && b.kind === 'site_count') return types.SITE_COUNT;
  return types[e.type] ?? e.type;
}

/** Badges waiting for their signature check, collected while rendering. @type {{badge: HTMLElement, message: any}[]} */
let pendingBadges = [];

/**
 * @param {Ev} e
 * @param {Texts} t
 * @param {Set<string>} replaced msg ids of bills a correction replaced
 * @param {OrderCtx} ctx
 */
function eventCard(e, t, replaced, ctx) {
  const li = el('li', `ev ${e.direction}`);
  const isReplaced = e.msgId !== null && replaced.has(e.msgId);
  if (isReplaced) li.classList.add('replaced');
  const head = el('div', 'head');
  head.append(el('span', 'seq', `#${e.seq}`));
  head.append(el('span', 'type', typeLabel(e, t)));
  head.append(el('span', 'dir', e.direction === 'in' ? t.dir_in : e.direction === 'out' ? t.dir_out : t.dir_local));
  if (e.direction !== 'local') {
    const badge = el('span', 'badge', t.sig_checking);
    head.append(badge);
    pendingBadges.push({ badge, message: e.body });
  }
  head.append(el('span', 'when', when(e.at)));
  li.append(head);
  if (isReplaced) li.append(el('div', 'note', t.replaced));
  li.append(bodyOf(e, t, ctx));
  const foot = el('div', 'foot');
  const parts = [];
  if (e.direction !== 'local') parts.push(`${t.from} ${e.body.from} → ${e.body.to}`, `${t.msg_id} ${short(e.msgId, 8)}`);
  parts.push(`${t.hash} ${short(e.hash, 12)}`, `${t.prev} ${short(e.prevHash, 12)}`);
  foot.textContent = parts.join('  ·  ');
  li.append(foot);
  return li;
}

/** @param {SideName} name @param {Texts} t */
const sideTitle = (name, t) => (name === 'jcb' ? t.ledger_jcb : name === 'supplier' ? t.ledger_supplier : t.ledger_contractor);

/**
 * One ledger's card at the top: agent, key, events, chain check over the whole ledger.
 * @param {SideName} name
 * @param {LedgerExport|null|undefined} side
 * @param {Texts} t
 * @param {{ok: boolean, brokenAt?: number}|null} chain
 */
function ledgerCard(name, side, t, chain) {
  const card = el('div', 'card');
  card.append(el('h3', undefined, sideTitle(name, t)));
  if (!side || !chain) {
    card.classList.add('missing');
    card.append(el('p', undefined, t.side_missing));
    return card;
  }
  const meta = el('dl', 'meta');
  /** @param {string} k @param {string} v @param {boolean} [bad] */
  const add = (k, v, bad = false) => {
    meta.append(el('dt', undefined, k));
    const dd = el('dd', undefined, v);
    if (bad) dd.style.color = 'var(--bad)';
    meta.append(dd);
  };
  add(t.agent, side.agentId);
  add(t.key, short(side.publicKey, 16));
  const signed = side.events.filter((e) => e.direction !== 'local').length;
  add(t.events, `${side.events.length} (${t.signed}: ${signed})`);
  add(t.orders, String(side.orders.length));
  add(t.chain, chain.ok ? t.chain_ok : t.chain_broken.replace('{n}', String(chain.brokenAt)), !chain.ok);
  card.append(meta);
  const remembered = el('section', 'usual-figures');
  remembered.append(el('h3', undefined, t.usual_title), el('p', 'hint', t.usual_note));
  const panels = usualPanels(side.events, t);
  if (!panels.length) remembered.append(el('p', 'hint', t.usual_empty));
  for (const panel of panels) {
    const party = el('section', 'usual-party');
    party.append(el('h4', undefined, panel.counterparty));
    const figures = el('ul', 'usual-list');
    for (const figure of panel.rows) {
      const item = el('li');
      item.append(el('strong', undefined, `${figure.item} · ${figure.metric}`),
        el('div', undefined, `${t.usual_median}: ${figure.median} · ${t.usual_count}: ${figure.n}`),
        el('div', 'hint', `${t.usual_range}: ${figure.min} … ${figure.max} · ${t.usual_last}: ${figure.last}`));
      figures.append(item);
    }
    party.append(figures);
    remembered.append(party);
  }
  card.append(remembered);
  return card;
}

/**
 * One side's column inside an order block: its view of this order and the events.
 * @param {SideName} name
 * @param {LedgerExport|null|undefined} side
 * @param {string} orderId
 * @param {Texts} t
 */
function orderColumn(name, side, orderId, t) {
  const section = el('section', 'ledger');
  section.append(el('h2', undefined, sideTitle(name, t)));
  if (!side) {
    section.append(el('p', 'hint', t.side_missing));
    return section;
  }
  const events = side.events.filter((e) => e.orderId === orderId);
  const meta = el('dl', 'meta');
  /** @param {string} k @param {string} v @param {boolean} [bad] */
  const add = (k, v, bad = false) => {
    meta.append(el('dt', undefined, k));
    const dd = el('dd', undefined, v);
    if (bad) dd.style.color = 'var(--bad)';
    meta.append(dd);
  };
  add(t.ref, side.refs?.[orderId] ?? '—');
  const v = stateOf(events);
  add(t.state, `${t.states[/** @type {keyof Texts['states']} */ (v.state)] ?? v.state}${v.billRev > 1 ? ` (${t.bill} rev ${v.billRev})` : ''}${v.fits ? '' : ' ❌'}`, !v.fits);
  add(t.order_chain, String(events.length));
  section.append(meta);

  const payments = paymentPanel(events, side.refs ?? {}, t);
  const panel = el('section', 'payments-panel');
  panel.append(el('h3', undefined, t.payments), el('p', 'payment-balance', payments.balance));
  if (!payments.rows.length) panel.append(el('p', 'hint', t.payment_none));
  const paidList = el('ul', 'payments');
  for (const p of payments.rows) {
    const item = el('li', `payment-row ${p.status}`);
    item.append(el('div', undefined, p.text));
    if (p.group) {
      const group = el('div', 'payment-group', `${p.group.text}: `);
      for (const member of p.group.orders) {
        const a = /** @type {HTMLAnchorElement} */ (el('a', undefined, member.ref));
        a.href = `#order-${encodeURIComponent(member.id)}`;
        group.append(a, document.createTextNode(' '));
      }
      item.append(group);
    }
    paidList.append(item);
  }
  panel.append(paidList);
  section.append(panel);

  const delivery = [...events].reverse().find((e) => e.type === 'DELIVERY');
  /** @type {OrderCtx} */
  const ctx = { delivery: delivery ? delivery.body.body : null };
  const replaced = new Set(events.filter((e) => e.type === 'CORRECTION').map((e) => String(e.body.body?.replaces)));
  const list = el('ol', 'events');
  list.append(...events.map((e) => {
    const li = eventCard(e, t, replaced, ctx);
    li.id = `ev-${name}-${e.seq}`;
    return li;
  }));
  section.append(list);
  section.append(insideAgent(name, side, orderId, events, t));
  return section;
}

/**
 * Inside the agent: this side's trace entries for the order as a timeline, with a one-line summary.
 * Muse steps are marked as Meta model work; checks carry ✓/✗; a signed message or a written row
 * links to its ledger card above.
 * @param {SideName} name @param {LedgerExport} side @param {string} orderId @param {Ev[]} events @param {Texts} t
 */
function insideAgent(name, side, orderId, events, t) {
  const box = el('section', 'inside');
  box.append(el('h3', undefined, `${t.inside_title} — ${sideTitle(name, t)}`));
  const entries = orderTrace(side.trace, orderId);
  if (entries.length === 0) {
    box.append(el('p', 'hint', t.inside_none));
    return box;
  }
  box.append(el('p', 'inside-sum', summaryText(traceSummary(entries), t)));
  const list = el('ol', 'trace-list');
  for (const e of entries) {
    const r = traceRow(e, t, events);
    const li = el('li', r.cls);
    li.append(el('span', 'tr-icon', r.icon));
    const main = el('div', 'tr-main');
    const head = el('div', 'tr-head');
    head.append(el('span', 'tr-kind', r.label));
    if (r.meta) head.append(el('span', 'tr-meta', 'META'));
    head.append(el('span', 'tr-when', when(r.at)));
    main.append(head);
    main.append(el('div', 'tr-text', r.text));
    if (r.extra) main.append(el('div', 'tr-extra', r.extra));
    if (r.seq !== null) {
      const a = /** @type {HTMLAnchorElement} */ (el('a', 'tr-link', `${t.to_ledger} #${r.seq}`));
      a.href = `#ev-${name}-${r.seq}`;
      main.append(a);
    }
    li.append(main);
    list.append(li);
  }
  box.append(list);
  return box;
}

/**
 * Every order known to any side, the contractor's first, in order of creation: the counterparty
 * side on the left, the contractor on the right.
 * @param {Export} x
 * @returns {{orderId: string, order: Order, seller: SideName}[]}
 */
function allOrders(x) {
  /** @type {Map<string, {orderId: string, order: Order, seller: SideName}>} */
  const out = new Map();
  /** @param {Order} o @param {SideName} from */
  const put = (o, from) => {
    if (out.has(o.order_id)) return;
    /** @type {SideName} */
    let seller = o.kind === 'material' ? 'supplier' : 'jcb';
    if (from !== 'contractor') seller = from;
    else if (x.supplier && o.counterparty === x.supplier.agentId) seller = 'supplier';
    else if (x.jcb && o.counterparty === x.jcb.agentId) seller = 'jcb';
    out.set(o.order_id, { orderId: o.order_id, order: o, seller });
  };
  for (const o of x.contractor?.orders ?? []) put(o, 'contractor');
  for (const o of x.jcb?.orders ?? []) put(o, 'jcb');
  for (const o of x.supplier?.orders ?? []) put(o, 'supplier');
  return [...out.values()].sort((a, b) => (a.order.created_at < b.order.created_at ? -1 : a.order.created_at > b.order.created_at ? 1 : 0));
}

/** Does any site count on this order differ from the delivery? @param {Ev[]} events */
function countDiffers(events) {
  const delivery = [...events].reverse().find((e) => e.type === 'DELIVERY');
  if (!delivery) return false;
  const delivered = Array.isArray(delivery.body.body?.items) ? delivery.body.body.items : [];
  return events.some((e) => e.type === 'NOTE' && e.body?.kind === 'site_count' && (e.body.items ?? []).some((/** @type {any} */ it) => {
    const d = delivered.find((/** @type {any} */ m) => m.name === it.name && m.unit === it.unit);
    return !d || d.qtyHundredths !== it.qtyHundredths;
  }));
}

/**
 * @param {Export} x
 * @param {Texts} t
 */
function renderOrders(x, t) {
  const host = /** @type {HTMLElement} */ (document.getElementById('orders'));
  host.replaceChildren();
  for (const { orderId, order, seller } of allOrders(x)) {
    const block = el('article', 'order');
    block.id = `order-${encodeURIComponent(orderId)}`;
    const head = el('div', 'order-head');
    const ref = x.contractor?.refs?.[orderId] ?? x[seller]?.refs?.[orderId] ?? short(orderId, 8);
    head.append(el('span', 'ref', ref));
    head.append(el('span', undefined, `${t.kind}: ${order.kind === 'material' ? t.kind_material : t.kind_jcb}`));
    head.append(el('span', undefined, `${t.site}: ${order.site}`));
    const req = (x.contractor ?? x[seller])?.events.find((e) => e.orderId === orderId && e.type === 'BOOKING_REQUEST');
    head.append(el('span', undefined, `${t.day}: ${req?.body?.body?.day ?? '—'}`));
    head.append(el('span', undefined, `${t.counterparty}: ${order.counterparty}`));
    const theirRef = x[seller]?.refs?.[orderId];
    if (theirRef) head.append(el('span', undefined, `${t.their_ref}: ${theirRef}`));
    head.append(el('span', 'mono', `${t.order}: ${short(orderId, 8)}`));
    if (x.contractor && countDiffers(x.contractor.events.filter((e) => e.orderId === orderId))) head.append(el('span', 'diffmark', `${t.site_count}: ${t.differs}`));
    // Both agents together: how much of this order was Meta's models, code checks and people.
    const both = [...orderTrace(x[seller]?.trace, orderId), ...orderTrace(x.contractor?.trace, orderId)];
    if (both.length) head.append(el('span', 'inside-sum', summaryText(traceSummary(both), t)));
    block.append(head);
    const cols = el('div', 'ledgers');
    cols.append(orderColumn(seller, x[seller], orderId, t), orderColumn('contractor', x.contractor, orderId, t));
    block.append(cols);
    host.append(block);
  }
}

/**
 * Checks every badge collected while rendering with the public key of the message's sender.
 * Verified afresh on every render: the page never trusts a result it computed earlier for a
 * message whose bytes may have changed (another export loaded, a tampered copy).
 * @param {Export} x
 */
async function verifyAll(x) {
  /** @type {Map<string, string>} */
  const keys = new Map();
  for (const name of SIDES) {
    const side = x[name];
    if (side) keys.set(side.agentId, side.publicKey);
  }
  const t = T();
  const batch = pendingBadges;
  pendingBadges = [];
  for (const { badge, message } of batch) {
    const key = keys.get(message?.from);
    // No key for the sender (its side is not in this export) is not a bad signature: it is unchecked.
    const result = key ? await verifySignature(message, key) : 'no_key';
    badge.textContent = result === 'ok' ? t.sig_ok : result === 'bad' ? t.sig_bad : result === 'no_key' ? t.sig_no_key : t.sig_unsupported;
    badge.classList.toggle('bad', result === 'bad');
    badge.classList.toggle('warn', result === 'no_key' || result === 'unsupported');
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
  /** @type {HTMLInputElement} */ (document.getElementById('key')).placeholder = t.key_placeholder;

  const orders = allOrders(x);
  /** @type {HTMLElement} */ (document.getElementById('source')).textContent = source.kind === 'live' ? t.source_live : source.kind === 'file' ? t.source_file : t.source_sample;
  /** @type {HTMLElement} */ (document.getElementById('order')).textContent = orders.length ? orders.map((o) => x.contractor?.refs?.[o.orderId] ?? x[o.seller]?.refs?.[o.orderId] ?? short(o.orderId, 8)).join(' · ') : '—';
  /** @type {HTMLElement} */ (document.getElementById('exported')).textContent = x.exportedAt ? when(x.exportedAt) : '—';
  /** @type {HTMLElement} */ (document.getElementById('summary')).hidden = false;

  const chains = await Promise.all(SIDES.map((name) => (x[name] ? checkChain(/** @type {LedgerExport} */ (x[name]).events) : Promise.resolve(null))));
  const cards = /** @type {HTMLElement} */ (document.getElementById('ledger-cards'));
  cards.replaceChildren(...SIDES.map((name, i) => ledgerCard(name, x[name], t, chains[i])));
  /** @type {HTMLElement} */ (document.getElementById('ledgers')).hidden = false;

  pendingBadges = [];
  renderOrders(x, t);
  // Live: each timeline shows its newest entry.
  if (liveTimer !== null) scrollTimelines();
  await verifyAll(x);
}

// --- Results panel: eval/results/*.json as the server lists them at results/, else "—" --------

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
    const list = await fetch('results/', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
    if (!Array.isArray(list) || list.length === 0) throw new Error('none');
    host.replaceChildren();
    for (const name of list.filter((n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n))) {
      const data = await fetch(`results/${encodeURIComponent(name)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
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

// --- Sources: sample, file, live ---------------------------------------------------------------

/** The notice as a function of the texts, so a language switch redraws it. @type {(t: Texts) => string} */
let lastNotice = () => '';

/** @param {(t: Texts) => string} make */
function notice(make) {
  lastNotice = make;
  const n = /** @type {HTMLElement} */ (document.getElementById('notice'));
  const text = make(T());
  n.textContent = text;
  n.hidden = text === '';
}

/** @param {unknown} s @returns {s is LedgerExport} */
const isSide = (s) => !!s && typeof s === 'object' && typeof (/** @type {any} */ (s)).agentId === 'string' && Array.isArray((/** @type {any} */ (s)).events) && Array.isArray((/** @type {any} */ (s)).orders);
/** An export with at least one ledger in it. @param {unknown} x @returns {x is Export} */
const isExport = (x) => !!x && typeof x === 'object' && SIDES.some((n) => isSide((/** @type {any} */ (x))[n]));

/** @param {Export} x @param {Source} from */
async function show(x, from) {
  current = x;
  source = from;
  notice(() => '');
  await render(x);
}

async function loadSample() {
  try {
    const x = await fetch('sample/export.json').then((r) => (r.ok ? r.json() : null));
    if (!isExport(x)) throw new Error('shape');
    await show(x, { kind: 'sample', missing: [] });
  } catch {
    notice((t) => t.no_export);
  }
}

/**
 * One side from the server, with the key as a Bearer header; null when it is not there (404: no
 * such agent, no token configured, or a wrong key — the server does not say which).
 * @param {SideName} name
 * @param {string} key
 * @returns {Promise<LedgerExport|null>}
 */
async function fetchSide(name, key) {
  try {
    const r = await fetch(`../agents/${AGENT_PATH[name]}/export`, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return null;
    const x = await r.json();
    return isSide(x) ? x : null;
  } catch {
    return null;
  }
}

/**
 * One agent's trace from the server, same key; null when the server has none (an older server, or
 * a key it does not accept).
 * @param {SideName} name @param {string} key
 * @returns {Promise<TraceEntry[]|null>}
 */
async function fetchTrace(name, key) {
  try {
    const r = await fetch(`../agents/${AGENT_PATH[name]}/trace`, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return null;
    const x = await r.json();
    return x && isTrace(x.entries) ? x.entries : null;
  } catch {
    return null;
  }
}

/** What was last shown live, to redraw only when something changed. */
let liveShown = '';
/** @type {ReturnType<typeof setInterval> | null} */
let liveTimer = null;

/** @param {string} key @param {{quiet?: boolean}} [o] quiet: a poll, no "loading" notice @returns {Promise<boolean>} whether anything was shown */
async function loadLive(key, o = {}) {
  const t = T();
  if (!o.quiet) notice((tt) => tt.live_loading);
  const [sides, traces] = await Promise.all([Promise.all(SIDES.map((n) => fetchSide(n, key))), Promise.all(SIDES.map((n) => fetchTrace(n, key)))]);
  sides.forEach((s, i) => { if (s && traces[i]) s.trace = /** @type {TraceEntry[]} */ (traces[i]); });
  /** @type {SideName[]} */
  const missing = SIDES.filter((_, i) => sides[i] === null);
  if (missing.length === SIDES.length) {
    notice((tt) => tt.key_rejected);
    return false;
  }
  // Each side carries its own exportedAt; the first present one stands for the whole.
  const first = /** @type {{exportedAt?: string} | undefined} */ (sides.find((s) => s));
  /** @type {Export} */
  const x ={ v: 'hb-export/0.1', exportedAt: first?.exportedAt ?? '', jcb: sides[0], contractor: sides[1], supplier: sides[2] };
  // A poll that brings nothing new leaves the page as it is (no redraw, no jump).
  const seen = JSON.stringify(sides.map((s) => [s?.events.length ?? -1, s?.trace?.at(-1)?.id ?? -1]));
  if (o.quiet && seen === liveShown && source.kind === 'live') return true;
  liveShown = seen;
  await show(x, { kind: 'live', missing });
  if (missing.length) notice((tt) => tt.live_partial.replace('{sides}', missing.map((n) => sideTitle(n, tt)).join(', ')));
  return true;
}

/** The key the viewer typed, from this tab's sessionStorage only. */
function savedKey() {
  try { return sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; }
}

/** @type {HTMLButtonElement} */ (document.getElementById('lang')).addEventListener('click', () => {
  lang = lang === 'hi' ? 'en' : 'hi';
  try { localStorage.setItem(STORAGE_LANG, lang); } catch { /* ignore */ }
  if (current) void render(current); else notice((t) => t.no_export);
  notice(lastNotice);
  void renderResults();
});

/** @type {HTMLInputElement} */ (document.getElementById('file')).addEventListener('change', async (ev) => {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const file = input.files?.[0];
  if (!file) return;
  try {
    const x = JSON.parse(await file.text());
    if (!isExport(x)) throw new Error('shape');
    await show(x, { kind: 'file', missing: [] });
  } catch {
    notice((t) => t.no_export);
  }
  input.value = '';
});

/** @type {HTMLFormElement} */ (document.getElementById('live-form')).addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const key = /** @type {HTMLInputElement} */ (document.getElementById('key')).value.trim();
  if (!key) { notice((t) => t.key_missing); return; }
  try { sessionStorage.setItem(SESSION_KEY, key); } catch { /* the key then lives in the field only */ }
  await loadLive(key);
});

/** @type {HTMLButtonElement} */ (document.getElementById('use-sample')).addEventListener('click', () => {
  stopLive();
  void loadSample();
});

/** Stops polling and unticks the live box. */
function stopLive() {
  if (liveTimer !== null) clearInterval(liveTimer);
  liveTimer = null;
  /** @type {HTMLInputElement} */ (document.getElementById('live-toggle')).checked = false;
}

// Live: with a key entered, the ledgers and traces are fetched again every 3 s.
/** @type {HTMLInputElement} */ (document.getElementById('live-toggle')).addEventListener('change', async (ev) => {
  const box = /** @type {HTMLInputElement} */ (ev.target);
  if (!box.checked) { stopLive(); return; }
  const key = /** @type {HTMLInputElement} */ (document.getElementById('key')).value.trim() || savedKey();
  if (!key) { box.checked = false; notice((t) => t.key_missing); return; }
  try { sessionStorage.setItem(SESSION_KEY, key); } catch { /* the key then lives in the field only */ }
  if (!(await loadLive(key))) { box.checked = false; return; }
  let busy = false;
  liveTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await loadLive(key, { quiet: true }); } finally { busy = false; }
  }, LIVE_MS);
  scrollTimelines();
});

/** Each timeline to its newest entry, at once (after layout, so the height is known). */
function scrollTimelines() {
  requestAnimationFrame(() => {
    for (const l of document.querySelectorAll('.trace-list')) l.scrollTo({ top: l.scrollHeight, behavior: 'instant' });
  });
}

const key0 = savedKey();
/** @type {HTMLInputElement} */ (document.getElementById('key')).value = key0;
if (!(key0 && await loadLive(key0))) await loadSample();
await renderResults();
