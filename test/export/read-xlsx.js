// Reads an .xlsx back for the tests, with no library: walks the zip by its central directory, checks
// sizes and CRCs, and parses every XML part with a small strict parser that refuses anything malformed.

import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';
import { xmlAllows } from '../../src/export/xlsx.js';

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} every entry's bytes by name, in the directory's order
 */
export function unzip(buf) {
  const endAt = buf.length - 22;
  assert.equal(buf.readUInt32LE(endAt), 0x06054b50, 'the end record is the last 22 bytes');
  const n = buf.readUInt16LE(endAt + 10);
  assert.equal(buf.readUInt16LE(endAt + 8), n);
  const size = buf.readUInt32LE(endAt + 12);
  let at = buf.readUInt32LE(endAt + 16);
  assert.equal(at + size, endAt, 'the directory ends where the end record starts');
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let expectedLocal = 0;
  for (let i = 0; i < n; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'a directory entry');
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.toString('ascii', at + 46, at + 46 + nameLen);
    const [flags, method, time, date, crc, packed, plain, extra, comment, local] = [buf.readUInt16LE(at + 8), buf.readUInt16LE(at + 10), buf.readUInt16LE(at + 12), buf.readUInt16LE(at + 14),
      buf.readUInt32LE(at + 16), buf.readUInt32LE(at + 20), buf.readUInt32LE(at + 24), buf.readUInt16LE(at + 30), buf.readUInt16LE(at + 32), buf.readUInt32LE(at + 42)];
    assert.deepEqual([flags, method, extra, comment], [0, 8, 0, 0], name);
    assert.equal(local, expectedLocal, 'entries follow each other with no gap');
    assert.equal(buf.readUInt32LE(local), 0x04034b50, 'a local header');
    // The local header says exactly what the directory says.
    assert.deepEqual([buf.readUInt16LE(local + 6), buf.readUInt16LE(local + 8), buf.readUInt16LE(local + 10), buf.readUInt16LE(local + 12), buf.readUInt32LE(local + 14), buf.readUInt32LE(local + 18), buf.readUInt32LE(local + 22), buf.readUInt16LE(local + 26), buf.readUInt16LE(local + 28)],
      [flags, method, time, date, crc, packed, plain, nameLen, 0], name);
    assert.equal(buf.toString('ascii', local + 30, local + 30 + nameLen), name);
    const start = local + 30 + nameLen;
    const data = inflateRawSync(buf.subarray(start, start + packed));
    assert.equal(data.length, plain, `${name} size`);
    assert.equal(crc32(data), crc, `${name} crc`);
    assert.ok(!out.has(name), `${name} once`);
    out.set(name, data);
    expectedLocal = start + packed;
    at += 46 + nameLen;
  }
  assert.equal(expectedLocal, buf.readUInt32LE(endAt + 16), 'the directory follows the last entry');
  return out;
}

/** @typedef {{tag: string, attrs: Record<string, string>, kids: XmlNode[], text: string}} XmlNode */

/** @param {string} s */
function unescapeXml(s) {
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(s), `a bad entity in ${s.slice(0, 60)}`);
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e) => (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]));
}

/**
 * @param {Buffer} data
 * @returns {XmlNode} the root element
 */
export function parseXml(data) {
  const xml = data.toString('utf8');
  assert.ok(Buffer.from(xml, 'utf8').equals(data), 'valid UTF-8');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'), 'the declaration');
  assert.ok([...xml].every((c) => xmlAllows(/** @type {number} */ (c.codePointAt(0)))), 'only characters XML 1.0 allows');
  /** @type {XmlNode} */
  const top = { tag: '', attrs: {}, kids: [], text: '' };
  const stack = [top];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/y;
  let at = xml.indexOf('\n') + 1;
  while (at < xml.length) {
    if (xml[at] === '<') {
      tag.lastIndex = at;
      const m = tag.exec(xml);
      assert.ok(m, `a malformed tag at ${xml.slice(at, at + 60)}`);
      at = tag.lastIndex;
      if (m[1]) {
        const open = stack.pop();
        assert.equal(open?.tag, m[2], 'tags close in order');
      } else {
        /** @type {Record<string, string>} */
        const attrs = {};
        for (const a of m[3].matchAll(/([\w:.-]+)="([^"]*)"/g)) {
          assert.ok(!Object.hasOwn(attrs, a[1]), `${a[1]} twice`);
          attrs[a[1]] = unescapeXml(a[2]);
        }
        const node = { tag: m[2], attrs, kids: [], text: '' };
        stack.at(-1)?.kids.push(node);
        if (!m[4]) stack.push(node);
      }
    } else {
      const end = xml.indexOf('<', at);
      const raw = xml.slice(at, end === -1 ? xml.length : end);
      const parent = /** @type {XmlNode} */ (stack.at(-1));
      assert.ok(parent !== top, 'no text outside the root');
      parent.text += unescapeXml(raw);
      at += raw.length;
    }
  }
  assert.equal(stack.length, 1, 'every tag is closed');
  assert.equal(top.kids.length, 1, 'one root');
  return top.kids[0];
}

