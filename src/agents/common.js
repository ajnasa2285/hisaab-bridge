// What both agents share: the shape of a tool (the steps a person can take, which the orchestrator
// proposes and code checks), the answer a tool gives back as a text key, and reading an order's
// history from the ledger.

import { day as dayName, rupees } from '../i18n/format.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../wa/directory.js').Person} Person */
/** @typedef {import('../wa/directory.js').Role} Role */
/** @typedef {{ok: boolean, key: string, params?: Record<string, string | number>}} Said */
/**
 * A step a person can take. `roles` is checked by code before `run`; the model never decides who may.
 * `describe` gives the read-back the person confirms before a committing step runs. `hold` marks a
 * step a supervisor may take only within a limit (docs/BUILD2.md section 3): which limit, and the
 * step's estimated value in paise from the ledger (null when it cannot be estimated). The tool itself
 * never holds anything; the gate is src/agents/office.js.
 * @typedef {{roles: Role[], commits: boolean, run: (person: Person, args: Record<string, any>) => Promise<Said> | Said,
 *   describe?: (args: Record<string, any>) => {key: string, params?: Record<string, string | number>}, hold?: Hold}} Tool
 */
/** @typedef {{limit: 'procurement' | 'payment', estimatePaise: (args: Record<string, any>) => number | null}} Hold */
/**
 * Tells everyone in a role. `expect` is the step a plain "yes" from them will mean (the text asks a
 * yes/no question), so they answer once instead of being asked again.
 * @typedef {(role: Role, key: string, params?: Record<string, string | number>, expect?: {tool: string, args: Record<string, any>}) => Promise<void> | void} Tell
 */
/** @typedef {import('../ledger/store.js').LedgerEvent} LedgerEvent */

/** @param {string} key @param {Record<string, string | number>} [params] @returns {Said} */
export const ok = (key, params) => ({ ok: true, key, ...(params ? { params } : {}) });
/** @param {string} key @param {Record<string, string | number>} [params] @returns {Said} */
export const no = (key, params) => ({ ok: false, key, ...(params ? { params } : {}) });

/**
 * Runs a tool for a person: unknown tool or role not allowed → refused before anything happens.
 * @param {Record<string, Tool>} tools
 * @param {Person} person
 * @param {{tool: string, args?: Record<string, any>}} step
 * @returns {Promise<Said>}
 */
export async function runTool(tools, person, step) {
  const tool = Object.hasOwn(tools, step.tool) ? tools[step.tool] : undefined;
  if (!tool) return no('common.unknown_step');
  if (!tool.roles.includes(person.role)) return no('common.not_allowed');
  return tool.run(person, step.args ?? {});
}

/**
 * What a delivery means for the person who asked for it.
 * @param {import('./link.js').Delivery} d
 * @param {string} okKey
 * @param {Record<string, string | number>} [params]
 * @returns {Said}
 */
export function deliveryResult(d, okKey, params) {
  if (d.ok) return ok(okKey, params);
  if (d.reason === 'wrong_state') return no('common.wrong_state');
  if (d.reason === 'refused') return no('common.refused');
  if (d.reason === 'busy') return no('common.busy');
  // Written on our side and kept; it is delivered again later, unchanged.
  return no('common.pending');
}

/**
 * Messages of one type in an order, in order; for sent/received messages the signed message is
 * returned, for local events the body.
 * @param {LedgerEvent[]} events
 * @param {string} type
 * @param {'in' | 'out' | 'local'} [direction]
 */
export function ofType(events, type, direction) {
  return events.filter((e) => e.type === type && (direction === undefined || e.direction === direction));
}

/**
 * A payment as both sides see it: "₹35,000, 23 अक्टूबर 2026, 14:05 बजे, UTR …". The time is left out
 * when the receipt did not show it (an old claim has none), never shown as "—".
 * @param {{amountPaise: number, paidOn: string, paidAt?: string | null, utr: string}} b a PAYMENT_CLAIM body
 */
export function paymentText(b) {
  const at = typeof b.paidAt === 'string' ? `, ${t('payment.at_time', { time: b.paidAt })}` : '';
  return `${rupees(b.amountPaise)}, ${dayName(b.paidOn)}${at}, UTR ${b.utr}`;
}

/** @param {unknown} v */
export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
/** @param {unknown} v @returns {v is number} */
export const posInt = (v) => Number.isSafeInteger(v) && /** @type {number} */ (v) > 0;
/** @param {unknown} v @returns {v is number} */
export const nonNegInt = (v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} v */
export const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** @param {unknown} v */
export const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** @param {unknown} v */
export const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** @param {unknown} v */
export const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T/.test(v);
