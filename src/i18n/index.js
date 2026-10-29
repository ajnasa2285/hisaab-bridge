// t(key, params): the mechanism behind docs/CONTRACTS.md section 9. The texts live in hi.js.
// Strict on purpose: an unknown key or a missing parameter throws, so agent code can never send a
// half-filled sentence. (Minimal version by Fable; Claude owns the mechanism and may replace it.)

import { hi } from './hi.js';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string} Hindi text with every {parameter} filled
 */
export function t(key, params = {}) {
  const template = hi[key];
  if (template === undefined) throw new Error(`i18n: unknown key "${key}"`);
  return template.replace(PLACEHOLDER, (_, name) => {
    const value = params[name];
    if (value === undefined || value === null) throw new Error(`i18n: "${key}" needs {${name}}`);
    return String(value);
  });
}

/** @returns {string[]} every key in hi.js */
export function keys() {
  return Object.keys(hi);
}

/**
 * @param {string} key
 * @returns {string[]} the parameter names the key's text uses, in order of first use
 */
export function paramsOf(key) {
  const template = hi[key];
  if (template === undefined) throw new Error(`i18n: unknown key "${key}"`);
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * The variant of a text for the optional parts a message has: the base key, then `_<part>` for each
 * part present, in the order given. `variant('step.request_jcb', {time: true, hours: false})` is
 * 'step.request_jcb_time'. A value that is absent is left out of the sentence, never shown as "—".
 * @param {string} base @param {Record<string, unknown>} parts
 */
export function variant(base, parts) {
  return [base, ...Object.entries(parts).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '').map(([k]) => k)].join('_');
}
