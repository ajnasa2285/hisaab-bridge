// Ed25519 keys and signatures for agent messages. A public key travels as text:
// "ed25519:" + base64 of the raw 32 bytes. Private keys stay as PEM files on the server.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './canonical.js';

const KEY_PREFIX = 'ed25519:';
const SIG_PREFIX = 'ed25519:';
// The DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_TEXT_RE = /^ed25519:[A-Za-z0-9+/]{43}=$/;
const SIG_TEXT_RE = /^ed25519:[A-Za-z0-9+/]{86}==$/;

/** @typedef {import('node:crypto').KeyObject} KeyObject */

/** @returns {{privateKey: KeyObject, publicKey: KeyObject}} a new key pair */
export function generateKeys() {
  return generateKeyPairSync('ed25519');
}

/**
 * @param {string} pem
 * @returns {KeyObject}
 */
export function privateKeyFromPem(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('the private key must be Ed25519');
  return key;
}

/**
 * @param {KeyObject} key a private or public Ed25519 key
 * @returns {string} "ed25519:<base64 of 32 bytes>"
 */
export function publicKeyText(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const der = pub.export({ type: 'spki', format: 'der' });
  return KEY_PREFIX + der.subarray(SPKI_PREFIX.length).toString('base64');
}

/**
 * @param {string} text "ed25519:<base64>"
 * @returns {KeyObject}
 */
export function publicKeyFromText(text) {
  if (!KEY_TEXT_RE.test(text)) throw new TypeError('not an ed25519 public key text');
  const raw = Buffer.from(text.slice(KEY_PREFIX.length), 'base64');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * Signs a message: the signature covers the canonical JSON of every field except `sig`.
 * @template {Record<string, unknown>} T
 * @param {T} message without `sig`
 * @param {KeyObject} privateKey
 * @returns {T & {sig: string}}
 */
export function signMessage(message, privateKey) {
  const { sig: _drop, ...unsigned } = /** @type {Record<string, unknown>} */ (message);
  const signature = edSign(null, canonicalBytes(unsigned), privateKey);
  return /** @type {T & {sig: string}} */ ({ ...unsigned, sig: SIG_PREFIX + signature.toString('base64') });
}

/**
 * @param {Record<string, unknown>} message with `sig`
 * @param {KeyObject} publicKey
 * @returns {boolean} true only for an intact message signed by that key
 */
export function verifyMessage(message, publicKey) {
  const { sig, ...unsigned } = message;
  if (typeof sig !== 'string' || !SIG_TEXT_RE.test(sig)) return false;
  try {
    return edVerify(null, canonicalBytes(unsigned), publicKey, Buffer.from(sig.slice(SIG_PREFIX.length), 'base64'));
  } catch {
    return false;
  }
}
