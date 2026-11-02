import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWorkspace } from '../lib/engine.ts';
import { AiPipelineError, buildAiBatches, openVisionRenderer, runDocumentAi, type ClientAiStatus, type VisionRenderer } from '../lib/client-vision.ts';
import type { ShipmentDocument, WorkspaceResponse } from '../lib/types.ts';

const status: ClientAiStatus = { configured: true, visionSupported: true, model: 'kimi-k2.6', endpoint: 'https://api.moonshot.ai/v1', provider: 'Moonshot', limits: { maxPages: 2, maxTextCharacters: 100, maxCandidates: 100 } };
const source = (count = 7): ShipmentDocument => ({ id: 'doc-client-test', caseId: 'case-client-test', name: 'scan.pdf', mime: 'application/pdf', size: 100, sha256: 'a'.repeat(64), version: 2, active: true, uploadedAt: '', pages: Array.from({ length: count }, (_, index) => ({ page: index + 1, text: '' })), extractionStatus: 'needs_transcription', synthetic: true, type: 'invoice' });
const workspace = (document = source()): WorkspaceResponse => ({ state: { ...createEmptyWorkspace('ws-test'), revision: 12, documents: [document] }, actor: { id: 'test', name: 'Test', email: 'test@example.invalid' }, role: 'owner', issues: [] });
const hash = (page: number) => String(page).repeat(64);
function rasterHarness() {
  const rendered: number[] = []; let closes = 0;
  const renderer = async (): Promise<VisionRenderer> => ({ render: async page => { rendered.push(page); return { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), width: 1000, height: 1400 }; }, close: async () => { closes++; } });
  return { renderer, rendered, get closes() { return closes; } };
}

test('vision batching includes every page and ignores legacy text while text-only input stays bounded', () => {
  const pages = source(50).pages;
  const batches = buildAiBatches(pages, pages.map(page => page.page), { ...status.limits, maxPages: 5 }, true);
  assert.equal(batches.length, 50); assert.ok(batches.every(batch => batch.length === 1)); assert.deepEqual(batches.flat(), pages.map(page => page.page));
  assert.throws(() => buildAiBatches(pages, [1], status.limits, false), /no readable text/);
  assert.throws(() => buildAiBatches(pages, [1, 1], status.limits, true), /Invalid/);
  assert.throws(() => buildAiBatches(pages, [51], status.limits, true), /no longer exist/);
  assert.throws(() => buildAiBatches([{ page: 1, text: 'x'.repeat(101) }], [1], status.limits, false), /exceeds/);
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(101) }], [1], status.limits, true), [[1]]);
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(80), pdfText: 'y'.repeat(21) }], [1], status.limits, true), [[1]]);
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(20), pdfText: 'y'.repeat(40) }, { page: 2, text: 'z'.repeat(41) }], [1, 2], status.limits, true), [[1], [2]]);
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(20) }, { page: 2, text: 'z'.repeat(41) }], [1, 2], status.limits, false), [[1, 2]]);
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(70) }, { page: 2, text: 'y'.repeat(60) }], [2, 1], status.limits, false), [[1], [2]]);
});

test('browser pipeline rereads legacy coverage, binds image hashes, follows regrouping, and carries each saved revision', async () => {
  const legacy = source();
  let current = workspace({ ...legacy, aiStatus: 'completed', aiProcessedPages: legacy.pages.map(page => page.page) }); const savedRevisions: number[] = []; const batches: number[][] = []; const rasters = rasterHarness();
  const result = await runDocumentAi({ workspace: current, documentId: source().id, status, onWorkspace: value => savedRevisions.push(value.state.revision) }, {
    renderer: rasters.renderer,
    fetch: async (url, init) => {
      if (url === '/api/ai/vision-page') {
        assert.ok(init?.body instanceof FormData); const form = init.body;
        const page = Number(form.get('page'));
        assert.equal(form.get('revision'), String(current.state.revision)); assert.equal(form.get('caseId'), current.state.documents[0].caseId);
        assert.equal(form.get('sha256'), source().sha256); assert.equal(form.get('documentVersion'), '2'); assert.ok(form.get('image') instanceof Blob);
        return Response.json({ page, documentId: source().id, documentVersion: 2, imageSha256: hash(page) });
      }
      assert.equal(url, '/api/ai/extract'); const body = JSON.parse(String(init?.body));
      assert.equal(body.revision, current.state.revision); assert.equal(body.caseId, current.state.documents[0].caseId);
      assert.deepEqual(body.visionPages, body.pages.map((page: number) => ({ page, imageSha256: hash(page) }))); assert.equal(body.consent, true);
      assert.equal(body.apiKey, undefined); assert.equal(body.images, undefined); batches.push(body.pages);
      current = { ...current, state: { ...current.state, revision: current.state.revision + 1, documents: [{ ...current.state.documents[0], caseId: 'case-regrouped', extractionPipeline: 'kimi', pages: current.state.documents[0].pages.map(page => body.pages.includes(page.page) ? { ...page, textSource: 'kimi', aiReadability: 'clear' } : page), aiProcessedPages: [...(current.state.documents[0].aiProcessedPages || []), ...body.pages] }] } };
      return Response.json({ ...current, ai: { added: 1, rejected: 0, pages: body.pages } });
    },
  });
  assert.deepEqual(batches, [[1], [2], [3], [4], [5], [6], [7]]); assert.deepEqual(rasters.rendered, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(savedRevisions, [13, 14, 15, 16, 17, 18, 19]); assert.equal(result.processed, 7); assert.equal(result.added, 7); assert.equal(rasters.closes, 1);
});

test('Word sections use the text AI path without rendering or uploading images', async () => {
  const word: ShipmentDocument = {
    ...source(2), name: 'invoice.doc', mime: 'application/msword', extractionPipeline: 'kimi', extractionStatus: 'pending_ai',
    pages: [{ page: 1, text: 'Invoice number: TEST-DOC-2026', textSource: 'office' }, { page: 2, text: 'Total: USD 1,234.50', textSource: 'office' }],
  };
  const current = workspace(word); const calls: string[] = [];
  const result = await runDocumentAi({ workspace: current, documentId: word.id, status: { ...status, visionSupported: false } }, {
    renderer: async () => { throw new Error('Word text must not start a visual renderer.'); },
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(url, '/api/ai/extract');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.pages, [1, 2]);
      assert.equal(body.visionPages, undefined);
      assert.equal(body.text, undefined, 'The server reads its own saved text rather than a browser text claim.');
      return Response.json({ ...current, ai: { added: 0, rejected: 0, pages: body.pages } });
    },
  });
  assert.deepEqual(calls, ['/api/ai/extract']);
  assert.equal(result.processed, 2);
});

