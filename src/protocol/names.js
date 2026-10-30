// Site names, item names and units are typed by one party and later shown to the other party's people
// and model, so they keep to plain name characters: letters (Devanagari too, with its marks), digits,
// space and - . / ( ) , &. ZWJ and ZWNJ are part of how Devanagari is typed on phones. Checked at
// intake and on an incoming BOOKING_REQUEST only; events already in a ledger are never checked again.

const NAME_RE = /^[\p{L}\p{M}\p{N} \-./(),&‌‍]+$/u;
export const MAX_NAME = 80;
export const MAX_UNIT = 20;

/** @param {unknown} s @param {number} [max] @returns {s is string} */
export function safeName(s, max = MAX_NAME) {
  return typeof s === 'string' && s.length <= max && s.trim().length > 0 && NAME_RE.test(s);
}
