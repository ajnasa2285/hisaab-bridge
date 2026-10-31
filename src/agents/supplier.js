// The supplier's agent: the material-selling twin of the JCB agent. The supplier answers an order
// with a rate per item, records what was delivered from a confirmed challan reading, sends the bill
// and, after a dispute, a correction; only the supplier can say the money has arrived. Every figure
// on a bill comes from the ledger (the rates from our own "yes", the quantities from our signed
// DELIVERY or the corrected ones the supplier typed); nothing is computed by a model.

import { rupees, day as dayName, qty } from '../i18n/format.js';
import { rateUsualNotes, withUsual } from './usual.js';
import { deliveryResult, isDay, isSha256, isTime, isUuid, no, ofType, posInt } from './common.js';
import { agreedRates, countDifferences, delivery, invoiceCheck, isGstPercent, itemsText, linesText, materialBillBody, rateFor, ratesText, requestedItems, sameChallanNo, signedWord, validItems } from './material.js';
import { t } from '../i18n/index.js';
import { openRefs } from '../ledger/refs.js';
import { variant } from '../i18n/index.js';
import { explainDifference } from './explain.js';
import { differenceFacts } from './explain-facts.js';
import { traceCheck } from '../trace/trace.js';
import { createSellerPayments } from './pay.js';
import { cancelTool, orderWords } from './cancel.js';
import { paymentWaiting } from './payment-view.js';

/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('./material.js').Item} Item */
/** @typedef {import('../protocol/messages.js').Message} Message */

const MAX_CHALLAN_NO = 40;

/**
 * @param {{
 *   agent: Parameters<typeof import('../protocol/exchange.js').prepare>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   spark?: import('./explain.js').Spark,
 * }} o
 */
