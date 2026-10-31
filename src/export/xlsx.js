// A small .xlsx writer with no dependency: a zip of the minimal OOXML parts, built with node:zlib.
// Every text goes into the shared-strings table and every text cell has type "s", so a text starting
// with "=", "+", "-" or "@" is shown as it is and never calculated: this writer has no way to emit a
// formula. Numbers and dates are real numbers with a number format.

import { crc32, deflateRawSync } from 'node:zlib';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `money` is integer paise, written in rupees; `date` is "YYYY-MM-DD", written as a date. @typedef {string | number | null | {money: number} | {date: string}} Cell */
/** @typedef {{name: string, columns: string[], rows: Cell[][]}} Sheet */

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const MAX_CELL_CHARS = 32767; // Excel's limit for one cell
const MAX_SHEET_NAME = 31;
const MIN_WIDTH = 8;
const MAX_WIDTH = 48;
const HEADER_HEIGHT = 33;

// Indexes into cellXfs in styles().
const STYLE = { header: 1, money: 2, date: 3 };
// Indian digit grouping, as the app writes money: ₹1,00,000.00.
const MONEY_FORMAT = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"##,##0.00';
const DATE_FORMAT = 'dd-mm-yyyy';

/** Does XML 1.0 allow this code point? A lone surrogate, read alone as one, it does not. @param {number} c */
export const xmlAllows = (c) => c === 0x9 || c === 0xA || c === 0xD || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF);

