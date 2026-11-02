import type { ShipmentDocument } from './types.ts';

/** Retry only originals that have never supplied readable text or AI evidence. */
export function canRetryWordDocument(document: ShipmentDocument): boolean {
  return document.active && !!document.blobKey && /\.doc$/i.test(document.name)
    && ['unsupported', 'failed'].includes(document.extractionStatus)
    && !document.aiProcessedPages?.length && !document.transcribedPages?.length
    && !document.pages.some(page => page.text.trim() || page.aiReadability);
}
