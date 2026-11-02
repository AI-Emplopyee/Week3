import { extractWordDocument, WordDocumentError } from './word-document.ts';
import type { PreparedWordSource } from './types.ts';

/** Server-side preparation, shared by first upload and a retry of saved bytes. */
export async function prepareWordSource(bytes: Uint8Array): Promise<PreparedWordSource> {
  try {
    const { pages } = await extractWordDocument(bytes);
    return { pages, extractionStatus: 'pending_ai' };
  } catch (error) {
    return {
      pages: [],
      extractionStatus: error instanceof WordDocumentError && error.code === 'unsupported' ? 'unsupported' : 'failed',
      extractionError: error instanceof WordDocumentError ? error.message : 'This Word document could not be read automatically. Open the original in Word or LibreOffice, save it as PDF, and upload the PDF.',
    };
  }
}
