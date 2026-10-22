import type { SourcePage, ShipmentDocument } from './types';
import { throwIfAborted, type IntakeOptions } from './client-intake-utils.ts';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PAGES = 50;
type PreparedFile = { pages: SourcePage[]; extractionStatus: ShipmentDocument['extractionStatus']; extractionError?: string };

/** Preserve originals for the configured AI reader. No PDF text reader, OCR, or fallback runs locally. */
export async function prepareFile(file: File, options: IntakeOptions = {}): Promise<PreparedFile> {
  throwIfAborted(options.signal);
  if (file.size > MAX_FILE_BYTES) throw new Error('Tệp vượt quá giới hạn 20 MB.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  options.onProgress?.({ page: 1, total: 1, stage: 'reading', progress: 0 });
  if (['txt', 'csv'].includes(extension || '')) {
    const text = await file.text();
    throwIfAborted(options.signal);
    if (text.length > 300_000) throw new Error('Tài liệu quá dài; giới hạn 300.000 ký tự mỗi tệp.');
    const pages = text.split('\f').map((text, index) => ({ page: index + 1, text }));
    if (pages.length > MAX_PAGES) throw new Error('Tài liệu vượt quá 50 trang. Hãy tách thành tệp nhỏ hơn.');
    return { pages, extractionStatus: 'pending_ai' };
  }
  // The server independently counts physical PDF pages; their text stays empty.
  if (extension === 'pdf' || extension === 'eml') return { pages: [], extractionStatus: 'pending_ai' };
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension || '')) return { pages: [{ page: 1, text: '' }], extractionStatus: 'pending_ai' };
  throw new Error('Chưa hỗ trợ định dạng này. Chọn PDF, TXT, CSV, EML, PNG hoặc JPG.');
}

export type PreparedIntakeFile = PreparedFile & {
  attachments?: (PreparedFile & { name: string; index: number })[];
};

/** Attachments use the same original-only intake as directly uploaded documents. */
export async function prepareIntakeFile(file: File, options: IntakeOptions = {}): Promise<PreparedIntakeFile> {
  if (!file.name.toLowerCase().endsWith('.eml')) return prepareFile(file, options);
  if (file.size > MAX_FILE_BYTES) throw new Error('Tệp vượt quá giới hạn 20 MB.');
  const { default: PostalMime } = await import('postal-mime');
  const parsed = await PostalMime.parse(await file.arrayBuffer(), { attachmentEncoding: 'arraybuffer', maxNestingDepth: 12, maxRfc822NestingDepth: 3, maxHeadersSize: 64 * 1024 });
  if (parsed.attachments.length > 50) throw new Error('Email intake supports up to 50 attachments.');
  const attachments: NonNullable<PreparedIntakeFile['attachments']> = [];
  for (const [index, attachment] of parsed.attachments.entries()) {
    throwIfAborted(options.signal);
    const name = attachment.filename || 'unnamed-attachment';
    const content = attachment.content;
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    const source = new File([new Uint8Array(bytes).buffer], name, { type: attachment.mimeType || 'application/octet-stream' });
    try { attachments.push({ name, index, ...await prepareFile(source, options) }); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      attachments.push({ name, index, pages: [], extractionStatus: 'unsupported', extractionError: error instanceof Error ? error.message : 'Attachment could not be read.' });
    }
  }
  return { pages: [], extractionStatus: 'extracted', attachments };
}