/** Text as XML content or an attribute value: forbidden characters dropped, the rest escaped. A CR is written as a reference, or a parser would turn it into LF. @param {string} s */
export function xmlText(s) {
  return [...s].filter((c) => xmlAllows(/** @type {number} */ (c.codePointAt(0)))).join('').replace(/[&<>"'\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[c] ?? c);
}

/** A cell's text: Excel reads "_x0041_" in a string as the letter A, so a text that looks like that keeps its underscore. @param {string} s */
const cellText = (s) => xmlText(s.slice(0, MAX_CELL_CHARS).replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_'));

/** "A", "B", … "Z", "AA". @param {number} i from 0 */
function columnName(i) {
  let name = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

/** Days since Excel's day zero, or null when this is no date. @param {string} day */
function dateSerial(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day ? null : (ms - Date.UTC(1899, 11, 30)) / 86400000;
}

/** How wide a cell reads, in characters. @param {Cell} c */
function shownLength(c) {
  if (c === null) return 0;
  if (typeof c === 'string') return c.length;
  if (typeof c === 'number') return String(c).length;
  return 'money' in c ? String(c.money / 100).length + 6 : 10;
}

function sharedStrings() {
  /** @type {Map<string, number>} */
  const index = new Map();
  let count = 0;
  return {
    /** @param {string} s */
    add(s) {
      count += 1;
      let i = index.get(s);
      if (i === undefined) index.set(s, i = index.size);
      return i;
    },
    xml: () => `${DECLARATION}<sst xmlns="${MAIN_NS}" count="${count}" uniqueCount="${index.size}">${[...index.keys()].map((s) => `<si><t xml:space="preserve">${cellText(s)}</t></si>`).join('')}</sst>`,
  };
}

/** @param {Cell} c @param {string} ref @param {ReturnType<typeof sharedStrings>} strings @param {number} [style] @returns {string} */
function cellXml(c, ref, strings, style) {
  if (c === null || c === undefined) return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof c === 'string') return `<c r="${ref}"${s} t="s"><v>${strings.add(c)}</v></c>`;
  if (typeof c === 'number') return Number.isFinite(c) ? `<c r="${ref}"${s}><v>${c}</v></c>` : '';
  if ('money' in c) return Number.isSafeInteger(c.money) ? `<c r="${ref}" s="${STYLE.money}"><v>${c.money / 100}</v></c>` : '';
  const serial = dateSerial(c.date);
  return serial === null ? cellXml(String(c.date), ref, strings) : `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
}

/** @param {Sheet} sheet @param {boolean} first @param {ReturnType<typeof sharedStrings>} strings */
function sheetXml(sheet, first, strings) {
  const n = sheet.columns.length;
  const widths = sheet.columns.map((name, i) => {
    // A heading wraps onto two lines, so it asks for about half its length.
    const longest = Math.max(Math.ceil(name.length / 2) + 2, ...sheet.rows.map((r) => shownLength(r[i] ?? null) + 2));
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest));
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const head = sheet.columns.map((name, i) => cellXml(name, `${columnName(i)}1`, strings, STYLE.header)).join('');
  const rows = sheet.rows.map((r, y) => {
    const cells = r.slice(0, n).map((c, x) => cellXml(c, `${columnName(x)}${y + 2}`, strings)).join('');
    return `<row r="${y + 2}">${cells}</row>`;
  }).join('');
  return `${DECLARATION}<worksheet xmlns="${MAIN_NS}"><dimension ref="A1:${columnName(n - 1)}${sheet.rows.length + 1}"/>`
    + `<sheetViews><sheetView${first ? ' tabSelected="1"' : ''} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols>`
    + `<sheetData><row r="1" ht="${HEADER_HEIGHT}" customHeight="1">${head}</row>${rows}</sheetData></worksheet>`;
}

function stylesXml() {
  return `${DECLARATION}<styleSheet xmlns="${MAIN_NS}">`
    + `<numFmts count="2"><numFmt numFmtId="164" formatCode="${xmlText(MONEY_FORMAT)}"/><numFmt numFmtId="165" formatCode="${DATE_FORMAT}"/></numFmts>`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    // The first two fills are reserved by the format: none and gray125.
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

/**
 * A plain zip: every entry deflated, no data descriptors, a fixed date so the same records give the
 * same bytes. Names are ASCII here.
 * @param {{name: string, data: Buffer}[]} files
 * @returns {Buffer}
 */
function zip(files) {
  const VERSION = 20; // 2.0, the first with deflate
  const DEFLATE = 8;
  const DOS_DATE = 0x0021; // 1 January 1980, the earliest a zip can say
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'ascii');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(VERSION, 4);
    head.writeUInt16LE(VERSION, 6);
    head.writeUInt16LE(DEFLATE, 10);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(f.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A workbook of these sheets, each with its headings on a frozen first row.
 * @param {Sheet[]} sheets
 * @returns {Buffer}
 */
export function workbook(sheets) {
  if (sheets.length === 0) throw new Error('xlsx: a workbook needs a sheet');
  const names = new Set();
  for (const s of sheets) {
    const folded = s.name.toLowerCase();
    if (!s.name || s.name.length > MAX_SHEET_NAME || /[[\]:*?/\\]/.test(s.name) || /^'|'$/.test(s.name) || names.has(folded)) throw new Error('xlsx: bad sheet name');
    if (s.columns.length === 0) throw new Error('xlsx: a sheet needs a column');
    names.add(folded);
  }
  const strings = sharedStrings();
  const parts = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s, i === 0, strings) }));
  const styleId = sheets.length + 1;
  const stringsId = sheets.length + 2;
  const types = `${DECLARATION}<Types xmlns="${CONTENT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + parts.map((p) => `<Override PartName="/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
  const rootRels = `${DECLARATION}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const book = `${DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>`
    + sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>';
  const bookRels = `${DECLARATION}<Relationships xmlns="${PKG_REL_NS}">`
    + parts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${styleId}" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId${stringsId}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  return zip([
    { name: '[Content_Types].xml', xml: types },
    { name: '_rels/.rels', xml: rootRels },
    { name: 'xl/workbook.xml', xml: book },
    { name: 'xl/_rels/workbook.xml.rels', xml: bookRels },
    ...parts,
    { name: 'xl/styles.xml', xml: stylesXml() },
    { name: 'xl/sharedStrings.xml', xml: strings.xml() },
  ].map((f) => ({ name: f.name, data: Buffer.from(f.xml, 'utf8') })));
}
