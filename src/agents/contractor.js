// The contractor's agent: booking a JCB or ordering material, the site's own count of a delivery,
// answering a bill (accept or dispute with the site's own figure), and telling the seller that a
// payment was made. A payment claim is only a claim; the order is settled when the JCB owner or the
// supplier confirms the money arrived. A material bill is checked by code against the signed
// delivery and the agreed rates before anyone is asked to accept it.

import { randomUUID } from 'node:crypto';
import { billUsualNotes, requestUsualNotes, withUsual } from './usual.js';
import { tenths as hours, rupees, day as dayName, qty } from '../i18n/format.js';
import { deliveryResult, isDay, isSha256, isTime, isUuid, no, nonNegInt, ofType, ok, posInt } from './common.js';
import { safeName } from '../protocol/names.js';
import { agreedRates, billFollows, countDifferences, delivery, gstPaise, invoiceCheck, isGstPercent, itemsText, itemsTotalPaise, lineAmountPaise, linesText, materialBillBody, ratesText, requestedItems, sameChallanNo, sameItems, siteChallan, siteCount, validItems } from './material.js';
import { openRefs } from '../ledger/refs.js';
import { t, variant } from '../i18n/index.js';
import { explainDifference } from './explain.js';
import { differenceFacts } from './explain-facts.js';
import { traceCheck } from '../trace/trace.js';
import { PAYABLE, balanceText, newGroupId, paymentLine, shares, summaryOf, utrUses } from './pay.js';
import { cancelTool, orderWords } from './cancel.js';

/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('./material.js').Item} Item */

// The same shape the UPI reader accepts (src/readers/upi.js): a clear reading must not dead-end here.
const UTR_RE = /^[A-Za-z0-9-]{6,64}$/;

/**
 * @param {{
 *   agent: Parameters<typeof import('../protocol/exchange.js').prepare>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   spark?: import('./explain.js').Spark,
 *   jcbAgentId: string,
 *   supplierAgentId?: string,
 *   evidence?: {countDifference: (orderId: string) => Promise<void>, disputedBill: (orderId: string) => Promise<void>},
 * }} o
 */
