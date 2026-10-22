import { throwIfAborted } from './client-intake-utils.ts';
import type { PdfRaster } from './pdf-raster.ts';

type RasterReply = { id: number; pageCount?: number; raster?: PdfRaster; error?: string };
type RasterRequest = { type: 'open'; bytes: ArrayBuffer; wasmUrl: string } | { type: 'render'; page: number };

/** The self-hosted renderer returns pixels for preview or AI reading, never extracted PDF text. */
export async function openPdfRasterizer(bytes: ArrayBuffer, signal?: AbortSignal, dependencies: { worker?: () => Worker; maxPages?: number } = {}): Promise<{ pageCount: number; render: (page: number) => Promise<PdfRaster>; close: () => void }> {
  throwIfAborted(signal);
  const maxPages = dependencies.maxPages ?? 50;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('Invalid PDF page limit.');
  // The explicit Vite worker import also survives the RSC transform, which may
  // replace import.meta.url with a file: URL in otherwise shared client modules.
  const worker = dependencies.worker
    ? dependencies.worker()
    : new (await import('./pdf-raster-worker.ts?worker')).default();
  let nextId = 0;
  let closed = false;
  let rejectPending: ((error: Error) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    worker.terminate();
    signal?.removeEventListener('abort', abort);
    rejectPending?.(new Error('The PDF renderer was closed.'));
  };
  const abort = () => {
    rejectPending?.(new DOMException('Đã hủy tiếp nhận.', 'AbortError'));
    close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  async function request(message: RasterRequest, transfer: Transferable[] = []): Promise<RasterReply> {
    throwIfAborted(signal);
    if (closed) throw new Error('The PDF renderer was closed.');
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error('Rendering the PDF page timed out.')); close(); }, 30_000);
      const finish = (error?: Error, reply?: RasterReply) => {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        rejectPending = undefined;
        if (error) reject(error); else resolve(reply!);
      };
      rejectPending = error => finish(error);
      worker.onmessage = (event: MessageEvent<RasterReply>) => {
        if (event.data.id !== id) return;
        finish(event.data.error ? new Error(event.data.error) : undefined, event.data);
      };
      worker.onerror = () => { finish(new Error('The PDF page renderer could not start.')); close(); };
      worker.postMessage({ ...message, id }, transfer);
    });
  }
  try {
    const reply = await request({ type: 'open', bytes, wasmUrl: new URL('/pdfium/pdfium.wasm', window.location.origin).href }, [bytes]);
    if (!Number.isInteger(reply.pageCount) || reply.pageCount! < 1 || reply.pageCount! > maxPages) throw new Error(`PDF documents are limited to ${maxPages} pages. Split this document before extraction.`);
    return {
      pageCount: reply.pageCount!,
      async render(page) {
        const reply = await request({ type: 'render', page });
        if (!reply.raster) throw new Error('The PDF renderer did not return page pixels.');
        return reply.raster;
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
