// The contractor's agent: booking a JCB or ordering material, the site's own count of a delivery,
// answering a bill (accept or dispute with the site's own figure), and telling the seller that a
// payment was made. A payment claim is only a claim; the order is settled when the JCB owner or the
// supplier confirms the money arrived. A material bill is checked by code against the signed
// delivery and the agreed rates before anyone is asked to accept it.

import { randomUUID } from 'node:crypto';
import { tenths as hours, rupees, day as dayName, qty } from '../i18n/format.js';
import { deliveryResult, isDay, isSha256, isTime, isUuid, no, nonNegInt, ofType, ok, posInt } from './common.js';
import { agreedRates, billFollows, delivery, itemsText, lineAmountPaise, linesText, materialBillBody, ratesText, sameItems, siteCount, validItems } from './material.js';
import { openRefs } from '../ledger/refs.js';

/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('./material.js').Item} Item */

const UTR_RE = /^[A-Za-z0-9]{6,35}$/;

/**
 * @param {{
 *   agent: Parameters<typeof import('../protocol/exchange.js').prepare>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   jcbAgentId: string,
 *   supplierAgentId?: string,
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

  /** The total of the bill in force, as the read-back shows it. @param {string} orderId */
  const billTotal = (orderId) => {
    if (!known(orderId)) return '—';
    const bill = ledger.view(orderId).currentBill;
    const total = bill ? ledger.eventOfMessage(bill)?.body.body.totalPaise : undefined;
    return posInt(total) ? rupees(total) : '—';
  };

  /** @type {Record<string, Tool>} */
  const tools = {
    // The contractor or the supervisor asks for the JCB on a site and day.
    request_jcb: {
      roles: ['contractor', 'supervisor'],
      commits: true,
      // The value an approval limit compares: hours × the last agreed JCB rate; unknown → null.
      hold: {
        limit: 'procurement',
        estimatePaise: (a) => {
          const rate = lastJcbRate();
          return posInt(a.hoursTenths) && rate !== null ? Math.round((a.hoursTenths * rate) / 10) : null;
        },
      },
      describe: (a) => ({ key: 'step.request_jcb', params: { site: typeof a.site === 'string' ? a.site : '—', day: isDay(a.day) ? dayName(a.day) : '—', time: a.time ?? '—', hours: posInt(a.hoursTenths) ? hours(a.hoursTenths) : '—' } }),
      async run(_p, a) {
        if (typeof a.site !== 'string' || !a.site.trim() || a.site.length > 80 || !isDay(a.day)) return no('common.bad_args');
        if ((a.time !== undefined && !isTime(a.time)) || (a.hoursTenths !== undefined && !posInt(a.hoursTenths))) return no('common.bad_args');
        /** @type {Record<string, any>} */
        const body = { kind: 'jcb_hours', site: a.site.trim(), day: a.day };
        if (a.time !== undefined) body.time = a.time;
        if (a.hoursTenths !== undefined) body.hoursTenths = a.hoursTenths;
        // A new order, or the same order again after the JCB owner offered another time.
        const orderId = a.orderId !== undefined && known(a.orderId) ? a.orderId : randomUUID();
        const d = await link.send({ type: 'BOOKING_REQUEST', to: a.orderId !== undefined && known(a.orderId) ? counterparty(a.orderId) : o.jcbAgentId, orderId, body });
        return deliveryResult(d, 'site.jcb_requested', { ref: refOf(orderId), site: body.site, day: dayName(body.day), time: body.time ?? '—' });
      },
    },

    // The contractor or the supervisor orders material from the supplier for a site and day.
    request_material: {
      roles: ['contractor', 'supervisor'],
      commits: true,
      // The value an approval limit compares: each quantity × the last rate this supplier agreed for
      // that item and unit; any item without a known rate → null.
      hold: {
        limit: 'procurement',
        estimatePaise: (a) => {
          if (!validItems(a.items)) return null;
          const seller = a.orderId !== undefined && known(a.orderId) ? counterparty(a.orderId) : o.supplierAgentId;
          let total = 0;
          for (const it of a.items) {
            const rate = lastMaterialRate(seller, it);
            const amount = rate === null ? null : lineAmountPaise(it.qtyHundredths, rate);
            if (amount === null) return null;
            total += amount;
          }
          return total;
        },
      },
      describe: (a) => ({
        key: 'step.request_material',
        params: { site: typeof a.site === 'string' ? a.site : '—', day: isDay(a.day) ? dayName(a.day) : '—', time: a.time ?? '—', items: validItems(a.items) ? itemsText(a.items) : '—' },
      }),
      async run(_p, a) {
        if (typeof a.site !== 'string' || !a.site.trim() || a.site.length > 80 || !isDay(a.day) || !validItems(a.items)) return no('common.bad_args');
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
    confirm_count: {
      roles: ['supervisor', 'contractor'],
      commits: true,
      describe: (a) => {
        const counted = countedItems(a.orderId, a.qtysHundredths);
        return { key: 'step.confirm_count', params: { site: siteOf(a.orderId), items: counted ? itemsText(counted) : '—' } };
      },
      async run(person, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
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

    // Only the contractor accepts a bill.
    accept_bill: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({ key: 'step.accept_bill', params: { site: siteOf(a.orderId), total: billTotal(a.orderId) } }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
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
        const d = await link.send({ type: 'DISPUTE', to: counterparty(a.orderId), orderId: a.orderId, body: { bill: view.currentBill, theirFigure, reason: a.reason.trim() } });
        return deliveryResult(d, keyFor(a.orderId, 'site.bill_disputed'), { ref: refOf(a.orderId), site: siteOf(a.orderId) });
      },
    },

    // After paying, the contractor tells the seller (UTR and screenshot fingerprint).
    claim_payment: {
      roles: ['contractor'],
      commits: true,
      hold: { limit: 'payment', estimatePaise: (a) => (posInt(a.amountPaise) ? a.amountPaise : null) },
      describe: (a) => ({ key: 'step.claim_payment', params: { site: siteOf(a.orderId), amount: posInt(a.amountPaise) ? rupees(a.amountPaise) : '—', utr: typeof a.utr === 'string' ? a.utr : '—' } }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        if (!posInt(a.amountPaise) || typeof a.utr !== 'string' || !UTR_RE.test(a.utr) || !isDay(a.paidOn) || !isSha256(a.screenshotSha256)) return no('common.bad_args');
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
        const body = { bill: view.currentBill, amountPaise: a.amountPaise, utr: a.utr, paidOn: a.paidOn, screenshot: { sha256: a.screenshotSha256 } };
        const d = await link.send({ type: 'PAYMENT_CLAIM', to: counterparty(a.orderId), orderId: a.orderId, body });
        return deliveryResult(d, keyFor(a.orderId, 'site.payment_claimed'), { amount: rupees(a.amountPaise) });
      },
    },
  };

  /**
   * A material bill or correction: checked against the signed delivery and the agreed rates, then
   * against the site's own count. Only a bill that follows from both is offered for a one-word "हाँ".
   * @param {Message} m
   */
  async function onMaterialBill(m) {
    const b = m.body;
    const site = siteOf(m.order_id);
    const ref = refOf(m.order_id);
    const events = ledger.events(m.order_id);
    const d = delivery(events);
    const rates = agreedRates(events);
    const total = rupees(b.totalPaise);
    const lines = linesText(b.lines, d?.items ?? []);
    if (!d || !rates || !billFollows(/** @type {{lines: any[], totalPaise: number}} */ (b), d.items, rates, { sameQty: m.type === 'BILL' })) {
      const want = d && rates ? materialBillBody(d.items, rates, { sha256: d.sha256, number: d.number, sentAt: d.at }) : null;
      await tell('contractor', 'site.material_bill_mismatch', { ref, site, lines, total, expected: want && d ? linesText(want.lines, d.items) : '—', expectedTotal: want ? rupees(want.totalPaise) : '—' });
      return;
    }
    const count = siteCount(events);
    /** @type {Item[]} */
    const billed = b.lines.map((/** @type {any} */ l, /** @type {number} */ i) => ({ name: l.what, qtyHundredths: l.qtyHundredths, unit: d.items[i].unit }));
    if (count !== null && !sameItems(count, billed)) {
      // What the site's count comes to at the same rates (an item counted as 0 adds nothing).
      const siteTotal = count.reduce((s, it, i) => s + (it.qtyHundredths === 0 ? 0 : lineAmountPaise(it.qtyHundredths, b.lines[i].ratePaise) ?? 0), 0);
      await tell('contractor', 'site.material_bill_count_differs', { ref, site, lines, total, count: itemsText(count), siteTotal: rupees(siteTotal) });
      return;
    }
    const params = { ref, site, lines, total, photos: Array.isArray(b.evidence) ? b.evidence.length : 0 };
    const key = m.type === 'BILL' ? 'site.material_bill_received' : 'site.material_correction_received';
    await tell('contractor', key, params, { tool: 'accept_bill', args: { orderId: m.order_id } });
    await tell('supervisor', key, params);
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
        /** @type {Record<string, string>} */
        const params = { ref, site, day: b.day ? dayName(b.day) : '—', time: b.time ?? '—' };
        if (isMaterial(m.order_id)) params.rates = Array.isArray(b.rates) ? ratesText(b.rates) : '—';
        else params.rate = b.ratePaise ? rupees(b.ratePaise) : '—';
        const key = keyFor(m.order_id, `site.booking_${b.answer}`);
        await tell('contractor', key, params);
        await tell('supervisor', key, params);
        break;
      }
      case 'DELIVERY': {
        // The site is asked for its own count; a plain "हाँ" means "the same as the challan".
        const params = { ref, site, items: itemsText(b.items), challan: b.challan?.number ?? '—' };
        const expect = { tool: 'confirm_count', args: { orderId: m.order_id, qtysHundredths: b.items.map((/** @type {Item} */ it) => it.qtyHundredths), sameAsChallan: true } };
        await tell('supervisor', 'site.delivery_received', params, expect);
        await tell('contractor', 'site.delivery_received', params, expect);
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
        await tell('contractor', key, params, { tool: 'accept_bill', args: { orderId: m.order_id } });
        await tell('supervisor', key, params);
        break;
      }
      case 'SETTLED':
        await tell('contractor', keyFor(m.order_id, 'site.settled'), { ref, site, amount: rupees(b.amountPaise) });
        break;
      default:
        break;
    }
  }

  return { tools, onApplied };
}
