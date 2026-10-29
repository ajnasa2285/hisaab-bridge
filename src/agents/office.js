// The site office (docs/BUILD2.md sections 3 and 4): approvals with limits, and the exact commands
// people type (status, pending, stock, ok, no). A committing step a supervisor confirms is held
// instead of run when it is above the limit, cannot be estimated, or no limit is set; a contractor
// then decides once, and "ok" runs the stored step exactly as it was read back. Held steps and
// decisions are two append-only tables of their own in the agent's ledger file, so they survive a
// restart; the ledger's own tables and hash chain are not touched. Commands are parsed by code,
// never by the model, and only a contractor decides.

import { runTool, ok, no, ofType, posInt, nonNegInt } from './common.js';
import { openRefs, parseRef } from '../ledger/refs.js';
import { day as dayName, qty, rupees, tenths } from '../i18n/format.js';
import { t, variant } from '../i18n/index.js';
import { itemsText, signedWord, siteReceipt } from './material.js';
import { orderBalanceText, orderPaymentText, paymentWaiting } from './payment-view.js';
import { withUsual } from './usual.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('./common.js').Said} Said */
/** @typedef {import('./conversation.js').Reply} Reply */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {{procurementPaise?: number, paymentPaise?: number}} Limits */
/**
 * @typedef {{cmd: 'status' | 'evidence', ref: string} | {cmd: 'pending'} | {cmd: 'stock', item: string | null} |
 *   {cmd: 'ok', ref: string, note: string | null} | {cmd: 'no', ref: string, reason: string | null}} Command
 */
/**
 * @typedef {{id: number, ref: string, person: Person, tool: string, args: Record<string, any>, limit: string,
 *   estimatePaise: number | null, createdAt: string,
 *   decision: {decision: 'ok' | 'no', by: Person, note: string | null, at: string} | null}} HeldStep
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS held_steps (
     id             INTEGER PRIMARY KEY,
     ref            TEXT NOT NULL,
     person_json    TEXT NOT NULL,
     tool           TEXT NOT NULL,
     args_json      TEXT NOT NULL,
     limit_name     TEXT NOT NULL,
     estimate_paise INTEGER,
     created_at     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS held_steps_ref ON held_steps (ref, id)`,
  `CREATE TABLE IF NOT EXISTS held_decisions (
     held_id  INTEGER PRIMARY KEY REFERENCES held_steps (id),
     decision TEXT NOT NULL CHECK (decision IN ('ok', 'no')),
     by_json  TEXT NOT NULL,
     note     TEXT,
     at       TEXT NOT NULL
   )`,
  `CREATE TRIGGER IF NOT EXISTS held_steps_no_update BEFORE UPDATE ON held_steps
     BEGIN SELECT RAISE(ABORT, 'held steps are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS held_steps_no_delete BEFORE DELETE ON held_steps
     BEGIN SELECT RAISE(ABORT, 'held steps are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS held_decisions_no_update BEFORE UPDATE ON held_decisions
     BEGIN SELECT RAISE(ABORT, 'decisions are set once'); END`,
  `CREATE TRIGGER IF NOT EXISTS held_decisions_no_delete BEFORE DELETE ON held_decisions
     BEGIN SELECT RAISE(ABORT, 'decisions are set once'); END`,
];

// The kind of order a committing step creates when it names no existing order.
/** @type {Record<string, 'J' | 'P'>} */
const NEW_ORDER_REF = { request_jcb: 'J', request_material: 'P' };
// Orders that wait for the contractor's own decision (a bill to accept or dispute, another day offered);
// a delivery the site has not counted yet waits for the site too (see pending()).
const AWAITING_CONTRACTOR = ['billed', 'offered'];
const CLOSED = ['settled', 'declined', 'none'];
const MAX_NOTE = 300;

