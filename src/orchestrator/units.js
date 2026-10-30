// Turning what a person wrote (as the model copied it out) into the integers the agents use.
// The model copies figures exactly as written; every conversion and every date is done here.

/**
 * "6.1" → 61, "6" → 60. More than one decimal, or anything else, is refused (null).
 * @param {unknown} s
 * @returns {number | null}
 */
export function parseTenths(s) {
  if (typeof s !== 'string' || !/^\d{1,6}(\.\d)?$/.test(s.trim())) return null;
  const [w, f = '0'] = s.trim().split('.');
  return Number(w) * 10 + Number(f);
}

/**
 * A quantity: "50" → 5000, "2.5" → 250, "1.25" → 125, "0" → 0. More than two decimals, or anything
 * else, is refused (null). Whether 0 is acceptable is for the caller.
 * @param {unknown} s
 * @returns {number | null}
 */
export function parseHundredths(s) {
  if (typeof s !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(s.trim())) return null;
  const [w, f = ''] = s.trim().split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/**
 * Quantities typed in order, separated by commas or spaces: "50, 2.5" → [5000, 250]. At most 20;
 * any figure that is not a quantity refuses the whole list (null).
 * @param {unknown} s
 * @returns {number[] | null}
 */
export function parseHundredthsList(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const parts = s.trim().split(/\s*[,;]\s*|\s+/);
  if (parts.length > 20) return null;
  const out = parts.map(parseHundredths);
  return out.every((q) => q !== null) ? /** @type {number[]} */ (out) : null;
}

/**
 * "7320" → 732000, "7,320.50" → 732050 (commas allowed as grouping only).
 * @param {unknown} s
 * @returns {number | null}
 */
export function parsePaise(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^₹\s*/, '');
  if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.replace(/,/g, '').split('.');
  const paise = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

/**
 * A payment amount: digits as parsePaise, or said in words as a voice note gives it (live, 30 Oct:
 * "पंद्रह हजार", "15 हज़ार", "do hazar paanch sau rupaye"), read like a quantity in rupees, so
 * hundredths of a rupee are paise. Only for amounts paid, which are read back before they are sent;
 * rates stay digits only ("साढ़े चार" could be ₹4.50 or ₹4,500). Not exactly a number: null.
 * @param {unknown} s
 */
export function parseAmountPaise(s) {
  const digits = parsePaise(s);
  if (digits !== null || typeof s !== 'string') return digits;
  const said = s.trim().replace(/^₹\s*/, '').replace(/\s*(?:रुपये|रुपए|रुपया|rupaye|rupaiye|rupees|rupay|rs\.?)$/iu, '');
  const h = said ? parseQuantity(said) : null;
  return h !== null && h > 0 && Number.isSafeInteger(h) ? h : null;
}

/**
 * A value the model left empty: null, undefined, or a string like "", "null", "none", "-" (models
 * sometimes write null as a word). Every nullable field goes through this.
 * @param {unknown} v
 */
export function blank(v) {
  if (v === null || v === undefined) return true;
  return typeof v === 'string' && ['', 'null', 'none', '-'].includes(v.trim().toLowerCase());
}

// Number words, in hundredths. Only exact words; anything else is not a number (null, never a guess).
/** @type {Record<string, number>} */
const WORDS = {};
for (const [n, forms] of /** @type {[number, string[]][]} */ ([
  [1, ['एक', 'ek']], [2, ['दो', 'do']], [3, ['तीन', 'teen', 'tin']], [4, ['चार', 'char', 'chaar']],
  [5, ['पाँच', 'पांच', 'paanch', 'panch', 'paach']], [6, ['छह', 'छः', 'छे', 'chhe', 'che', 'chhah', 'chah']],
  [7, ['सात', 'saat', 'sat']], [8, ['आठ', 'aath', 'ath']], [9, ['नौ', 'nau']], [10, ['दस', 'das', 'dus']],
  [11, ['ग्यारह', 'gyarah', 'gyara']], [12, ['बारह', 'barah', 'bara']], [13, ['तेरह', 'terah', 'tera']],
  [14, ['चौदह', 'chaudah', 'chauda']], [15, ['पंद्रह', 'पन्द्रह', 'pandrah', 'pandra']], [16, ['सोलह', 'solah', 'sola']],
  [17, ['सत्रह', 'satrah', 'satra']], [18, ['अठारह', 'atharah', 'athara']], [19, ['उन्नीस', 'unnis', 'unees']],
  [20, ['बीस', 'bees', 'bis']], [25, ['पच्चीस', 'pachchis', 'pachis', 'pachees']], [30, ['तीस', 'tees', 'tis']],
  [35, ['पैंतीस', 'paintis', 'paintees']], [40, ['चालीस', 'chalis', 'chaalis', 'chalees']],
  [45, ['पैंतालीस', 'paintalis', 'paintalees']], [50, ['पचास', 'pachaas', 'pachas']],
  [60, ['साठ', 'saath', 'sath']], [70, ['सत्तर', 'sattar']], [75, ['पचहत्तर', 'pachhattar', 'pachattar']],
  [80, ['अस्सी', 'assi', 'assee']], [90, ['नब्बे', 'nabbe']],
  // Fractions said as one word: 1½ and 2½.
  [1.5, ['डेढ़', 'डेढ', 'dedh', 'derh']], [2.5, ['ढाई', 'dhai', 'dhaai', 'adhai', 'dhaayi']],
])) for (const f of forms) WORDS[f.normalize('NFC')] = Math.round(n * 100);
/** "साढ़े तीन" = 3½, "सवा दो" = 2¼, "पौने तीन" = 2¾: added to the next number, in hundredths. */
const PREFIX = /** @type {Record<string, number>} */ ({ 'साढ़े': 50, 'साढे': 50, saadhe: 50, sadhe: 50, saade: 50, 'सवा': 25, sawa: 25, sava: 25, 'पौने': -25, paune: -25, pone: -25 });
const HUNDRED = new Set(['सौ', 'sau']);
const THOUSAND = new Set(['हज़ार', 'हजार', 'hazar', 'hazaar', 'hajar']);

/**
 * A quantity as the person wrote it: digits ("50", "2.5"), number words ("पचास", "pachaas",
 * "दो सौ", "dhai sau", "do hazar paanch sau", "saadhe teen"), or digits with a word ("2 सौ").
 * Returns hundredths, or null when it is not exactly a number. 0 only as the digit "0".
 * @param {unknown} s
 * @returns {number | null}
 */
export function parseQuantity(s) {
  const digits = parseHundredths(s);
  if (digits !== null || typeof s !== 'string') return digits;
  const tokens = s.normalize('NFC').trim().toLowerCase().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 6) return null;
  let total = 0;
  let cur = 0;
  let afterHundred = false;
  let prefix = 0;
  for (const tok of tokens) {
    if (Object.hasOwn(PREFIX, tok)) {
      if (prefix || cur) return null;
      prefix = PREFIX[tok];
      continue;
    }
    const n = Object.hasOwn(WORDS, tok) ? WORDS[tok] : parseHundredths(tok);
    if (n !== null) {
      if (prefix && n % 100 !== 0) return null; // "saadhe dhai" is not a number
      const v = n + prefix;
      prefix = 0;
      if (v <= 0) return null;
      if (cur === 0) cur = v;
      else if (afterHundred && cur % 10000 === 0 && v < 10000) cur += v; // "do sau pachaas"
      else return null;
      afterHundred = false;
      continue;
    }
    if (HUNDRED.has(tok)) {
      if ((prefix && cur) || cur >= 10000) return null;
      cur = (cur || 100 + prefix) * 100; // "sau" alone is 100; "sawa sau" 125
      prefix = 0;
      afterHundred = true;
      continue;
    }
    if (THOUSAND.has(tok)) {
      if ((prefix && cur) || total !== 0 || cur >= 100000) return null;
      total = (cur || 100 + prefix) * 1000;
      prefix = 0;
      cur = 0;
      afterHundred = false;
      continue;
    }
    return null;
  }
  if (prefix) return null;
  const q = total + cur;
  // Whole hundredths only (a fraction of a fraction is refused), and within what digits allow.
  return Number.isSafeInteger(q) && q > 0 && q < 1e9 ? q : null;
}

