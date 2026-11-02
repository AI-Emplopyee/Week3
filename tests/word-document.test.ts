import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { extractWordDocument, WordDocumentError } from '../lib/word-document.ts';
import { wordFixture } from './helpers/word-document.ts';

test('real synthetic Word file preserves Vietnamese, table tabs and labels text sections honestly', async () => {
  const bytes = await readFile(new URL('./fixtures/word/synthetic-invoice.doc', import.meta.url));
  const result = await extractWordDocument(bytes);
  const text = result.pages.map(page => page.text).join('\n');
  assert.match(text, /TEST-DOC-2026/);
  assert.match(text, /Công ty Thử nghiệm Việt Nam/);
  assert.match(text, /Item\tQuantity\tUnit\nDemo crane\t2\tPCS/);
  assert.ok(result.pages.every(page => page.textSource === 'office' && page.label?.includes('not a printed page')));
  assert.match(result.warnings.join(' '), /images.*page layout/);
});

test('normal, mini-stream and version 4 compound files extract readable paragraphs and table separators', async () => {
  for (const options of [{}, { miniTable: true }, { sectorSize: 4096 as const }, { compressed: true }]) {
    const { bytes } = wordFixture('Invoice: TEST-001\rItem\x07Quantity\rCrane\x072\r', options);
    const result = await extractWordDocument(bytes);
    assert.equal(result.pages[0].text, 'Invoice: TEST-001\nItem\tQuantity\nCrane\t2');
  }
});

test('long Word text is bounded without dropping content or breaking Unicode pairs', async () => {
  const body = `${'a'.repeat(11_999)}😀${' Tiếng Việt — “hóa đơn”'.repeat(1200)}`;
  const result = await extractWordDocument(wordFixture(body).bytes);
  assert.equal(result.pages.map(page => page.text).join(''), body);
  assert.ok(result.pages.length > 1);
  assert.ok(result.pages.every(page => page.text.length <= 12_000 && !/[\ud800-\udbff]$/.test(page.text)));
});

test('Word text in headers, footers, notes and textboxes is retained while review comments are excluded', async () => {
  // Stories follow the Word binary character-count ordering.
  const headerParts = [...Array<string>(6).fill('\r'), 'Invoice header\r', 'Even header\r', 'Invoice footer\r'];
  const stories = ['Invoice TEST\r', 'Footnote\r', headerParts.join(''), 'Reviewer comment\r', 'Endnote\r', 'Text box\r', 'Header text box\r'];
  const fixture = wordFixture(stories.join(''));
  for (const [index, offset] of [0x4c, 0x50, 0x54, 0x5c, 0x60, 0x64, 0x68].entries()) fixture.bytes.writeUInt32LE(stories[index].length, fixture.wordOffset + offset);
  fixture.bytes.writeUInt32LE(32, fixture.wordOffset + 0xf2);
  fixture.bytes.writeUInt32LE((headerParts.length + 1) * 4, fixture.wordOffset + 0xf6);
  let cp = 0;
  for (const [i, text] of [...headerParts, ''].entries()) {
    fixture.bytes.writeUInt32LE(cp, fixture.tableOffset + 32 + i * 4);
    cp += text.length;
  }
  const result = await extractWordDocument(fixture.bytes);
  const text = result.pages.map(page => page.text).join('\n');
  for (const expected of ['Invoice TEST', 'Footnote', 'Invoice header', 'Invoice footer', 'Endnote', 'Text box', 'Header text box']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('Reviewer comment'));
  assert.match(result.warnings.join(' '), /comments/);
});

test('renamed RTF, HTML, ZIP and arbitrary files get a safe conversion explanation', async () => {
  for (const text of ['{\\rtf1 test}', '<html><body>invoice</body></html>', 'PK\x03\x04hello', 'not a document']) {
    await assert.rejects(extractWordDocument(Buffer.from(text)), (error: unknown) => error instanceof WordDocumentError && error.code === 'unsupported' && error.message.includes('export it as PDF'));
  }
});