/** @param {string[]} words */
const wordSet = (words) => new Set(words.map((w) => w.normalize('NFC')));
const STATUS = wordSet(['status', 'स्टेटस', 'स्थिति', 'हालत']);
const EVIDENCE = wordSet(['सबूत', 'सबुत', 'saboot', 'sabut']);
const PENDING = wordSet(['pending', 'पेंडिंग', 'बाकी', 'बाक़ी', 'लंबित']);
const STOCK = wordSet(['stock', 'स्टॉक', 'स्टाक']);
const OK = wordSet(['ok', 'okay', 'ओके', 'हाँ', 'हां', 'मंज़ूर', 'मंजूर']);
const NO = wordSet(['no', 'नहीं', 'नही', 'ना', 'नामंज़ूर', 'नामंजूर']);

/**
 * An exact command, or null for anything else (which then goes to the model). Case and spacing do
 * not matter; a reference may be written "J-1", "j1", "P 2", "पी-2".
 * @param {string} text
 * @returns {Command | null}
 */
export function parseCommand(text) {
  const s = text.normalize('NFC').trim().toLowerCase().replace(/[।.!]+$/u, '').replace(/\s+/g, ' ');
  const m = /^(\S+)(?: (.*))?$/u.exec(s);
  if (!m) return null;
  const word = m[1];
  const rest = m[2] ?? '';
  if (PENDING.has(word) && rest === '') return { cmd: 'pending' };
  if (STOCK.has(word)) return rest.length > 40 ? null : { cmd: 'stock', item: rest || null };
  if (STATUS.has(word) || EVIDENCE.has(word)) {
    const ref = parseRef(rest);
    return ref === null ? null : { cmd: EVIDENCE.has(word) ? 'evidence' : 'status', ref };
  }
  if (OK.has(word) || NO.has(word)) {
    const r = /^((?:j|p|जे|पी) ?-? ?\d{1,6})(?: (.+))?$/u.exec(rest);
    const ref = r ? parseRef(r[1]) : null;
    if (!r || ref === null) return null;
    const tail = r[2] && r[2].length <= MAX_NOTE ? r[2] : null;
    if (r[2] && tail === null) return null;
    return OK.has(word) ? { cmd: 'ok', ref, note: tail } : { cmd: 'no', ref, reason: tail };
  }
  return null;
}

/**
 * What a site has received, per item, from the ledger alone: the signed DELIVERY of each material
 * order (the challan's figures) and the site's own count (a local NOTE `{kind: 'site_count', items}`).
 * Where the site counted, its count is what was received; else the challan's figure. Pure.
 * @param {{site: string, events: LedgerEvent[]}[]} orders the material orders
 * @returns {{site: string, name: string, unit: string, receivedHundredths: number, challanHundredths: number}[]}
 */