/**
 * A day as a person types it in reply to "which day?", in the model's form for resolveDay:
 * आज/aaj → 'today', कल/kal → 'tomorrow' (a request is always ahead), परसों/parso → 'day_after',
 * or a date like '30-10'. Anything else is null.
 * @param {string} s
 * @returns {string | null}
 */
export function dayWord(s) {
  const t = s.normalize('NFC').trim().toLowerCase().replace(/[।.!]+$/u, '');
  if (['आज', 'aaj', 'aj', 'today'].includes(t)) return 'today';
  if (['कल', 'kal', 'tomorrow'].includes(t)) return 'tomorrow';
  if (['परसों', 'परसो', 'parso', 'parson', 'parsoon'].includes(t)) return 'day_after';
  return /^\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{4})?$/.test(t) ? t : null;
}

/** The IST calendar day of a moment. @param {number} ms @returns {string} YYYY-MM-DD */
export function istDay(ms) {
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {string} day @param {number} n */
function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * A day as the model copied it: 'today' | 'tomorrow' | 'day_after' | 'DD-MM' | 'DD-MM-YYYY'
 * (also with '/' or '.'). 'DD-MM' is this year, or next year if that date is more than 60 days past.
 * @param {unknown} s
 * @param {number} nowMs
 * @returns {string | null} YYYY-MM-DD
 */
export function resolveDay(s, nowMs) {
  if (typeof s !== 'string') return null;
  const today = istDay(nowMs);
  const t = s.trim().toLowerCase();
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  if (t === 'day_after') return addDays(today, 2);
  const m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}))?$/.exec(t);
  if (!m) return null;
  const [d, mo] = [Number(m[1]), Number(m[2])];
  let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  const make = (/** @type {number} */ y) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let day = make(year);
  const check = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d || check.getUTCMonth() + 1 !== mo) return null;
  if (!m[3] && Date.parse(`${day}T00:00:00Z`) < Date.parse(`${addDays(today, -60)}T00:00:00Z`)) day = make(year += 1);
  return day;
}

/**
 * "8", "8:00", "08:30" → "08:00"/"08:30"; a voice note's words too: "आठ", "दस बजे", "साढ़े आठ" →
 * "08:30", "सवा नौ" → "09:15". null when absent or not a time.
 * @param {unknown} s
 */
export function parseTime(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(s.trim());
  if (m) return Number(m[1]) > 23 ? null : `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
  // "10am", "10 AM", "2:30 pm"; an hour outside 1 to 12 with am/pm is no time.
  const ampm = /^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?$/iu.exec(s.trim());
  if (ampm) {
    const hour = Number(ampm[1]);
    if (hour < 1 || hour > 12) return null;
    return `${String((hour % 12) + (ampm[3].toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0')}:${ampm[2] ?? '00'}`;
  }
  const said = s.normalize('NFC').trim().replace(/\s*(?:बजे|baje|बज|o'?clock)$/iu, '');
  const h = said && !/\d/.test(said) ? parseQuantity(said) : null;
  if (h === null || h < 100 || h >= 2400 || h % 25 !== 0) return null;
  return `${String(Math.floor(h / 100)).padStart(2, '0')}:${String((h % 100) * 60 / 100).padStart(2, '0')}`;
}
