// An owner's own records as an Excel file on WhatsApp (docs/BUILD2.md, last section). Read-only and
// code only: no model is called and nothing is written to the ledger. Every figure comes from the same
// helpers the app answers with (`orderFacts`, `paymentSummary`), so refused messages are left out the
// same way. A month chooses orders by their day; each order then comes whole, with all its bills and
// payments, so a file's balances are the ones `status` shows.

import { orderFacts, whoOf } from '../agents/ask.js';
import { no, nonNegInt, ofType, ok } from '../agents/common.js';
import { itemsText, siteChallan } from '../agents/material.js';
import { paymentEvents } from '../agents/payment-view.js';
import { day as dayName, rupees, tenths } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { traceCheck } from '../trace/trace.js';
import { workbook, XLSX_MIME } from './xlsx.js';

/** @typedef {import('./xlsx.js').Cell} Cell */
/** @typedef {import('./xlsx.js').Sheet} Sheet */
/** @typedef {import('../agents/ask.js').OrderFacts} OrderFacts */
/** @typedef {{bytes: Uint8Array, mime: string, fileName: string, caption: string}} RecordsDocument */

// WhatsApp takes a document up to 100 MB. This is far below that and far above any real ledger: past
// it the upload would be slow and the file no use on a phone, and a month is the way to a smaller one.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const REF = 'संदर्भ (Reference)';
const SITE = 'साइट (Site)';
const UNIT = 'इकाई (Unit)';
// Headings are in both languages by design, so they live with their sheet and not among the message texts.
const COLUMNS = {
  orders: { name: 'ऑर्डर (Orders)', columns: [REF, 'प्रकार (Kind)', SITE, 'दिन (Day)', 'सामने वाला (Other party)', 'हालत (State)', 'क्या माँगा (Asked)'] },
  deliveries: { name: 'पहुँच और गिनती (Deliveries)', columns: [REF, 'चीज़ (Item)', UNIT, 'चालान पर (On challan)', 'साइट की गिनती (Site count)', 'किसने, कैसे दर्ज की (Entered by, how)', 'चालान नंबर (Challan no.)'] },
  bills: { name: 'बिल (Bills)', columns: [REF, 'बिल या सुधार (Bill or correction)', 'लागू (In force)', 'लाइन (Line)', 'मात्रा या घंटे (Quantity or hours)', UNIT, 'दर (Rate)', 'GST %', 'GST ₹', 'रक़म (Amount)', 'बिल का कुल (Bill total)'] },
  payments: { name: 'भुगतान (Payments)', columns: [REF, 'तारीख़ (Date)', 'तरीक़ा (Method)', 'रक़म (Amount)', 'हालत (Status)', 'UTR', 'किसलिए (Purpose)', 'एक साथ (Paid together)'] },
  balance: { name: 'हिसाब (Balance)', columns: [REF, SITE, 'बिल (Bill)', 'पक्का भुगतान (Confirmed)', 'पक्का होना बाक़ी (Waiting)', 'देना बाक़ी (Due)', 'ज़्यादा जमा (Credit)'] },
};
const COUNT_WAYS = ['yes', 'typed', 'photo'];
const COUNT_BY = ['contractor', 'supervisor'];
const HOURS_UNIT = 'घंटे';
// A number a person might have typed into a site or item name. An Indian mobile, with or without its
// prefix; a UTR is 12 digits on its own column and does not pass through here.
const PHONE = /(?<!\d)(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/g;

/** Free text from the ledger, with any phone number down to its last 4 digits. @param {string} s */
const noPhones = (s) => s.replace(PHONE, (m) => `…${m.replace(/\D/g, '').slice(-4)}`);
/** @param {unknown} n @returns {Cell} */
const money = (n) => (nonNegInt(n) ? { money: /** @type {number} */ (n) } : null);
/** @param {number} n hundredths or tenths @param {number} per */
const scaled = (n, per) => n / per;
/** @param {import('../ledger/store.js').LedgerEvent} e */
const bodyOf = (e) => (e.direction === 'local' ? e.body : e.body.body ?? {});
/** @param {string} s */
const fold = (s) => s.trim().toLowerCase();

/** @param {OrderFacts} o @param {'buyer' | 'seller'} side @returns {Cell[]} */
function orderRow(o, side) {
  const asked = o.kind === 'material' ? itemsText(o.requested) || t('kind.material')
    : o.hoursTenths !== null ? t('office.what_jcb', { hours: tenths(o.hoursTenths) }) : t('kind.jcb');
  return [o.ref, t(o.kind === 'material' ? 'kind.material' : 'kind.jcb'), noPhones(o.site), { date: o.day }, whoOf(o, side),
    o.state === 'none' ? t('office.state_unknown') : t(`state.${o.state}`), noPhones(asked)];
}

/** Who entered the count in force, and how; on a seller's ledger, that it came on the site's signed copy. @param {OrderFacts} o */
function countedBy(o) {
  const e = o.countEntry;
  if (e && COUNT_WAYS.includes(e.how) && COUNT_BY.includes(e.by)) return t(`records.count_entered.${e.how}`, { by: t(`records.who.${e.by}`) });
  return !o.counted && o.siteReceipt ? t('evidence.kind.site_count') : null;
}

/** One row per item delivered or counted, and the site's hours on a JCB job. @param {OrderFacts} o @param {import('../ledger/store.js').LedgerEvent[]} events @returns {Cell[][]} */
function deliveryRows(o, events) {
  if (o.kind === 'jcb_hours') {
    if (!o.siteHours) return [];
    return [[o.ref, t('kind.jcb'), HOURS_UNIT, null, scaled(o.siteHours.hoursTenths, 10), t('records.hours_entered', { by: t(`records.who.${o.siteHours.by}`) }), null]];
  }
  const delivery = ofType(events, 'DELIVERY').at(-1);
  const challanNo = delivery ? bodyOf(delivery).challan?.number : null;
  const number = typeof challanNo === 'string' ? challanNo : siteChallan(events)?.number ?? o.siteReceipt?.number ?? null;
  /** @type {Map<string, {name: string, unit: string, challan: number | null, count: number | null}>} */
  const rows = new Map();
  const counted = o.counted ?? o.siteReceipt?.items ?? [];
  for (const [items, field] of /** @type {const} */ ([[o.delivered ?? [], 'challan'], [counted, 'count']])) {
    for (const i of items) {
      const key = `${fold(i.name)}\u0000${fold(i.unit)}`;
      const r = rows.get(key) ?? { name: i.name.trim(), unit: i.unit.trim(), challan: null, count: null };
      r[field] = i.qtyHundredths;
      rows.set(key, r);
    }
  }
  const by = countedBy(o);
  return [...rows.values()].map((r) => [o.ref, noPhones(r.name), noPhones(r.unit), r.challan === null ? null : scaled(r.challan, 100), r.count === null ? null : scaled(r.count, 100),
    r.count === null ? null : by, number === null ? null : noPhones(number)]);
}

/** Each bill and correction in order, one row per line; the bill's total on its first row only, so a column still adds up. @param {OrderFacts} o @param {import('../ledger/store.js').LedgerEvent[]} events @param {string | null} inForce @returns {Cell[][]} */
function billRows(o, events, inForce) {
  const units = o.delivered ?? [];
  let corrections = 0;
  return events.filter((e) => e.type === 'BILL' || e.type === 'CORRECTION').flatMap((e) => {
    const b = bodyOf(e);
    const label = e.type === 'BILL' ? t('excel.bill') : t('excel.correction', { n: corrections += 1 });
    const forced = t(e.msgId === inForce ? 'excel.in_force' : 'excel.not_in_force');
    const lines = /** @type {any[]} */ (Array.isArray(b.lines) ? b.lines : []).filter((l) => l && typeof l.what === 'string');
    return lines.map((l, i) => {
      const hours = nonNegInt(l.hoursTenths);
      const quantity = hours ? scaled(l.hoursTenths, 10) : nonNegInt(l.qtyHundredths) ? scaled(l.qtyHundredths, 100) : null;
      return [o.ref, label, forced, noPhones(l.what), quantity, hours ? HOURS_UNIT : units[i] ? noPhones(units[i].unit) : null, money(l.ratePaise),
        Number.isFinite(l.gstPercent) ? l.gstPercent : null, money(l.gstPaise), money(l.amountPaise), i === 0 ? money(b.totalPaise) : null];
    });
  });
}

/** @param {OrderFacts} o @param {OrderFacts[]} all @returns {Cell[][]} */
function paymentRows(o, all) {
  return o.balance.payments.map((p) => {
    const refs = p.group ? p.group.orders.flatMap((id) => { const ref = all.find((x) => x.orderId === id)?.ref; return ref ? [ref] : []; }).join(', ') : '';
    return [o.ref, p.paidOn ? { date: p.paidOn } : null, t(`records.method.${p.method}`), money(p.amountPaise), t(`records.payment.${p.status}`), p.utr,
      t(p.advance ? 'records.advance' : 'records.against_bill'), p.group ? `${refs}: ${rupees(p.group.totalPaise)}` : null];
  });
}

/** An order with neither a bill nor a payment has no balance to show. @param {OrderFacts} o @returns {Cell[][]} */
function balanceRows(o) {
  const b = o.balance;
  if (b.billTotalPaise === null && b.payments.length === 0) return [];
  return [[o.ref, noPhones(o.site), money(b.billTotalPaise), money(b.confirmedPaise), money(b.waitingPaise), money(b.duePaise), money(b.creditPaise)]];
}

/**
 * The workbook of this ledger's orders, or null when the period holds none.
 * @param {{ledger: import('../ledger/store.js').Ledger, side: 'buyer' | 'seller', month: string | null}} o `month` is "YYYY-MM"; null means everything
 * @returns {{bytes: Buffer, orders: number, rows: number, sheets: number} | null}
 */
export function recordsWorkbook(o) {
  const all = orderFacts(o.ledger);
  const { month } = o;
  const chosen = month === null ? all : all.filter((f) => f.day.startsWith(`${month}-`));
  if (chosen.length === 0) return null;
  /** @type {Record<keyof typeof COLUMNS, Cell[][]>} */
  const rows = { orders: [], deliveries: [], bills: [], payments: [], balance: [] };
  for (const f of chosen) {
    const events = paymentEvents(o.ledger.events(f.orderId));
    rows.orders.push(orderRow(f, o.side));
    rows.deliveries.push(...deliveryRows(f, events));
    rows.bills.push(...billRows(f, events, o.ledger.view(f.orderId).currentBill));
    rows.payments.push(...paymentRows(f, all));
    rows.balance.push(...balanceRows(f));
  }
  /** @type {Sheet[]} */
  const sheets = (/** @type {(keyof typeof COLUMNS)[]} */ (Object.keys(COLUMNS))).map((k) => ({ ...COLUMNS[k], rows: rows[k] }));
  return { bytes: workbook(sheets), orders: chosen.length, rows: sheets.reduce((n, s) => n + s.rows.length, 0), sheets: sheets.length };
}

/**
 * Makes the file and sends it, and says what happened. Nothing is claimed unless WhatsApp took it.
 * @param {{ledger: import('../ledger/store.js').Ledger, side: 'buyer' | 'seller', agentName: string, month: string | null,
 *   send: (doc: RecordsDocument) => Promise<{ok: true, id: string} | {ok: false, reason: string}>, maxBytes?: number}} o
 * @returns {Promise<import('../agents/common.js').Said>}
 */
export async function sendRecords(o) {
  const { month } = o;
  const monthName = month === null ? '' : dayName(`${month}-01`).replace(/^\d+ /, '');
  /** @param {string} outcome @param {boolean} pass @param {{orders: number, rows: number, sheets: number, bytes: Buffer} | {bytes?: undefined, rows?: undefined, sheets?: undefined}} made */
  const told = (outcome, pass, made) => traceCheck(`records file: ${made.sheets ?? 0} sheets, ${made.rows ?? 0} rows, ${outcome}`, pass,
    { name: 'records_file', outcome, sheets: made.sheets ?? 0, rows: made.rows ?? 0, bytes: made.bytes?.length ?? 0 });
  const made = recordsWorkbook(o);
  if (made === null) {
    told('nothing in this period', true, {});
    return ok(month === null ? 'excel.none' : 'excel.none_month', month === null ? undefined : { month: monthName });
  }
  if (made.bytes.length > (o.maxBytes ?? MAX_FILE_BYTES)) {
    told('too large', false, made);
    return no(month === null ? 'excel.too_big' : 'excel.too_big_month', month === null ? undefined : { month: monthName });
  }
  const sent = await o.send({ bytes: made.bytes, mime: XLSX_MIME, fileName: `hisaab-${o.agentName}-${month ?? 'all'}.xlsx`,
    caption: month === null ? t('excel.caption_all') : t('excel.caption_month', { month: monthName }) });
  told(sent.ok ? 'sent' : 'not sent', sent.ok, made);
  return sent.ok ? ok('excel.sent', { orders: made.orders }) : no('excel.send_failed');
}
