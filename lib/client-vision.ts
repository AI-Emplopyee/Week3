import { sourcePageNeedsKimi } from './source-completeness.ts';
import { fetchWithSession } from './auth-client.ts';
import { throwIfAborted, withIntakeTimeout } from './client-intake-utils.ts';
import { MAX_FILE_BYTES } from './client-intake.ts';
import { openPdfRasterizer } from './client-pdf-raster.ts';
import type { SourcePage, ShipmentDocument, WorkspaceResponse } from './types.ts';

export const VISION_IMAGE_LIMITS = { maxDimension: 2600, maxBytes: 1.5 * 1024 * 1024 };
export type ClientAiStatus = {
  configured: boolean;
  backgroundProcessing?: boolean;
  visionSupported?: boolean;
  model: string | null;
  endpoint: string;
  provider: string;
  limits: { maxPages: number; maxTextCharacters: number; maxCandidates: number };
};
export type AiProgress = { documentName: string; stage: 'rendering' | 'extracting'; page: number; completed: number; total: number };
type AiResponse = WorkspaceResponse & { error?: string; ai?: { added: number; rejected: number; pages: number[] } };
type PageRaster = { blob: Blob; width: number; height: number };
export type VisionRenderer = { render: (page: number) => Promise<PageRaster>; close: () => Promise<void> };

export class AiPipelineError extends Error {
  readonly status?: number;
  readonly workspace?: WorkspaceResponse;
  constructor(message: string, status?: number, workspace?: WorkspaceResponse) { super(message); this.name = 'AiPipelineError'; this.status = status; this.workspace = workspace; }
}

export function canRenderVisionDocument(document: Pick<ShipmentDocument, 'mime' | 'name'>): boolean {
  return document.mime === 'application/pdf' || /^image\/(png|jpeg|webp)$/.test(document.mime);
}

/** Every selected page appears exactly once. Visual pages save independently so a dense page can resume without rereading its neighbours. */
export function buildAiBatches(pages: readonly SourcePage[], selected: readonly number[], limits: ClientAiStatus['limits'], visual: boolean): number[][] {
  const unique = new Set(selected);
  if (!unique.size) throw new Error('Select at least one page.');
  if (unique.size !== selected.length || !Number.isInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxTextCharacters < 1) throw new Error('Invalid page selection or extraction limits.');
  const chosen = pages.filter(page => unique.has(page.page)).sort((a, b) => a.page - b.page);
  if (chosen.length !== unique.size) throw new Error('The selected pages no longer exist. Reload the document.');
  const batches: number[][] = [];
  const maxPages = visual ? 1 : limits.maxPages;
  let batch: number[] = []; let characters = 0;
  for (const page of chosen) {
    if (!visual && !page.text.trim()) throw new Error(`Page ${page.page} has no readable text. Use a PDF or supported image for vision extraction.`);
    const pageCharacters = visual ? 0 : page.text.length;
    if (pageCharacters > limits.maxTextCharacters) throw new Error(`Page ${page.page} exceeds the extraction text limit. Split this page into a smaller document before processing.`);
    if (batch.length && (batch.length >= maxPages || characters + pageCharacters > limits.maxTextCharacters)) { batches.push(batch); batch = []; characters = 0; }
    batch.push(page.page); characters += pageCharacters;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of [.88, .76, .62]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= VISION_IMAGE_LIMITS.maxBytes) return blob;
  }
  throw new Error('The rendered page is too large for vision extraction. Split or resize this document.');
}

