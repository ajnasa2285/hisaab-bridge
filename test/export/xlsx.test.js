// The writer on its own: the zip and the parts it holds, read back without a library.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kid, parseXml, readWorkbook, unzip } from './read-xlsx.js';
import { workbook, xmlText, XLSX_MIME } from '../../src/export/xlsx.js';

const one = (/** @type {import('../../src/export/xlsx.js').Cell[][]} */ rows) => workbook([{ name: 'नमूना (Sample)', columns: ['क', 'ख', 'ग'], rows }]);

test('the MIME type is the one for .xlsx', () => {
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('the zip reads back: entries, sizes and CRCs, the content types first', () => {
  const parts = unzip(one([['a', 1, null]]));
  assert.deepEqual([...parts.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']);
  for (const data of parts.values()) parseXml(data);
});

test('the same sheets give the same bytes', () => {
  assert.ok(one([['a']]).equals(one([['a']])));
});

test('the parts agree with each other: content types, relationships, styles, shared-string counts', () => {
  const book = readWorkbook(workbook([{ name: 'A', columns: ['x'], rows: [['दो'], ['दो'], ['तीन']] }, { name: 'B', columns: ['y'], rows: [] }]));
  assert.deepEqual(book.sheets.map((s) => s.name), ['A', 'B']);
  const sst = /** @type {import('./read-xlsx.js').XmlNode} */ (book.xml.get('xl/sharedStrings.xml'));
  assert.deepEqual([sst.attrs.count, sst.attrs.uniqueCount, sst.kids.length], ['5', '4', 4], 'two headings and three cells, one repeated');
  const styles = /** @type {import('./read-xlsx.js').XmlNode} */ (book.xml.get('xl/styles.xml'));
  for (const list of ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles']) assert.equal(Number(kid(styles, list).attrs.count), kid(styles, list).kids.length, list);
  assert.deepEqual(styles.kids.map((k) => k.tag), ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles'], 'the order the schema requires');
  assert.deepEqual(kid(styles, 'fills').kids.slice(0, 2).map((f) => f.kids[0].attrs.patternType), ['none', 'gray125'], 'the two reserved fills');
  const xfs = kid(styles, 'cellXfs').kids.length;
  for (const s of book.sheets) for (const r of s.rows) for (const c of r.values()) assert.ok(c.style < xfs);
  assert.deepEqual(book.sheets[0].xml.kids.map((k) => k.tag), ['dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData'], 'the order the schema requires');
  assert.equal(kid(book.sheets[0].xml, 'dimension').attrs.ref, 'A1:A4');
  assert.deepEqual(book.sheets.map((s) => kid(s.xml, 'sheetViews').kids[0].attrs.tabSelected), ['1', undefined], 'one tab selected');
  assert.deepEqual(kid(book.sheets[0].xml, 'sheetData').kids.map((r) => r.attrs.r), ['1', '2', '3', '4'], 'rows in order');
});

test('money in rupees, numbers as numbers, a date as a date; an empty cell is left out', () => {
  const book = readWorkbook(one([[{ money: 123450 }, 2.5, { date: '2026-10-30' }], [null, 'x', { date: 'not a day' }]]));
  const [, first, second] = book.sheets[0].rows;
  assert.deepEqual(first.get('A'), { type: null, style: 2, value: 1234.5 });
  assert.deepEqual(first.get('B'), { type: null, style: 0, value: 2.5 });
  // 30 Oct 2026, counted from Excel's day zero.
  assert.deepEqual(first.get('C'), { type: null, style: 3, value: 46325 });
  assert.equal(second.has('A'), false);
  assert.equal(second.get('C')?.value, 'not a day', 'what is no date stays readable as text');
});

test('the headings are styled, and the first row stays in view', () => {
  const book = readWorkbook(one([]));
  const head = book.sheets[0].rows[0];
  assert.deepEqual([...head.values()].map((c) => [c.value, c.style, c.type]), [['क', 1, 's'], ['ख', 1, 's'], ['ग', 1, 's']]);
  const pane = kid(kid(book.sheets[0].xml, 'sheetViews').kids[0], 'pane');
  assert.deepEqual([pane.attrs.ySplit, pane.attrs.state], ['1', 'frozen']);
  for (const c of kid(book.sheets[0].xml, 'cols').kids) assert.ok(Number(c.attrs.width) > 0);
});

for (const text of ['=SUM(1)', '+1+1', '-2+3', '@SUM(1)', '\tcmd', '\rcmd', "=HYPERLINK(\"http://x\",\"y\")"]) {
  test(`a text starting like a formula stays text: ${JSON.stringify(text)}`, () => {
    const book = readWorkbook(one([[text]]));
    const c = book.sheets[0].rows[1].get('A');
    assert.deepEqual([c?.type, c?.value], ['s', text]);
    assert.doesNotMatch(book.text, /<f[ >/]/, 'the writer emits no formula element');
  });
}

test('XML special characters, Hindi, newlines and spaces survive', () => {
  const texts = ['सीमेंट & <रेत> "बालू" \'गिट्टी\'', ' दो  स्पेस ', 'एक\nदो', 'सितंबर 😀', ']]>'];
  const book = readWorkbook(one(texts.map((x) => [x])));
  assert.deepEqual(book.sheets[0].rows.slice(1).map((r) => r.get('A')?.value), texts);
});

test('characters XML 1.0 forbids are dropped; the rest of the text stays', () => {
  const dirty = 'a\u0000b\u0008c\u000Bd\u001Fe\uFFFEf\uFFFFg\uD800h\uDFFFi';
  assert.equal(xmlText(dirty), 'abcdefghi');
  assert.equal(readWorkbook(one([[dirty]])).sheets[0].rows[1].get('A')?.value, 'abcdefghi');
});

test('text that looks like Excel\'s own _xHHHH_ escape keeps its meaning', () => {
  const book = readWorkbook(one([['_x0041_']]));
  assert.equal(book.sheets[0].rows[1].get('A')?.value, '_x005F_x0041_', 'written so that Excel shows _x0041_ and not A');
});

test('a very long text is cut to what one cell holds', () => {
  const value = readWorkbook(one([['क'.repeat(40000)]])).sheets[0].rows[1].get('A')?.value;
  assert.equal(typeof value === 'string' && value.length, 32767);
});

test('a sheet name Excel would refuse is refused here', () => {
  const sheet = (/** @type {string} */ name) => ({ name, columns: ['x'], rows: [] });
  for (const name of ['', 'a'.repeat(32), 'a/b', 'a[b', 'a:b', 'a*b', 'a?b', 'a\\b', "'a"]) assert.throws(() => workbook([sheet(name)]), /sheet name/, name);
  assert.throws(() => workbook([sheet('A'), sheet('a')]), /sheet name/, 'names are unique whatever their case');
  assert.throws(() => workbook([]));
  assert.throws(() => workbook([{ name: 'A', columns: [], rows: [] }]));
});

test('columns past Z are named as Excel names them', () => {
  const columns = Array.from({ length: 28 }, (_, i) => `c${i}`);
  const book = readWorkbook(workbook([{ name: 'A', columns, rows: [columns] }]));
  assert.deepEqual([...book.sheets[0].rows[1].keys()].slice(24), ['Y', 'Z', 'AA', 'AB']);
});
