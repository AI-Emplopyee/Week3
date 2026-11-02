declare module 'word-extractor' {
  type TextOptions = { filterUnicode?: boolean; includeFooters?: boolean; includeBody?: boolean; includeHeadersAndFooters?: boolean };
  interface WordText {
    getBody(options?: TextOptions): string;
    getHeaders(options?: TextOptions): string;
    getFooters(options?: TextOptions): string;
    getFootnotes(options?: TextOptions): string;
    getEndnotes(options?: TextOptions): string;
    getAnnotations(options?: TextOptions): string;
    getTextboxes(options?: TextOptions): string;
  }
  export default class WordExtractor {
    extract(source: import('node:buffer').Buffer): Promise<WordText>;
  }
}