/** Download only the authenticated original; verify its bytes before deriving page images. */
export async function openVisionRenderer(source: ShipmentDocument, signal?: AbortSignal): Promise<VisionRenderer> {
  throwIfAborted(signal);
  const response = await fetchWithSession(`/api/documents/${encodeURIComponent(source.id)}`, { signal });
  if (!response.ok) throw new Error('The original document could not be loaded.');
  if (Number(response.headers.get('content-length') || 0) > MAX_FILE_BYTES) throw new Error('The original document exceeds the 20 MB limit.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('The original document exceeds the 20 MB limit.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== source.sha256.toLowerCase()) throw new Error('The original document has changed. Reload it before extracting.');
  throwIfAborted(signal);
  if (source.mime === 'application/pdf') {
    const pdf = await openPdfRasterizer(bytes, signal);
    if (pdf.pageCount !== source.pages.length) { pdf.close(); throw new Error('The rendered PDF page count differs from the saved original. Reload the document.'); }
    return {
      async render(pageNumber) {
        throwIfAborted(signal);
        const raster = await pdf.render(pageNumber);
        throwIfAborted(signal);
        const canvas = document.createElement('canvas');
        try {
          canvas.width = raster.width;
          canvas.height = raster.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('The PDF page could not be rendered.');
          context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
          return { blob: await jpeg(canvas), width: canvas.width, height: canvas.height };
        } finally { canvas.width = 0; canvas.height = 0; }
      },
      async close() { pdf.close(); },
    };
  }
  const bitmap = await withIntakeTimeout(createImageBitmap(new Blob([bytes], { type: source.mime })), 20_000, 'The image could not be loaded.');
  return {
    async render(page) {
      throwIfAborted(signal);
      if (page !== 1) throw new Error('An image document only has one page.');
      const canvas = document.createElement('canvas');
      try {
        const scale = Math.min(1, VISION_IMAGE_LIMITS.maxDimension / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.min(VISION_IMAGE_LIMITS.maxDimension, Math.ceil(bitmap.width * scale));
        canvas.height = Math.min(VISION_IMAGE_LIMITS.maxDimension, Math.ceil(bitmap.height * scale));
        const context = canvas.getContext('2d'); if (!context) throw new Error('The image could not be rendered.');
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return { blob: await jpeg(canvas), width: canvas.width, height: canvas.height };
      } finally { canvas.width = 0; canvas.height = 0; }
    },
    async close() { bitmap.close(); },
  };
}

/** Commit each bounded batch and expose the new revision immediately, so a failed later batch is resumable. */
export async function runDocumentAi(options: {
  workspace: WorkspaceResponse;
  documentId: string;
  pages?: number[];
  status: ClientAiStatus;
  signal?: AbortSignal;
  onWorkspace?: (response: WorkspaceResponse) => void;
  onProgress?: (progress: AiProgress) => void;
}, dependencies: { fetch?: typeof fetchWithSession; renderer?: typeof openVisionRenderer } = {}): Promise<{ workspace: WorkspaceResponse; added: number; rejected: number; processed: number }> {
  const request = dependencies.fetch || fetchWithSession;
  let workspace = options.workspace;
  const source = workspace.state.documents.find(document => document.id === options.documentId && document.active);
  if (!source || source.referenceOnly) throw new Error('Choose an active shipment document.');
  if (!options.status.configured) throw new Error('An administrator must configure the AI document reader on the server.');
  const visual = canRenderVisionDocument(source);
  if (visual && options.status.visionSupported === false) throw new Error('The configured AI model does not support vision. An administrator must select a vision model.');
  const selected = options.pages ?? source.pages.filter(page => sourcePageNeedsKimi(workspace.state, source, page)).map(page => page.page);
  if (!selected.length) return { workspace, added: 0, rejected: 0, processed: 0 };
  const batches = buildAiBatches(source.pages, selected, options.status.limits, visual);
  let renderer: VisionRenderer | undefined; let added = 0; let rejected = 0; let processed = 0;
  const parse = async (response: Response): Promise<AiResponse> => {
    let body: AiResponse;
    try { body = await response.json() as AiResponse; } catch { throw new AiPipelineError(`Extraction returned HTTP ${response.status}. Saved batches are preserved.`, response.status); }
    if (!response.ok) throw new AiPipelineError(body.error || 'Extraction could not finish. Saved batches are preserved.', response.status, body.state ? body : undefined);
    return body;
  };
  try {
    if (visual) renderer = await (dependencies.renderer || openVisionRenderer)(source, options.signal);
    for (const pages of batches) {
      throwIfAborted(options.signal);
      const current = workspace.state.documents.find(document => document.id === source.id && document.active && document.version === source.version && document.sha256 === source.sha256);
      if (!current) throw new Error('The document changed during extraction. Reload it before continuing.');
      const visionPages: { page: number; imageSha256: string }[] = [];
      if (renderer) for (const page of pages) {
        throwIfAborted(options.signal);
        options.onProgress?.({ documentName: source.name, stage: 'rendering', page, completed: processed, total: selected.length });
        const raster = await renderer.render(page);
        throwIfAborted(options.signal);
        const form = new FormData();
        for (const [key, value] of Object.entries({ revision: workspace.state.revision, caseId: current.caseId, documentId: current.id, documentVersion: current.version, sha256: current.sha256, page, width: raster.width, height: raster.height })) form.set(key, String(value));
        form.set('image', raster.blob, `page-${page}.jpg`);
        // Do not abort mutations: obtain their result before honoring a stop request.
        const imageResponse = await parse(await request('/api/ai/vision-page', { method: 'POST', body: form })) as AiResponse & { imageSha256?: string };
        if (!imageResponse.imageSha256 || !/^[a-f0-9]{64}$/.test(imageResponse.imageSha256)) throw new Error('The server did not verify the rendered page. No extraction request was sent.');
        visionPages.push({ page, imageSha256: imageResponse.imageSha256 });
      }
      throwIfAborted(options.signal);
      options.onProgress?.({ documentName: source.name, stage: 'extracting', page: pages[0], completed: processed, total: selected.length });
      const body = await parse(await request('/api/ai/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: workspace.state.revision, caseId: current.caseId, documentId: current.id, pages, ...(visionPages.length ? { visionPages } : {}), consent: true }) }));
      workspace = body; added += body.ai?.added || 0; rejected += body.ai?.rejected || 0; processed += pages.length;
      options.onWorkspace?.(workspace);
    }
    return { workspace, added, rejected, processed };
  } finally { await renderer?.close(); }
}
