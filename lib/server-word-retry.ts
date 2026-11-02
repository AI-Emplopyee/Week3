import { z } from 'zod';
import { ApiError, bucket, expectRevision, json, mutate, readJson, requireSameOrigin, workspace } from '@/lib/server';
import { MAX_FILE_BYTES, parseId } from '@/lib/server-validation';
import { canRetryWordDocument } from './word-retry.ts';
import { prepareWordSource } from './word-source.ts';

export async function retryWordDocument(request: Request, id: string): Promise<Response> {
  requireSameOrigin(request);
  parseId(id);
  const context = await workspace(request);
  const { revision } = z.object({ revision: z.number().int().nonnegative() }).strict().parse(await readJson(request));
  expectRevision(context, revision);
  const document = context.state.documents.find(source => source.id === id && source.active);
  const shipment = context.state.cases.find(item => item.id === document?.caseId && !item.mergedInto);
  if (!document || !shipment) throw new ApiError(404, 'Active document not found in this case.');
  if (shipment.status === 'completed') throw new ApiError(422, 'Reopen this case before retrying Word reading.');
  if (!canRetryWordDocument(document) || context.state.candidates.some(candidate => candidate.documentId === id && candidate.documentVersion === document.version)) throw new ApiError(422, 'This Word document already has text or reviewed extraction results.');
  if (!document.blobKey?.startsWith(`${context.state.id}/`)) throw new ApiError(404, 'Original document not found in this workspace.');
  const original = await bucket().get(document.blobKey);
  if (!original) throw new ApiError(404, 'The original document is unavailable.');
  if (original.size > MAX_FILE_BYTES) throw new ApiError(413, 'This original exceeds the 20 MB Word file limit.');
  const bytes = new Uint8Array(await original.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'The original Word file is empty or too large.');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== document.sha256) throw new ApiError(422, 'The saved original failed its integrity check. Upload a new copy instead.');
  const prepared = await prepareWordSource(bytes);
  return json(await mutate(context, revision, { type: 'intake', documents: [], preparedExisting: [{ documentId: id, documentVersion: document.version, sha256, ...prepared }] }));
}