test('encrypted and empty-text Word documents are explicitly rejected', async () => {
  for (const encryption of [0x0100, 0x8000]) {
    const fixture = wordFixture();
    fixture.bytes.writeUInt16LE(0x0200 | encryption, fixture.wordOffset + 10);
    await assert.rejects(extractWordDocument(fixture.bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'encrypted');
  }
  await assert.rejects(extractWordDocument(wordFixture('\r\r\t').bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'no_text');
});

test('malformed allocation cycles, directory cycles and out-of-range offsets fail before parsing', async () => {
  const mutations = [
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt32LE(f.wordStart, f.fatOffset + (f.wordStart + 1) * 4),
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt32LE(1, f.directoryOffset + 128 + 72),
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt32LE(0x7fffffff, f.fatOffset + f.wordStart * 4),
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt32LE(0x7fffffff, f.wordOffset + 0x1a2),
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt32LE(0x7fffffff, f.tableOffset + 15),
    (f: ReturnType<typeof wordFixture>) => f.bytes.writeUInt16LE(15, 30),
    (f: ReturnType<typeof wordFixture>) => { f.bytes.writeUInt32LE(0xffffffff, 76); f.bytes.writeUInt32LE(1, 80); },
  ];
  for (const mutate of mutations) {
    const fixture = wordFixture();
    mutate(fixture);
    await assert.rejects(extractWordDocument(fixture.bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'malformed');
  }
});

test('known unsupported legacy characters are rejected rather than silently turned into undefined', async () => {
  for (const fixture of [wordFixture('Total: \x80100', { compressed: true }), wordFixture('Soft\x1fhyphen')]) {
    await assert.rejects(extractWordDocument(fixture.bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'unsupported');
  }
  const result = await extractWordDocument(wordFixture('Total: €100').bytes);
  assert.equal(result.pages[0].text, 'Total: €100');
});

test('malformed, nested and cross-story fields cannot reach the upstream field cleaner', async () => {
  for (const body of ['\x13unterminated', '\x13outer\x13inner\x15\x15', '\x13code\x14one\x14two\x15']) {
    await assert.rejects(extractWordDocument(wordFixture(body).bytes), WordDocumentError);
  }
  const crossStory = wordFixture('\x13body\x15\r');
  crossStory.bytes.writeUInt32LE(5, crossStory.wordOffset + 0x4c);
  crossStory.bytes.writeUInt32LE(2, crossStory.wordOffset + 0x50);
  await assert.rejects(extractWordDocument(crossStory.bytes), WordDocumentError);
  const valid = await extractWordDocument(wordFixture('Date: \x13DATE\x142026-11-01\x15\r').bytes);
  assert.match(valid.pages[0].text, /2026-11-01/);
});

test('formatting cannot remove a checked field delimiter and expose the upstream cleaner', async () => {
  const body = `\x13${'a'.repeat(1000)}\x14x\x15\r`;
  const fixture = wordFixture(body);
  fixture.bytes.writeUInt32LE(64, fixture.wordOffset + 0xfa);
  fixture.bytes.writeUInt32LE(12, fixture.wordOffset + 0xfe);
  fixture.bytes.writeUInt32LE(7, fixture.tableOffset + 72);
  const format = fixture.wordOffset + 7 * 512;
  const closingPosition = 512 + body.lastIndexOf('\x15') * 2;
  fixture.bytes.writeUInt32LE(closingPosition, format);
  fixture.bytes.writeUInt32LE(closingPosition + 2, format + 4);
  fixture.bytes[format + 8] = 10;
  fixture.bytes[format + 20] = 3;
  fixture.bytes.writeUInt16LE(0x0800, format + 21);
  fixture.bytes[format + 23] = 1;
  fixture.bytes[format + 511] = 1;
  await assert.rejects(extractWordDocument(fixture.bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'unsupported');
});

test('hostile allocation sizes, text counts and field nesting are bounded', async () => {
  const oversizedFat = wordFixture();
  oversizedFat.bytes.writeUInt32LE(0x7fffffff, 44);
  const oversizedText = wordFixture();
  oversizedText.bytes.writeUInt32LE(300_001, oversizedText.wordOffset + 0x4c);
  const nesting = wordFixture(`${'\x13'.repeat(33)}Invoice${'\x15'.repeat(33)}`);
  for (const fixture of [oversizedFat, oversizedText, nesting]) {
    await assert.rejects(extractWordDocument(fixture.bytes), (error: unknown) => error instanceof WordDocumentError && error.code === 'limit');
  }
});

test('truncated Word bytes never produce partial extracted evidence', async () => {
  const { bytes } = wordFixture();
  for (const length of [0, 8, 64, 512, bytes.length - 1, bytes.length - 512]) {
    await assert.rejects(extractWordDocument(bytes.subarray(0, length)), WordDocumentError);
  }
});