export function createContractorAgent(o) {
  const { agent, link, tell } = o;
  const ledger = agent.ledger;
  const refs = openRefs(ledger);
  /** The order's short reference for the texts. @param {string} orderId */
  const refOf = (orderId) => refs.refOf(orderId) ?? '—';

  /** @param {string} orderId */
  const known = (orderId) => isUuid(orderId) && ledger.order(orderId) !== null;
  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string}} */ (ledger.order(orderId)).counterparty;
  /** @param {string} orderId */
  const siteOf = (orderId) => (isUuid(orderId) ? /** @type {{site: string} | null} */ (ledger.order(orderId))?.site : null) ?? '—';
  /** @param {string} orderId */
  const isMaterial = (orderId) => known(orderId) && /** @type {{kind: string}} */ (ledger.order(orderId)).kind === 'material';
  /** The JCB text key, or its material twin for a material order. @param {string} orderId @param {string} key */
  const keyFor = (orderId, key) => (isMaterial(orderId) ? key.replace(/^site\./, 'site.material_') : key);
  /** A quantity in the unit of the delivered item when there is one, else the bare figure. @param {string} orderId @param {number} q */
  const qtyOf = (orderId, q) => {
    const d = known(orderId) ? delivery(ledger.events(orderId)) : null;
    return qty(q, d && d.items.length === 1 ? d.items[0].unit : '').trim();
  };
  /**
   * The site's count as items: one figure (0 allowed) per delivered item, in the challan's order.
   * @param {string} orderId @param {unknown} qtys @returns {Item[] | null}
   */
  const countedItems = (orderId, qtys) => {
    const d = isMaterial(orderId) ? delivery(ledger.events(orderId)) : null;
    if (!d || !Array.isArray(qtys) || qtys.length !== d.items.length || !qtys.every(nonNegInt)) return null;
    return d.items.map((it, i) => ({ name: it.name, qtyHundredths: /** @type {number} */ (qtys[i]), unit: it.unit }));
  };

  /**
   * The site's count from its own copy of the challan: one figure (0 allowed) per ordered item, in the
   * order's order, not all 0; the items at 0 are left out (they did not come).
   * @param {string} orderId @param {unknown} qtys @returns {Item[] | null}
   */
  const challanItems = (orderId, qtys) => {
    const ordered = isMaterial(orderId) ? requestedItems(ledger.events(orderId)) : [];
    if (!ordered.length || !Array.isArray(qtys) || qtys.length !== ordered.length || !qtys.every(nonNegInt) || qtys.every((q) => q === 0)) return null;
    return ordered.map((it, i) => ({ name: it.name, qtyHundredths: /** @type {number} */ (qtys[i]), unit: it.unit })).filter((it) => it.qtyHundredths > 0);
  };
  /** "बालू (cft), सीमेंट (बोरी)": the order's items, for typing figures in order. @param {string} orderId */
  const orderedNames = (orderId) => (isMaterial(orderId) ? requestedItems(ledger.events(orderId)) : []).map((i) => `${i.name} (${i.unit})`).join(', ') || '—';
  /**
   * A challan as evidence: the photo's fingerprint, the number as read and confirmed and, optionally,
   * whether the reader saw the receiver's mark on it (`signed`: true, false or null when unsure).
   * @param {unknown} c
   */
  const validChallan = (c) => {
    const x = /** @type {any} */ (c);
    return !!x && typeof x === 'object' && isSha256(x.sha256)
      && (x.number === null || (typeof x.number === 'string' && x.number.trim().length > 0 && x.number.length <= 40))
      && (x.signed === undefined || x.signed === null || typeof x.signed === 'boolean');
  };
  /**
   * The site's count against the supplier's signed delivery: the quantity of each item and, when both
   * are known, the challan numbers. Code compares; a difference is told with both figures.
   * @param {string} orderId @param {Item[]} count @param {string | null} siteNo
   * @param {NonNullable<ReturnType<typeof delivery>>} d
   */
  const compareCount = (orderId, count, siteNo, d) => {
    const numbersDiffer = siteNo !== null && d.number !== null && !sameChallanNo(siteNo, d.number);
    const itemsDiffer = countDifferences(count, d.items).length > 0;
    traceCheck(`site count vs signed delivery ${itemsDiffer ? '✗ differs' : '✓ matches'}: ${itemsText(count)} / ${itemsText(d.items)}`, !itemsDiffer,
      { name: 'count_vs_delivery', count, delivered: d.items }, orderId);
    if (siteNo !== null && d.number !== null) {
      traceCheck(`challan number ${numbersDiffer ? '✗' : '✓'} ${siteNo} ${numbersDiffer ? '≠' : '='} ${d.number}`, !numbersDiffer, { name: 'challan_number', site: siteNo, delivery: d.number }, orderId);
    }
    return {
      same: countDifferences(count, d.items).length === 0 && !numbersDiffer,
      params: { ref: refOf(orderId), site: siteOf(orderId), count: itemsText(count), siteNo: siteNo ?? '—', challan: itemsText(d.items), challanNo: d.number ?? '—' },
    };
  };

  /**
   * Every "yes" from one seller over the orders of one kind with that seller, oldest first.
   * @param {'jcb_hours' | 'material'} kind @param {string | undefined} seller
   */
  const yesReplies = (kind, seller) => /** @type {{order_id: string, kind: string, counterparty: string}[]} */ (ledger.orders())
    .filter((r) => r.kind === kind && r.counterparty === seller)
    .flatMap((r) => ofType(ledger.events(r.order_id), 'BOOKING_REPLY', 'in').filter((e) => e.body.body.answer === 'yes'))
    .sort((a, b) => a.seq - b.seq);
  /** The last hourly rate the JCB owner agreed to, or null. */
  const lastJcbRate = () => {
    const r = yesReplies('jcb_hours', o.jcbAgentId).filter((e) => posInt(e.body.body.ratePaise)).at(-1);
    return r ? /** @type {number} */ (r.body.body.ratePaise) : null;
  };
  /**
   * The last rate this supplier agreed for this item and unit (compared ignoring case), or null.
   * @param {string | undefined} seller @param {{name: string, unit: string}} it
   */
  const lastMaterialRate = (seller, it) => {
    const same = (/** @type {string} */ x, /** @type {string} */ y) => x.trim().toLowerCase() === y.trim().toLowerCase();
    for (const e of yesReplies('material', seller).reverse()) {
      const r = (e.body.body.rates ?? []).find((/** @type {any} */ x) => same(x.name, it.name) && same(x.unit, it.unit));
      if (r) return /** @type {number} */ (r.ratePaise);
    }
    return null;
  };

  /**
   * The last GST percent known for this supplier, item and unit (the supplier's yes, else the tax
   * invoice carried on that delivery), or null.
   * @param {string | undefined} seller @param {{name: string, unit: string}} it
   */
  const lastMaterialGst = (seller, it) => {
    const same = (/** @type {{name: string, unit: string}} */ x) => x.name.trim().toLowerCase() === it.name.trim().toLowerCase() && x.unit.trim().toLowerCase() === it.unit.trim().toLowerCase();
    for (const e of yesReplies('material', seller).reverse()) {
      const said = (e.body.body.rates ?? []).find(same)?.gstPercent;
      if (isGstPercent(said)) return said;
      const read = delivery(ledger.events(e.orderId))?.items.find(same)?.gstPercent;
      if (isGstPercent(read)) return read;
    }
    return null;
  };

  /** Only context for the contractor; these comparisons never take part in the approval gate.
   * @param {Record<string, any>} a @param {'jcb_hours'|'material'} kind @param {boolean} estimate
   */
  const requestNotes = (a, kind, estimate) => {
    const peer = a.orderId !== undefined && known(a.orderId) ? counterparty(a.orderId)
      : kind === 'jcb_hours' ? o.jcbAgentId : o.supplierAgentId;
    if (kind === 'jcb_hours') return posInt(a.hoursTenths)
      ? requestUsualNotes(ledger, peer, [{ name: 'JCB', unit: 'घंटे', quantity: a.hoursTenths, rate: lastJcbRate() }], 'hours', a.orderId, estimate) : '';
    return validItems(a.items) ? requestUsualNotes(ledger, peer, a.items.map((it) => ({ name: it.name, unit: it.unit,
      quantity: it.qtyHundredths, rate: lastMaterialRate(peer, it) })), 'quantity', a.orderId, estimate) : '';
  };

  /** Append the usual context to the contractor's existing bill notice, preserving its decision.
   * @param {string} orderId @param {Record<string, any>} body @param {string} key
   * @param {Record<string, string | number>} params @param {Parameters<Tell>[3]} [expect]
   */
  const tellBill = (orderId, body, key, params, expect) => {
    const notice = withUsual({ key, params }, billUsualNotes(ledger, orderId, body));
    return tell('contractor', notice.key, notice.params, expect);
  };

  /** The total of the bill in force, as the read-back shows it. @param {string} orderId */
  const billTotal = (orderId) => {
    if (!known(orderId)) return '—';
    const bill = ledger.view(orderId).currentBill;
    const total = bill ? ledger.eventOfMessage(bill)?.body.body.totalPaise : undefined;
    return posInt(total) ? rupees(total) : '—';
  };

  /**
   * A JCB request as a plain statement, with only the parts given: "शिवपुरी पर 30 अक्टूबर 2026 को 8 बजे
   * से JCB, 6 घंटे". @param {Record<string, any>} a @returns {{key: string, params: Record<string, string>}}
   */
  const jcbSummary = (a) => ({
    key: variant('what.jcb', { time: isTime(a.time), hours: posInt(a.hoursTenths) }),
    params: {
      site: typeof a.site === 'string' ? a.site : '—', day: isDay(a.day) ? dayName(a.day) : '—',
      ...(isTime(a.time) ? { time: a.time } : {}), ...(posInt(a.hoursTenths) ? { hours: hours(a.hoursTenths) } : {}),
    },
  });
  /**
   * A material request as a plain statement: "शिवपुरी पर 30 अक्टूबर 2026 को: सीमेंट 50 बोरी".
   * @param {Record<string, any>} a @returns {{key: string, params: Record<string, string>}}
   */
  const materialSummary = (a) => ({
    key: variant('what.material', { time: isTime(a.time) }),
    params: {
      site: typeof a.site === 'string' ? a.site : '—', day: isDay(a.day) ? dayName(a.day) : '—',
      ...(isTime(a.time) ? { time: a.time } : {}), items: validItems(a.items) ? itemsText(a.items) : '—',
    },
  });
  /** @param {{key: string, params: Record<string, string>}} w */
  const said = (w) => t(w.key, w.params);

  /** Who is told of a payment on this order: the JCB owner or the supplier. @param {string} orderId */
  const toWhom = (orderId) => t(isMaterial(orderId) ? 'pay.to.supplier' : 'pay.to.jcb');
  /** Several orders, all known, all with the same seller, none twice. @param {unknown} ids @returns {ids is string[]} */
  const groupOk = (ids) => Array.isArray(ids) && ids.length >= 2 && ids.length <= 20 && new Set(ids).size === ids.length
    && ids.every((id) => known(id)) && new Set(ids.map((id) => counterparty(id))).size === 1;
  /**
   * The parts of a claim's body that do not depend on the order: method, amount, day and, for UPI,
   * the UTR and screenshot (cash: no UTR; a receipt photo optional). Null when anything is wrong.
   * @param {Record<string, any>} a @returns {Record<string, any> | null}
   */
  const paymentBody = (a) => {
    const method = a.method ?? 'upi';
    if (!posInt(a.amountPaise) || !isDay(a.paidOn) || (method !== 'upi' && method !== 'cash')) return null;
    // `paidAt`: the clock printed on the receipt (HH:MM), sent only when it was visible.
    if (a.paidAt !== undefined && a.paidAt !== null && !isTime(a.paidAt)) return null;
    /** @type {Record<string, any>} */
    const body = { amountPaise: a.amountPaise, paidOn: a.paidOn };
    if (method === 'cash') {
      if (a.utr !== undefined || (a.screenshotSha256 !== undefined && !isSha256(a.screenshotSha256))) return null;
      body.method = 'cash';
      if (a.screenshotSha256 !== undefined) body.screenshot = { sha256: a.screenshotSha256 };
    } else {
      if (typeof a.utr !== 'string' || !UTR_RE.test(a.utr) || !isSha256(a.screenshotSha256)) return null;
      Object.assign(body, { utr: a.utr, screenshot: { sha256: a.screenshotSha256 } });
    }
    if (typeof a.paidAt === 'string') body.paidAt = a.paidAt;
    // The payee the UPI reader saw, as read: only shown to the seller, code decides nothing from it.
    if (method === 'upi' && typeof a.payeeName === 'string' && a.payeeName) body.payeeName = a.payeeName;
    return body;
  };
  /**
   * One line per share: "P-1: ₹20,650" (before sending; "अग्रिम" for an order without a bill), or with
   * the balance now (after). @param {{orderId: string, amountPaise: number}[]} split @param {boolean} [after]
   */
  const shareLines = (split, after = false) => split.map((x) => t(after ? 'pay.line' : variant('pay.share', { advance: ledger.view(x.orderId).currentBill === null }), {
    ref: refOf(x.orderId), amount: rupees(x.amountPaise), ...(after ? { balance: balanceText(summaryOf(ledger, x.orderId)) } : {}),
  })).join('\n');
  /** The earlier use of a UTR next to this one. @param {{orderId: string, body: Record<string, any>}[]} used @param {string} now */
  const utrParams = (used, now) => ({ utr: used[0].body.utr, before: used.map((u) => `${refOf(u.orderId)}: ${paymentLine(u.body)}`).join('; '), now });

  /** @type {Record<string, Tool>} */
  const tools = {
    // The contractor or the supervisor asks for the JCB on a site and day.
    request_jcb: {
      roles: ['contractor', 'supervisor'],
      commits: true,
      // The value an approval limit compares: hours × the last agreed JCB rate; unknown → null.
      hold: {
        limit: 'procurement',
        usualNote: (a, estimate = true) => requestNotes(a, 'jcb_hours', estimate),
        estimatePaise: (a) => {
          const rate = lastJcbRate();
          return posInt(a.hoursTenths) && rate !== null ? Math.round((a.hoursTenths * rate) / 10) : null;
        },
      },
      describe: (a) => ({ key: 'step.request_jcb', params: { what: said(jcbSummary(a)) } }),
      summary: jcbSummary,
      async run(_p, a) {
        if (!safeName(a.site) || !isDay(a.day)) return no('common.bad_args');
        if ((a.time !== undefined && !isTime(a.time)) || (a.hoursTenths !== undefined && !posInt(a.hoursTenths))) return no('common.bad_args');
        /** @type {Record<string, any>} */
        const body = { kind: 'jcb_hours', site: a.site.trim(), day: a.day };
        if (a.time !== undefined) body.time = a.time;
        if (a.hoursTenths !== undefined) body.hoursTenths = a.hoursTenths;
        // A new order, or the same order again after the JCB owner offered another time.
        const orderId = a.orderId !== undefined && known(a.orderId) ? a.orderId : randomUUID();
        const d = await link.send({ type: 'BOOKING_REQUEST', to: a.orderId !== undefined && known(a.orderId) ? counterparty(a.orderId) : o.jcbAgentId, orderId, body });
        return deliveryResult(d, variant('site.jcb_requested', { time: body.time }), { ref: refOf(orderId), site: body.site, day: dayName(body.day), ...(body.time ? { time: body.time } : {}) });
      },
    },

    // The contractor or the supervisor orders material from the supplier for a site and day.
    request_material: {
      roles: ['contractor', 'supervisor'],
      commits: true,
      // The value an approval limit compares: each quantity × the last rate this supplier agreed for
      // that item and unit, with its last GST percent when known; any item without a known rate → null.
      hold: {
        limit: 'procurement',
        usualNote: (a, estimate = true) => requestNotes(a, 'material', estimate),
        estimatePaise: (a) => {
          if (!validItems(a.items)) return null;
          const seller = a.orderId !== undefined && known(a.orderId) ? counterparty(a.orderId) : o.supplierAgentId;
          let total = 0;
          for (const it of a.items) {
            const rate = lastMaterialRate(seller, it);
            const amount = rate === null ? null : lineAmountPaise(it.qtyHundredths, rate);
            if (amount === null) return null;
            const gst = lastMaterialGst(seller, it);
            total += amount + (gst === null ? 0 : gstPaise(amount, gst) ?? 0);
          }
          return total;
        },
      },
      describe: (a) => ({ key: 'step.request_material', params: { what: said(materialSummary(a)) } }),
      summary: materialSummary,
      async run(_p, a) {
        if (!safeName(a.site) || !isDay(a.day) || !validItems(a.items)) return no('common.bad_args');
        if (a.time !== undefined && !isTime(a.time)) return no('common.bad_args');
        const again = a.orderId !== undefined && known(a.orderId);
        if (!again && !o.supplierAgentId) return no('site.no_supplier');
        const items = /** @type {Item[]} */ (a.items).map((it) => ({ name: it.name.trim(), qtyHundredths: it.qtyHundredths, unit: it.unit.trim() }));
        /** @type {Record<string, any>} */
        const body = { kind: 'material', site: a.site.trim(), day: a.day, items };
        if (a.time !== undefined) body.time = a.time;
        // A new order, or the same order again after the supplier offered another time.
        const orderId = again ? a.orderId : randomUUID();
        const d = await link.send({ type: 'BOOKING_REQUEST', to: again ? counterparty(a.orderId) : /** @type {string} */ (o.supplierAgentId), orderId, body });
        return deliveryResult(d, 'site.material_requested', { ref: refOf(orderId), site: body.site, day: dayName(body.day), items: itemsText(items) });
      },
    },

    // The site's own count of a delivery, one figure per delivered item in the challan's order. It is
    // kept on our side only (a local NOTE); code compares it with the challan and later with the bill.
    // `sameAsChallan` marks the one-word "हाँ" to the delivery notice: it records a first count only.
    // A count already recorded changes only with typed figures, and the contractor is told both.
    // With `challan` ({sha256, number}) the count comes from the site's own copy of the challan (a
    // photo the site sent): one figure per ordered item, recorded before or after the DELIVERY.
    confirm_count: {
      roles: ['supervisor', 'contractor'],
      commits: true,
      stillOpen: (a) => a.sameAsChallan !== true || (known(a.orderId) && siteCount(ledger.events(a.orderId)) === null),
      /** @returns {{key: string, params: Record<string, string>}} */
      describe: (a) => {
        if (a.challan !== undefined) {
          const counted = challanItems(a.orderId, a.qtysHundredths);
          /** @type {string} */
          const challan = validChallan(a.challan) ? a.challan.number ?? '—' : '—';
          return { key: variant('step.site_challan', { challan: challan !== '—' }), params: { ref: refOf(a.orderId), site: siteOf(a.orderId), challan, items: counted ? itemsText(counted) : '—', names: orderedNames(a.orderId) } };
        }
        const counted = countedItems(a.orderId, a.qtysHundredths);
        return { key: 'step.confirm_count', params: { site: siteOf(a.orderId), items: counted ? itemsText(counted) : '—' } };
      },
      async run(person, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        if (a.challan !== undefined) return countFromChallan(person, a);
        const d = isMaterial(a.orderId) ? delivery(ledger.events(a.orderId)) : null;
        if (d === null) return no('common.wrong_state');
        const items = countedItems(a.orderId, a.qtysHundredths);
        if (items === null) return no('site.count_figures', { items: itemsText(d.items) });
        const before = siteCount(ledger.events(a.orderId));
        if (before !== null && a.sameAsChallan === true) return no('site.count_already', { ref: refOf(a.orderId), count: itemsText(before) });
        const stored = ledger.append({
          orderId: a.orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(),
          body: { kind: 'site_count', items }, at: new Date(agent.now()).toISOString(),
        });
        if (stored === null) return no('common.wrong_state');
        traceCheck(`site count vs signed delivery ${sameItems(items, d.items) ? '✓ matches' : '✗ differs'}: ${itemsText(items)} / ${itemsText(d.items)}`,
          sameItems(items, d.items), { name: 'count_vs_delivery', count: items, delivered: d.items }, a.orderId);
        if (!sameItems(items, d.items)) await o.evidence?.countDifference(a.orderId);
        const site = siteOf(a.orderId);
        const ref = refOf(a.orderId);
        if (before !== null) {
          if (sameItems(before, items)) return ok('site.count_matches', { ref, site, items: itemsText(items) });
          const changed = { ref, site, old: itemsText(before), count: itemsText(items), challan: itemsText(d.items) };
          if (person.role !== 'contractor') await tell('contractor', 'site.count_changed', changed);
          return ok('site.count_changed', changed);
        }
        if (sameItems(items, d.items)) return ok('site.count_matches', { ref, site, items: itemsText(items) });
        // Code compares; the contractor is told both figures (in the reply, when the contractor counted).
        const params = { ref, site, challan: itemsText(d.items), count: itemsText(items) };
        if (person.role !== 'contractor') await tell('contractor', 'site.count_differs', params);
        return ok('site.count_saved_differs', params);
      },
    },

    // Only the contractor calls off an order never carried out; the supervisor is told.
    cancel_order: cancelTool({ ledger, link, tell, roles: ['contractor'], team: { role: 'supervisor', key: 'site.order_cancelled_own' } }),

    // Only the contractor accepts a bill.
    accept_bill: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({ key: 'step.accept_bill', params: { site: siteOf(a.orderId), total: billTotal(a.orderId) } }),
      // What the person says yes to is the bill in force when they are asked.
      bind: (a) => (known(a.orderId) ? { ...a, bill: ledger.view(a.orderId).currentBill } : a),
      stillOpen: (a) => {
        if (!known(a.orderId)) return false;
        const view = ledger.view(a.orderId);
        return (view.state === 'billed' || view.state === 'disputed') && (a.bill === undefined || a.bill === view.currentBill);
      },
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
        // The bill changed after this yes was asked for: nothing is accepted, the new bill is shown.
        if (a.bill !== undefined && a.bill !== view.currentBill) return billChanged(a.orderId, view.currentBill);
        const d = await link.send({ type: 'ACCEPT', to: counterparty(a.orderId), orderId: a.orderId, body: { bill: view.currentBill } });
        return deliveryResult(d, keyFor(a.orderId, 'site.bill_accepted'), { ref: refOf(a.orderId), site: siteOf(a.orderId) });
      },
    },

    // A dispute states the site's own figure (hours for a JCB, a quantity for material, or a total)
    // and why; it never changes the seller's bill by itself.
    dispute_bill: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({
        key: 'step.dispute_bill',
        params: {
          site: siteOf(a.orderId),
          their: posInt(a.hoursTenths) ? hours(a.hoursTenths) : posInt(a.qtyHundredths) ? qtyOf(a.orderId, a.qtyHundredths) : posInt(a.totalPaise) ? rupees(a.totalPaise) : '—',
          reason: typeof a.reason === 'string' ? a.reason : '—',
        },
      }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 500) return no('site.reason_needed');
        // Exactly one figure: in what the order is measured in (hours or a quantity), or a total.
        const measure = isMaterial(a.orderId) ? 'qtyHundredths' : 'hoursTenths';
        const given = ['hoursTenths', 'qtyHundredths', 'totalPaise'].filter((k) => a[k] !== undefined);
        if (given.length !== 1 || (given[0] !== measure && given[0] !== 'totalPaise') || !posInt(a[given[0]])) return no(keyFor(a.orderId, 'site.figure_needed'));
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
        // A quantity names one item: on a bill with several lines only a total is clear.
        const lines = ledger.eventOfMessage(view.currentBill)?.body.body.lines;
        if (given[0] === 'qtyHundredths' && (!Array.isArray(lines) || lines.length !== 1)) return no('site.material_total_only');
        const theirFigure = { [given[0]]: a[given[0]] };
        // A site's local photo record is committed in the signed dispute before the seller can ask
        // for it. Include it only when this objection actually cites that count's quantity/total.
        const count = ofType(ledger.events(a.orderId), 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
        const rates = agreedRates(ledger.events(a.orderId));
        // What the count comes to at the agreed rates, GST included where its rate is known.
        const countTotal = count && rates ? itemsTotalPaise(count.body.items, rates, delivery(ledger.events(a.orderId))?.items ?? []) : null;
        const citesCount = count && ((given[0] === 'qtyHundredths' && count.body.items.length === 1 && count.body.items[0].qtyHundredths === a.qtyHundredths)
          || (given[0] === 'totalPaise' && countTotal === a.totalPaise));
        const siteCountEvidence = citesCount && count?.msgId && count.body.challan ? {
          siteCount: { record: count.msgId, sha256: count.body.challan.sha256, number: count.body.challan.number,
            items: count.body.items, at: count.at },
        } : {};
        const d = await link.send({ type: 'DISPUTE', to: counterparty(a.orderId), orderId: a.orderId,
          body: { bill: view.currentBill, theirFigure, reason: a.reason.trim(), ...siteCountEvidence } });
        if (d.ok) await o.evidence?.disputedBill(a.orderId);
        return deliveryResult(d, keyFor(a.orderId, 'site.bill_disputed'), { ref: refOf(a.orderId), site: siteOf(a.orderId) });
      },
    },

    // After paying, the contractor tells the seller: any amount (part, full or more), by UPI (UTR and
    // screenshot fingerprint) or cash (a receipt photo optional), against the bill in force or, before
    // any bill, as an advance. A UTR already told to this seller is shown and asked, never sent silently.
    claim_payment: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({
        key: a.method === 'cash' ? 'step.claim_payment_cash' : 'step.claim_payment',
        params: { site: siteOf(a.orderId), amount: posInt(a.amountPaise) ? rupees(a.amountPaise) : '—', utr: typeof a.utr === 'string' ? a.utr : '—' },
      }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        const body = paymentBody(a);
        if (body === null) return no('common.bad_args');
        const view = ledger.view(a.orderId);
        if (!PAYABLE.includes(view.state)) return no('common.wrong_state');
        body.bill = view.currentBill;
        const used = typeof body.utr === 'string' && a.sameUtrOk !== true ? utrUses(ledger, counterparty(a.orderId), body.utr) : [];
        if (used.length) return no('pay.utr_used', utrParams(used, paymentLine(body)));
        const d = await link.send({ type: 'PAYMENT_CLAIM', to: counterparty(a.orderId), orderId: a.orderId, body });
        return deliveryResult(d, variant('pay.site.claimed', { advance: body.bill === null }), {
          ref: refOf(a.orderId), to: toWhom(a.orderId), payment: paymentLine(body), balance: balanceText(summaryOf(ledger, a.orderId)),
        });
      },
    },

    // One payment for several orders with the same seller (CONTRACTS 4.1): code splits it, oldest
    // named first (src/agents/pay.js shares), and sends one claim per order with the group; the payer
    // saw the split read back once.
    claim_group: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => {
        const split = groupOk(a.orderIds) && posInt(a.totalPaise) ? shares(ledger, a.orderIds, a.totalPaise) : null;
        return {
          key: a.method === 'cash' ? 'step.claim_group_cash' : 'step.claim_group',
          params: { amount: posInt(a.totalPaise) ? rupees(a.totalPaise) : '—', to: groupOk(a.orderIds) ? toWhom(a.orderIds[0]) : '—', lines: split ? shareLines(split) : '—' },
        };
      },
      async run(_p, a) {
        if (!groupOk(a.orderIds)) return no('pay.one_seller');
        const base = paymentBody({ ...a, amountPaise: a.totalPaise });
        if (base === null) return no('common.bad_args');
        if (!a.orderIds.every((/** @type {string} */ id) => PAYABLE.includes(ledger.view(id).state))) return no('common.wrong_state');
        const split = shares(ledger, a.orderIds, a.totalPaise);
        if (split === null) return no('common.bad_args');
        const seller = counterparty(a.orderIds[0]);
        const used = typeof base.utr === 'string' && a.sameUtrOk !== true ? utrUses(ledger, seller, base.utr) : [];
        if (used.length) return no('pay.utr_used', utrParams(used, paymentLine(base)));
        // Each order takes one message at a time: checked first, so the payment is never left half made.
        const inFlight = new Set(link.pending().map((m) => m.order_id));
        if (split.some((x) => inFlight.has(x.orderId))) return no('common.busy');
        // Only one order takes anything: a plain payment for it.
        const group = split.length > 1 ? { id: newGroupId(), totalPaise: a.totalPaise, orders: split.map((x) => x.orderId) } : undefined;
        /** @type {import('./link.js').Delivery | null} */
        let undelivered = null;
        for (const share of split) {
          const body = { ...base, amountPaise: share.amountPaise, bill: ledger.view(share.orderId).currentBill, ...(group ? { group } : {}) };
          const d = await link.send({ type: 'PAYMENT_CLAIM', to: seller, orderId: share.orderId, body });
          // A share recorded but not delivered yet goes again by itself and does not stop the others.
          if (!d.ok && (d.reason === 'unreachable' || d.reason === 'bad_answer' || d.reason === 'no_address')) undelivered = d;
          else if (!d.ok) return deliveryResult(d, 'pay.site.group_claimed');
        }
        if (undelivered) return deliveryResult(undelivered, 'pay.site.group_claimed');
        return ok('pay.site.group_claimed', { to: toWhom(a.orderIds[0]), payment: paymentLine(base), lines: shareLines(split, true) });
      },
    },
  };

  /**
   * The bill in force as one plain text, as the notices show it. @param {string} orderId @param {Record<string, any>} b
   */
  const billText = (orderId, b) => {
    if (isMaterial(orderId)) return t('site.bill_is_material', { lines: linesText(b.lines, delivery(ledger.events(orderId))?.items ?? []), total: rupees(b.totalPaise) });
    const line = b.lines[0];
    return t('site.bill_is_jcb', { hours: line.hoursTenths !== undefined ? hours(line.hoursTenths) : '—', rate: rupees(line.ratePaise), total: rupees(b.totalPaise) });
  };

  /**
   * A material bill against the signed delivery and the agreed rates, and a correction against what
   * was delivered: a quantity above the delivery counts only when it is the site's own count.
   * @param {Record<string, any>} b @param {string} type @param {string} orderId
   */
  function materialBillCheck(b, type, orderId) {
    const events = ledger.events(orderId);
    const d = delivery(events);
    const rates = agreedRates(events);
    const count = siteCount(events);
    const above = !!d && type === 'CORRECTION' && b.lines.some((/** @type {any} */ l, /** @type {number} */ i) => l.qtyHundredths > d.items[i]?.qtyHundredths
      && count?.find((c) => c.name === d.items[i].name && c.unit === d.items[i].unit)?.qtyHundredths !== l.qtyHundredths);
    const follows = !!d && !!rates && !above && billFollows(/** @type {{lines: any[], totalPaise: number}} */ (b), d.items, rates, { sameQty: type === 'BILL' });
    return { d, rates, count, above, follows };
  }

  /**
   * Whether a plain "हाँ" may accept this bill: a JCB bill, or a material bill that follows from the
   * delivery, the agreed rates and the site's count.
   * @param {string} orderId @param {Record<string, any>} b @param {string} type
   */
  function mayAcceptOnYes(orderId, b, type) {
    if (!isMaterial(orderId)) return true;
    const c = materialBillCheck(b, type, orderId);
    if (!c.follows || !c.d) return false;
    const d = c.d;
    return c.count === null || sameItems(c.count, b.lines.map((/** @type {any} */ l, /** @type {number} */ i) => ({ name: l.what, qtyHundredths: l.qtyHundredths, unit: d.items[i].unit })));
  }

  /**
   * The person's yes was for a bill no longer in force: the new bill is shown, and asked again if a
   * plain yes may accept it.
   * @param {string} orderId @param {string} billId @returns {import('./common.js').Said}
   */
  function billChanged(orderId, billId) {
    const e = /** @type {NonNullable<ReturnType<typeof ledger.eventOfMessage>>} */ (ledger.eventOfMessage(billId));
    const b = e.body.body;
    const armed = mayAcceptOnYes(orderId, b, e.type);
    const params = { ref: refOf(orderId), site: siteOf(orderId), bill: billText(orderId, b), total: rupees(b.totalPaise) };
    return armed ? { ...no('site.bill_changed', params), expect: { tool: 'accept_bill', args: { orderId, bill: billId } } } : no('site.bill_changed_check', params);
  }

  /**
   * The site's count from its own copy of the challan, with the photo as evidence. Before the
   * supplier's DELIVERY it is kept for the comparison when the DELIVERY comes; after it, code compares
   * at once.
   * @param {import('../wa/directory.js').Person} person @param {Record<string, any>} a
   */
  async function countFromChallan(person, a) {
    if (!isMaterial(a.orderId) || !['booked', 'delivered'].includes(ledger.view(a.orderId).state)) return no('common.wrong_state');
    if (!validChallan(a.challan)) return no('common.bad_args');
    const items = challanItems(a.orderId, a.qtysHundredths);
    const ref = refOf(a.orderId);
    if (items === null) return no('site.challan_figures', { ref, names: orderedNames(a.orderId) });
    const before = siteCount(ledger.events(a.orderId));
    if (before !== null && a.sameAsChallan === true) return no('site.count_already', { ref, count: itemsText(before) });
    /** @type {{sha256: string, number: string | null, signed?: boolean | null}} */
    const challan = { sha256: a.challan.sha256, number: a.challan.number === null ? null : a.challan.number.trim() };
    if (a.challan.signed !== undefined) challan.signed = a.challan.signed;
    const stored = ledger.append({
      orderId: a.orderId, direction: 'local', type: 'NOTE', msgId: randomUUID(),
      body: { kind: 'site_count', items, challan }, at: new Date(agent.now()).toISOString(),
    });
    if (stored === null) return no('common.wrong_state');
    const site = siteOf(a.orderId);
    const d = delivery(ledger.events(a.orderId));
    if (d !== null) await sendSiteReceipt(a.orderId);
    if (before !== null && !sameItems(before, items) && person.role !== 'contractor') {
      await tell('contractor', 'site.count_changed', { ref, site, old: itemsText(before), count: itemsText(items), challan: d ? itemsText(d.items) : '—' });
    }
    if (d === null) return ok(variant('site.challan_count_saved', { challan: challan.number }), { ref, site, items: itemsText(items), ...(challan.number ? { challan: challan.number } : {}) });
    const c = compareCount(a.orderId, items, challan.number, d);
    const number = d.number ?? challan.number;
    if (c.same) return ok(variant('site.challan_count_matches', { challan: number }), { ref, site, items: itemsText(items), ...(number ? { challan: number } : {}) });
    await o.evidence?.countDifference(a.orderId);
    // Code compares; the contractor is told both figures (in the reply, when the contractor counted).
    if (person.role !== 'contractor') await tell('contractor', 'site.challan_count_differs', c.params);
    return ok('site.challan_count_differs', c.params);
  }

  /**
   * The site's signed copy of the challan goes back to the supplier (docs/BUILD2.md, "Signed copy and
   * payment time"): what the site wrote it received, on which challan, and whether the reader saw the
   * receiver's mark. Only for a count read from the site's own challan photo, and only once the
   * supplier's DELIVERY is here. A message that cannot be delivered stays pending and goes again.
   * @param {string} orderId
   */
  async function sendSiteReceipt(orderId) {
    const events = ledger.events(orderId);
    const d = delivery(events);
    const note = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
    if (!d || !note || !validChallan(note.body.challan)) return;
    const c = note.body.challan;
    const body = { delivery: d.msgId, challan: { sha256: c.sha256, number: c.number ?? null }, items: note.body.items, signed: c.signed ?? null };
    await link.send({ type: 'SITE_RECEIPT', to: counterparty(orderId), orderId, body });
  }

  /**
   * A material bill or correction: checked against the signed delivery and the agreed rates, then
   * against the site's own count. Only a bill that follows from both is offered for a one-word "हाँ".
   * @param {Message} m
   */
  async function onMaterialBill(m) {
    const b = m.body;
    const site = siteOf(m.order_id);
    const ref = refOf(m.order_id);
    const { d, rates, count, above, follows } = materialBillCheck(b, m.type, m.order_id);
    const total = rupees(b.totalPaise);
    const lines = linesText(b.lines, d?.items ?? []);
    traceCheck(`bill = delivered × agreed rate ${follows ? '✓' : '✗'} ${total}${above ? ' (above the signed delivery)' : ''}`, follows, { name: 'bill_follows', totalPaise: b.totalPaise, delivered: d?.items ?? null }, m.order_id);
    if (!follows || !d || !rates) {
      const want = d && rates ? materialBillBody(d.items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
      await tellBill(m.order_id, b, 'site.material_bill_mismatch', { ref, site, lines, total, expected: want && d ? linesText(want.lines, d.items) : '—', expectedTotal: want ? rupees(want.totalPaise) : '—' });
      const explanation = await explainDifference({ spark: o.spark, audience: 'buyer', facts: differenceFacts(ledger, m.order_id, ref) });
      await tell('contractor', explanation.key, explanation.params);
      return;
    }
    /** @type {Item[]} */
    const billed = b.lines.map((/** @type {any} */ l, /** @type {number} */ i) => ({ name: l.what, qtyHundredths: l.qtyHundredths, unit: d.items[i].unit }));
    if (count !== null && !sameItems(count, billed)) {
      // What the site's count comes to at the agreed rates (an item counted as 0 adds nothing). A count
      // from the site's own challan may list other items than the delivery, so each is priced by name.
      const siteTotal = itemsTotalPaise(count, rates, d.items);
      await tellBill(m.order_id, b, 'site.material_bill_count_differs', { ref, site, lines, total, count: itemsText(count), siteTotal: rupees(siteTotal) });
      const explanation = await explainDifference({ spark: o.spark, audience: 'buyer', facts: differenceFacts(ledger, m.order_id, ref) });
      await tell('contractor', explanation.key, explanation.params);
      return;
    }
    // The tax invoice's grand total (carried on the delivery) against the bill: both figures when they differ.
    const check = invoiceCheck(d.grandTotalPaise, b.totalPaise);
    if (check !== null) {
      traceCheck(`bill total ${check === 'match' ? '✓ =' : '✗ ≠'} invoice grand total: ${total} / ${rupees(/** @type {number} */ (d.grandTotalPaise))}`,
        check === 'match', { name: 'invoice_total', billPaise: b.totalPaise, invoicePaise: d.grandTotalPaise }, m.order_id);
    }
    const params = { ref, site, lines, total, photos: Array.isArray(b.evidence) ? b.evidence.length : 0,
      ...(check === 'differs' ? { invoiceTotal: rupees(/** @type {number} */ (d.grandTotalPaise)) } : {}) };
    const key = variant(m.type === 'BILL' ? 'site.material_bill_received' : 'site.material_correction_received', { invoice_match: check === 'match', invoice_differs: check === 'differs' });
    await tellBill(m.order_id, b, key, params, { tool: 'accept_bill', args: { orderId: m.order_id, bill: m.msg_id } });
    await tell('supervisor', 'site.bill_copy', { ref, site, what: billText(m.order_id, b) });
  }

  /**
   * The seller's answer to a reported payment, with the balance. A clubbed payment is told once,
   * when the answers for all its shares are in.
   * @param {Message} m
   */
  async function onPaymentAck(m) {
    const b = m.body;
    const claim = ledger.eventOfMessage(b.payment)?.body.body;
    const word = b.received ? 'acked' : 'denied';
    if (!claim?.group) {
      await tell('contractor', `pay.site.${word}`, { ref: refOf(m.order_id), from: toWhom(m.order_id), payment: claim ? paymentLine(claim) : rupees(b.amountPaise), balance: balanceText(summaryOf(ledger, m.order_id)) });
      return;
    }
    /** @type {{orderId: string, amountPaise: number}[]} */
    const parts = [];
    for (const id of /** @type {string[]} */ (claim.group.orders)) {
      const events = known(id) ? ledger.events(id) : [];
      const share = ofType(events, 'PAYMENT_CLAIM', 'out').find((e) => e.body.body.group?.id === claim.group.id);
      if (!share || !ofType(events, 'PAYMENT_ACK', 'in').some((e) => e.body.body.payment === share.msgId)) return;
      parts.push({ orderId: id, amountPaise: share.body.body.amountPaise });
    }
    await tell('contractor', `pay.site.group_${word}`, { from: toWhom(m.order_id), payment: paymentLine({ ...claim, amountPaise: claim.group.totalPaise }), lines: shareLines(parts, true) });
  }

  /**
   * Called once when the JCB agent's or the supplier agent's message has been written to our ledger.
   * @param {Message} m
   */
  async function onApplied(m) {
    const b = m.body;
    const site = siteOf(m.order_id);
    const ref = refOf(m.order_id);
    switch (m.type) {
      case 'BOOKING_REPLY': {
        // The day and time the answer is about: another day when offered, else what the order asked for.
        const req = ofType(ledger.events(m.order_id), 'BOOKING_REQUEST', 'out').at(-1)?.body.body;
        const day = b.day ?? req?.day;
        const time = b.time ?? (b.answer === 'yes' ? req?.time : undefined);
        /** @type {Record<string, string>} */
        const params = { ref, site };
        if (isDay(day)) params.day = dayName(day);
        if (time) params.time = time;
        if (isMaterial(m.order_id)) params.rates = Array.isArray(b.rates) ? ratesText(b.rates) : '—';
        else if (b.ratePaise) params.rate = rupees(b.ratePaise);
        const key = variant(keyFor(m.order_id, `site.booking_${b.answer}`), { time: b.answer !== 'no' && time });
        await tell('contractor', key, params);
        await tell('supervisor', key, params);
        break;
      }
      case 'DELIVERY': {
        // The site already counted from its own copy of the challan: code compares, nobody is asked again.
        const events = ledger.events(m.order_id);
        const count = siteCount(events);
        const d = delivery(events);
        if (count !== null && d !== null) {
          const c = compareCount(m.order_id, count, siteChallan(events)?.number ?? null, d);
          const key = c.same ? 'site.delivery_matches_count' : 'site.challan_count_differs';
          await tell('contractor', key, c.params);
          await tell('supervisor', key, c.params);
          await sendSiteReceipt(m.order_id);
          if (!c.same) await o.evidence?.countDifference(m.order_id);
          break;
        }
        // The supervisor is asked for the site's count; a plain "हाँ" means "the same as the challan". The
        // contractor is only told: a question put to them must not be closed by someone else's answer.
        const params = { ref, site, items: itemsText(b.items), ...(b.challan?.number ? { challan: b.challan.number } : {}) };
        const expect = { tool: 'confirm_count', args: { orderId: m.order_id, qtysHundredths: b.items.map((/** @type {Item} */ it) => it.qtyHundredths), sameAsChallan: true } };
        await tell('supervisor', variant('site.delivery_received', { challan: b.challan?.number }), params, expect);
        await tell('contractor', variant('site.delivery_info', { challan: b.challan?.number }), params);
        break;
      }
      case 'BILL':
      case 'CORRECTION': {
        if (isMaterial(m.order_id)) {
          await onMaterialBill(m);
          break;
        }
        const line = b.lines[0];
        const params = {
          ref,
          site,
          hours: line.hoursTenths !== undefined ? hours(line.hoursTenths) : '—',
          rate: rupees(line.ratePaise),
          total: rupees(b.totalPaise),
          photos: Array.isArray(b.evidence) ? b.evidence.length : 0,
        };
        const key = m.type === 'BILL' ? 'site.bill_received' : 'site.correction_received';
        await tellBill(m.order_id, b, key, params, { tool: 'accept_bill', args: { orderId: m.order_id, bill: m.msg_id } });
        await tell('supervisor', 'site.bill_copy', { ref, site, what: billText(m.order_id, b) });
        break;
      }
      case 'SETTLED': {
        // With the credit, shown only, when more came than the bill (never refunded or carried by code).
        const credit = summaryOf(ledger, m.order_id).creditPaise;
        await tell('contractor', variant(keyFor(m.order_id, 'site.settled'), { credit: credit > 0 }), { ref, site, amount: rupees(b.amountPaise), ...(credit > 0 ? { credit: rupees(credit) } : {}) });
        break;
      }
      case 'PAYMENT_ACK':
        await onPaymentAck(m);
        break;
      case 'CANCEL': {
        const words = { ...orderWords(ledger, m.order_id), from: toWhom(m.order_id) };
        await tell('contractor', 'site.order_cancelled', words);
        await tell('supervisor', 'site.order_cancelled', words);
        break;
      }
      case 'PAYMENT_RECEIVED':
        await tell('contractor', 'pay.site.received', { ref, from: toWhom(m.order_id), payment: paymentLine(b), balance: balanceText(summaryOf(ledger, m.order_id)) });
        break;
      default:
        break;
    }
  }

  return { tools, onApplied };
}
