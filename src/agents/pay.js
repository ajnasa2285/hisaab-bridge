// Payments as the agents record them (docs/CONTRACTS.md section 4.1): part, cash, advance and one
// payment for several orders. The balance always comes from paymentSummary (src/ledger/payments.js),
// the shares of a clubbed payment from allocate; nothing here is the model's. The buyer's tools live
// in contractor.js; the seller's (the JCB owner's and the supplier's are the same) are made here.
// Every receipt and notice shows the balance; nothing asks anyone to pay.

import { randomUUID } from 'node:crypto';
import { allocate, paymentSummary } from '../ledger/payments.js';
import { refusedIds } from '../ledger/states.js';
import { rupees, day as dayName } from '../i18n/format.js';
import { t, variant } from '../i18n/index.js';
import { deliveryResult, isDay, isUuid, no, ofType, ok, posInt } from './common.js';
import { traceCheck } from '../trace/trace.js';
import { plain } from '../learn/corrections.js';

/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {import('../ledger/payments.js').PaymentSummary} PaymentSummary */
/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('../protocol/messages.js').Message} Message */

// A payment fits an order from the booking on until it is settled (src/ledger/states.js).
export const PAYABLE = ['booked', 'working', 'delivered', 'billed', 'disputed', 'accepted', 'payment_claimed', 'part_paid'];

/** Today's date in India, for money given or received today. @param {number} nowMs */
export const todayIst = (nowMs) => new Date(nowMs + 330 * 60 * 1000).toISOString().slice(0, 10);

/**
 * The order's events as they count: a message we sent that the other side refused never happened
 * (as in the ledger's own view).
 * @param {Ledger} ledger @param {string} orderId @returns {LedgerEvent[]}
 */
export function liveEvents(ledger, orderId) {
  const all = ledger.events(orderId);
  const refused = refusedIds(all);
  return all.filter((e) => !(e.direction === 'out' && refused.has(e.msgId)));
}

/** @param {Ledger} ledger @param {string} orderId @returns {PaymentSummary} */
export const summaryOf = (ledger, orderId) => paymentSummary(liveEvents(ledger, orderId));

/**
 * What is still owed on an order once the claims waiting for an answer are counted too: what a new
 * payment should cover. Null before any bill. (CONTRACTS 4.1's `due` counts confirmed money only; a
 * clubbed payment that ignored a waiting claim would pay the same money twice.)
 * @param {PaymentSummary} s
 */
export const owedPaise = (s) => (s.duePaise === null ? null : Math.max(s.duePaise - s.waitingPaise, 0));

/**
 * The balance as one plain line: "बाक़ी ₹10,650", "बाक़ी ₹10,650; ₹10,000 पुष्टि के इंतज़ार में",
 * "पूरा मिला, ₹350 ज़्यादा", "अभी बिल नहीं बना; अग्रिम ₹5,000 पक्का". Never a reminder, never a date.
 * @param {PaymentSummary} s
 */
export function balanceText(s) {
  const waiting = s.waitingPaise > 0;
  /** @type {Record<string, string>} */
  const params = waiting ? { waiting: rupees(s.waitingPaise) } : {};
  if (s.billTotalPaise === null) {
    const confirmed = s.confirmedPaise > 0;
    return t(variant('pay.balance.no_bill', { confirmed, waiting }), { ...params, ...(confirmed ? { confirmed: rupees(s.confirmedPaise) } : {}) });
  }
  if (/** @type {number} */ (s.duePaise) > 0) return t(variant('pay.balance.due', { waiting }), { ...params, due: rupees(/** @type {number} */ (s.duePaise)) });
  if (s.creditPaise > 0) return t(variant('pay.balance.credit', { waiting }), { ...params, credit: rupees(s.creditPaise) });
  return t(variant('pay.balance.clear', { waiting }), params);
}