/** @param {XmlNode} n @param {string} tag */
export const kid = (n, tag) => /** @type {XmlNode} */ (n.kids.find((k) => k.tag === tag));

/**
 * The workbook as tests read it, following the relationships as a reader must.
 * @param {Buffer} buf
 * @returns {{parts: Map<string, Buffer>, xml: Map<string, XmlNode>, sheets: {name: string, xml: XmlNode, rows: Map<string, {type: string | null, style: number, value: string | number}>[]}[], text: string}}
 *   `rows[y]` maps a column letter to its cell; numbers are numbers, shared strings are their text
 */
export function readWorkbook(buf) {
  const parts = unzip(buf);
  const xml = new Map([...parts].map(([name, data]) => [name, parseXml(data)]));
  const part = (/** @type {string} */ name) => /** @type {XmlNode} */ (xml.get(name) ?? assert.fail(`no part ${name}`));
  const types = part('[Content_Types].xml');
  const overrides = new Map(types.kids.filter((k) => k.tag === 'Override').map((k) => [k.attrs.PartName, k.attrs.ContentType]));
  for (const name of parts.keys()) {
    if (name === '[Content_Types].xml') continue;
    assert.ok(name.endsWith('.rels') || overrides.has(`/${name}`), `${name} has its content type`);
  }
  for (const name of overrides.keys()) assert.ok(parts.has(name.slice(1)), `${name} exists`);
  const root = part('_rels/.rels');
  assert.equal(root.kids[0].attrs.Target, 'xl/workbook.xml');
  const rels = new Map(part('xl/_rels/workbook.xml.rels').kids.map((k) => [k.attrs.Id, k.attrs.Target]));
  assert.equal(rels.size, part('xl/_rels/workbook.xml.rels').kids.length, 'relationship ids are unique');
  for (const target of rels.values()) assert.ok(parts.has(`xl/${target}`), `${target} exists`);
  const shared = kid(part('xl/sharedStrings.xml'), 'si') ? part('xl/sharedStrings.xml').kids.map((si) => si.kids[0].text) : [];
  const sheets = kid(part('xl/workbook.xml'), 'sheets').kids.map((s) => {
    const node = part(`xl/${rels.get(s.attrs['r:id'])}`);
    const rows = kid(node, 'sheetData').kids.map((row) => new Map(row.kids.map((c) => {
      const raw = kid(c, 'v').text;
      const value = c.attrs.t === 's' ? shared[Number(raw)] : Number(raw);
      assert.notEqual(value, undefined, `cell ${c.attrs.r}`);
      assert.ok(typeof value === 'string' || Number.isFinite(value), `cell ${c.attrs.r}`);
      assert.deepEqual(c.kids.map((k) => k.tag), ['v'], 'a value and nothing else: no formula');
      return [c.attrs.r.replace(/\d+$/, ''), { type: c.attrs.t ?? null, style: Number(c.attrs.s ?? 0), value }];
    })));
    return { name: s.attrs.name, xml: node, rows };
  });
  return { parts, xml, sheets, text: [...parts.values()].map((d) => d.toString('utf8')).join('\n') };
}

/**
 * One sheet as objects keyed by column letter, without its heading row.
 * @param {ReturnType<typeof readWorkbook>} book @param {string} english a word of the sheet's name
 * @returns {Record<string, string | number>[]}
 */
export function rowsOf(book, english) {
  const sheet = book.sheets.find((s) => s.name.includes(english)) ?? assert.fail(`no sheet ${english}`);
  return sheet.rows.slice(1).map((r) => Object.fromEntries([...r].map(([col, c]) => [col, c.value])));
}
