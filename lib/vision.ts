import { z } from 'zod';
import type { AiVisionPageEvidence, ShipmentDocument } from './types.ts';

export const VISION_LIMITS = { maxImageBytes: 1536 * 1024, maxDimension: 2600, maxPixels: 2600 * 2600 } as const;
export const imageHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const visualBoundsSchema = z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().positive().max(1), z.number().finite().positive().max(1)])
  .refine(([x, y, width, height]) => x + width <= 1.000001 && y + height <= 1.000001, 'Region must fit inside the source page.');
export const visionReferenceSchema = z.object({ page: z.number().int().min(1).max(200), imageSha256: imageHashSchema }).strict();
export type KimiPageImage = AiVisionPageEvidence & { bytes: Uint8Array };
export function isVisualDocument(document: Pick<ShipmentDocument, 'mime'>): boolean {
  return ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(document.mime);
}
export function supportsKimiVision(model: string | null): boolean {
  return !!model && ['glm-5.3-flash', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.5', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview'].includes(model);
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Parse JPEG frame dimensions without decoding untrusted pixels or trusting form metadata. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 12 || bytes.length > VISION_LIMITS.maxImageBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('A bounded JPEG page image is required.');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) break;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!width || !height || width > VISION_LIMITS.maxDimension || height > VISION_LIMITS.maxDimension || width * height > VISION_LIMITS.maxPixels) throw new Error('Page image dimensions exceed the allowed limit.');
      return { width, height };
    }
    offset += length;
  }
  throw new Error('Page image has no supported JPEG frame.');
}
/** No request may select another workspace, original, version, or arbitrary storage path. */
export function visionBlobKey(workspaceId: string, document: Pick<ShipmentDocument, 'id' | 'version' | 'sha256'>, page: number, imageSha256: string): string {
  const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
  id.parse(workspaceId); id.parse(document.id); imageHashSchema.parse(document.sha256); imageHashSchema.parse(imageSha256);
  z.number().int().positive().parse(document.version); z.number().int().min(1).max(200).parse(page);
  return `${workspaceId}/vision/${document.id}/v${document.version}/${document.sha256}/${page}/${imageSha256}.jpg`;
}
export function jpegDataUrl(bytes: Uint8Array): string {
  jpegDimensions(bytes);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
