// The JCB owner's agent: the steps the owner and the operator can take, and what they are told when
// the contractor's agent sends something. Every figure on a bill comes from the ledger (the agreed
// rate from our own "yes", the hours from the two meter readings the operator confirmed); nothing
// is computed by a model.

import { randomUUID } from 'node:crypto';
import { tenths as hours, rupees, day as dayName } from '../i18n/format.js';
import { deliveryResult, isIso, isSha256, isTime, isDay, isUuid, no, nonNegInt, ofType, ok, posInt } from './common.js';
import { openRefs } from '../ledger/refs.js';
import { explainDifference } from './explain.js';
import { differenceFacts } from './explain-facts.js';

/** @typedef {import('./common.js').Tool} Tool */
/** @typedef {import('./common.js').Tell} Tell */
/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
/** @typedef {{which: 'start' | 'end', valueTenths: number, sha256: string, takenAt: string | null, at: string}} MeterReading */

/**
 * The meter readings in force for an order: the latest confirmed start and end.
 * @param {LedgerEvent[]} events
 * @returns {{start: MeterReading | null, end: MeterReading | null}}
 */
export function meterReadings(events) {
  /** @type {{start: MeterReading | null, end: MeterReading | null}} */
  const r = { start: null, end: null };
  for (const e of ofType(events, 'EVIDENCE', 'local')) {
    if (e.body.kind !== 'meter') continue;
    const which = /** @type {'start' | 'end'} */ (e.body.which);
    r[which] = { which, valueTenths: e.body.valueTenths, sha256: e.body.sha256, takenAt: e.body.takenAt ?? null, at: e.at };
  }
  return r;
}

/**
 * Bill lines and evidence from the ledger. Rounds the amount to the nearest paisa only when the
 * rate is not a whole number of paise per tenth of an hour.
 * @param {number} hoursTenths
 * @param {number} ratePaise per hour
 * @param {MeterReading[]} readings
 */
export function jcbBillBody(hoursTenths, ratePaise, readings) {
  const amountPaise = Math.round((hoursTenths * ratePaise) / 10);
  return {
    lines: [{ what: 'JCB', hoursTenths, ratePaise, amountPaise }],
    totalPaise: amountPaise,
    evidence: readings.map((m) => ({ sha256: m.sha256, kind: 'meter', readValue: hours(m.valueTenths), takenAt: m.takenAt, sentAt: m.at })),
  };
}

/**
 * @param {{
 *   agent: Parameters<typeof import('../protocol/exchange.js').prepare>[0],
 *   link: ReturnType<typeof import('./link.js').createLink>,
 *   tell: Tell,
 *   spark?: import('./explain.js').Spark,
 * }} o
 */
