// Canonical JSON (RFC 8785, JSON Canonicalization Scheme): the exact bytes that get signed.
// Two agents that hold the same message must produce the same bytes, whatever order its keys
// arrived in. Object keys are sorted by UTF-16 code units; strings and numbers are written the
// way ECMAScript's JSON.stringify writes them, which is what RFC 8785 specifies.

/**
 * @param {unknown} value a JSON value (objects, arrays, strings, finite numbers, booleans, null)
 * @returns {string}
 * @throws {TypeError} for anything JSON cannot represent exactly
 */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalize: numbers must be finite');
    // -0 and 0 are the same JSON number.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalize: only plain objects');
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalize: ${typeof value} is not JSON`);
}

/**
 * @param {unknown} value
 * @returns {Buffer} UTF-8 bytes of the canonical form
 */
export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}