export function createSupplierAgent(o) {
  const { agent, link, tell } = o;
  const ledger = agent.ledger;
  const refs = openRefs(ledger);
  /** The order's short reference for the texts. @param {string} orderId */
  const refOf = (orderId) => refs.refOf(orderId) ?? '—';
  // Only this seller can say the money has arrived; a screenshot or a claim is not money (CONTRACTS 4.1).
  const seller = createSellerPayments({ ledger, link, tell, role: 'supplier', settledKey: 'supplier.settled_sent',
    refOf: (id) => refOf(id), siteOf: (id) => siteOf(id), now: () => agent.now() });

  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string} | null} */ (ledger.order(orderId))?.counterparty ?? null;
  /** @param {string} orderId */
  const siteOf = (orderId) => (isUuid(orderId) ? /** @type {{site: string} | null} */ (ledger.order(orderId))?.site : null) ?? '—';
  /** @param {string} orderId */
  const eventsOf = (orderId) => (isUuid(orderId) && counterparty(orderId) ? ledger.events(orderId) : []);

  /**
   * One rate per requested item, in the request's order, from the rates the supplier wrote.
   * @param {string} orderId @param {unknown} ratesPaise @param {unknown} [gstPercents]
   */
  const ratesFromArgs = (orderId, ratesPaise, gstPercents) => {
    const items = requestedItems(eventsOf(orderId));
    if (!Array.isArray(ratesPaise) || items.length === 0 || ratesPaise.length !== items.length || !ratesPaise.every(posInt)) return null;
    // GST per rate is optional: one entry per rate, a GST slab or null where the supplier gave none.
    if (gstPercents !== undefined && (!Array.isArray(gstPercents) || gstPercents.length !== items.length || !gstPercents.every((g) => g === null || isGstPercent(g)))) return null;
    return items.map((it, i) => ({ name: it.name, unit: it.unit, ratePaise: /** @type {number} */ (ratesPaise[i]),
      ...(Array.isArray(gstPercents) && isGstPercent(gstPercents[i]) ? { gstPercent: gstPercents[i] } : {}) }));
  };

  /**
   * Corrected quantities, one per delivered item in the delivery's order.
   * @param {string} orderId @param {unknown} qtys @returns {Item[] | null}
   */
  const correctedItems = (orderId, qtys) => {
    const d = delivery(eventsOf(orderId));
    if (!d || !Array.isArray(qtys) || qtys.length !== d.items.length || !qtys.every(posInt)) return null;
    return d.items.map((it, i) => ({ ...it, qtyHundredths: /** @type {number} */ (qtys[i]) }));
  };

  /** @type {Record<string, Tool>} */
  const tools = {
    // The supplier answers an order: yes (with a rate for each item), no, or another day/time.
    reply_order: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => {
        const rates = isUuid(a.orderId) ? ratesFromArgs(a.orderId, a.ratesPaise, a.gstPercents) : null;
        // The day the answer is about: another day when offered, else the day asked for.
        const day = isDay(a.day) ? a.day : ofType(eventsOf(a.orderId), 'BOOKING_REQUEST', 'in').at(-1)?.body.body.day;
        const time = a.answer === 'other_time' && isTime(a.time) ? a.time : null;
        return withUsual({
          key: variant(`step.reply_order_${a.answer}`, { time }),
          params: { site: siteOf(a.orderId), day: isDay(day) ? dayName(day) : '—', ...(time ? { time } : {}), rates: rates ? ratesText(rates) : '—' },
        }, a.answer === 'yes' && rates ? rateUsualNotes(ledger, a.orderId, rates) : '');
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if (!['yes', 'no', 'other_time'].includes(a.answer)) return no('common.bad_args');
        const rates = a.answer === 'yes' ? ratesFromArgs(a.orderId, a.ratesPaise, a.gstPercents) : null;
        if (a.answer === 'yes' && rates === null) return no('supplier.rates_needed', { items: itemsText(requestedItems(ledger.events(a.orderId))) || '—' });
        if (a.answer === 'other_time' && !isDay(a.day)) return no('jcb.day_needed');
        if ((a.time !== undefined && !isTime(a.time)) || (a.day !== undefined && !isDay(a.day))) return no('common.bad_args');
        /** @type {Record<string, any>} */
        const body = { answer: a.answer };
        if (a.day !== undefined) body.day = a.day;
        if (a.time !== undefined) body.time = a.time;
        if (rates !== null) body.rates = rates;
        const d = await link.send({ type: 'BOOKING_REPLY', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        // One receipt of what was sent, with the figures.
        const day = isDay(a.day) ? a.day : ofType(ledger.events(a.orderId), 'BOOKING_REQUEST', 'in').at(-1)?.body.body.day;
        return withUsual(deliveryResult(d, `supplier.reply_sent_${a.answer}`, { ref: refOf(a.orderId), site: siteOf(a.orderId), day: isDay(day) ? dayName(day) : '—', ...(rates ? { rates: ratesText(rates) } : {}) }),
          d.ok && rates ? rateUsualNotes(ledger, a.orderId, rates) : '');
      },
    },

    // The supplier confirms what a challan photo shows as delivered; the photo's fingerprint goes with it.
    record_delivery: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => {
        const challan = typeof a.challanNo === 'string' && a.challanNo ? a.challanNo : null;
        return {
          key: variant('step.record_delivery', { challan }),
          params: { site: siteOf(a.orderId), items: validItems(a.items) ? itemsText(a.items) : '—', ...(challan ? { challan } : {}) },
        };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if (!validItems(a.items) || !isSha256(a.sha256)) return no('common.bad_args');
        if (a.challanNo !== undefined && a.challanNo !== null && (typeof a.challanNo !== 'string' || !a.challanNo.trim() || a.challanNo.length > MAX_CHALLAN_NO)) return no('common.bad_args');
        const rates = agreedRates(ledger.events(a.orderId));
        if (rates === null) return no('common.wrong_state');
        // Only what was agreed can be delivered and billed: each item once, at an agreed rate.
        const keys = new Set();
        for (const it of /** @type {Item[]} */ (a.items)) {
          const key = JSON.stringify([it.name, it.unit]);
          if (rateFor(rates, it) === null || keys.has(key)) return no('supplier.item_not_agreed', { item: `${it.name} (${it.unit})` });
          keys.add(key);
        }
        /** @type {Record<string, any>} */
        const challan = { sha256: a.sha256 };
        if (typeof a.challanNo === 'string') challan.number = a.challanNo.trim();
        // What a tax invoice printed for each item (GST rate, rate, taxable value) and its grand total,
        // as read by the challan reader; a figure that is not usable is left out, never guessed.
        const printed = Array.isArray(a.invoice?.lines) ? a.invoice.lines : [];
        const items = /** @type {Item[]} */ (a.items).map((it, i) => {
          const p = printed[i] ?? {};
          return { name: it.name, qtyHundredths: it.qtyHundredths, unit: it.unit,
            ...(isGstPercent(p.gstPercent) ? { gstPercent: p.gstPercent } : {}),
            ...(posInt(p.ratePaise) ? { invoiceRatePaise: p.ratePaise } : {}),
            ...(posInt(p.taxablePaise) ? { taxablePaise: p.taxablePaise } : {}) };
        });
        const grand = a.invoice?.grandTotalPaise;
        const body = { items, challan, deliveredAt: new Date(agent.now()).toISOString(), ...(posInt(grand) ? { grandTotalPaise: grand } : {}) };
        const d = await link.send({ type: 'DELIVERY', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(d, 'supplier.delivery_sent', { ref: refOf(a.orderId), site: siteOf(a.orderId), items: itemsText(items) });
      },
    },

    // The supplier sends the bill: delivered quantities × the rates of our "yes", the challan as evidence.
    send_bill: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => {
        const events = eventsOf(a.orderId);
        const d = delivery(events);
        const rates = agreedRates(events);
        const body = d && rates ? materialBillBody(d.items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
        // A tax invoice's grand total is compared by code; a different one is shown beside the bill's.
        const check = body && d ? invoiceCheck(d.grandTotalPaise, body.totalPaise) : null;
        return {
          key: variant('step.send_material_bill', { invoice_match: check === 'match', invoice_differs: check === 'differs' }),
          params: { site: siteOf(a.orderId), lines: body && d ? linesText(body.lines, d.items) : '—', total: body ? rupees(body.totalPaise) : '—',
            ...(check === 'differs' && d ? { invoiceTotal: rupees(/** @type {number} */ (d.grandTotalPaise)) } : {}) },
        };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        const events = ledger.events(a.orderId);
        const d = delivery(events);
        if (!d) return no('supplier.delivery_missing');
        const rates = agreedRates(events);
        const body = rates ? materialBillBody(d.items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
        if (body === null) return no('common.wrong_state');
        const check = invoiceCheck(d.grandTotalPaise, body.totalPaise);
        if (check !== null) {
          traceCheck(`bill total ${check === 'match' ? '✓ =' : '✗ ≠'} invoice grand total: ${rupees(body.totalPaise)} / ${rupees(/** @type {number} */ (d.grandTotalPaise))}`,
            check === 'match', { name: 'invoice_total', billPaise: body.totalPaise, invoicePaise: d.grandTotalPaise }, a.orderId);
        }
        const sent = await link.send({ type: 'BILL', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(sent, variant('supplier.bill_sent', { invoice_match: check === 'match', invoice_differs: check === 'differs' }),
          { lines: linesText(body.lines, d.items), total: rupees(body.totalPaise), ...(check === 'differs' ? { invoiceTotal: rupees(/** @type {number} */ (d.grandTotalPaise)) } : {}) });
      },
    },

    // After a dispute the supplier may send corrected quantities; the bill it replaces stays in history.
    send_correction: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => {
        const items = isUuid(a.orderId) ? correctedItems(a.orderId, a.qtysHundredths) : null;
        const rates = items ? agreedRates(ledger.events(a.orderId)) : null;
        const d = delivery(eventsOf(a.orderId));
        const body = items && rates && d ? materialBillBody(items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
        return { key: 'step.send_material_correction', params: { site: siteOf(a.orderId), lines: body && items ? linesText(body.lines, items) : '—', total: body ? rupees(body.totalPaise) : '—' } };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        const items = correctedItems(a.orderId, a.qtysHundredths);
        if (items === null) return no('common.bad_args');
        const events = ledger.events(a.orderId);
        const view = ledger.view(a.orderId);
        const rates = agreedRates(events);
        const d = /** @type {NonNullable<ReturnType<typeof delivery>>} */ (delivery(events));
        const bill = rates ? materialBillBody(items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
        if (bill === null || view.currentBill === null) return no('common.wrong_state');
        const body = { ...bill, replaces: view.currentBill };
        const sent = await link.send({ type: 'CORRECTION', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(sent, 'supplier.correction_sent', { lines: linesText(body.lines, items), total: rupees(body.totalPaise) });
      },
    },
    // Calling off an order never carried out.
    cancel_order: cancelTool({ ledger, link, tell, roles: ['supplier'] }),
    // Payments: confirm_payment and record_received (src/agents/pay.js, the same for both sellers).
    ...seller.tools,
  };

  /**
   * The site's signed copy of our challan (SITE_RECEIPT), already in our ledger: code checks it against
   * our own signed DELIVERY (the challan number, ignoring case, spaces and leading zeros, and every item
   * by name and unit) and tells the supplier both figures. A different number is shown, never accepted
   * silently; nothing is decided and nobody is reminded.
   * @param {Message} m
   */
  async function onSiteReceipt(m) {
    const b = m.body;
    const d = delivery(ledger.events(m.order_id));
    const siteNo = typeof b.challan.number === 'string' ? b.challan.number : null;
    const params = {
      ref: refOf(m.order_id), site: siteOf(m.order_id), count: itemsText(b.items), siteNo: siteNo ?? '—',
      challan: d ? itemsText(d.items) : '—', challanNo: d?.number ?? '—',
      signed: t(`supplier.site_receipt_signed_${signedWord(typeof b.signed === 'boolean' ? b.signed : null)}`),
    };
    let key = 'supplier.site_receipt_matches';
    if (!d || d.msgId !== b.delivery) key = 'supplier.site_receipt_other_delivery';
    else if (siteNo !== null && d.number !== null && !sameChallanNo(siteNo, d.number)) key = 'supplier.site_receipt_number_differs';
    else if (siteNo === null || d.number === null) key = 'supplier.site_receipt_number_unknown';
    else if (countDifferences(b.items, d.items).length > 0) key = 'supplier.site_receipt_differs';
    traceCheck(`site's signed copy: ${key.replace('supplier.site_receipt_', '').replaceAll('_', ' ')} (challan ${siteNo ?? '?'} / ${d?.number ?? '?'})`,
      key === 'supplier.site_receipt_matches', { name: 'site_receipt', site: siteNo, delivery: d?.number ?? null, signed: typeof b.signed === 'boolean' ? b.signed : null }, m.order_id);
    await tell('supplier', key, params);
  }

  /** @typedef {{key: string, params: Record<string, string | number>}} Notice */

  /**
   * The notice for a contractor's message that asks something of the supplier (an order, an objection
   * to the bill, a reported payment). The same text when first told and when told again after a
   * missed 24-hour window (waiting()).
   * @param {Message} m @returns {Notice | null}
   */
  function supplierNotice(m) {
    const b = m.body;
    switch (m.type) {
      case 'BOOKING_REQUEST':
        return { key: variant('supplier.order_request', { time: b.time }), params: { ref: refOf(m.order_id), site: b.site, day: dayName(b.day), ...(b.time ? { time: b.time } : {}), items: itemsText(b.items ?? []) || '—' } };
      case 'DISPUTE': {
        // A quantity is shown in the unit of the delivered item when the bill has one line.
        const d = delivery(ledger.events(m.order_id));
        const unit = d && d.items.length === 1 ? d.items[0].unit : '';
        const f = b.theirFigure ?? {};
        // How to answer with a correction ("सुधार 48 बोरी"): the quantity the contractor named on a
        // one-line bill, else the delivered quantities in order.
        const example = d && d.items.length === 1
          ? qty(posInt(f.qtyHundredths) ? f.qtyHundredths : d.items[0].qtyHundredths, unit).trim()
          : d ? d.items.map((it) => qty(it.qtyHundredths, '').trim()).join(' ') : '48';
        return { key: 'supplier.bill_disputed', params: {
          ref: refOf(m.order_id),
          site: siteOf(m.order_id),
          their: posInt(f.qtyHundredths) ? qty(f.qtyHundredths, unit).trim() : posInt(f.totalPaise) ? rupees(f.totalPaise) : '—',
          reason: b.reason,
          example,
        } };
      }
      case 'PAYMENT_CLAIM':
        // Part, cash, advance or a share of a clubbed payment, with the balance (src/agents/pay.js).
        return seller.claimNotice(m);
      default:
        return null;
    }
  }

  /**
   * Called once when the contractor's agent's message has been written to our ledger.
   * @param {Message} m
   */
  async function onApplied(m) {
    const n = supplierNotice(m);
    switch (m.type) {
      case 'BOOKING_REQUEST':
        if (n) await tell('supplier', n.key, n.params);
        break;
      case 'SITE_RECEIPT':
        await onSiteReceipt(m);
        break;
      case 'ACCEPT':
        await tell('supplier', 'supplier.bill_accepted', { ref: refOf(m.order_id), site: siteOf(m.order_id) });
        // Advances already covering the bill settle it now.
        await seller.onApplied(m);
        break;
      case 'DISPUTE': {
        if (n) await tell('supplier', n.key, n.params);
        const explanation = await explainDifference({ spark: o.spark, audience: 'seller', facts: differenceFacts(ledger, m.order_id, refOf(m.order_id)) });
        await tell('supplier', explanation.key, explanation.params);
        break;
      }
      case 'PAYMENT_CLAIM':
        await seller.onApplied(m);
        break;
      case 'CANCEL':
        await tell('supplier', 'supplier.order_cancelled', orderWords(ledger, m.order_id));
        break;
      default:
        break;
    }
  }

  // What still waits for the supplier, by the order's state, and the message that asked for it.
  /** @type {Record<string, string>} */
  const WAITS = { requested: 'BOOKING_REQUEST', disputed: 'DISPUTE' };

  /**
   * What is still waiting for the supplier, rebuilt from the ledger: open orders, objections and
   * reported payments, each as its notice would be told now.
   * @param {string} role @returns {Notice[]}
   */
  function waiting(role) {
    if (role !== 'supplier') return [];
    /** @type {Notice[]} */
    const out = paymentWaiting(ledger);
    for (const order of /** @type {{order_id: string}[]} */ (ledger.orders())) {
      const type = WAITS[ledger.view(order.order_id).state];
      const e = type ? ofType(ledger.events(order.order_id), type, 'in').at(-1) : undefined;
      const n = e ? supplierNotice(/** @type {Message} */ (e.body)) : null;
      if (n) out.push(n);
    }
    return out;
  }

  return { tools, onApplied, waiting };
}