export function stockOf(orders) {
  /** @type {Map<string, {site: string, name: string, unit: string, receivedHundredths: number, challanHundredths: number}>} */
  const out = new Map();
  /** @param {string} site @param {any} item */
  const row = (site, item) => {
    const key = `${site}\u0000${item.name.trim().toLowerCase()}\u0000${item.unit.trim()}`;
    let r = out.get(key);
    if (!r) {
      r = { site, name: item.name.trim(), unit: item.unit.trim(), receivedHundredths: 0, challanHundredths: 0 };
      out.set(key, r);
    }
    return r;
  };
  /** @param {unknown} items @returns {any[]} */
  const valid = (items) => (Array.isArray(items) ? items.filter((i) => i && typeof i.name === 'string' && i.name.trim() && typeof i.unit === 'string' && nonNegInt(i.qtyHundredths)) : []);
  for (const o of orders) {
    const refused = new Set(o.events.filter((e) => e.direction === 'in' && e.type === 'REFUSE').map((e) => e.body.body?.refers_to));
    const delivery = o.events.filter((e) => e.type === 'DELIVERY' && !(e.direction === 'out' && refused.has(e.msgId))).at(-1);
    const challan = delivery ? valid((delivery.direction === 'local' ? delivery.body : delivery.body.body)?.items) : [];
    const count = ofType(o.events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
    for (const i of challan) row(o.site, i).challanHundredths += i.qtyHundredths;
    for (const i of count ? valid(count.body.items) : challan) row(o.site, i).receivedHundredths += i.qtyHundredths;
  }
  return [...out.values()];
}

/**
 * @param {{
 *   ledger: import('../ledger/store.js').Ledger,
 *   tools: Record<string, Tool>,
 *   kind: 'jcb' | 'contractor' | 'supplier',
 *   limits?: Limits,
 *   tell: Tell,
 *   reply: Reply,
 *   now: () => number,
 *   evidence?: {requestLatest: (orderId: string) => Promise<Said>},
 * }} o
 */
export function createOffice(o) {
  const { ledger } = o;
  const db = ledger.db;
  for (const sql of SCHEMA) db.exec(sql);
  const refs = openRefs(ledger);
  const side = o.kind === 'contractor' ? 'buyer' : 'seller';
  const q = {
    insertHeld: db.prepare('INSERT INTO held_steps (ref, person_json, tool, args_json, limit_name, estimate_paise, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insertDecision: db.prepare('INSERT INTO held_decisions (held_id, decision, by_json, note, at) VALUES (?, ?, ?, ?, ?)'),
    all: db.prepare('SELECT h.*, d.decision, d.by_json, d.note, d.at FROM held_steps h LEFT JOIN held_decisions d ON d.held_id = h.id ORDER BY h.id'),
    byRef: db.prepare('SELECT h.*, d.decision, d.by_json, d.note, d.at FROM held_steps h LEFT JOIN held_decisions d ON d.held_id = h.id WHERE h.ref = ? ORDER BY h.id'),
  };
  const nowIso = () => new Date(o.now()).toISOString();

  /** @param {any} r @returns {HeldStep} */
  const toHeld = (r) => ({
    id: r.id, ref: r.ref, person: JSON.parse(r.person_json), tool: r.tool, args: JSON.parse(r.args_json), limit: r.limit_name,
    estimatePaise: r.estimate_paise ?? null, createdAt: r.created_at,
    decision: r.decision ? { decision: r.decision, by: JSON.parse(r.by_json), note: r.note ?? null, at: r.at } : null,
  });
  /** The held step a reference names: the open one, else the latest decided one. @param {string} ref */
  const heldByRef = (ref) => {
    const all = q.byRef.all(ref).map(toHeld);
    return all.findLast((h) => h.decision === null) ?? all.at(-1) ?? null;
  };
  /** @param {Person} a @param {Person} b */
  const same = (a, b) => a.agent === b.agent && a.line === b.line && a.phone === b.phone;
  /** @param {Person} p */
  const nameOf = (p) => p.name || t(`role.${p.role}`);
  /** @param {number | null} paise */
  const money = (paise) => (paise === null ? '—' : rupees(paise));
  /** What the step does, for someone else to decide on: its summary, else its read-back without the closing question. @param {string} tool @param {Record<string, any>} args */
  const stepText = (tool, args) => {
    const step = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    const what = step?.summary?.(args);
    if (what) return t(what.key, what.params);
    const d = step?.describe?.(args);
    return d ? t(d.key, d.params).replace(/\s*हाँ \/ नहीं\s*$/u, '') : t('office.step_unknown');
  };
  /** @param {string} orderId */
  const knownOrder = (orderId) => typeof orderId === 'string' && ledger.order(orderId) !== null;

  /**
   * Runs a step the person confirmed with "हाँ", or holds it for a contractor's decision. This is the
   * one gate every committing step passes through (src/agents/conversation.js).
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   * @returns {Promise<Said>}
   */
  async function commit(person, tool, args) {
    const step = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (step?.hold && holds(person, tool, args)) return hold(person, tool, step.hold.limit, args, step.hold.estimatePaise(args));
    const result = await runTool(o.tools, person, { tool, args });
    if (result.ok && person.role === 'supervisor' && NEW_ORDER_REF[tool]) {
      const notes = step?.hold?.usualNote?.(args, false) ?? '';
      if (notes) {
        const notice = withUsual(result, notes);
        await o.tell('contractor', notice.key, notice.params);
      }
    }
    return result;
  }

  /**
   * Would this step be held for a contractor's decision rather than run? A supervisor's step above
   * the limit, that cannot be estimated, or with no limit set. Such a step needs no read-back to the
   * supervisor: the contractor's OK is the check.
   * @param {Person} person @param {string} tool @param {Record<string, any>} args
   */
  function holds(person, tool, args) {
    const step = Object.hasOwn(o.tools, tool) ? o.tools[tool] : undefined;
    if (!step?.hold || o.kind !== 'contractor' || person.role !== 'supervisor' || !step.roles.includes(person.role)) return false;
    const limit = step.hold.limit === 'procurement' ? o.limits?.procurementPaise : o.limits?.paymentPaise;
    const estimate = step.hold.estimatePaise(args);
    return limit === undefined || estimate === null || estimate > limit;
  }

  /**
   * Stores the step exactly as read back, with the reference its order has or will have, and asks
   * every contractor once.
   * @param {Person} person @param {string} tool @param {string} limit @param {Record<string, any>} args @param {number | null} estimate
   * @returns {Promise<Said>}
   */
  async function hold(person, tool, limit, args, estimate) {
    const ref = knownOrder(args.orderId) ? refs.refOf(args.orderId) ?? refs.reserve('J') : refs.reserve(NEW_ORDER_REF[tool] ?? 'J');
    q.insertHeld.run(ref, JSON.stringify(person), tool, JSON.stringify(args), limit, estimate, nowIso());
    const notice = withUsual({ key: variant('office.approval_needed', { estimate: estimate !== null }),
      params: { ref, by: nameOf(person), ...(estimate !== null ? { estimate: money(estimate) } : {}), step: stepText(tool, args) } },
    o.tools[tool]?.hold?.usualNote?.(args) ?? '');
    await o.tell('contractor', notice.key, notice.params);
    // One message to the supervisor: what was understood, and that it went for approval.
    const what = Object.hasOwn(o.tools, tool) ? o.tools[tool].summary?.(args) : undefined;
    return what ? ok('office.held_step', { ref, what: t(what.key, what.params) }) : ok('office.held', { ref });
  }

  /**
   * Runs a held step exactly as stored, as its requester. A new order is written before its message
   * leaves (link.send prepares synchronously), so it is tied to the reserved reference right away,
   * before anything else could number it.
   * @param {HeldStep} h
   */
  async function runHeld(h) {
    const before = new Set(/** @type {{order_id: string}[]} */ (ledger.orders()).map((x) => x.order_id));
    const running = runTool(o.tools, h.person, { tool: h.tool, args: h.args });
    const kind = h.ref.startsWith('P-') ? 'material' : 'jcb_hours';
    const created = /** @type {{order_id: string, kind: string}[]} */ (ledger.orders()).find((x) => !before.has(x.order_id) && x.kind === kind);
    if (created) refs.bind(h.ref, created.order_id);
    return running;
  }

  /** @param {Person} person @param {{cmd: 'ok' | 'no', ref: string, note?: string | null, reason?: string | null}} c @returns {Promise<Said>} */
  async function decide(person, c) {
    if (person.role !== 'contractor') return no('office.only_contractor');
    const h = heldByRef(c.ref);
    if (!h) return no('office.no_such_ref', { ref: c.ref });
    const decided = () => /** @type {HeldStep} */ (heldByRef(c.ref)).decision;
    const already = (/** @type {NonNullable<HeldStep['decision']>} */ d) => no('office.already_decided', { ref: c.ref, decision: t(`office.decision.${d.decision}`), by: nameOf(d.by) });
    if (h.decision) return already(h.decision);
    if (same(h.person, person)) return no('office.own_entry');
    const reason = c.cmd === 'no' ? c.reason ?? null : null;
    if (c.cmd === 'no' && !reason) return no('office.reason_needed', { ref: c.ref });
    const note = c.cmd === 'ok' ? c.note ?? null : reason;
    try {
      q.insertDecision.run(h.id, c.cmd, JSON.stringify(person), note, nowIso());
    } catch {
      // Someone decided in between: the first decision stands.
      const d = decided();
      return d ? already(d) : no('common.wrong_state');
    }
    if (c.cmd === 'no') {
      await o.reply(h.person, 'office.declined', { ref: c.ref, by: nameOf(person), reason: /** @type {string} */ (reason) });
      return ok('office.you_declined', { ref: c.ref });
    }
    await o.reply(h.person, note ? 'office.approved_note' : 'office.approved', { ref: c.ref, by: nameOf(person), ...(note ? { note } : {}) });
    const r = await runHeld(h);
    await o.reply(h.person, r.key, r.params);
    return r.ok ? withUsual(r, o.tools[h.tool]?.hold?.usualNote?.(h.args, false) ?? '') : r;
  }

  /** What an order is about, in words. @param {string} orderId @param {string} kind */
  function whatOf(orderId, kind) {
    const req = ledger.events(orderId).filter((e) => e.type === 'BOOKING_REQUEST').at(-1)?.body.body;
    if (kind === 'material') {
      const items = Array.isArray(req?.items) ? req.items.filter((/** @type {any} */ i) => typeof i?.name === 'string' && nonNegInt(i.qtyHundredths) && typeof i.unit === 'string') : [];
      return items.length ? t('office.what_material', { items: items.map((/** @type {any} */ i) => t('account.material', { name: i.name, qty: qty(i.qtyHundredths, i.unit) })).join(', ') }) : t('kind.material');
    }
    return posInt(req?.hoursTenths) ? t('office.what_jcb', { hours: tenths(req.hoursTenths) }) : t('kind.jcb');
  }

  /** @param {string} state */
  const awaited = (state) => (state === 'none' ? t('office.pending_none') : t(`office.await.${side}.${state}`));

  /** @param {string} ref @returns {Said} */
  function status(ref) {
    const orderId = refs.orderOfRef(ref);
    if (orderId === null) {
      const h = o.kind === 'contractor' ? heldByRef(ref) : null;
      if (!h) return no('office.no_such_ref', { ref });
      const d = h.decision;
      const decision = !d ? t('office.held_waiting') : d.decision === 'ok' ? t('office.held_ok', { by: nameOf(d.by) }) : t('office.held_no', { by: nameOf(d.by), reason: d.note ?? '' });
      return ok(variant('office.status_held', { estimate: h.estimatePaise !== null }), { ref, step: stepText(h.tool, h.args), ...(h.estimatePaise !== null ? { estimate: money(h.estimatePaise) } : {}), decision });
    }
    const order = /** @type {{kind: string, site: string}} */ (ledger.order(orderId));
    const view = ledger.view(orderId);
    const events = ledger.events(orderId);
    const req = events.filter((e) => e.type === 'BOOKING_REQUEST').at(-1)?.body.body;
    const yes = ofType(events, 'BOOKING_REPLY').filter((e) => e.body.body.answer === 'yes').at(-1)?.body.body;
    let rate = '';
    if (posInt(yes?.ratePaise)) rate = rupees(yes.ratePaise);
    else if (Array.isArray(yes?.rates)) rate = yes.rates.filter((/** @type {any} */ r) => posInt(r?.ratePaise)).map((/** @type {any} */ r) => t('account.material', { name: r.name, qty: rupees(r.ratePaise) })).join(', ');
    const params = {
      ref, what: whatOf(orderId, order.kind), site: order.site, day: typeof req?.day === 'string' ? `, ${dayName(req.day)}` : '',
      state: view.state === 'none' ? t('office.state_unknown') : t(`state.${view.state}`), rate: rate ? `\n${t('office.rate', { rate })}` : '',
      payments: orderPaymentText(ledger, orderId), awaited: awaited(view.state),
    };
    // The supplier also sees what the site wrote on its signed copy of the challan, when it came.
    const receipt = o.kind === 'supplier' && order.kind === 'material' ? siteReceipt(events) : null;
    if (receipt === null) return ok('office.status', params);
    return ok('office.status_with_receipt', {
      ...params,
      receipt: t(receipt.number ? 'office.site_receipt' : 'office.site_receipt_no_number', { challanNo: receipt.number ?? '', count: itemsText(receipt.items), signed: t(`office.signed_${signedWord(receipt.signed)}`) }),
    });
  }

  /** @param {Person} person @returns {Said} */
  function pending(person) {
    /** @type {string[]} */
    const lines = [];
    const sellerClaims = o.kind !== 'contractor' && ['jcb_owner', 'supplier'].includes(person.role) ? paymentWaiting(ledger) : [];
    lines.push(...sellerClaims.map((n) => t(n.key, n.params)));
    const claimedRefs = new Set(sellerClaims.flatMap((n) => String(n.params.refs).split(', ')));
    if (o.kind === 'contractor') {
      for (const h of q.all.all().map(toHeld)) {
        if (h.decision !== null || (person.role !== 'contractor' && !same(h.person, person))) continue;
        lines.push(t('office.pending_held', { ref: h.ref, step: stepText(h.tool, h.args), by: nameOf(h.person) }));
      }
    }
    for (const order of /** @type {{order_id: string, kind: string, site: string}[]} */ (ledger.orders())) {
      const state = ledger.view(order.order_id).state;
      const ref = refs.refOf(order.order_id) ?? '';
      // The claim/group above already says what the seller needs to answer. Other work remains visible.
      if (state === 'payment_claimed' && claimedRefs.has(ref)) continue;
      const uncounted = state === 'delivered' && !ofType(ledger.events(order.order_id), 'NOTE', 'local').some((e) => e.body.kind === 'site_count');
      const wanted = person.role === 'contractor' ? AWAITING_CONTRACTOR.includes(state) || uncounted : !CLOSED.includes(state);
      if (!wanted) continue;
      lines.push(t('office.pending_order', { ref, what: whatOf(order.order_id, order.kind), site: order.site, awaited: awaited(state), balance: orderBalanceText(ledger, order.order_id) }));
    }
    return lines.length ? ok('office.pending', { lines: lines.join('\n') }) : ok('office.pending_none');
  }

  /** @param {string | null} item @returns {Said} */
  function stock(item) {
    if (o.kind !== 'contractor') return ok('office.stock_not_here');
    const material = /** @type {{order_id: string, kind: string, site: string}[]} */ (ledger.orders()).filter((x) => x.kind === 'material');
    const rows = stockOf(material.map((x) => ({ site: x.site, events: ledger.events(x.order_id) })))
      .filter((r) => item === null || r.name.toLowerCase().includes(item));
    if (rows.length === 0) return ok('office.stock_none');
    /** @type {string[]} */
    const lines = [];
    for (const site of new Set(rows.map((r) => r.site))) {
      lines.push(t('office.stock_site', { site }));
      for (const r of rows.filter((x) => x.site === site)) {
        lines.push(r.receivedHundredths === r.challanHundredths
          ? t('office.stock_line', { name: r.name, qty: qty(r.receivedHundredths, r.unit) })
          : t('office.stock_line_differs', { name: r.name, qty: qty(r.receivedHundredths, r.unit), challan: qty(r.challanHundredths, r.unit) }));
      }
    }
    return ok('office.stock', { lines: lines.join('\n') });
  }

  /**
   * Answers an exact command. Returns null when the command means nothing on this agent (ok/no away
   * from the contractor's agent), so the message goes to the model as before.
   * @param {Person} person @param {Command} c
   * @returns {Promise<Said | null>}
   */
  async function command(person, c) {
    switch (c.cmd) {
      case 'evidence': {
        if (!['contractor', 'supervisor', 'jcb_owner', 'supplier'].includes(person.role)) return no('common.not_allowed');
        const orderId = refs.orderOfRef(c.ref);
        if (!orderId) return no('office.no_such_ref', { ref: c.ref });
        return o.evidence ? o.evidence.requestLatest(orderId) : no('evidence.unavailable', { ref: c.ref });
      }
      case 'status': return status(c.ref);
      case 'pending': return pending(person);
      case 'stock': return stock(c.item);
      case 'ok':
      case 'no':
        return o.kind === 'contractor' ? decide(person, c) : null;
      default: return null;
    }
  }

  return {
    commit,
    holds,
    command,
    /** Every held step with its decision, oldest first (for tests and the judge export). @returns {HeldStep[]} */
    held: () => q.all.all().map(toHeld),
  };
}
