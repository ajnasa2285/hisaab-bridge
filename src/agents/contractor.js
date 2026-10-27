// The contractor's agent: booking a JCB, answering a bill (accept or dispute with the site's own
// figure), and telling the JCB side that a payment was made. A payment claim is only a claim; the
// order is settled when the JCB owner confirms the money arrived.

import { randomUUID } from 'node:crypto';
import { tenths as hours, rupees, day as dayName } from '../i18n/format.js';
import { deliveryResult, isDay, isSha256, isTime, isUuid, no, posInt } from './common.js';

/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('../protocol/messages.js').Message} Message */

const UTR_RE = /^[A-Za-z0-9]{6,35}$/;

/**
 * @param {{
 *   agent: Parameters<typeof import('../protocol/exchange.js').prepare>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   jcbAgentId: string,
 * }} o
 */
export function createContractorAgent(o) {
  const { agent, link, tell } = o;
  const ledger = agent.ledger;

  /** @param {string} orderId */
  const known = (orderId) => isUuid(orderId) && ledger.order(orderId) !== null;
  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string}} */ (ledger.order(orderId)).counterparty;
  /** @param {string} orderId */
  const siteOf = (orderId) => (isUuid(orderId) ? /** @type {{site: string} | null} */ (ledger.order(orderId))?.site : null) ?? '—';
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
        return deliveryResult(d, 'site.jcb_requested', { site: body.site, day: dayName(body.day), time: body.time ?? '—' });
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
        return deliveryResult(d, 'site.bill_accepted', { site: siteOf(a.orderId) });
      },
    },

    // A dispute states the site's own figure and why; it never changes the JCB side's bill by itself.
    dispute_bill: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({
        key: 'step.dispute_bill',
        params: { site: siteOf(a.orderId), their: posInt(a.hoursTenths) ? hours(a.hoursTenths) : posInt(a.totalPaise) ? rupees(a.totalPaise) : '—', reason: typeof a.reason === 'string' ? a.reason : '—' },
      }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 500) return no('site.reason_needed');
        const hasHours = a.hoursTenths !== undefined;
        const hasTotal = a.totalPaise !== undefined;
        if (hasHours === hasTotal || (hasHours && !posInt(a.hoursTenths)) || (hasTotal && !posInt(a.totalPaise))) return no('site.figure_needed');
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
        const theirFigure = hasHours ? { hoursTenths: a.hoursTenths } : { totalPaise: a.totalPaise };
        const d = await link.send({ type: 'DISPUTE', to: counterparty(a.orderId), orderId: a.orderId, body: { bill: view.currentBill, theirFigure, reason: a.reason.trim() } });
        return deliveryResult(d, 'site.bill_disputed', { site: siteOf(a.orderId) });
      },
    },

    // After paying, the contractor tells the JCB side (UTR and screenshot fingerprint).
    claim_payment: {
      roles: ['contractor'],
      commits: true,
      describe: (a) => ({ key: 'step.claim_payment', params: { site: siteOf(a.orderId), amount: posInt(a.amountPaise) ? rupees(a.amountPaise) : '—', utr: typeof a.utr === 'string' ? a.utr : '—' } }),
      async run(_p, a) {
        if (!known(a.orderId)) return no('common.no_such_order');
        if (!posInt(a.amountPaise) || typeof a.utr !== 'string' || !UTR_RE.test(a.utr) || !isDay(a.paidOn) || !isSha256(a.screenshotSha256)) return no('common.bad_args');
        const view = ledger.view(a.orderId);
        if (view.currentBill === null) return no('common.wrong_state');
        const body = { bill: view.currentBill, amountPaise: a.amountPaise, utr: a.utr, paidOn: a.paidOn, screenshot: { sha256: a.screenshotSha256 } };
        const d = await link.send({ type: 'PAYMENT_CLAIM', to: counterparty(a.orderId), orderId: a.orderId, body });
        return deliveryResult(d, 'site.payment_claimed', { amount: rupees(a.amountPaise) });
      },
    },
  };

  /**
   * Called once when the JCB agent's message has been written to our ledger.
   * @param {Message} m
   */
  async function onApplied(m) {
    const b = m.body;
    const site = siteOf(m.order_id);
    switch (m.type) {
      case 'BOOKING_REPLY': {
        const params = { site, day: b.day ? dayName(b.day) : '—', time: b.time ?? '—', rate: b.ratePaise ? rupees(b.ratePaise) : '—' };
        const key = `site.booking_${b.answer}`;
        await tell('contractor', key, params);
        await tell('supervisor', key, params);
        break;
      }
      case 'BILL':
      case 'CORRECTION': {
        const line = b.lines[0];
        const params = {
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
        await tell('contractor', 'site.settled', { site, amount: rupees(b.amountPaise) });
        break;
      default:
        break;
    }
  }

  return { tools, onApplied };
}
