import { Buffer } from 'node:buffer';

/** Small synthetic Word 97 compound file; no customer data or external converter. */
export function wordFixture(body = 'Invoice: TEST-001\rItem\x07Quantity\rCẩu trục\x072\r', options: { miniTable?: boolean; sectorSize?: 512 | 4096; compressed?: boolean } = {}) {
  const sectorSize = options.sectorSize ?? 512;
  const END = 0xfffffffe;
  const FREE = 0xffffffff;
  const content = Buffer.from(body, options.compressed ? 'latin1' : 'utf16le');
  const wordSize = Math.max(4096, Math.ceil((512 + content.length) / sectorSize) * sectorSize);
  const wordSectors = wordSize / sectorSize;
  const tableSectors = options.miniTable ? 0 : 4096 / sectorSize;
  const miniSectors = options.miniTable ? 2 : 0;
  let fatCount = 1;
  while (fatCount * sectorSize / 4 < 1 + fatCount + wordSectors + tableSectors + miniSectors) fatCount++;
  if (fatCount > 109) throw new Error('Test fixture is too large for its inline DIFAT.');
  const sectorCount = 1 + fatCount + wordSectors + tableSectors + miniSectors;
  const bytes = Buffer.alloc((sectorCount + 1) * sectorSize);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
  bytes.writeUInt16LE(0x003e, 24);
  bytes.writeUInt16LE(sectorSize === 512 ? 3 : 4, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(sectorSize === 512 ? 9 : 12, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(sectorSize === 512 ? 0 : 1, 40);
  bytes.writeUInt32LE(fatCount, 44);
  bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(4096, 56);
  bytes.writeUInt32LE(END, 60);
  bytes.writeUInt32LE(END, 68);
  for (let i = 0; i < 109; i++) bytes.writeUInt32LE(i < fatCount ? i + 1 : FREE, 76 + i * 4);
  const fatOffset = 2 * sectorSize;
  const fat = bytes.subarray(fatOffset, fatOffset + fatCount * sectorSize);
  fat.fill(0xff);
  fat.writeUInt32LE(END, 0);
  for (let i = 0; i < fatCount; i++) fat.writeUInt32LE(0xfffffffd, (i + 1) * 4);
  const wordStart = 1 + fatCount;
  const tableStart = wordStart + wordSectors;
  const makeChain = (start: number, count: number) => {
    for (let i = 0; i < count; i++) fat.writeUInt32LE(i + 1 < count ? start + i + 1 : END, (start + i) * 4);
  };
  makeChain(wordStart, wordSectors);
  if (!options.miniTable) makeChain(tableStart, tableSectors);
  const directoryOffset = sectorSize;
  const entry = (id: number, name: string, type: number, start: number, size: number, child = FREE, right = FREE) => {
    const offset = directoryOffset + id * 128;
    Buffer.from(`${name}\0`, 'utf16le').copy(bytes, offset);
    bytes.writeUInt16LE((name.length + 1) * 2, offset + 64);
    bytes[offset + 66] = type;
    bytes[offset + 67] = 1;
    bytes.writeUInt32LE(FREE, offset + 68);
    bytes.writeUInt32LE(right, offset + 72);
    bytes.writeUInt32LE(child, offset + 76);
    bytes.writeUInt32LE(start, offset + 116);
    bytes.writeUInt32LE(size, offset + 120);
  };
  entry(0, 'Root Entry', 5, options.miniTable ? tableStart : END, options.miniTable ? 64 : 0, 1);
  entry(1, 'WordDocument', 2, wordStart, wordSize, FREE, 2);
  entry(2, '1Table', 2, options.miniTable ? 0 : tableStart, options.miniTable ? 21 : 4096);
  const wordOffset = (wordStart + 1) * sectorSize;
  const tableOffset = (tableStart + 1) * sectorSize;
  if (options.miniTable) {
    makeChain(tableStart, 1);
    makeChain(tableStart + 1, 1);
    bytes.writeUInt32LE(tableStart + 1, 60);
    bytes.writeUInt32LE(1, 64);
    const miniFat = bytes.subarray((tableStart + 2) * sectorSize, (tableStart + 3) * sectorSize);
    miniFat.fill(0xff);
    miniFat.writeUInt32LE(END, 0);
  }
  bytes.writeUInt16LE(0xa5ec, wordOffset);
  bytes.writeUInt16LE(0x00c1, wordOffset + 2);
  bytes.writeUInt16LE(0x0200, wordOffset + 10);
  bytes.writeUInt32LE(512, wordOffset + 0x18);
  bytes.writeUInt32LE(body.length, wordOffset + 0x4c);
  bytes.writeUInt32LE(21, wordOffset + 0x1a6);
  content.copy(bytes, wordOffset + 512);
  bytes[tableOffset] = 2;
  bytes.writeUInt32LE(16, tableOffset + 1);
  bytes.writeUInt32LE(body.length, tableOffset + 9);
  bytes.writeUInt32LE(options.compressed ? 0x40000400 : 512, tableOffset + 15);
  return { bytes, wordOffset, tableOffset, fatOffset, directoryOffset, wordStart, sectorSize };
}
