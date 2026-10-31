// The JCB owner's agent: the steps the owner and the operator can take, and what they are told when
// the contractor's agent sends something. Every figure on a bill comes from the ledger (the agreed
// rate from our own "yes", the hours from the two meter readings the operator confirmed); nothing
// is computed by a model.

import { randomUUID } from 'node:crypto';
import { rateUsualNotes, withUsual } from './usual.js';
import { tenths as hours, rupees, day as dayName } from '../i18n/format.js';
import { deliveryResult, isIso, isSha256, isTime, isDay, isUuid, no, nonNegInt, ofType, ok, posInt } from './common.js';
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
/** @typedef {import('../protocol/messages.js').Message} Message */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */
// One job is one day's work: more than 24 hours between two meter readings means the photos are of
// different machines or a misread, never work done. Code refuses it; the person sends the right photo
// or types the digits. (Found live on 29 Oct: two clear photos of two different JCBs gave 4,738 hours.)
export const MAX_JOB_TENTHS = 240;
/** @param {number} startTenths @param {number} endTenths */
export const impossible = (startTenths, endTenths) => ({ start: hours(startTenths), end: hours(endTenths), hours: hours(endTenths - startTenths) });

/** @typedef {{which: 'start' | 'end', valueTenths: number, sha256: string, takenAt: string | null, at: string, record?: string}} MeterReading */

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
    r[which] = { which, valueTenths: e.body.valueTenths, sha256: e.body.sha256, takenAt: e.body.takenAt ?? null, at: e.at, record: e.msgId ?? undefined };
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
    evidence: readings.map((m) => ({ sha256: m.sha256, kind: 'meter', readValue: hours(m.valueTenths), takenAt: m.takenAt, sentAt: m.at, ...(m.record ? { record: m.record } : {}) })),
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
  // Only this seller can say the money has arrived; a screenshot or a claim is not money (CONTRACTS 4.1).
  const seller = createSellerPayments({ ledger, link, tell, role: 'jcb_owner', settledKey: 'jcb.settled_sent',
    refOf: (id) => refOf(id), siteOf: (id) => siteOf(id), now: () => agent.now() });

  /** @param {string} orderId */
  const counterparty = (orderId) => /** @type {{counterparty: string} | null} */ (ledger.order(orderId))?.counterparty ?? null;

  /** The rate we agreed to in our own "yes". @param {LedgerEvent[]} events */
  const agreedRate = (events) => {
    const yes = ofType(events, 'BOOKING_REPLY', 'out').filter((e) => e.body.body.answer === 'yes').at(-1);
    return yes && posInt(yes.body.body.ratePaise) ? yes.body.body.ratePaise : null;
  };

  /**
   * The day and time an answer is about: another day when offered, else the day (and on a yes the
   * time) the request asked for. No time is no time, never "—".
   * @param {Record<string, any>} a @returns {{day: string, time: string | null}}
   */
  const answered = (a) => {
    const req = isUuid(a.orderId) ? ofType(ledger.events(a.orderId), 'BOOKING_REQUEST', 'in').at(-1)?.body.body : undefined;
    const day = isDay(a.day) ? a.day : req?.day;
    const time = isTime(a.time) ? a.time : a.answer === 'yes' && isTime(req?.time) ? req.time : null;
    return { day: isDay(day) ? dayName(day) : '—', time };
  };

  /** @type {Record<string, Tool>} */
  const tools = {
    // The owner answers a booking request: yes (with the hourly rate), no, or another day/time.
    reply_booking: {
      roles: ['jcb_owner'],
      commits: true,
      describe: (a) => {
        const w = answered(a);
        return withUsual({
          key: variant(`step.reply_booking_${a.answer}`, { time: a.answer !== 'no' && w.time }),
          params: { site: siteOf(a.orderId), day: w.day, ...(w.time ? { time: w.time } : {}), rate: posInt(a.ratePaise) ? rupees(a.ratePaise) : '—' },
        }, a.answer === 'yes' && posInt(a.ratePaise) ? rateUsualNotes(ledger, a.orderId, a.ratePaise) : '');
      },
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
        const w = answered(a);
        if (d.ok && a.answer === 'yes') {
          const n = jobBookedNotice(a.orderId, w);
          await tell('operator', n.key, n.params);
        }
        // One receipt of what was sent, with the figures.
        return withUsual(deliveryResult(d, `jcb.reply_sent_${a.answer}`, { ref: refOf(a.orderId), site: siteOf(a.orderId), day: w.day, ...(posInt(a.ratePaise) ? { rate: rupees(a.ratePaise) } : {}) }),
          d.ok && a.answer === 'yes' ? rateUsualNotes(ledger, a.orderId, a.ratePaise) : '');
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
        // Asked or read before another reading arrived: the start is already there, nothing is overwritten.
        if (a.which === 'start' && r.start) return no('jcb.meter_which_stale');
        if (a.which === 'end') {
          if (!r.start) return no('jcb.start_first');
          traceCheck(`meter end above start ${a.valueTenths > r.start.valueTenths ? '✓' : '✗'} ${hours(a.valueTenths)} > ${hours(r.start.valueTenths)}`,
            a.valueTenths > r.start.valueTenths, { name: 'meter_order', startTenths: r.start.valueTenths, endTenths: a.valueTenths }, a.orderId);
          if (a.valueTenths <= r.start.valueTenths) return no('jcb.end_not_after_start', { start: hours(r.start.valueTenths) });
          if (a.valueTenths - r.start.valueTenths > MAX_JOB_TENTHS) return no('jcb.meter_hours_impossible', impossible(r.start.valueTenths, a.valueTenths));
        }
        if (a.which === 'start' && r.end && a.valueTenths >= r.end.valueTenths) return no('jcb.end_not_after_start', { start: hours(a.valueTenths) });
        if (a.which === 'start' && r.end && r.end.valueTenths - a.valueTenths > MAX_JOB_TENTHS) return no('jcb.meter_hours_impossible', impossible(a.valueTenths, r.end.valueTenths));
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
        traceCheck(`hours = end − start: ${hours(end.valueTenths)} − ${hours(start.valueTenths)} = ${hours(body.lines[0].hoursTenths)} h × ${rupees(rate)} = ${rupees(body.totalPaise)}`,
          true, { name: 'bill_from_meter', startTenths: start.valueTenths, endTenths: end.valueTenths, hoursTenths: body.lines[0].hoursTenths, ratePaise: rate, totalPaise: body.totalPaise }, a.orderId);
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
        if (!posInt(a.hoursTenths) || a.hoursTenths > MAX_JOB_TENTHS) return no('common.bad_args');
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
    // Calling off a job never carried out; the operator is told.
    cancel_order: cancelTool({ ledger, link, tell, roles: ['jcb_owner'], team: { role: 'operator', key: 'jcb.order_cancelled_own' } }),
    // Payments: confirm_payment and record_received (src/agents/pay.js, the same for both sellers).
    ...seller.tools,
  };

  /** @typedef {{key: string, params: Record<string, string | number>}} Notice */

  /** To the operator: a job is booked. @param {string} orderId @param {{day: string, time: string | null}} w @returns {Notice} */
  const jobBookedNotice = (orderId, w) => ({
    key: variant('jcb.job_booked', { time: w.time }),
    params: { ref: refOf(orderId), site: siteOf(orderId), day: w.day, ...(w.time ? { time: w.time } : {}) },
  });

  /**
   * To the owner: the notice for a contractor's message that asks something of them (a booking request,
   * an objection to the bill, a reported payment). The same text when first told and when told again
   * after a missed 24-hour window (waiting()).
   * @param {Message} m @returns {Notice | null}
   */
  function ownerNotice(m) {
    const b = m.body;
    switch (m.type) {
      case 'BOOKING_REQUEST':
        return { key: variant('jcb.booking_request', { time: b.time, hours: b.hoursTenths }), params: {
          ref: refOf(m.order_id), site: b.site, day: dayName(b.day), ...(b.time ? { time: b.time } : {}), ...(b.hoursTenths ? { hours: hours(b.hoursTenths) } : {}),
        } };
      case 'DISPUTE': {
        // How to answer with a correction: the hours the contractor named, else the hours billed.
        const billed = ledger.eventOfMessage(b.bill)?.body.body.lines?.[0]?.hoursTenths;
        const example = posInt(b.theirFigure?.hoursTenths) ? b.theirFigure.hoursTenths : posInt(billed) ? billed : null;
        return { key: 'jcb.bill_disputed', params: {
          ref: refOf(m.order_id),
          site: siteOf(m.order_id),
          their: b.theirFigure?.hoursTenths !== undefined ? `${hours(b.theirFigure.hoursTenths)} h` : b.theirFigure?.totalPaise !== undefined ? rupees(b.theirFigure.totalPaise) : '—',
          reason: b.reason,
          example: example !== null ? hours(example) : '6',
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
    const n = ownerNotice(m);
    switch (m.type) {
      case 'BOOKING_REQUEST':
        if (n) await tell('jcb_owner', n.key, n.params);
        break;
      case 'ACCEPT':
        await tell('jcb_owner', 'jcb.bill_accepted', { ref: refOf(m.order_id), site: siteOf(m.order_id) });
        // Advances already covering the bill settle it now.
        await seller.onApplied(m);
        break;
      case 'DISPUTE': {
        if (n) await tell('jcb_owner', n.key, n.params);
        const explanation = await explainDifference({ spark: o.spark, audience: 'seller', facts: differenceFacts(ledger, m.order_id, refOf(m.order_id)) });
        await tell('jcb_owner', explanation.key, explanation.params);
        break;
      }
      case 'PAYMENT_CLAIM':
        await seller.onApplied(m);
        break;
      case 'CANCEL': {
        const words = orderWords(ledger, m.order_id);
        await tell('jcb_owner', 'jcb.order_cancelled', words);
        await tell('operator', 'jcb.order_cancelled', words);
        break;
      }
      default:
        break;
    }
  }

  // What still waits for each role, by the order's state, and the message that asked for it.
  /** @type {Record<string, [string, string]>} */
  /** @type {Record<string, [string, 'in' | 'out' | 'local']>} */
  const OWNER_WAITS = { requested: ['BOOKING_REQUEST', 'in'], disputed: ['DISPUTE', 'in'] };

  /**
   * What is still waiting for a person of this role, rebuilt from the ledger (docs/BUILD2.md "GST on
   * material", 24-hour window): the owner's open requests, objections and reported payments, the
   * operator's booked jobs not started. The text is the notice's own, as it would be told now.
   * @param {string} role @returns {Notice[]}
   */
  function waiting(role) {
    /** @type {Notice[]} */
    const out = role === 'jcb_owner' ? paymentWaiting(ledger) : [];
    for (const order of /** @type {{order_id: string}[]} */ (ledger.orders())) {
      const id = order.order_id;
      const state = ledger.view(id).state;
      if (role === 'jcb_owner' && Object.hasOwn(OWNER_WAITS, state)) {
        const [type, direction] = OWNER_WAITS[state];
        const e = ofType(ledger.events(id), type, direction).at(-1);
        const n = e ? ownerNotice(/** @type {Message} */ (e.body)) : null;
        if (n) out.push(n);
      }
      if (role === 'operator' && state === 'booked') {
        const yes = ofType(ledger.events(id), 'BOOKING_REPLY', 'out').filter((e) => e.body.body.answer === 'yes').at(-1);
        if (yes) out.push(jobBookedNotice(id, answered({ orderId: id, answer: 'yes', day: yes.body.body.day, time: yes.body.body.time })));
      }
    }
    return out;
  }

  /** @param {string} orderId */
  const siteOf = (orderId) => /** @type {{site: string} | null} */ (ledger.order(orderId))?.site ?? '—';

  return { tools, onApplied, waiting };
}
