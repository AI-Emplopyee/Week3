import { documentAiConfiguration } from '@/lib/ai-provider';
import { env } from 'cloudflare:workers';
import PostalMime from 'postal-mime';
import { boundedPdfPages } from '@/lib/pdf-pages';
import { consumeRateLimit } from '@/lib/auth-persistence';
import { matchEmailsInContext } from '@/lib/server-email-grouping';
import { isVisualDocument } from '@/lib/vision';
import { kimiStatus } from '@/lib/kimi';
import { enrichIntakeWithKimi } from '@/lib/intake-ai';
import { parseIntakeMetadata, sourceCollectionSchema, type IntakeMetadata } from '@/lib/intake-metadata';
import { ApiError, bucket, expectRevision, json, mutate, readLimitedBytes, requireSameOrigin, response, workspace } from '@/lib/server';
import { acceptedFile, MAX_UPLOAD_BYTES, parseId, parseUploadedPages, parseRevision, safeFilename } from '@/lib/server-validation';
import type { EmailRecord, SourcePage, UploadedDocument } from '@/lib/types';

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function textPages(text: string): SourcePage[] {
  if (text.length > 500_000) return [];
  const parts = text.split('\f');
  return parts.length > 50 ? [] : parts.map((part, index) => ({ page: index + 1, text: part, textSource: 'pdf_text' }));
}
/** HTML-only messages have no parsed.text in PostalMime. Read their body text
 * without rendering HTML, fetching resources, or creating a shipment document. */
function emailBodyText(parsed: Pick<Awaited<ReturnType<typeof PostalMime.parse>>, 'text' | 'html'>): string {
  if (parsed.text?.trim()) return parsed.text.slice(0, 50000);
  if (!parsed.html) return '';
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return parsed.html.slice(0, 500000)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<br\b[^>]*>|<\/?(?:p|div|table|tr|li|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (literal, entity: string) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? literal;
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
    })
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
}
function optionalId(value: FormDataEntryValue | null): string | undefined { return value == null || value === '' ? undefined : parseId(value); }
function validateFile(name: string, bytes: Uint8Array) {
  try { return acceptedFile(name, bytes); }
  catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Unsupported file.'); }
}
async function readPages(bytes: Uint8Array, extension: string, metadata?: IntakeMetadata): Promise<SourcePage[]> {
  // Binary documents never accept browser/OCR text as extraction evidence.
  // Counting pages is structural validation only; Kimi reads their page images.
  if (['txt', 'csv'].includes(extension)) return textPages(new TextDecoder().decode(bytes));
  if (extension === 'xml') return textPages(new TextDecoder().decode(bytes)).map(page => ({ ...page, textSource: 'xml' }));
  if (extension === 'pdf') {
    try { return await boundedPdfPages(bytes, [], { referenceOnly: metadata?.referenceOnly }); }
    catch (error) { throw new ApiError(400, (error as Error).message); }
  }
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return [{ page: 1, text: '' }];
  return [];
}
function pendingExtraction(extension: string, pages: SourcePage[]): Pick<UploadedDocument, 'extractionStatus' | 'extractionError'> {
  if (!['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv', 'xml'].includes(extension)) return { extractionStatus: 'unsupported', extractionError: 'Original preserved. Convert this format to PDF or a supported image for AI extraction.' };
  if (!pages.length) return { extractionStatus: 'failed', extractionError: 'The original pages could not be opened. Provide an unlocked, readable PDF or supported image.' };
  return { extractionStatus: 'pending_ai' };
}

