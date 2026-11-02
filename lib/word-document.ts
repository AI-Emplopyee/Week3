import { Buffer } from 'node:buffer';
import WordExtractor from 'word-extractor';
import type { SourcePage } from './types.ts';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 300_000;
const SECTION_LENGTH = 12_000;
const MAX_SECTIONS = 50;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const CONVERT = 'Open the original in Word or LibreOffice, export it as PDF, and upload the PDF.';

export class WordDocumentError extends Error {
  readonly code: 'unsupported' | 'encrypted' | 'malformed' | 'limit' | 'no_text';

  constructor(code: WordDocumentError['code'], message: string) {
    super(`${message} ${CONVERT}`);
    this.name = 'WordDocumentError';
    this.code = code;
  }
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new WordDocumentError('malformed', 'This .doc file is damaged or has an unsupported internal structure.');
}

function requireLimit(condition: unknown): asserts condition {
  if (!condition) throw new WordDocumentError('limit', 'This .doc file is too large or complex for automatic text extraction.');
}

type Entry = { name: string; type: number; left: number; right: number; child: number; start: number; size: number };

/** Validate allocations before entering word-extractor 1.0.4's unbounded OLE traversals. */
function checkedStreams(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new WordDocumentError('unsupported', 'This is not a supported Word 97–2003 binary .doc file; renaming RTF, HTML or .docx files to .doc is not supported.');
  }
  requireLimit(bytes.length <= MAX_FILE_BYTES);
  requireValid(bytes.length >= 512);
  const major = bytes.readUInt16LE(26);
  const shift = bytes.readUInt16LE(30);
  requireValid((major === 3 && shift === 9) || (major === 4 && shift === 12));
  requireValid(bytes.readUInt16LE(28) === 0xfffe && bytes.readUInt16LE(32) === 6);
  requireValid(bytes.readUInt32LE(56) === 4096);
  const sectorSize = 2 ** shift;
  requireValid(bytes.length % sectorSize === 0);
  const sectorCount = bytes.length / sectorSize - 1;
  const fatCount = bytes.readUInt32LE(44);
  const difatCount = bytes.readUInt32LE(72);
  const miniFatCount = bytes.readUInt32LE(64);
  requireValid(sectorCount > 0 && fatCount > 0);
  // An allocation table only needs one entry per actual sector; reject amplification.
  requireLimit(fatCount <= Math.ceil(sectorCount / (sectorSize / 4)));
  requireValid(difatCount <= sectorCount && miniFatCount <= sectorCount);
  const used = new Set<number>();
  const sector = (id: number) => {
    requireValid(Number.isInteger(id) && id >= 0 && id < sectorCount);
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const claim = (id: number) => {
    sector(id);
    requireValid(!used.has(id));
    used.add(id);
  };
  const fatSectors: number[] = [];
  const addFat = (id: number) => {
    if (id === FREE) {
      requireValid(fatSectors.length === fatCount);
      return;
    }
    requireValid(fatSectors.length < fatCount);
    claim(id);
    fatSectors.push(id);
  };
  for (let offset = 76; offset < 512; offset += 4) addFat(bytes.readUInt32LE(offset));
  let nextDifat = bytes.readUInt32LE(68);
  for (let i = 0; i < difatCount; i++) {
    claim(nextDifat);
    const data = sector(nextDifat);
    for (let offset = 0; offset < sectorSize - 4; offset += 4) addFat(data.readUInt32LE(offset));
    nextDifat = data.readUInt32LE(sectorSize - 4);
  }
  requireValid(nextDifat === END || (difatCount === 0 && nextDifat === FREE));
  requireValid(fatSectors.length === fatCount);
  const fat = Buffer.concat(fatSectors.map(sector));
  const chain = (start: number, table: Buffer, available: number, size?: number, unit = sectorSize) => {
    const ids: number[] = [];
    const seen = new Set<number>();
    let id = start;
    if (size === 0 && (id === END || id === FREE)) return ids;
    while (id !== END) {
      requireValid(id < available && id * 4 + 4 <= table.length && !seen.has(id));
      seen.add(id);
      ids.push(id);
      requireLimit(ids.length <= available);
      id = table.readUInt32LE(id * 4);
    }
    if (size !== undefined) requireValid(ids.length === Math.ceil(size / unit));
    return ids;
  };
  const read = (ids: number[]) => {
    ids.forEach(claim);
    return Buffer.concat(ids.map(sector));
  };
  const directory = read(chain(bytes.readUInt32LE(48), fat, sectorCount));
  requireValid(directory.length > 0);
  requireLimit(directory.length / 128 <= 4096);
  const entries: Entry[] = [];
  for (let offset = 0; offset < directory.length; offset += 128) {
    const type = directory[offset + 66];
    requireValid([0, 1, 2, 5].includes(type));
    const nameLength = directory.readUInt16LE(offset + 64);
    if (type !== 0) requireValid(nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0);
    const name = type ? directory.toString('utf16le', offset, offset + nameLength - 2) : '';
    requireValid(!['__proto__', 'prototype', 'constructor'].includes(name));
    const size = directory.readUInt32LE(offset + 120);
    if (type === 2 || type === 5) {
      requireValid(directory.readUInt32LE(offset + 124) === 0);
      requireLimit(size <= MAX_FILE_BYTES);
    }
    entries.push({ name, type,
      left: directory.readUInt32LE(offset + 68), right: directory.readUInt32LE(offset + 72), child: directory.readUInt32LE(offset + 76),
      start: directory.readUInt32LE(offset + 116), size });
  }
  const root = entries[0];
  requireValid(root.type === 5 && entries.filter(entry => entry.type === 5).length === 1);
  requireValid(root.left === FREE && root.right === FREE);
  const visited = new Set<number>([0]);
  const rootStreams = new Map<string, Entry>();
  const visit = (id: number, depth: number, parentIsRoot: boolean) => {
    if (id === FREE) return;
    requireLimit(depth <= 64);
    requireValid(id > 0 && id < entries.length && !visited.has(id));
    visited.add(id);
    const entry = entries[id];
    requireValid(entry.type === 1 || entry.type === 2);
    visit(entry.left, depth + 1, parentIsRoot);
    visit(entry.right, depth + 1, parentIsRoot);
    if (entry.type === 1) visit(entry.child, depth + 1, false);
    else {
      requireValid(entry.child === FREE);
      if (parentIsRoot) {
        requireValid(!rootStreams.has(entry.name));
        rootStreams.set(entry.name, entry);
      }
    }
  };
  visit(root.child, 0, true);
  const miniFat = read(chain(bytes.readUInt32LE(60), fat, sectorCount, miniFatCount * sectorSize));
  const miniStream = read(chain(root.start, fat, sectorCount, root.size)).subarray(0, root.size);
  const miniUsed = new Set<number>();
  const streams = new Map<string, Buffer>();
  for (const id of visited) {
    const entry = entries[id];
    if (entry.type !== 2) continue;
    const small = entry.size < 4096;
    const ids = chain(entry.start, small ? miniFat : fat, small ? Math.floor(miniStream.length / 64) : sectorCount, entry.size, small ? 64 : sectorSize);
    const needed = rootStreams.get(entry.name) === entry && ['WordDocument', '0Table', '1Table', 'EncryptionInfo', 'EncryptedPackage'].includes(entry.name);
    if (small) {
      for (const miniId of ids) {
        requireValid(!miniUsed.has(miniId));
        miniUsed.add(miniId);
      }
      if (needed) streams.set(entry.name, Buffer.concat(ids.map(miniId => miniStream.subarray(miniId * 64, (miniId + 1) * 64))).subarray(0, entry.size));
    } else {
      ids.forEach(claim);
      if (needed) streams.set(entry.name, Buffer.concat(ids.map(sector)).subarray(0, entry.size));
    }
  }
  return streams;
}

