import { z } from 'zod';
import { SHIPMENT_TEXT_LIMITS } from './source-text-limits.ts';
import type { Action, SourcePage } from './types';
import { declarationActionSchema, declarationRemoveActionSchema } from './declaration.ts';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 2 * 1024 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;
// Larger workspaces are stored in bounded chunks, with an atomic revision manifest.
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const evidenceId = z.string().min(1).max(300).regex(/^[a-zA-Z0-9_:-]+$/);
const text = z.string().max(SHIPMENT_TEXT_LIMITS.maxValueLength);
const reason = z.string().trim().min(1).max(2_000);
const documentType = z.enum(['invoice', 'packing_list', 'bill_of_lading', 'air_waybill', 'contract', 'certificate_of_origin', 'other']);
const pageSchema = z.object({
  page: z.number().int().min(1).max(200),
  text: z.string().max(500_000),
  pdfText: z.string().max(500_000).optional(),
  label: z.string().max(200).optional(),
  documentType: documentType.optional(),
  textSource: z.enum(['pdf_text', 'ocr', 'manual', 'office', 'xml']).optional(),
  ocrConfidence: z.number().finite().min(0).max(1).optional(),
}).strict().superRefine((page, context) => {
  if (page.ocrConfidence !== undefined && page.textSource !== 'ocr') context.addIssue({ code: 'custom', message: 'OCR confidence requires OCR text provenance.' });
});
export const pagesSchema = z.array(pageSchema).max(200).superRefine((pages, ctx) => {
  if (pages.reduce((n, p) => n + p.text.length + (p.pdfText?.length ?? 0), 0) > 500_000) ctx.addIssue({ code: 'custom', message: 'Extracted text exceeds 500,000 characters.' });
  if (new Set(pages.map(p => p.page)).size !== pages.length) ctx.addIssue({ code: 'custom', message: 'Page numbers must be unique.' });
});
const caseType = z.enum(['import', 'export', 'reference', 'unknown', 'unsupported']);
const goods = z.object({
  id: evidenceId, description: text, quantity: z.string().max(100), unit: z.string().max(100), unitPrice: z.string().max(100), amount: z.string().max(100),
  hsCode: z.string().max(100), origin: z.string().max(100), dutyRate: z.string().max(100), vatRate: z.string().max(100),
  sourceDocumentId: id.optional(), sourcePage: z.number().int().min(1).max(50).optional(), originalText: z.string().max(SHIPMENT_TEXT_LIMITS.maxQuoteLength).optional(),
  reviewed: z.boolean(), manual: z.boolean(), reason: z.string().max(2_000).optional(),
}).strict();
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('review_email_match'), emailId: id, matchId: id, decision: z.enum(['accept', 'reject']), reason }).strict(),
  z.object({ type: z.literal('refresh_extraction'), caseId: id, reason }).strict(),
  z.object({ type: z.literal('refresh_case_automation'), caseId: id, locale: z.enum(['vi', 'en']).optional() }).strict(),
  declarationActionSchema,
  declarationRemoveActionSchema,
  z.object({ type: z.literal('apply_client_memory'), caseId: id, memoryId: id, expectedValue: z.string().max(12000) }).strict(),
  z.object({ type: z.literal('dismiss_client_memory'), caseId: id, memoryId: id }).strict(),
  z.object({ type: z.literal('revoke_client_memory'), caseId: id, memoryId: id }).strict(),
  z.object({ type: z.literal('regroup_existing'), caseIds: z.array(id).min(1).max(50).optional() }).strict(),
  z.object({ type: z.literal('draft_questions'), caseId: id, issueIds: z.array(z.string().min(1).max(300)).min(1).max(50), locale: z.enum(['vi', 'en']).optional() }).strict(),
  z.object({ type: z.literal('save_email_draft'), draftId: id, recipient: z.union([z.string().trim().email().max(320), z.literal('')]).optional(), subject: z.string().trim().min(1).max(500), body: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('approve_email_draft'), draftId: id }).strict(),
  z.object({ type: z.literal('seed_demo') }).strict(),
  z.object({ type: z.literal('delete_case'), caseId: id, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('create_case'), title: z.string().trim().min(1).max(200), caseType: caseType.optional() }).strict(),
  z.object({ type: z.literal('review_field'), caseId: id, field: z.string().min(1).max(100), value: text, candidateId: evidenceId.optional(), reason }).strict(),
  z.object({ type: z.literal('review_goods'), caseId: id, goods: z.array(goods).max(500), reviewedLineIds: z.array(evidenceId).max(500).optional(), reason }).strict(),
  z.object({ type: z.literal('resolve_issue'), caseId: id, issueId: z.string().min(1).max(300), reason }).strict(),
  z.object({ type: z.literal('confirm_grouping'), caseId: id, reason }).strict(),
  z.object({ type: z.literal('move_documents'), documentIds: z.array(id).min(1).max(50), targetCaseId: id.optional(), title: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ type: z.literal('merge_cases'), sourceCaseId: id, targetCaseId: id }).strict(),
  z.object({ type: z.literal('classify_document'), documentId: id, documentType }).strict(),
  z.object({ type: z.literal('transcribe_document'), documentId: id, pages: pagesSchema, reason }).strict(),
  z.object({ type: z.literal('update_case'), caseId: id, title: z.string().trim().min(1).max(200).optional(), assignedTo: z.string().max(320).optional(), caseType: caseType.optional(), reason: reason.optional() }).strict(),
  z.object({ type: z.literal('approve'), caseId: id }).strict(),
  z.object({ type: z.literal('handoff'), caseId: id, simulateFailure: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('complete'), caseId: id, reason }).strict(),
  z.object({ type: z.literal('reopen'), caseId: id, reason }).strict(),
  z.object({ type: z.literal('settings'), inboxAddress: z.union([z.string().email().max(320), z.literal('')]).optional(), defaultReviewer: z.string().max(320).optional() }).strict(),
]);
export const mutationSchema = z.object({ revision: z.number().int().nonnegative(), action: actionSchema }).strict();
export const inviteSchema = z.object({ email: z.string().trim().email().max(320) }).strict();
export function parseMutation(value: unknown): { revision: number; action: Action } { return mutationSchema.parse(value); }
export function parsePages(value: unknown): SourcePage[] { return pagesSchema.parse(value); }
export function parseUploadedPages(value: unknown): SourcePage[] {
  return pagesSchema.refine(pages => !pages.some(page => page.textSource === 'manual'), {
    message: 'Manual transcription must use the audited document transcription action.',
  }).parse(value);
}
export function parseId(value: unknown): string { return id.parse(value); }
export function parseRevision(value: unknown): number { return z.coerce.number().int().nonnegative().parse(value); }
export function safeFilename(value: string): string {
  const name = value.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  if (!name || name.length > 240) throw new Error('File name must contain 1–240 characters.');
  return name;
}
export function acceptedFile(name: string, bytes: Uint8Array): { extension: string; mime: string } {
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  const mimes: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', eml: 'message/rfc822', tif: 'image/tiff', tiff: 'image/tiff', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint', xml: 'application/xml', zip: 'application/zip', rar: 'application/vnd.rar' };
  if (!mimes[extension]) throw new Error('This file format is not supported.');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('Each file must be nonempty and no larger than 20 MB.');
  if (extension === 'pdf' && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('The file does not have a valid PDF header.');
  if (extension === 'png' && ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) throw new Error('The file does not have a valid PNG header.');
  if (['jpg', 'jpeg'].includes(extension) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw new Error('The file does not have a valid JPEG header.');
  if (extension === 'webp' && !(new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP')) throw new Error('The file does not have a valid WebP header.');
  if (['xlsx', 'docx', 'zip'].includes(extension) && !(bytes[0] === 80 && bytes[1] === 75 && [3,5,7].includes(bytes[2]))) throw new Error('The file does not have a valid ZIP container header.');
  const ole = [208,207,17,224,161,177,26,225].every((b,i) => bytes[i] === b);
  const legacyText = new TextDecoder(bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-8').decode(bytes.slice(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  // Older Word exports sometimes contain RTF or HTML. They are download-only;
  // extracted text is displayed as text and the original is never executed.
  const wordText = extension === 'doc' && (/^\{\\rtf/i.test(legacyText) || /^<(?:!doctype\s+html|html\b)/i.test(legacyText));
  if (['xls', 'doc', 'ppt'].includes(extension) && !ole && !wordText) throw new Error('The file does not have a valid Office binary header.');
  if (['tif','tiff'].includes(extension) && !((bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0) || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42))) throw new Error('The file does not have a valid TIFF header.');
  if (extension === 'rar' && ![82,97,114,33,26,7].every((b,i) => bytes[i] === b)) throw new Error('The file does not have a valid RAR header.');
  if (['txt', 'csv', 'eml'].includes(extension) && bytes.slice(0, 4096).includes(0)) throw new Error('Text and email files must contain text, not binary data.');
  if (extension === 'xml' && !new TextDecoder().decode(bytes.slice(0,4096)).replace(/^\uFEFF/, '').trimStart().startsWith('<')) throw new Error('The file does not have a valid XML header.');
  return { extension, mime: mimes[extension] };
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;
  if (!origin) return fetchSite === 'same-origin' || fetchSite === 'none';
  return origin === new URL(request.url).origin;
}
