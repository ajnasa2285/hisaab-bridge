// Cancelling an order that was never carried out (docs/CONTRACTS.md section 4, `CANCEL`). The contractor
// on the buyer's side, the JCB owner or the supplier on the seller's; never a supervisor or an operator.
// An exact command read by code (src/agents/office.js parseCommand), read back, one "हाँ", one signed
// message; the other side's agent records it without a yes and tells its people. Refused, with the
// reason, once the order has meter evidence, a delivery, a site count, a bill or money on it. What this
// side cannot see (the JCB side's meter photos) the other side's state refuses. The site's own hours on a
// JCB job (a `site_hours` NOTE) do not refuse: they are entered with no read-back and cannot be changed, so
// one mistyped reference must not lock an order, no bill can follow a cancel, and a refusal to the JCB owner
// would give away a note that is ours alone.

import { CANCELLABLE } from '../ledger/states.js';
import { openRefs } from '../ledger/refs.js';
import { day as dayName, rupees } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { deliveryResult, isUuid, no, ofType } from './common.js';
import { itemsText, requestedItems, siteCount } from './material.js';

/** @typedef {import('../ledger/store.js').Ledger} Ledger */
/** @typedef {import('../wa/directory.js').Role} Role */

/**
 * Why this order cannot be cancelled, as a text to say; null when it can. Pure reading.
 * @param {Ledger} ledger @param {string} orderId
 * @returns {{key: string, params: Record<string, string>} | null}
 */
export function cancelBlock(ledger, orderId) {
  const ref = openRefs(ledger).refOf(orderId) ?? '—';
  const view = ledger.view(orderId);
  const events = ledger.events(orderId);
  if (view.state === 'cancelled') return { key: 'cancel.already', params: { ref } };
  if (view.currentBill !== null) return { key: 'cancel.has_bill', params: { ref } };
  const money = Object.values(view.paid).filter((p) => p.status !== 'denied').reduce((sum, p) => sum + p.amountPaise, 0);
  if (money > 0) return { key: 'cancel.has_payment', params: { ref, amount: rupees(money) } };
  if (view.state === 'delivered') return { key: 'cancel.has_delivery', params: { ref } };
  if (siteCount(events) !== null) return { key: 'cancel.has_count', params: { ref } };
  if (ofType(events, 'EVIDENCE', 'local').some((e) => e.body.kind === 'meter')) return { key: 'cancel.has_meter', params: { ref } };
  return CANCELLABLE.includes(view.state) ? null : { key: 'cancel.closed', params: { ref, state: t(`state.${view.state}`) } };
}

/**
 * An order in the words every notice uses: reference, site, day and what it was for.
 * @param {Ledger} ledger @param {string} orderId @returns {Record<string, string>}
 */
export function orderWords(ledger, orderId) {
  const order = /** @type {{kind: string, site: string}} */ (ledger.order(orderId));
  const events = ledger.events(orderId);
  const day = ofType(events, 'BOOKING_REQUEST').at(-1)?.body.body.day;
  return {
    ref: openRefs(ledger).refOf(orderId) ?? '—', site: order.site, day: typeof day === 'string' ? dayName(day) : '—',
    what: order.kind === 'material' ? itemsText(requestedItems(events)) : t('kind.jcb'),
  };
}

/**
 * The step: read back, then the signed CANCEL. `team` is told too: the people of this side who work on
 * the order and did not decide this. A message that could not be delivered stays recorded and goes again.
 * @param {{ledger: Ledger, link: ReturnType<typeof import('./link.js').createLink>, tell: import('./common.js').Tell,
 *   roles: Role[], team?: {role: Role, key: string}}} o
 * @returns {import('./common.js').Tool}
 */
export function cancelTool(o) {
  const { ledger } = o;
  const known = (/** @type {unknown} */ id) => isUuid(id) && ledger.order(/** @type {string} */ (id)) !== null;
  return {
    roles: o.roles,
    commits: true,
    describe: (a) => ({ key: 'step.cancel_order', params: known(a.orderId) ? orderWords(ledger, a.orderId) : { ref: '—', site: '—', day: '—', what: '—' } }),
    stillOpen: (a) => known(a.orderId) && cancelBlock(ledger, a.orderId) === null,
    async run(_p, a) {
      if (!known(a.orderId)) return no('common.no_such_order');
      const blocked = cancelBlock(ledger, a.orderId);
      if (blocked) return no(blocked.key, blocked.params);
      const words = orderWords(ledger, a.orderId);
      const to = /** @type {{counterparty: string}} */ (ledger.order(a.orderId)).counterparty;
      const d = await o.link.send({ type: 'CANCEL', to, orderId: a.orderId, body: {} });
      if (!d.ok && d.reason === 'refused') return no('cancel.refused', { ref: words.ref });
      if (o.team && (d.ok || 'message' in d)) await o.tell(o.team.role, o.team.key, words);
      return deliveryResult(d, 'cancel.done', words);
    },
  };
}