test('a rate-limited later batch preserves saved pages, closes the renderer, and resumes only the remainder', async () => {
  let current = workspace(source(4)); let extracts = 0; const firstRasters = rasterHarness();
  const request = async (url: string, init?: RequestInit) => {
    if (url === '/api/ai/vision-page') { const page = Number((init?.body as FormData).get('page')); return Response.json({ imageSha256: hash(page) }); }
    extracts++; if (extracts === 2) return Response.json({ error: 'Rate limit reached.' }, { status: 429 });
    const body = JSON.parse(String(init?.body)); current = { ...current, state: { ...current.state, revision: current.state.revision + 1, documents: [{ ...current.state.documents[0], extractionPipeline: 'kimi', pages: current.state.documents[0].pages.map(page => body.pages.includes(page.page) ? { ...page, textSource: 'kimi', aiReadability: 'clear' } : page), aiProcessedPages: [...(current.state.documents[0].aiProcessedPages || []), ...body.pages] }] } };
    return Response.json({ ...current, ai: { added: 0, rejected: 0, pages: body.pages } });
  };
  let lastInstalled: WorkspaceResponse | undefined;
  await assert.rejects(runDocumentAi({ workspace: current, documentId: source().id, status, onWorkspace: response => { lastInstalled = response; } }, { renderer: firstRasters.renderer, fetch: request }), error => error instanceof AiPipelineError && error.status === 429);
  assert.equal(extracts, 2); assert.equal(firstRasters.closes, 1); assert.deepEqual(lastInstalled?.state.documents[0].aiProcessedPages, [1]);
  const secondRasters = rasterHarness();
  const result = await runDocumentAi({ workspace: lastInstalled!, documentId: source().id, status }, { renderer: secondRasters.renderer, fetch: request });
  assert.deepEqual(secondRasters.rendered, [2, 3, 4]); assert.equal(result.processed, 3); assert.equal(extracts, 5);
});

test('stopping after a committed batch leaves that result installed and sends no next extraction', async () => {
  const controller = new AbortController(); const rasters = rasterHarness(); let extractCalls = 0;
  await assert.rejects(runDocumentAi({ workspace: workspace(), documentId: source().id, status, signal: controller.signal, onWorkspace: () => controller.abort() }, {
    renderer: rasters.renderer,
    fetch: async (url, init) => {
      if (url === '/api/ai/vision-page') return Response.json({ imageSha256: hash(Number((init?.body as FormData).get('page'))) });
      extractCalls++; return Response.json({ ...workspace(), ai: { pages: [1] } });
    },
  }), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(extractCalls, 1); assert.equal(rasters.closes, 1); assert.deepEqual(rasters.rendered, [1]);
});

test('a new document extraction retries only rejected completed pages once', async () => {
  const original = source(3);
  const current = workspace({ ...original, extractionPipeline: 'kimi', extractionStatus: 'extracted', aiProcessedPages: [1, 2, 3], aiRejectedPages: [2], pages: original.pages.map(page => ({ ...page, aiReadability: 'clear' })) });
  const rasters = rasterHarness(); const requested: number[][] = [];
  const result = await runDocumentAi({ workspace: current, documentId: original.id, status }, { renderer: rasters.renderer, fetch: async (url, init) => {
    if (url === '/api/ai/vision-page') return Response.json({ imageSha256: hash(Number((init?.body as FormData).get('page'))) });
    const body = JSON.parse(String(init?.body)); requested.push(body.pages);
    return Response.json({ ...current, ai: { added: 0, rejected: 1, pages: body.pages } });
  } });
  assert.deepEqual(requested, [[2]]); assert.deepEqual(rasters.rendered, [2]);
  assert.equal(result.processed, 1); assert.equal(result.rejected, 1); assert.equal(rasters.closes, 1);
});

test('unverified image responses and unsupported configured models cannot initiate extraction', async () => {
  const rasters = rasterHarness(); const calls: string[] = [];
  await assert.rejects(runDocumentAi({ workspace: workspace(), documentId: source().id, status }, { renderer: rasters.renderer, fetch: async url => { calls.push(url); return Response.json({ imageSha256: 'unverified' }); } }), /did not verify/);
  assert.deepEqual(calls, ['/api/ai/vision-page']); assert.equal(rasters.closes, 1);
  await assert.rejects(runDocumentAi({ workspace: workspace(), documentId: source().id, status: { ...status, visionSupported: false } }), /does not support vision/);
  await assert.rejects(runDocumentAi({ workspace: workspace({ ...source(), referenceOnly: true }), documentId: source().id, status }), /active shipment document/);
});

test('the downloaded original must match its saved SHA before any PDF rendering', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('different original bytes');
    await assert.rejects(openVisionRenderer(source()), /original document has changed/);
  } finally { globalThis.fetch = previous; }
});

