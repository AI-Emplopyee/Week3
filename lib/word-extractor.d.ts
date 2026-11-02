// Internal extension points of the pinned word-extractor 1.0.4 dependency.
declare module 'word-extractor/lib/buffer-reader.js' {
  export default class BufferReader {
    constructor(buffer: import('node:buffer').Buffer);
    read(buffer: import('node:buffer').Buffer, offset: number, length: number, position: number): Promise<import('node:buffer').Buffer>;
  }
}

declare module 'word-extractor/lib/word-ole-extractor.js' {
  import type BufferReader from 'word-extractor/lib/buffer-reader.js';
  export default class WordOleExtractor<Result> {
    protected _pieces: { text: string }[];
    protected _boundaries: Record<'ccpText' | 'ccpFtn' | 'ccpHdd' | 'ccpAtn' | 'ccpEdn' | 'ccpTxbx' | 'ccpHdrTxbx', number>;
    protected _taggedHeaders: { type: string; text: string }[];
    buildDocument(): Result;
    extract(reader: BufferReader): Promise<Result>;
  }
}
