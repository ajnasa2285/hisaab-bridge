// The supplier's agent: the material-selling twin of the JCB agent. The supplier answers an order
// with a rate per item, records what was delivered from a confirmed challan reading, sends the bill
// and, after a dispute, a correction; only the supplier can say the money has arrived. Every figure
// on a bill comes from the ledger (the rates from our own "yes", the quantities from our signed
// DELIVERY or the corrected ones the supplier typed); nothing is computed by a model.

import { rupees, day as dayName, qty } from '../i18n/format.js';
import { deliveryResult, isDay, isSha256, isTime, isUuid, no, ofType, posInt } from './common.js';
import { agreedRates, countDifferences, delivery, itemsText, linesText, materialBillBody, rateFor, ratesText, requestedItems, sameChallanNo, signedWord, validItems } from './material.js';
import { t } from '../i18n/index.js';
import { openRefs } from '../ledger/refs.js';
import { explainDifference } from './explain.js';
import { differenceFacts } from './explain-facts.js';

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

  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string} | null} */ (ledger.order(orderId))?.counterparty ?? null;
  /** @param {string} orderId */
  const siteOf = (orderId) => (isUuid(orderId) ? /** @type {{site: string} | null} */ (ledger.order(orderId))?.site : null) ?? '—';
  /** @param {string} orderId */
  const eventsOf = (orderId) => (isUuid(orderId) && counterparty(orderId) ? ledger.events(orderId) : []);

  /**
   * One rate per requested item, in the request's order, from the rates the supplier wrote.
   * @param {string} orderId @param {unknown} ratesPaise
   */
  const ratesFromArgs = (orderId, ratesPaise) => {
    const items = requestedItems(eventsOf(orderId));
    if (!Array.isArray(ratesPaise) || items.length === 0 || ratesPaise.length !== items.length || !ratesPaise.every(posInt)) return null;
    return items.map((it, i) => ({ name: it.name, unit: it.unit, ratePaise: /** @type {number} */ (ratesPaise[i]) }));
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
        const rates = isUuid(a.orderId) ? ratesFromArgs(a.orderId, a.ratesPaise) : null;
        // The day the answer is about: another day when offered, else the day asked for.
        const day = isDay(a.day) ? a.day : ofType(eventsOf(a.orderId), 'BOOKING_REQUEST', 'in').at(-1)?.body.body.day;
        return {
          key: `step.reply_order_${a.answer}`,
          params: { site: siteOf(a.orderId), day: isDay(day) ? dayName(day) : '—', time: a.time ?? '—', rates: rates ? ratesText(rates) : '—' },
        };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if (!['yes', 'no', 'other_time'].includes(a.answer)) return no('common.bad_args');
        const rates = a.answer === 'yes' ? ratesFromArgs(a.orderId, a.ratesPaise) : null;
        if (a.answer === 'yes' && rates === null) return no('supplier.rates_needed', { items: itemsText(requestedItems(ledger.events(a.orderId))) || '—' });
        if (a.answer === 'other_time' && !isDay(a.day)) return no('jcb.day_needed');
        if ((a.time !== undefined && !isTime(a.time)) || (a.day !== undefined && !isDay(a.day))) return no('common.bad_args');
        /** @type {Record<string, any>} */
        const body = { answer: a.answer };
        if (a.day !== undefined) body.day = a.day;
        if (a.time !== undefined) body.time = a.time;
        if (rates !== null) body.rates = rates;
        const d = await link.send({ type: 'BOOKING_REPLY', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(d, `supplier.reply_sent_${a.answer}`);
      },
    },

    // The supplier confirms what a challan photo shows as delivered; the photo's fingerprint goes with it.
    record_delivery: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => ({
        key: 'step.record_delivery',
        params: { site: siteOf(a.orderId), items: validItems(a.items) ? itemsText(a.items) : '—', challan: typeof a.challanNo === 'string' && a.challanNo ? a.challanNo : '—' },
      }),
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
        const items = /** @type {Item[]} */ (a.items).map((it) => ({ name: it.name, qtyHundredths: it.qtyHundredths, unit: it.unit }));
        const body = { items, challan, deliveredAt: new Date(agent.now()).toISOString() };
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
        return { key: 'step.send_material_bill', params: { site: siteOf(a.orderId), lines: body && d ? linesText(body.lines, d.items) : '—', total: body ? rupees(body.totalPaise) : '—' } };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        const events = ledger.events(a.orderId);
        const d = delivery(events);
        if (!d) return no('supplier.delivery_missing');
        const rates = agreedRates(events);
        const body = rates ? materialBillBody(d.items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
        if (body === null) return no('common.wrong_state');
        const sent = await link.send({ type: 'BILL', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(sent, 'supplier.bill_sent', { lines: linesText(body.lines, d.items), total: rupees(body.totalPaise) });
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

    // Only the supplier can say the money has arrived; a screenshot from the contractor is a claim.
    confirm_payment: {
      roles: ['supplier'],
      commits: true,
      describe: (a) => {
        const view = isUuid(a.orderId) && ledger.order(a.orderId) ? ledger.view(a.orderId) : null;
        const amount = view?.payment ? ledger.eventOfMessage(view.payment)?.body.body.amountPaise : undefined;
        return { key: 'step.confirm_payment', params: { site: siteOf(a.orderId), amount: posInt(amount) ? rupees(amount) : '—' } };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        const view = ledger.view(a.orderId);
        if (view.state !== 'payment_claimed' || view.payment === null || view.currentBill === null) return no('common.wrong_state');
        const claim = ledger.eventOfMessage(view.payment);
        const amountPaise = claim?.body.body.amountPaise;
        if (!posInt(amountPaise)) return no('common.wrong_state');
        const d = await link.send({ type: 'SETTLED', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body: { bill: view.currentBill, payment: view.payment, amountPaise } });
        return deliveryResult(d, 'supplier.settled_sent', { amount: rupees(amountPaise) });
      },
    },
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
    await tell('supplier', key, params);
  }

  /**
   * Called once when the contractor's agent's message has been written to our ledger.
   * @param {Message} m
   */
  async function onApplied(m) {
    const b = m.body;
    switch (m.type) {
      case 'BOOKING_REQUEST':
        await tell('supplier', 'supplier.order_request', { ref: refOf(m.order_id), site: b.site, day: dayName(b.day), time: b.time ?? '—', items: itemsText(b.items ?? []) || '—' });
        break;
      case 'SITE_RECEIPT':
        await onSiteReceipt(m);
        break;
      case 'ACCEPT':
        await tell('supplier', 'supplier.bill_accepted', { ref: refOf(m.order_id), site: siteOf(m.order_id) });
        break;
      case 'DISPUTE': {
        // A quantity is shown in the unit of the delivered item when the bill has one line.
        const d = delivery(ledger.events(m.order_id));
        const unit = d && d.items.length === 1 ? d.items[0].unit : '';
        const f = b.theirFigure ?? {};
        await tell('supplier', 'supplier.bill_disputed', {
          ref: refOf(m.order_id),
          site: siteOf(m.order_id),
          their: posInt(f.qtyHundredths) ? qty(f.qtyHundredths, unit).trim() : posInt(f.totalPaise) ? rupees(f.totalPaise) : '—',
          reason: b.reason,
        });
        const explanation = await explainDifference({ spark: o.spark, audience: 'seller', facts: differenceFacts(ledger, m.order_id, refOf(m.order_id)) });
        await tell('supplier', explanation.key, explanation.params);
        break;
      }
      case 'PAYMENT_CLAIM':
        // With the receipt's clock when it was visible; an old claim without `paidAt` reads as before.
        await tell('supplier', typeof b.paidAt === 'string' ? 'supplier.payment_claimed_at' : 'supplier.payment_claimed', { ref: refOf(m.order_id), site: siteOf(m.order_id), amount: rupees(b.amountPaise), utr: b.utr, day: dayName(b.paidOn), ...(typeof b.paidAt === 'string' ? { time: b.paidAt } : {}) }, { tool: 'confirm_payment', args: { orderId: m.order_id } });
        break;
      default:
        break;
    }
  }

  return { tools, onApplied };
}
