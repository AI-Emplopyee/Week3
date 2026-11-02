import { z } from 'zod';
import { env } from 'cloudflare:workers';
import { consumeRateLimit } from '@/lib/auth-persistence';
import { ApiError, bucket, expectRevision, json, privateHeaders, readLimitedBytes, requireSameOrigin, workspace } from '@/lib/server';
import { imageHashSchema, isVisualDocument, jpegDimensions, sha256Hex, VISION_LIMITS, visionBlobKey, visionReferenceSchema, type KimiPageImage } from '@/lib/vision';
import type { ShipmentDocument } from '@/lib/types';
import { storeVisionPage } from '@/lib/vision-storage';

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const uploadSchema = z.object({
  revision: z.coerce.number().int().nonnegative(), caseId: id, documentId: id, automatic: z.literal('true').optional(),
  documentVersion: z.coerce.number().int().positive(), sha256: imageHashSchema,
  page: z.coerce.number().int().min(1).max(200),
  width: z.coerce.number().int().positive().max(VISION_LIMITS.maxDimension),
  height: z.coerce.number().int().positive().max(VISION_LIMITS.maxDimension),
}).strict();

/** These are authenticated browser derivatives, not independently verified server renders. */
export async function uploadVisionPage(request: Request): Promise<Response> {
  requireSameOrigin(request);
  const context = await workspace(request);
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new ApiError(415, 'Upload a rendered page using multipart/form-data.');
  const bytes = await readLimitedBytes(request, VISION_LIMITS.maxImageBytes + 16 * 1024);
  const form = await new Response(new Uint8Array(bytes).buffer, { headers: { 'content-type': contentType } }).formData();
  if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new ApiError(400, 'Each page upload field must appear once.');
  const { image, ...metadata } = Object.fromEntries(form);
  const input = uploadSchema.parse(metadata);
  expectRevision(context, input.revision);
  if (input.automatic && (env.AICD_AUTH_MODE !== 'local' || env.AICD_BACKGROUND_PROCESSING !== '1')) throw new ApiError(403, 'Automatic page preparation requires the active local reader.');
  const document = context.state.documents.find(doc => doc.id === input.documentId && doc.active && (input.automatic || doc.caseId === input.caseId));
  const shipment = context.state.cases.find(item => item.id === document?.caseId && !item.mergedInto);
  if (!document || !shipment) throw new ApiError(404, 'Active document not found.');
  if (shipment.status === 'completed' || document.referenceOnly || !isVisualDocument(document)) throw new ApiError(422, 'This document is not available for shipment vision extraction.');
  if (document.version !== input.documentVersion || document.sha256 !== input.sha256) throw new ApiError(409, 'The original document changed. Render its current version again.');
  if (!document.pages.some(page => page.page === input.page)) throw new ApiError(422, 'The page does not exist in the original document.');
  if (!image || typeof image === 'string' || image.type !== 'image/jpeg') throw new ApiError(400, 'A JPEG page image is required.');
  const raster = new Uint8Array(await image.arrayBuffer());
  let dimensions: { width: number; height: number };
  try { dimensions = jpegDimensions(raster); } catch { throw new ApiError(400, 'The rendered page is not a valid bounded JPEG.'); }
  if (dimensions.width !== input.width || dimensions.height !== input.height) throw new ApiError(400, 'Image dimensions do not match the rendered page.');
  if (!await consumeRateLimit(context.db, `vision-upload:${context.state.id}`, 120, 60)) throw new ApiError(429, 'Too many page uploads. Resume in one minute.');
  const imageSha256 = await sha256Hex(raster);
  const stored = await storeVisionPage(context.db, bucket(), context.state.id, document.id, visionBlobKey(context.state.id, document, input.page, imageSha256), raster);
  if (!stored) throw new ApiError(409, 'This document was deleted while its page was being prepared. Reload the workspace.');
  return json({ page: input.page, documentId: document.id, documentVersion: document.version, imageSha256 });
}

export async function loadVisionPages(workspaceId: string, document: ShipmentDocument, references: { page: number; imageSha256: string }[]): Promise<KimiPageImage[]> {
  const images: KimiPageImage[] = [];
  for (const reference of references) {
    visionReferenceSchema.parse(reference);
    const object = await bucket().get(visionBlobKey(workspaceId, document, reference.page, reference.imageSha256));
    if (!object || object.size > VISION_LIMITS.maxImageBytes) throw new ApiError(422, 'The source page image is unavailable. Render the original again.');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256Hex(bytes) !== reference.imageSha256) throw new ApiError(422, 'The source page image failed its integrity check.');
    let dimensions: { width: number; height: number };
    try { dimensions = jpegDimensions(bytes); } catch { throw new ApiError(422, 'The stored source page image is invalid.'); }
    images.push({ ...reference, ...dimensions, bytes });
  }
  return images;
}

/** Reviewers can see only rasters referenced by saved evidence in their workspace. */
export async function getVisionPage(request: Request): Promise<Response> {
  const context = await workspace(request);
  const url = new URL(request.url);
  const documentId = id.parse(url.searchParams.get('documentId'));
  const reference = visionReferenceSchema.parse({ page: Number(url.searchParams.get('page')), imageSha256: url.searchParams.get('imageSha256') });
  const candidate = context.state.candidates.find(item => item.documentId === documentId && item.page === reference.page && item.visualEvidence?.imageSha256 === reference.imageSha256);
  const document = context.state.documents.find(item => item.id === documentId && item.version === candidate?.documentVersion);
  if (!candidate || !document) throw new ApiError(404, 'Visual evidence not found.');
  const [image] = await loadVisionPages(context.state.id, document, [reference]);
  return new Response(new Uint8Array(image.bytes).buffer, { headers: { ...privateHeaders, 'Content-Type': 'image/jpeg', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline' } });
}