/** Originals and extracted pages are staged together; grouping/autofill commit once per batch. */
export async function upload(request: Request): Promise<Response> {
  requireSameOrigin(request);
  const context = await workspace(request);
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new ApiError(415, 'Upload files using multipart/form-data.');
  const raw = await readLimitedBytes(request, MAX_UPLOAD_BYTES);
  const form = await new Response(new Uint8Array(raw).buffer, { headers: { 'content-type': contentType } }).formData();
  const entries = form.getAll('file');
  if (!entries.length || entries.length > 20 || entries.some(file => typeof file === 'string')) throw new ApiError(400, 'Choose between 1 and 20 files for one batch.');
  const files = entries as File[];
  if (form.get('revision') == null) throw new ApiError(400, 'A workspace revision is required.');
  const revision = parseRevision(form.get('revision'));
  expectRevision(context, revision);
  const targetCaseId = optionalId(form.get('targetCaseId'));
  const sourceCollection = form.has('sourceCollection') ? sourceCollectionSchema.parse(JSON.parse(String(form.get('sourceCollection')))) : undefined;
  if (sourceCollection && targetCaseId) throw new ApiError(400, 'Choose a source collection or a shipment target.');
  const documentId = optionalId(form.get('documentId'));
  if (targetCaseId && !context.state.cases.some(item => item.id === targetCaseId && !item.mergedInto && item.status !== 'completed')) throw new ApiError(404, 'Open shipment case not found.');
  if (documentId && (!context.state.documents.some(item => item.id === documentId && item.active) || files.length !== 1)) throw new ApiError(400, 'Replace one active document at a time.');
  let metadata: IntakeMetadata[];
  try {
    metadata = form.has('documents') ? parseIntakeMetadata(JSON.parse(String(form.get('documents'))), files.map(file => file.name)) : parseIntakeMetadata([{
      name: files[0].name,
      pages: parseUploadedPages(JSON.parse(String(form.get('pages') || '[]'))),
      extractionStatus: String(form.get('extractionStatus') || 'extracted'),
      ...(form.get('extractionError') ? { extractionError: String(form.get('extractionError')) } : {}),
    }], files.map(file => file.name));
  } catch { throw new ApiError(400, 'Invalid batch document metadata. Each file must have matching bounded page data.'); }
  const documents: UploadedDocument[] = [];
  const emails: EmailRecord[] = [];
  const storedKeys: string[] = [];
  const storage = bucket();
  const writeOriginal = async (id: string, data: Uint8Array, mime: string) => {
    const key = `${context.state.id}/${id}`;
    await storage.put(key, data, { httpMetadata: { contentType: mime } });
    storedKeys.push(key); return key;
  };
  const findDuplicate = (sha256: string) => documents.find(document => document.sha256 === sha256) ?? context.state.documents.find(document => document.sha256 === sha256);
  let committed = false;
  try {
    for (const [index, file] of files.entries()) {
      const name = safeFilename(file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { extension, mime } = validateFile(name, bytes);
      const sha256 = await hash(bytes);
      if (extension !== 'eml') {
        const duplicate = findDuplicate(sha256);
        if (duplicate) {
          const incoming = metadata[index].sourcePaths ?? [];
          const combined = [...new Set([...(duplicate.sourcePaths ?? []), ...incoming])].slice(0, 100);
          if (combined.length !== (duplicate.sourcePaths?.length ?? 0)) {
            const staged = documents.find(d => d.sha256 === sha256);
            if (staged) staged.sourcePaths = combined;
            else documents.push({ ...duplicate, sourcePaths: combined });
          }
          continue;
        }
        const pages = await readPages(bytes, extension, metadata[index]);
        const assessment = pendingExtraction(extension, pages);
        const id = `doc_${crypto.randomUUID()}`;
        documents.push({ extractionPipeline: 'kimi', id, name, mime, size: bytes.length, sha256, pages, ...assessment, sourcePaths: metadata[index].sourcePaths, referenceOnly: metadata[index].referenceOnly, blobKey: await writeOriginal(id, bytes, mime) });
        continue;
      }
      if (documentId) throw new ApiError(400, 'Import an email as a new intake. Replace an individual attachment from its source document.');
      let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
      try { parsed = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 12, maxRfc822NestingDepth: 3, maxHeadersSize: 64 * 1024 }); }
      catch { throw new ApiError(400, 'This email could not be parsed. Export the original message as an EML file and retry.'); }
      if (!parsed.headers.some(header => ['from', 'subject', 'message-id'].includes(header.key))) throw new ApiError(400, 'The file does not contain an email envelope.');
      const messageId = (parsed.messageId || `sha256:${sha256}`).slice(0, 1000);
      if ([...context.state.emails, ...emails].some(email => email.sha256 === sha256 || email.messageId === messageId)) continue;
      if (parsed.attachments.length > 50) throw new ApiError(400, 'Email intake supports up to 50 attachments.');
      if (metadata[index].attachments?.some(item => !parsed.attachments[item.index] || (parsed.attachments[item.index].filename || 'unnamed-attachment') !== item.name)) throw new ApiError(400, 'Attachment metadata does not match this email.');
      const emailId = `email_${crypto.randomUUID()}`;
      const date = parsed.date ? new Date(parsed.date) : new Date();
      const email: EmailRecord = { text: emailBodyText(parsed), inReplyTo: parsed.inReplyTo?.slice(0, 1000), references: parsed.references?.split(/\s+/).filter(Boolean).slice(0, 50).map(value => value.slice(0, 1000)), aiGroupingStatus: kimiStatus(documentAiConfiguration(env)).configured ? 'partial' : 'unavailable', id: emailId, messageId, sender: (parsed.from?.address || parsed.from?.name || 'Unknown sender').slice(0, 1000), subject: (parsed.subject || name).slice(0, 1000), receivedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(), originalName: name, blobKey: await writeOriginal(emailId, bytes, mime), documentIds: [], sha256 };
      // Replies belong to the email record. Only actual attachments enter document
      // grouping; a body-only message must not manufacture a provisional shipment.
      for (const [attachmentIndex, attachment] of parsed.attachments.entries()) {
        const attachmentName = safeFilename(attachment.filename || 'unnamed-attachment');
        const data = typeof attachment.content === 'string' ? new TextEncoder().encode(attachment.content) : new Uint8Array(attachment.content);
        const attachmentHash = await hash(data); const duplicate = findDuplicate(attachmentHash);
        if (duplicate) { email.documentIds.push(duplicate.id); continue; }
        const id = `doc_${crypto.randomUUID()}`;
        let attachmentMime = attachment.mimeType || 'application/octet-stream';
        let pages: SourcePage[] = [];
        let assessment: Pick<UploadedDocument, 'extractionStatus' | 'extractionError'>;
        let accepted: ReturnType<typeof acceptedFile> | undefined;
        try { accepted = acceptedFile(attachmentName, data); } catch { /* Keep unsupported originals with an explicit blocker. */ }
        if (accepted) {
          attachmentMime = accepted.mime;
          const prepared = metadata[index].attachments?.find(item => item.index === attachmentIndex);
          pages = await readPages(data, accepted.extension, prepared);
          assessment = pendingExtraction(accepted.extension, pages);
        } else assessment = { extractionStatus: 'unsupported', extractionError: 'Attachment preserved, but this format cannot be extracted. Replace it with a supported document.' };
        documents.push({ extractionPipeline: 'kimi', id, name: attachmentName, mime: attachmentMime, size: data.length, sha256: attachmentHash, blobKey: await writeOriginal(id, data, attachmentMime), pages, ...assessment, sourceEmailId: emailId });
        email.documentIds.push(id);
      }
      emails.push(email);
    }
    if (!documents.length && !emails.length) return json({ ...response(context), notice: 'These original documents are already in the workspace. No duplicates were created.' });
    // PDF/image vision runs after originals are committed and grouped. Do not pay
    // for a separate text-only pass that cannot see tables or OCR errors.
    const aiConfigured = kimiStatus(documentAiConfiguration(env)).configured;
    for (const document of documents.filter(isVisualDocument)) {
      document.aiStatus = aiConfigured ? 'partial' : 'unavailable';
      if (aiConfigured) document.aiError = 'Page images are ready to be processed after upload.';
    }
    if (env.AICD_AUTH_MODE !== 'local') await enrichIntakeWithKimi(documents.filter(document => !isVisualDocument(document) && document.extractionStatus === 'pending_ai' && !document.referenceOnly && !context.state.documents.some(existing => existing.sha256 === document.sha256)), documentAiConfiguration(env), {
      allowRequest: () => consumeRateLimit(context.db, `kimi-extract:${context.state.id}`, 6, 60),
    });
    const result = await mutate(context, revision, documentId ? { type: 'replace_document', documentId, document: documents[0] } : { type: 'intake', documents, targetCaseId, sourceCollection, emails });
    committed = true;
    if (emails.length && aiConfigured && env.AICD_AUTH_MODE !== 'local') {
      try { return json(await matchEmailsInContext(context, emails.map(email => email.id))); }
      catch (error) {
        // Original intake already committed. Matching failures must not discard it or
        // turn a successful upload into an apparently failed/duplicate upload.
        if (error instanceof ApiError && error.status === 409) return json({ ...response(context), notice: 'Email originals were saved. The workspace changed during matching; review current records before retrying.' });
        const reason = error instanceof ApiError && error.status === 429
          ? 'The AI request limit was reached. Resume email matching in one minute.'
          : 'Email originals were saved, but AI shipment matching could not finish. Resume matching from the email section.';
        try { return json(await mutate(context, context.state.revision, { type: 'email_matching_status', emailIds: emails.map(email => email.id), status: 'partial', reason })); }
        catch { return json({ ...response(context), notice: reason }); }
      }
    }
    return json(result);
  } catch (error) {
    if (!committed && storedKeys.length) await storage.delete(storedKeys).catch(() => undefined);
    throw error;
  }
}