/**
 * A payment as both sides see it: "₹10,000 नकद, 30 अक्टूबर 2026" or, for UPI, the amount, day, time
 * when printed, and UTR (paymentText in common.js).
 * @param {Record<string, any>} b a PAYMENT_CLAIM or PAYMENT_RECEIVED body
 */
export function paymentLine(b) {
  const on = isDay(b.paidOn) ? b.paidOn : b.receivedOn;
  const at = typeof b.paidAt === 'string' ? `, ${t('payment.at_time', { time: b.paidAt })}` : '';
  if (b.method === 'cash') return `${rupees(b.amountPaise)} ${t('payment.cash')}, ${dayName(on)}${at}`;
  return typeof b.utr === 'string' ? `${rupees(b.amountPaise)}, ${dayName(on)}${at}, UTR ${b.utr}` : `${rupees(b.amountPaise)} UPI, ${dayName(on)}${at}`;
}

/**
 * Earlier claims to this counterparty with the same UTR, outside the given group: never accepted
 * silently (CONTRACTS 4.1). Claims the other side refused do not count.
 * @param {Ledger} ledger @param {string} counterparty @param {string} utr @param {string | null} [groupId]
 * @returns {{orderId: string, body: Record<string, any>}[]}
 */
export function utrUses(ledger, counterparty, utr, groupId = null) {
  const want = utr.trim().toUpperCase();
  /** @type {{orderId: string, body: Record<string, any>}[]} */
  const out = [];
  for (const o of /** @type {{order_id: string, counterparty: string}[]} */ (ledger.orders())) {
    if (o.counterparty !== counterparty) continue;
    for (const e of ofType(liveEvents(ledger, o.order_id), 'PAYMENT_CLAIM', 'out')) {
      const b = e.body.body;
      if (typeof b.utr === 'string' && b.utr.trim().toUpperCase() === want && (groupId === null || b.group?.id !== groupId)) out.push({ orderId: o.order_id, body: b });
    }
  }
  return out;
}

/**
 * The orders a payment can go to, with what is owed on each: those from the booking on and not
 * settled, of one counterparty when given. Oldest bill first; orders without a bill after them,
 * oldest first.
 * @param {Ledger} ledger @param {string | null} [counterparty]
 * @returns {{orderId: string, counterparty: string, owedPaise: number | null, billSeq: number | null}[]}
 */
export function payableOrders(ledger, counterparty = null) {
  const out = [];
  for (const o of /** @type {{order_id: string, counterparty: string}[]} */ (ledger.orders())) {
    if (counterparty !== null && o.counterparty !== counterparty) continue;
    const view = ledger.view(o.order_id);
    if (!PAYABLE.includes(view.state)) continue;
    const bill = view.currentBill ? ledger.eventOfMessage(view.currentBill) : null;
    out.push({ orderId: o.order_id, counterparty: o.counterparty, owedPaise: owedPaise(summaryOf(ledger, o.order_id)), billSeq: bill ? bill.seq : null });
  }
  return out.sort((a, b) => (a.billSeq ?? Infinity) - (b.billSeq ?? Infinity));
}

/**
 * Code's split of one payment among the named orders, in the order named (CONTRACTS 4.1): each takes
 * what is owed on it, up to what is left; what is left over goes to the last (an advance when it has
 * no bill yet, else a credit). Orders that take nothing are left out.
 * @param {Ledger} ledger @param {string[]} orderIds @param {number} totalPaise
 */
export function shares(ledger, orderIds, totalPaise) {
  const split = allocate(totalPaise, orderIds.map((orderId) => ({ orderId, duePaise: owedPaise(summaryOf(ledger, orderId)) })));
  if (split) {
    const sum = split.reduce((a, s) => a + s.amountPaise, 0);
    traceCheck(`clubbed payment: shares add up ${sum === totalPaise ? '✓' : '✗'} ${rupees(sum)} / ${rupees(totalPaise)}`, sum === totalPaise,
      { name: 'payment_shares', totalPaise, shares: split }, split[0].orderId);
  }
  return split;
}