export function createJcbAgent(o) {
  const { agent, link, tell } = o;
  const ledger = agent.ledger;
  const refs = openRefs(ledger);
  /** The order's short reference for the texts. @param {string} orderId */
  const refOf = (orderId) => refs.refOf(orderId) ?? '—';

  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string} | null} */ (ledger.order(orderId))?.counterparty ?? null;

  /** The rate we agreed to in our own "yes". @param {LedgerEvent[]} events */
  const agreedRate = (events) => {
    const yes = ofType(events, 'BOOKING_REPLY', 'out').filter((e) => e.body.body.answer === 'yes').at(-1);
    return yes && posInt(yes.body.body.ratePaise) ? yes.body.body.ratePaise : null;
  };

  /** @type {Record<string, Tool>} */
  const tools = {
    // The owner answers a booking request: yes (with the hourly rate), no, or another day/time.
    reply_booking: {
      roles: ['jcb_owner'],
      commits: true,
      describe: (a) => ({
        key: `step.reply_booking_${a.answer}`,
        params: { site: siteOf(a.orderId), day: isDay(a.day) ? dayName(a.day) : '—', time: a.time ?? '—', rate: posInt(a.ratePaise) ? rupees(a.ratePaise) : '—' },
      }),
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if (!['yes', 'no', 'other_time'].includes(a.answer)) return no('common.bad_args');
        if (a.answer === 'yes' && !posInt(a.ratePaise)) return no('jcb.rate_needed');
        if (a.answer === 'other_time' && !isDay(a.day)) return no('jcb.day_needed');
        if ((a.time !== undefined && !isTime(a.time)) || (a.day !== undefined && !isDay(a.day))) return no('common.bad_args');
        /** @type {Record<string, any>} */
        const body = { answer: a.answer };
        if (a.day !== undefined) body.day = a.day;
        if (a.time !== undefined) body.time = a.time;
        if (a.answer === 'yes') body.ratePaise = a.ratePaise;
        const d = await link.send({ type: 'BOOKING_REPLY', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        if (d.ok && a.answer === 'yes') {
          const req = ofType(ledger.events(a.orderId), 'BOOKING_REQUEST', 'in').at(-1)?.body.body;
          const bookedDay = a.day ?? req?.day;
          await tell('operator', 'jcb.job_booked', { ref: refOf(a.orderId), site: req?.site ?? '—', day: isDay(bookedDay) ? dayName(bookedDay) : '—', time: a.time ?? req?.time ?? '—' });
        }
        return deliveryResult(d, `jcb.reply_sent_${a.answer}`);
      },
    },

    // The operator (or owner) confirms a meter reading the reader proposed from a photo.
    record_meter: {
      roles: ['operator', 'jcb_owner'],
      commits: true,
      describe: (a) => ({ key: `step.record_meter_${a.which}`, params: { reading: nonNegInt(a.valueTenths) ? hours(a.valueTenths) : '—' } }),
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if ((a.which !== 'start' && a.which !== 'end') || !nonNegInt(a.valueTenths) || !isSha256(a.sha256)) return no('common.bad_args');
        if (a.takenAt !== undefined && a.takenAt !== null && !isIso(a.takenAt)) return no('common.bad_args');
        const r = meterReadings(ledger.events(a.orderId));
        if (a.which === 'end') {
          if (!r.start) return no('jcb.start_first');
          if (a.valueTenths <= r.start.valueTenths) return no('jcb.end_not_after_start', { start: hours(r.start.valueTenths) });
        }
        if (a.which === 'start' && r.end && a.valueTenths >= r.end.valueTenths) return no('jcb.end_not_after_start', { start: hours(a.valueTenths) });
        const stored = ledger.append({
          orderId: a.orderId, direction: 'local', type: 'EVIDENCE', msgId: randomUUID(),
          body: { kind: 'meter', which: a.which, valueTenths: a.valueTenths, sha256: a.sha256, takenAt: a.takenAt ?? null },
          at: new Date(agent.now()).toISOString(),
        });
        if (stored === null) return no('common.wrong_state');
        if (a.which === 'end' && r.start) {
          const worked = a.valueTenths - r.start.valueTenths;
          await tell('jcb_owner', 'jcb.meter_done', { hours: hours(worked) });
          return ok('jcb.meter_end_saved', { reading: hours(a.valueTenths), hours: hours(worked) });
        }
        return ok(`jcb.meter_${a.which}_saved`, { reading: hours(a.valueTenths) });
      },
    },

    // The owner sends the bill: hours from the two readings, the rate from our "yes".
    send_bill: {
      roles: ['jcb_owner'],
      commits: true,
      describe: (a) => {
        const events = isUuid(a.orderId) ? ledger.events(a.orderId) : [];
        const { start, end } = meterReadings(events);
        const rate = agreedRate(events);
        const h = start && end ? end.valueTenths - start.valueTenths : null;
        return {
          key: 'step.send_bill',
          params: { site: siteOf(a.orderId), hours: h === null ? '—' : hours(h), rate: rate === null ? '—' : rupees(rate), total: h === null || rate === null ? '—' : rupees(Math.round((h * rate) / 10)) },
        };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        const events = ledger.events(a.orderId);
        const { start, end } = meterReadings(events);
        if (!start || !end) return no('jcb.readings_missing');
        const rate = agreedRate(events);
        if (rate === null) return no('jcb.rate_needed');
        const body = jcbBillBody(end.valueTenths - start.valueTenths, rate, [start, end]);
        const d = await link.send({ type: 'BILL', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(d, 'jcb.bill_sent', { hours: hours(body.lines[0].hoursTenths), rate: rupees(rate), total: rupees(body.totalPaise) });
      },
    },

    // After a dispute the owner may send corrected hours; the bill it replaces stays in history.
    send_correction: {
      roles: ['jcb_owner'],
      commits: true,
      describe: (a) => {
        const rate = isUuid(a.orderId) ? agreedRate(ledger.events(a.orderId)) : null;
        const ok = posInt(a.hoursTenths);
        return { key: 'step.send_correction', params: { site: siteOf(a.orderId), hours: ok ? hours(a.hoursTenths) : '—', total: ok && rate !== null ? rupees(Math.round((a.hoursTenths * rate) / 10)) : '—' } };
      },
      async run(_p, a) {
        if (!isUuid(a.orderId) || !counterparty(a.orderId)) return no('common.no_such_order');
        if (!posInt(a.hoursTenths)) return no('common.bad_args');
        const events = ledger.events(a.orderId);
        const view = ledger.view(a.orderId);
        const rate = agreedRate(events);
        if (rate === null || view.currentBill === null) return no('common.wrong_state');
        const { start, end } = meterReadings(events);
        const body = { ...jcbBillBody(a.hoursTenths, rate, [start, end].filter((x) => x !== null)), replaces: view.currentBill };
        const d = await link.send({ type: 'CORRECTION', to: /** @type {string} */ (counterparty(a.orderId)), orderId: a.orderId, body });
        return deliveryResult(d, 'jcb.correction_sent', { hours: hours(a.hoursTenths), total: rupees(body.totalPaise) });
      },
    },

    // Only the owner can say the money has arrived; a screenshot from the contractor is a claim.
    confirm_payment: {
      roles: ['jcb_owner'],
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
        return deliveryResult(d, 'jcb.settled_sent', { amount: rupees(amountPaise) });
      },
    },
  };

  /**
   * Called once when the contractor's agent's message has been written to our ledger.
   * @param {Message} m
   */
  async function onApplied(m) {
    const b = m.body;
    switch (m.type) {
      case 'BOOKING_REQUEST':
        await tell('jcb_owner', 'jcb.booking_request', { ref: refOf(m.order_id), site: b.site, day: dayName(b.day), time: b.time ?? '—', hours: b.hoursTenths ? hours(b.hoursTenths) : '—' });
        break;
      case 'ACCEPT':
        await tell('jcb_owner', 'jcb.bill_accepted', { ref: refOf(m.order_id), site: siteOf(m.order_id) });
        break;
      case 'DISPUTE': {
        await tell('jcb_owner', 'jcb.bill_disputed', {
          ref: refOf(m.order_id),
          site: siteOf(m.order_id),
          their: b.theirFigure?.hoursTenths !== undefined ? `${hours(b.theirFigure.hoursTenths)} h` : b.theirFigure?.totalPaise !== undefined ? rupees(b.theirFigure.totalPaise) : '—',
          reason: b.reason,
        });
        const explanation = await explainDifference({ spark: o.spark, audience: 'seller', facts: differenceFacts(ledger, m.order_id, refOf(m.order_id)) });
        await tell('jcb_owner', explanation.key, explanation.params);
        break;
      }
      case 'PAYMENT_CLAIM':
        // With the receipt's clock when it was visible; an old claim without `paidAt` reads as before.
        await tell('jcb_owner', typeof b.paidAt === 'string' ? 'jcb.payment_claimed_at' : 'jcb.payment_claimed', { ref: refOf(m.order_id), site: siteOf(m.order_id), amount: rupees(b.amountPaise), utr: b.utr, day: dayName(b.paidOn), ...(typeof b.paidAt === 'string' ? { time: b.paidAt } : {}) }, { tool: 'confirm_payment', args: { orderId: m.order_id } });
        break;
      default:
        break;
    }
  }

  /** @param {string} orderId */
  const siteOf = (orderId) => /** @type {{site: string} | null} */ (ledger.order(orderId))?.site ?? '—';

  return { tools, onApplied };
}
