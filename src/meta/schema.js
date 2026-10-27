// Deliberately small, fail-closed JSON Schema validator. No remote references.
const ANNOTATIONS = new Set(['title', 'description', '$schema', 'default']);
const SUPPORTED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'anyOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', ...ANNOTATIONS]);

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} schema @param {number} [depth] @returns {boolean} */
export function supportedSchema(schema, depth = 0) {
  if (!isObject(schema) || depth > 10 || Object.keys(schema).some(k => !SUPPORTED.has(k))) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && types.some(t => !['object', 'array', 'string', 'boolean', 'null', 'integer', 'number'].includes(t))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string'))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return false;
  if (schema.properties !== undefined && (!isObject(schema.properties) || !Object.values(schema.properties).every(s => supportedSchema(s, depth + 1)))) return false;
  if (schema.items !== undefined && !supportedSchema(schema.items, depth + 1)) return false;
  if (schema.anyOf !== undefined && (!Array.isArray(schema.anyOf) || !schema.anyOf.length || !schema.anyOf.every(s => supportedSchema(s, depth + 1)))) return false;
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[k] !== undefined && (typeof schema[k] !== 'number' || !Number.isFinite(schema[k]))) return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') return false;
    try { new RegExp(schema.pattern, 'u'); } catch { return false; }
  }
  return true;
}

/** @param {unknown} value @param {Record<string, any>} schema @returns {boolean} */
export function matchesSchema(value, schema) {
  if (schema.enum && !schema.enum.some((/** @type {unknown} */ v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.anyOf && !schema.anyOf.some((/** @type {Record<string, any>} */ s) => matchesSchema(value, s))) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value)
      : t === 'object' ? isObject(value) : t === 'integer' ? Number.isSafeInteger(value)
        : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t)) return false;
  }
  if (isObject(value)) {
    if ((schema.required ?? []).some((/** @type {string} */ k) => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties ?? {}, k))) return false;
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, k) && !matchesSchema(value[k], s)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(v => matchesSchema(v, schema.items))) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  return true;
}