/**
 * The seller's side of payments, the same for the JCB owner and the supplier: confirm or deny a
 * reported payment (one हाँ/नहीं for a whole clubbed group), record money received in hand, and settle
 * by itself as soon as the contract allows. Only this person can say money arrived.
 * @param {{
 *   ledger: Ledger,
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   role: 'jcb_owner' | 'supplier',
 *   settledKey: string,
 *   refOf: (orderId: string) => string,
 *   siteOf: (orderId: string) => string,
 *   now: () => number,
 * }} o
 */
export function createSellerPayments(o) {
  const { ledger, link } = o;
  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string} | null} */ (ledger.order(orderId))?.counterparty ?? null;
  /** @param {string} orderId */
  const knownOrder = (orderId) => isUuid(orderId) && counterparty(orderId) !== null;

  /** The claim's body as received. @param {string} msgId */
  const claimBody = (msgId) => {
    const e = ledger.eventOfMessage(msgId);
    return e && e.type === 'PAYMENT_CLAIM' && e.direction === 'in' ? /** @type {Record<string, any>} */ (e.body.body) : null;
  };

  /**
   * The claims one हाँ/नहीं answers: the claim itself, or every waiting claim of its group, as
   * [orderId, claim msg_id] in the group's order.
   * @param {string} orderId @param {string} payment @returns {[string, string][]}
   */
  function unitOf(orderId, payment) {
    const b = claimBody(payment);
    if (!b?.group) return [[orderId, payment]];
    /** @type {[string, string][]} */
    const out = [];
    for (const id of /** @type {string[]} */ (b.group.orders)) {
      if (!knownOrder(id)) continue;
      const view = ledger.view(id);
      for (const p of view.pending) if (claimBody(p)?.group?.id === b.group.id) out.push([id, p]);
    }
    return out;
  }

  /**
   * Money already confirmed on this order of exactly this amount (a confirmed claim or an entry of the
   * seller's own), each as "₹10,000 नकद, 28 अक्टूबर 2026". A second equal payment can be genuine and cash
   * has no UTR, so this only ever makes the seller say so; one order at a time.
   * @param {string} orderId @param {number} amountPaise @returns {string[]}
   */
  const sameConfirmed = (orderId, amountPaise) => summaryOf(ledger, orderId).payments
    .filter((p) => p.status === 'confirmed' && p.amountPaise === amountPaise).map((p) => paymentLine(p));

  /** The oldest claim of this order waiting for an answer, or the one named. @param {string} orderId @param {unknown} payment */
  const waitingClaim = (orderId, payment) => {
    const pending = ledger.view(orderId).pending;
    if (payment === undefined) return pending[0] ?? null;
    return typeof payment === 'string' && pending.includes(payment) ? payment : null;
  };

  /**
   * SETTLED by code as soon as the contract allows it: the bill accepted, nothing waiting and the
   * money confirmed covering the bill. Returns the summary when it went.
   * @param {string} orderId @returns {Promise<PaymentSummary | null>}
   */
  async function settleIfDue(orderId) {
    const view = ledger.view(orderId);
    if ((view.state !== 'accepted' && view.state !== 'part_paid') || view.pending.length || view.currentBill === null
      || view.billTotalPaise === null || view.confirmedPaise < view.billTotalPaise) return null;
    const payments = Object.entries(view.paid).filter(([, p]) => p.status === 'confirmed').map(([id]) => id);
    traceCheck(`balance: confirmed ${rupees(view.confirmedPaise)} ≥ bill ${rupees(view.billTotalPaise)} ✓ → settled`, true,
      { name: 'settle', confirmedPaise: view.confirmedPaise, billPaise: view.billTotalPaise }, orderId);
    const d = await link.send({ type: 'SETTLED', to: /** @type {string} */ (counterparty(orderId)), orderId,
      body: { bill: view.currentBill, amountPaise: view.confirmedPaise, payments } });
    return d.ok ? summaryOf(ledger, orderId) : null;
  }

  /** "P-1: ₹20,650, हिसाब पूरा" lines for a group. @param {[string, number][]} parts [orderId, amount] */
  const groupLines = (parts) => parts.map(([id, amount]) => t('pay.line', { ref: o.refOf(id), amount: rupees(amount), balance: lineBalance(id) })).join('\n');
  /** @param {string} orderId */
  const lineBalance = (orderId) => (ledger.view(orderId).state === 'settled' ? t('pay.balance.settled') : balanceText(summaryOf(ledger, orderId)));

  /** @type {Record<string, Tool>} */
  const tools = {
    // The seller's हाँ (received) or नहीं (not received) to a reported payment; a clubbed payment is
    // answered as a whole. A yes that completes the bill settles it at once.
    confirm_payment: {
      roles: [o.role],
      commits: true,
      stillOpen: (a) => knownOrder(a.orderId) && waitingClaim(a.orderId, a.payment) !== null,
      describe: (a) => {
        const claim = knownOrder(a.orderId) ? waitingClaim(a.orderId, a.payment) : null;
        const unit = claim ? unitOf(a.orderId, claim) : [];
        const amount = unit.reduce((s, [, p]) => s + (claimBody(p)?.amountPaise ?? 0), 0);
        return { key: a.received === false ? 'step.deny_payment' : 'step.confirm_payment', params: { site: o.siteOf(a.orderId), amount: amount > 0 ? rupees(amount) : t('pay.nothing') } };
      },
      async run(_p, a) {
        if (!knownOrder(a.orderId)) return no('common.no_such_order');
        if (a.received !== undefined && typeof a.received !== 'boolean') return no('common.bad_args');
        const received = a.received !== false;
        const claim = waitingClaim(a.orderId, a.payment);
        if (claim === null) return no('pay.nothing_waiting');
        const unit = unitOf(a.orderId, claim);
        // A yes to money equal to what is already confirmed on that order: said first, with its date and
        // method. Only an explicit second yes counts it; a no tells the contractor it did not come.
        if (received && a.sameAmountOk !== true) {
          const before = unit.flatMap(([orderId, payment]) => sameConfirmed(orderId, /** @type {number} */ (claimBody(payment)?.amountPaise)).map((line) => `${o.refOf(orderId)}: ${line}`));
          if (before.length) {
            return { ...no('pay.seller.claim_same_confirmed', { ref: o.refOf(a.orderId), amount: rupees(unit.reduce((s, [, p]) => s + (claimBody(p)?.amountPaise ?? 0), 0)), before: before.join('; ') }),
              expect: { tool: 'confirm_payment', args: { orderId: a.orderId, payment: claim, sameAmountOk: true }, no: { tool: 'confirm_payment', args: { orderId: a.orderId, payment: claim, received: false } } } };
          }
        }
        /** @type {[string, number][]} */
        const done = [];
        for (const [orderId, payment] of unit) {
          const amountPaise = /** @type {number} */ (claimBody(payment)?.amountPaise);
          const d = await link.send({ type: 'PAYMENT_ACK', to: /** @type {string} */ (counterparty(orderId)), orderId, body: { payment, received, amountPaise } });
          if (!d.ok) return deliveryResult(d, 'pay.seller.confirmed');
          done.push([orderId, amountPaise]);
        }
        const total = done.reduce((s, [, x]) => s + x, 0);
        // Any answer can be the last one waiting, a denial too: the order may be fully paid now.
        const settled = [];
        for (const [orderId] of done) if (await settleIfDue(orderId)) settled.push(orderId);
        if (!received) {
          if (done.length > 1) return ok('pay.seller.group_denied', { amount: rupees(total), lines: groupLines(done) });
          if (settled.length) return settledSaid(a.orderId);
          return ok('pay.seller.denied', { ref: o.refOf(a.orderId), amount: rupees(total), balance: balanceText(summaryOf(ledger, a.orderId)) });
        }
        if (done.length > 1) return ok('pay.seller.group_confirmed', { amount: rupees(total), lines: groupLines(done) });
        if (settled.length) return settledSaid(a.orderId);
        return ok('pay.seller.confirmed', { ref: o.refOf(a.orderId), amount: rupees(total), balance: balanceText(summaryOf(ledger, a.orderId)) });
      },
    },

    // Money the seller received himself (cash in hand, or UPI the contractor did not report): it
    // counts as confirmed at once, and settles the bill when it completes it.
    record_received: {
      roles: [o.role],
      commits: true,
      describe: (a) => ({
        key: a.method === 'upi' ? 'step.record_received_upi' : 'step.record_received',
        params: { ref: o.refOf(a.orderId), site: o.siteOf(a.orderId), amount: posInt(a.amountPaise) ? rupees(a.amountPaise) : t('pay.nothing') },
      }),
      async run(_p, a) {
        if (!knownOrder(a.orderId)) return no('common.no_such_order');
        if (!posInt(a.amountPaise) || (a.method !== 'cash' && a.method !== 'upi')) return no('common.bad_args');
        const receivedOn = a.receivedOn === undefined ? todayIst(o.now()) : a.receivedOn;
        if (!isDay(receivedOn)) return no('common.bad_args');
        const view = ledger.view(a.orderId);
        if (!PAYABLE.includes(view.state)) return no('common.wrong_state');
        // The same money reported by the contractor and still waiting: counting both would count one
        // receipt twice. The seller answers that claim, or says it is a separate payment.
        const same = a.separate === true ? undefined : view.pending.find((id) => view.paid[id].amountPaise === a.amountPaise);
        if (same !== undefined) {
          return { ...no('pay.seller.claim_waiting', { ref: o.refOf(a.orderId), payment: paymentLine(claimBody(same) ?? { amountPaise: a.amountPaise, receivedOn }) }),
            expect: { tool: 'confirm_payment', args: { orderId: a.orderId, payment: same }, no: { tool: 'record_received', args: { ...a, separate: true } } } };
        }
        // Equal to money already confirmed: said first, and counted only on an explicit yes.
        const before = a.sameAmountOk === true ? [] : sameConfirmed(a.orderId, a.amountPaise);
        if (before.length) {
          return { ...no('pay.seller.same_recorded', { ref: o.refOf(a.orderId), amount: rupees(a.amountPaise), before: before.join('; ') }),
            expect: { tool: 'record_received', args: { ...a, receivedOn, sameAmountOk: true } } };
        }
        const body = { method: a.method, amountPaise: a.amountPaise, receivedOn, bill: view.currentBill };
        const d = await link.send({ type: 'PAYMENT_RECEIVED', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        if (!d.ok) return deliveryResult(d, 'pay.seller.received');
        if (await settleIfDue(a.orderId)) return settledSaid(a.orderId);
        return ok('pay.seller.received', { ref: o.refOf(a.orderId), payment: paymentLine(body), balance: balanceText(summaryOf(ledger, a.orderId)) });
      },
    },
  };

  /** The seller's receipt when the order is settled: the old key, with the credit when more came. @param {string} orderId */
  function settledSaid(orderId) {
    const s = summaryOf(ledger, orderId);
    return ok(variant(o.settledKey, { credit: s.creditPaise > 0 }), { amount: rupees(s.confirmedPaise), ...(s.creditPaise > 0 ? { credit: rupees(s.creditPaise) } : {}) });
  }

  /**
   * Where this claim's UTR was told before on this seller's orders (a denied claim is not a use; the
   * shares of one clubbed payment are one use), as one warning line for the notice, or ''.
   * @param {Message} m
   */
  function utrSeen(m) {
    const b = m.body;
    if (typeof b.utr !== 'string') return '';
    const want = b.utr.trim().toUpperCase();
    /** @type {string[]} */
    const before = [];
    for (const order of /** @type {{order_id: string}[]} */ (ledger.orders())) {
      const paid = ledger.view(order.order_id).paid;
      for (const e of ofType(ledger.events(order.order_id), 'PAYMENT_CLAIM', 'in')) {
        const c = e.body.body;
        if (e.msgId === m.msg_id || typeof c.utr !== 'string' || c.utr.trim().toUpperCase() !== want) continue;
        if (b.group && c.group?.id === b.group.id) continue;
        if (paid[/** @type {string} */ (e.msgId)]?.status !== 'denied') before.push(`${o.refOf(order.order_id)}: ${paymentLine(c)}`);
      }
    }
    traceCheck(`UTR ${b.utr} ${before.length ? '✗ used before on this seller\'s orders' : '✓ not used before'}`, before.length === 0, { name: 'utr_seller', utr: b.utr, uses: before.length }, m.order_id);
    return before.length ? t('pay.seller.utr_seen', { utr: b.utr, before: before.join('; ') }) : '';
  }

  /**
   * The notice for a reported payment, or null while a clubbed payment's other shares are still on
   * their way (the group is told once, whole). Its हाँ confirms, its नहीं denies.
   * @param {Message} m a PAYMENT_CLAIM in our ledger
   * @returns {{key: string, params: Record<string, string | number>, expect: {tool: string, args: Record<string, any>, no: {tool: string, args: Record<string, any>}}} | null}
   */
  function claimNotice(m) {
    const b = m.body;
    const expect = { tool: 'confirm_payment', args: { orderId: m.order_id, payment: m.msg_id }, no: { tool: 'confirm_payment', args: { orderId: m.order_id, payment: m.msg_id, received: false } } };
    const seen = utrSeen(m);
    // Who the receipt says was paid, when the reader saw it: for the seller to look at.
    const name = plain(b.payeeName, 60);
    const payee = name ? `, ${t('pay.payee', { name })}` : '';
    if (b.group) {
      /** @type {[string, number][]} */
      const parts = [];
      for (const id of /** @type {string[]} */ (b.group.orders)) {
        const share = knownOrder(id) ? ofType(ledger.events(id), 'PAYMENT_CLAIM', 'in').find((e) => e.body.body.group?.id === b.group.id) : undefined;
        if (!share) return null;
        parts.push([id, share.body.body.amountPaise]);
      }
      const lines = groupLines(parts);
      // `ref`: the first order's, so that a notice missed outside the window is remembered and told again.
      return { key: 'pay.seller.group_claimed', params: { ref: o.refOf(parts[0][0]), payment: `${paymentLine({ ...b, amountPaise: b.group.totalPaise })}${payee}`, lines: seen ? `${lines}\n${seen}` : lines }, expect };
    }
    const key = variant('pay.seller.claimed', { advance: b.bill === null });
    const balance = balanceText(summaryOf(ledger, m.order_id));
    return { key, params: { ref: o.refOf(m.order_id), site: o.siteOf(m.order_id), payment: `${paymentLine(b)}${payee}`, balance: seen ? `${balance}। ${seen}` : balance }, expect };
  }

  /**
   * Called when the contractor's message is in our ledger: a reported payment is told (once per
   * group); an accepted bill that advances already cover is settled at once.
   * @param {Message} m
   */
  async function onApplied(m) {
    if (m.type === 'PAYMENT_CLAIM') {
      const n = claimNotice(m);
      if (n) await o.tell(o.role, n.key, n.params, n.expect);
    } else if (m.type === 'ACCEPT') {
      const s = await settleIfDue(m.order_id);
      if (s) await o.tell(o.role, variant('pay.seller.settled_at_accept', { credit: s.creditPaise > 0 }),
        { ref: o.refOf(m.order_id), site: o.siteOf(m.order_id), amount: rupees(s.confirmedPaise), ...(s.creditPaise > 0 ? { credit: rupees(s.creditPaise) } : {}) });
    }
  }

  return { tools, onApplied, claimNotice, settleIfDue };
}

/** A fresh group id for one payment shared among orders. */
export const newGroupId = () => randomUUID();
