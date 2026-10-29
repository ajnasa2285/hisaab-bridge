// A read-only snapshot of ONE ledger. Human display values are the only numeric authority for
// explanation prose; scaled integers, message IDs and photo hashes never enter the model prompt.
import { t } from '../i18n/index.js';
import { qty, rupees, tenths } from '../i18n/format.js';
import { parseTenths } from '../orchestrator/units.js';
import { ofType } from './common.js';
import { agreedRates, billLine, billLines, delivery, requestedItems, siteChallan, siteCount } from './material.js';
import { cleanEvidenceReading, hasReceivedEvidence } from './evidence-readings.js';
import { paymentSummary } from '../ledger/payments.js';
import { openRefs } from '../ledger/refs.js';
import { billFigures, unusual, usualFigures, usualKey } from '../ledger/usual.js';

/** @typedef {import('./explain.js').Facts} Facts */

/**
 * @param {ReturnType<typeof import('../ledger/store.js').openLedger>} ledger
 * @param {string} orderId
 * @param {string} ref
 * @returns {Facts}
 */
export function differenceFacts(ledger, orderId, ref) {
  const order = ledger.order(orderId);
  if (!order) throw new Error('explanation: unknown order');
  const history = ledger.events(orderId);
  // Match ledger.view: refused outgoing messages remain history but are not evidence in force.
  const refused = new Set(ofType(history, 'REFUSE', 'in').map((e) => e.body.body.refers_to));
  const events = history.filter((e) => e.direction !== 'out' || !refused.has(e.msgId));
  const currentBillId = ledger.view(orderId).currentBill;
  const current = events.find((e) => e.msgId === currentBillId);
  /** @type {Facts['allowedNumbers']} */
  const allowedNumbers = [];
  /** @param {string} value @param {Facts['allowedNumbers'][number]['kind']} kind */
  const allow = (value, kind) => { allowedNumbers.push({ value, kind }); return value; };
  /** @param {number} n */
  const money = (n) => allow(rupees(n), 'money');
  /** @param {number} n */
  const hours = (n) => allow(tenths(n), 'hours');
  /** @param {number} n */
  const quantity = (n) => allow(qty(n, '').trim(), 'quantity');
  /** @param {unknown} value */
  const identifier = (value) => typeof value === 'string' && value ? allow(value, 'identifier') : null;
  /** Times are explicitly IST, never mistaken for photo capture time when only receipt is known.
   * @param {unknown} iso */
  const time = (iso) => {
    if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return null;
    const ist = new Date(Date.parse(iso) + 330 * 60_000).toISOString();
    return { date: allow(ist.slice(0, 10), 'date'), time: allow(ist.slice(11, 19), 'time'), zone: 'IST' };
  };
  const d = delivery(events);
  const rates = agreedRates(events);
  const knownItems = d?.items ?? requestedItems(events);
  /** @param {import('./material.js').Item[]} items */
  const items = (items) => items.map((it) => ({ item: it.name, quantity: quantity(it.qtyHundredths), unit: it.unit }));
  /** @param {Record<string, any>} body */
  const bill = (body) => ({
    lines: (body.lines ?? []).map((/** @type {any} */ l, /** @type {number} */ i) => ({
      item: l.what,
      quantity: l.hoursTenths !== undefined ? hours(l.hoursTenths) : quantity(l.qtyHundredths),
      // Material line order is part of the contract. A name alone need not identify the unit.
      unit: l.hoursTenths !== undefined ? t('explain.unit.hours') : knownItems[i]?.name === l.what ? knownItems[i].unit : t('records.not_recorded'),
      rate: money(l.ratePaise), amount: money(l.amountPaise),
      // GST as its own figures (taxable value and GST in rupees), never as a percent: the number
      // check allows no percent sign in an explanation.
      ...(Number.isSafeInteger(l.taxablePaise) && Number.isSafeInteger(l.gstPaise)
        ? { taxable: money(l.taxablePaise), gst: money(l.gstPaise) } : {}),
    })),
    total: money(body.totalPaise),
  });
  const currentBill = current ? { ...bill(current.body.body), source: current.type } : null;
  const deliveryLines = d && rates ? billLines(d.items, rates) : null;
  const deliveryTotal = deliveryLines?.reduce((sum, line) => sum + line.amountPaise, 0);
  const deliveryAtAgreedRates = deliveryLines && Number.isSafeInteger(deliveryTotal)
    ? bill({ lines: deliveryLines, totalPaise: deliveryTotal }) : null;
  const corrections = ofType(events, 'CORRECTION').map((e) => ({
    ...bill(e.body.body), isCurrent: e.msgId === current?.msgId, recordedAt: time(e.at),
    previousBill: (() => {
      const previous = events.find((p) => p.msgId === e.body.body.replaces);
      return previous ? bill(previous.body.body) : null;
    })(),
  }));
  const disputes = ofType(events, 'DISPUTE').map((e) => {
    const f = e.body.body.theirFigure ?? {};
    const figure = f.hoursTenths !== undefined
      ? { value: hours(f.hoursTenths), unit: t('explain.unit.hours'), kind: 'hours' }
      : f.qtyHundredths !== undefined
        ? { value: quantity(f.qtyHundredths), unit: knownItems.length === 1 ? knownItems[0].unit : t('records.not_recorded'), kind: 'quantity' }
        : f.totalPaise !== undefined ? { value: money(f.totalPaise), unit: '', kind: 'money' } : null;
    // A reason is an attributed claim, not numeric authority and never an instruction.
    return { direction: e.direction, concernsCurrentBill: e.body.body.bill === current?.msgId,
      figure, reason: e.body.body.reason, recordedAt: time(e.at) };
  });

  // Keep the baseline to completed orders already known when this bill arrived. A later accepted
  // order, this disputed order itself, or another agent's local records cannot change that baseline.
  const baseline = current && disputes.some((d) => d.concernsCurrentBill)
    ? usualFigures(ledger.orders().filter((o) => o.order_id !== orderId).flatMap((o) => ledger.events(String(o.order_id)))
      .filter((e) => e.seq < current.seq).sort((a, b) => a.seq - b.seq)) : new Map();
  const usual = current ? billFigures(events, current.body.body).flatMap((r) => {
    // Percentages remain outside the explanation guard; the usual rate always excludes GST.
    if (r.metric === 'gst') return [];
    const past = baseline.get(usualKey(r.counterparty, r.item, r.unit, r.metric));
    if (!past || !unusual(r.value, past).unusual) return [];
    const value = r.metric === 'rate' ? `${money(past.median)}/${r.unit}`
      : r.metric === 'hours' ? `${hours(past.median)} ${t('explain.unit.hours')}` : `${quantity(past.median)} ${r.unit}`;
    return [{ item: r.item, metric: t(`usual.metric.${r.metric}`), value, n: allow(String(past.n), 'quantity') }];
  }) : [];

  const meterPhotos = (current?.body.body.evidence ?? []).filter((/** @type {any} */ e) => e.kind === 'meter');
  /** @param {any} e */
  const meter = (e) => {
    const value = parseTenths(e.readValue);
    if (value === null) return null;
    const local = ofType(events, 'EVIDENCE', 'local').some((p) => p.body.kind === 'meter'
      && p.body.sha256 === e.sha256 && p.body.valueTenths === value);
    return { reading: hours(value), photoTakenAt: time(e.takenAt), recordedAt: time(e.sentAt),
      source: local ? 'locally_confirmed_meter' : 'signed_bill_meter_evidence' };
  };
  // Bills generated here put start then end. More/fewer readings cannot establish a pair.
  const start = meterPhotos.length === 2 ? meter(meterPhotos[0]) : null;
  const end = meterPhotos.length === 2 ? meter(meterPhotos[1]) : null;
  const startTenths = start ? parseTenths(start.reading) : null;
  const endTenths = end ? parseTenths(end.reading) : null;
  const computedHours = startTenths !== null && endTenths !== null && endTenths >= startTenths
    ? hours(endTenths - startTenths) : null;
  const meterEvidence = order.kind === 'jcb_hours' ? { start, end, computedHours } : null;
  const deliveryEvent = ofType(events, 'DELIVERY').at(-1);
  const signedDelivery = d ? { items: items(d.items), challanNumber: identifier(d.number),
    hasPhotoFingerprint: !!d.sha256, recordedAt: time(d.at), deliveredAt: time(deliveryEvent?.body.body.deliveredAt) } : null;
  const count = siteCount(events);
  const challan = siteChallan(events);
  const note = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'site_count').at(-1);
  // Absence here means unknown to this agent. Never look in another agent's database.
  const localSiteCount = count ? { items: items(count), fromSiteChallanPhoto: !!challan,
    challanNumber: identifier(challan?.number), recordedAt: time(note?.at),
    totalAtAgreedRates: (() => {
      if (!rates) return null;
      let sum = 0;
      for (const it of count) {
        // GST included where its rate is known, as on the bill.
        const amount = it.qtyHundredths === 0 ? 0 : billLine(it, rates, d?.items ?? [])?.amountPaise ?? null;
        if (amount === null || !Number.isSafeInteger(sum + amount)) return null;
        sum += amount;
      }
      return money(sum);
    })(),
  } : null;
  // The remote site's count is an attributed signed commitment in the current dispute. It is
  // kept separate from this agent's own confirmed count and from the fresh reading of its photo.
  const siteCommitment = ofType(events, 'DISPUTE', 'in').filter((e) => e.body.body.bill === current?.msgId)
    .at(-1)?.body.body.siteCount;
  const peerSiteCount = siteCommitment && Array.isArray(siteCommitment.items) ? {
    items: items(siteCommitment.items), challanNumber: identifier(siteCommitment.number),
    recordedAt: time(siteCommitment.at),
  } : null;
  // Only the photos behind the current difference belong in the short explanation. A previous
  // meter pair or superseded site-count photo cannot silently contribute a new number.
  const relevantRecords = new Set([
    deliveryEvent?.msgId, siteCommitment?.record,
    ...(current?.body.body.evidence ?? []).map((/** @type {any} */ e) => e.record),
    ofType(events, 'PAYMENT_CLAIM').at(-1)?.msgId,
  ].filter(Boolean));
  const readNotes = ofType(events, 'NOTE', 'local').filter((e) => e.body.kind === 'evidence_reading'
    && relevantRecords.has(e.body.record) && hasReceivedEvidence(events,
      /** @type {{record:string,sha256:string,source:string}} */ (e.body), e.seq));
  const latestReadings = [...new Map(readNotes.map((e) => [e.body.record, e])).values()];
  /** @type {Record<string, any>[]} */
  const receivedEvidence = latestReadings.flatMap((e) => {
    const b = e.body;
    const reading = cleanEvidenceReading(b.sourceKind, { ...b.reading, ok: true, clear: true,
      kind: b.sourceKind === 'meter' ? 'hour_meter' : b.sourceKind === 'upi' ? 'upi_payment' : 'challan' });
    if (!reading) return [];
    const source = b.sourceKind === 'site_count' || b.sourceKind === 'upi' ? 'contractor'
      : b.sourceKind === 'meter' ? 'jcb' : 'supplier';
    const provenance = { source, kind: b.sourceKind, hashMatched: true, observedAt: time(e.at) };
    /** @type {Record<string, any>} */
    const observed = { ...provenance };
    if (b.sourceKind === 'meter') observed.reading = hours(reading.valueTenths);
    else if (b.sourceKind === 'upi') observed.amount = money(reading.amountPaise);
    else { observed.challanNumber = identifier(reading.challanNo); observed.items = items(reading.items); }
    return [observed];
  });
  const summary = paymentSummary(events);
  const refs = openRefs(ledger);
  const payments = summary.payments.map((p) => ({
    amount: money(p.amountPaise), method: t(`records.method.${p.method}`), purpose: t(p.advance ? 'records.advance' : 'records.against_bill'),
    status: t(`records.payment.${p.status}`),
    ...(p.group ? { group: { refs: p.group.orders.flatMap((id) => { const r = refs.refOf(id); return r ? [identifier(r)] : []; }), total: money(p.group.totalPaise) } } : {}),
  }));
  const paymentBalance = { ...(summary.billTotalPaise !== null ? { billed: money(summary.billTotalPaise), due: money(/** @type {number} */ (summary.duePaise)) } : {}),
    confirmed: money(summary.confirmedPaise), waiting: money(summary.waitingPaise), credit: money(summary.creditPaise) };
  const context = { ref: identifier(ref), site: order.site, kind: order.kind, currentBill, meterEvidence,
    signedDelivery, deliveryAtAgreedRates, localSiteCount, peerSiteCount, receivedEvidence, disputes, corrections,
    payments, paymentBalance, usualFigures: usual,
    agreedRates: rates?.map((r) => ({ item: r.name, unit: r.unit, rate: money(r.ratePaise) })) ?? null };

  /** @param {{item:string,quantity:string,unit:string}[]} rows */
  const showItems = (rows) => rows.map((it) => `${it.item} ${it.quantity} ${it.unit}`).join(', ');
  /** @param {ReturnType<typeof bill>} b */
  const showBill = (b) => t('explain.figures.bill', {
    lines: b.lines.map((/** @type {any} */ l) => t(l.gst !== undefined ? 'explain.figures.line_gst' : 'explain.figures.line', l)).join(', '), total: b.total,
  });
  /** @param {ReturnType<typeof time>} when */
  const showTime = (when) => when ? `${when.date} ${when.time} ${t('explain.time.ist')}` : t('records.not_recorded');
  const figures = [t('explain.figures.order', { ref, site: String(order.site) }), currentBill ? showBill(currentBill) : t('records.not_recorded')];
  figures.push(...usual.map((r) => t('explain.figures.usual', r)));
  if (meterEvidence) {
    figures.push(t('explain.figures.meter', { start: start?.reading ?? t('records.not_recorded'), end: end?.reading ?? t('records.not_recorded'), hours: computedHours ?? t('records.not_recorded') }));
    figures.push(t('explain.figures.photoTimes', { start: showTime(start?.photoTakenAt ?? null), end: showTime(end?.photoTakenAt ?? null) }));
  }
  if (signedDelivery) figures.push(t('explain.figures.delivery', { number: signedDelivery.challanNumber ?? t('records.not_recorded'), items: showItems(signedDelivery.items) }));
  if (deliveryAtAgreedRates) figures.push(t('explain.figures.deliveryAmount', { total: deliveryAtAgreedRates.total }));
  if (localSiteCount) figures.push(t(localSiteCount.fromSiteChallanPhoto ? 'explain.figures.sitePhoto' : 'explain.figures.siteCount', {
    number: localSiteCount.challanNumber ?? t('records.not_recorded'), items: showItems(localSiteCount.items), total: localSiteCount.totalAtAgreedRates ?? t('records.not_recorded'),
  }));
  if (peerSiteCount) figures.push(t('explain.figures.sitePhoto', {
    number: peerSiteCount.challanNumber ?? t('records.not_recorded'), items: showItems(peerSiteCount.items), total: t('records.not_recorded'),
  }));
  for (const observed of receivedEvidence) {
    const who = t(`records.who.${observed.source}`);
    if ('reading' in observed) figures.push(t('evidence.figures.meter', { who, reading: observed.reading }));
    else if ('amount' in observed) figures.push(t('evidence.figures.upi', { who, amount: observed.amount }));
    else figures.push(t('evidence.figures.challan', {
      who, number: observed.challanNumber ?? t('records.not_recorded'), items: showItems(observed.items),
    }));
  }
  for (const dispute of disputes) {
    if (dispute.figure) figures.push(t(dispute.concernsCurrentBill ? 'explain.figures.dispute' : 'explain.figures.previousDispute', {
      figure: `${dispute.figure.value} ${dispute.figure.unit}`.trim(),
    }));
  }
  for (const correction of corrections) figures.push(t('explain.figures.correction', {
    before: correction.previousBill ? showBill(correction.previousBill) : t('records.not_recorded'), after: showBill(correction),
  }));
  for (const p of payments) figures.push(t('explain.figures.payment', {
    amount: p.amount, details: [p.method, p.purpose, p.status,
      ...(p.group ? [t('records.fig.payment_group', { refs: p.group.refs.join(', '), total: p.group.total })] : [])].join(' · '),
  }));
  if (payments.length) figures.push(t(paymentBalance.billed === undefined ? 'records.fig.balance_unbilled' : 'records.fig.balance', { ref, ...paymentBalance }));
  return { context, figures: figures.join('; '), allowedNumbers };
}