/** Bound Word offsets/character counts as well as the enclosing compound file. */
function validateWordTables(streams: Map<string, Buffer>) {
  if (streams.has('EncryptedPackage') || streams.has('EncryptionInfo')) {
    throw new WordDocumentError('encrypted', 'Password-protected Word documents cannot be read automatically.');
  }
  const word = streams.get('WordDocument');
  requireValid(word && word.length >= 0x1aa && word.readUInt16LE(0) === 0xa5ec);
  const flags = word.readUInt16LE(10);
  if (flags & 0x8100) throw new WordDocumentError('encrypted', 'Password-protected Word documents cannot be read automatically.');
  // Word 6/95 uses a different FIB layout and must not be interpreted as Word 97.
  if (word.readUInt16LE(2) < 0x00c1) throw new WordDocumentError('unsupported', 'This older Word format is not supported for automatic extraction.');
  const table = streams.get(flags & 0x0200 ? '1Table' : '0Table');
  requireValid(table);
  const range = (offset: number, length: number, source = table) => {
    requireValid(offset <= source.length && length <= source.length - offset);
    return source.subarray(offset, offset + length);
  };
  const fibRange = (offset: number) => range(word.readUInt32LE(offset), word.readUInt32LE(offset + 4));
  const boundaries = [0x4c, 0x50, 0x54, 0x5c, 0x60, 0x64, 0x68].map(offset => word.readUInt32LE(offset));
  const characterCount = boundaries.reduce((total, value) => total + value, 0);
  requireLimit(characterCount <= MAX_TEXT);
  const fieldBoundaries = new Set<number>();
  let storyEnd = 0;
  for (const [index, length] of boundaries.entries()) {
    storyEnd += length;
    fieldBoundaries.add(storyEnd);
    // The extractor removes the last character from non-body stories.
    if (index > 0 && length) fieldBoundaries.add(storyEnd - 1);
  }
  const headers = fibRange(0xf2);
  requireValid(headers.length % 4 === 0);
  requireValid(boundaries[2] === 0 || headers.length >= 8);
  requireLimit(headers.length / 4 <= 2000);
  let previousHeader = 0;
  for (let offset = 0; offset < headers.length; offset += 4) {
    const cp = headers.readUInt32LE(offset);
    requireValid(cp >= previousHeader && cp <= boundaries[2]);
    previousHeader = cp;
    fieldBoundaries.add(boundaries[0] + boundaries[1] + cp);
  }
  const clx = fibRange(0x1a2);
  let pos = 0;
  while (pos < clx.length && clx[pos] === 1) {
    requireValid(pos + 3 <= clx.length);
    pos += 3 + clx.readUInt16LE(pos + 1);
  }
  requireValid(pos + 5 <= clx.length && clx[pos] === 2);
  const pieceSize = clx.readUInt32LE(pos + 1);
  pos += 5;
  requireValid(pieceSize >= 4 && (pieceSize - 4) % 12 === 0 && pos + pieceSize <= clx.length);
  const pieces = (pieceSize - 4) / 12;
  requireLimit(pieces <= 2000);
  requireValid(pieces > 0 && clx.readUInt32LE(pos) === 0);
  let textLength = 0;
  let fieldDepth = 0;
  let fieldCount = 0;
  let fieldSeparator = false;
  let characterPosition = 0;
  for (let i = 0; i < pieces; i++) {
    const start = clx.readUInt32LE(pos + i * 4);
    const end = clx.readUInt32LE(pos + (i + 1) * 4);
    requireValid(end >= start);
    textLength += end - start;
    requireLimit(textLength <= MAX_TEXT);
    const filePosition = clx.readUInt32LE(pos + (pieces + 1) * 4 + i * 8 + 2);
    requireValid((filePosition & 0x80000000) === 0);
    const compressed = Boolean(filePosition & 0x40000000);
    const fileOffset = compressed ? (filePosition & 0x3fffffff) / 2 : filePosition;
    requireValid(Number.isInteger(fileOffset));
    const data = range(fileOffset, (end - start) * (compressed ? 1 : 2), word);
    // A narrow field grammar avoids pathological backtracking in the upstream cleaner.
    for (let j = 0; j < data.length; j += compressed ? 1 : 2) {
      const char = compressed ? data[j] : data.readUInt16LE(j);
      if (char === 0x1f || (compressed && [0x80, 0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(char))) {
        throw new WordDocumentError('unsupported', 'This Word document uses a legacy character encoding that cannot be extracted reliably.');
      }
      if (char === 0x13) { requireLimit(fieldDepth === 0); fieldDepth = 1; fieldCount++; fieldSeparator = false; }
      if (char === 0x14) { requireValid(fieldDepth === 1 && !fieldSeparator); fieldSeparator = true; }
      if (char === 0x15) { requireValid(fieldDepth === 1); fieldDepth = 0; }
      requireLimit(fieldCount <= 5000);
      characterPosition++;
      if (fieldBoundaries.has(characterPosition)) requireValid(fieldDepth === 0);
    }
  }
  requireValid(fieldDepth === 0);
  requireValid(characterCount <= textLength);
  // Bookmarks and headers drive loops in the parser; their buffers must be real.
  for (const offset of [0x142, 0x14a, 0x152]) fibRange(offset);
  let formatRuns = 0;
  for (const fibOffset of [0xfa, 0x102]) {
    const properties = fibRange(fibOffset);
    if (!properties.length) continue;
    requireValid(properties.length >= 4 && (properties.length - 4) % 8 === 0);
    const blocks = (properties.length - 4) / 8;
    // Formatting may delete field delimiters after validation, exposing the upstream
    // cleaner to an unterminated field. Keep that combination out of this parser.
    if (fieldCount && blocks) throw new WordDocumentError('unsupported', 'This Word document combines dynamic fields with formatting that cannot be extracted reliably.');
    requireLimit(blocks <= 2000);
    for (let i = 0; i < blocks; i++) {
      const block = range(properties.readUInt32LE((blocks + 1) * 4 + i * 4) * 512, 512, word);
      const count = block[511];
      requireValid((count + 1) * 4 + count * (fibOffset === 0xfa ? 1 : 13) <= 511);
      formatRuns += count;
      requireLimit(formatRuns * Math.max(pieces, 1) <= 1_000_000);
      let previous = 0;
      for (let j = 0; j <= count; j++) {
        const cp = block.readUInt32LE(j * 4);
        requireValid(cp >= previous && cp <= word.length);
        previous = cp;
      }
    }
  }
}

export type WordDocumentText = { pages: SourcePage[]; warnings: string[] };

/** Server only: extract the original bytes, never client-submitted text metadata. */
export async function extractWordDocument(bytes: Uint8Array): Promise<WordDocumentText> {
  try {
    requireLimit(bytes.byteLength <= MAX_FILE_BYTES);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    validateWordTables(checkedStreams(buffer));
    const document = await new WordExtractor().extract(buffer);
    const options = { filterUnicode: false };
    const parts = [
      ['Body', document.getBody(options)],
      ['Headers', document.getHeaders({ ...options, includeFooters: false })],
      ['Footers', document.getFooters(options)],
      ['Footnotes', document.getFootnotes(options)],
      ['Endnotes', document.getEndnotes(options)],
      ['Text boxes', document.getTextboxes(options)],
    ];
    const pages: SourcePage[] = [];
    let total = 0;
    for (const [part, raw] of parts) {
      const text = raw.replace(/\r\n?/g, '\n').trim();
      total += text.length;
      requireLimit(total <= MAX_TEXT);
      let offset = 0;
      while (offset < text.length) {
        let end = Math.min(offset + SECTION_LENGTH, text.length);
        if (end < text.length) {
          const newline = text.lastIndexOf('\n', end);
          if (newline > offset + SECTION_LENGTH / 2) end = newline + 1;
          // Never split a UTF-16 surrogate pair between sections.
          else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
        }
        const section = text.slice(offset, end);
        pages.push({ page: pages.length + 1, label: `Word ${part.toLowerCase()} · text section ${pages.length + 1} (not a printed page)`, text: section, textSource: 'office' });
        requireLimit(pages.length <= MAX_SECTIONS);
        offset = end;
      }
    }
    if (!pages.some(page => /[\p{L}\p{N}]/u.test(page.text))) throw new WordDocumentError('no_text', 'No readable text was found in this Word document. It may contain scanned images.');
    return { pages, warnings: ['Word text extraction does not read images, embedded objects, signatures, comments or exact page layout. Sections are text chunks, not printed pages; check the original document, or upload a PDF for visual review.'] };
  } catch (error) {
    if (error instanceof WordDocumentError) throw error;
    throw new WordDocumentError('malformed', 'This .doc file could not be read automatically.');
  }
}
