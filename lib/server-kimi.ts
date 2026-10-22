import { documentAiConfiguration } from '@/lib/ai-provider';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/auth-persistence';
import { extractWithKimi, KIMI_LIMITS, KimiError, kimiRequestSchema, kimiStatus, selectKimiPages } from '@/lib/kimi';
import { ApiError, expectRevision, readJson, requireSameOrigin, response, workspace } from '@/lib/server';
import { runtimeAuthMode } from '@/lib/server-auth';
import { loadVisionPages } from '@/lib/server-vision';
import { emailMatchingInputFingerprint } from '@/lib/email-shipment-ai';
import { sourcePageNeedsKimi } from '@/lib/source-completeness';
import { isVisualDocument } from '@/lib/vision';
import { automaticDocuments, automaticPageNeedsKimi, claimAiJob, finishAiJob, JOB_IDENTITY, jobIdentity, type AiJob } from '@/lib/ai-processing-queue';
import { AiCommitError, saveAiResult } from '@/lib/ai-result-persistence';

function configuration() { return documentAiConfiguration(env); }
export async function getKimiStatus(request: Request) {
  const context = await workspace(request);
  const backgroundProcessing = runtimeAuthMode() === 'local' && ['0', '1'].includes(env.AICD_BACKGROUND_PROCESSING ?? '');
  let queue;
  if (backgroundProcessing) {
    const { results } = await context.db.prepare('SELECT * FROM ai_processing_jobs WHERE workspace_id = ?').bind(context.state.id).all<AiJob>();
    const liveCases = new Set(context.state.cases.filter(shipment => !shipment.mergedInto && shipment.status !== 'completed' && !shipment.sourceCollection).map(shipment => shipment.id));
    const current = results.filter(job => context.state.documents.some(document => document.id === job.document_id && document.version === job.document_version && document.sha256 === job.sha256 && document.active && !document.referenceOnly && liveCases.has(document.caseId)));
    const pendingDocuments = automaticDocuments(context.state);
    const pending = current.filter(job => pendingDocuments.some(document => document.id === job.document_id && document.pages.some(page => page.page === job.page && automaticPageNeedsKimi(context.state, document, page))));
    const emailFailures = await Promise.all(context.state.emails.map(async email => {
      const failed = results.filter(job => job.document_id === `email-match_${email.id}` && job.state === 'failed');
      if (!failed.length) return false;
      const fingerprint = await emailMatchingInputFingerprint(context.state, [email.id]);
      return failed.some(job => job.sha256 === fingerprint && (!email.aiGroupedAt || Date.parse(email.aiGroupedAt) <= (job.completed_at ?? 0)));
    }));
    const last = current.filter(job => job.state === 'completed' && job.elapsed_ms != null).sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))[0];
    queue = {
      running: pending.filter(job => job.state === 'running' && job.lease_until > Date.now()).length,
      queued: pending.filter(job => job.state === 'queued' || job.state === 'running' && job.lease_until <= Date.now()).length,
      failed: pending.filter(job => job.state === 'failed').length,
      needsReview: context.state.documents.filter(document => document.active && !document.referenceOnly && liveCases.has(document.caseId) && document.extractionPipeline === 'kimi').reduce((count, document) => count + document.pages.filter(page => document.aiProcessedPages?.includes(page.page) && (page.aiReadability === 'uncertain' || sourcePageNeedsKimi(context.state, document, page))).length, 0),
      emailMatchingFailed: emailFailures.filter(Boolean).length,
      recentDurationMs: last?.elapsed_ms ?? null,
      failures: pending.filter(job => job.state === 'failed').slice(0, 10).map(job => ({ documentId: job.document_id, page: job.page, error: job.error })),
    };
  }
  return { ...kimiStatus(configuration()), backgroundProcessing, backgroundPaused: env.AICD_BACKGROUND_PROCESSING === '0', ...(queue ? { queue } : {}) };
}

export async function requestKimiExtraction(request: Request) {
  requireSameOrigin(request);
  const context = await workspace(request);
  const input = kimiRequestSchema.extend({ automatic: z.boolean().optional(), documentVersion: z.number().int().positive().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(await readJson(request));
  if (!input.automatic) expectRevision(context, input.revision);
  if (input.automatic && (runtimeAuthMode() !== 'local' || env.AICD_BACKGROUND_PROCESSING !== '1')) throw new ApiError(403, 'Automatic processing requires the local launcher.');
  const document = context.state.documents.find(document => document.id === input.documentId && document.active && (input.automatic || document.caseId === input.caseId));
  const shipment = context.state.cases.find(shipment => shipment.id === document?.caseId && !shipment.mergedInto);
  if (!shipment || !document) throw new ApiError(404, 'Active document not found in this case.');
  if (document.referenceOnly) throw new ApiError(422, 'Reference-only documents cannot supply shipment AI proposals.');
  if (shipment.status === 'completed') throw new ApiError(422, 'Reopen this case before requesting AI proposals.');
  if (input.automatic && (input.documentVersion !== document.version || input.sha256 !== document.sha256 || input.pages?.length !== 1 || !document.pages.some(page => page.page === input.pages?.[0] && automaticPageNeedsKimi(context.state, document, page)) || !automaticDocuments(context.state).some(source => source.id === document.id))) throw new ApiError(409, 'This source is no longer pending in the automatic queue.');
  let lease: string | null = null;
  let firstPage = 0;
  try {
    const config = configuration();
    if (!kimiStatus(config).configured) throw new KimiError(503, 'Configure GLM-5.3-Flash with the server-side ZAI_API_KEY.');
    const references = input.visionPages ?? [];
    if (new Set(references.map(image => image.page)).size !== references.length) throw new ApiError(400, 'Use distinct source page images.');
    const pages = selectKimiPages(document, input.pages, references.map(image => image.page));
    if (references.some(image => !pages.some(page => page.page === image.page))) throw new ApiError(400, 'Images must belong to selected source pages.');
    if (isVisualDocument(document) && pages.some(page => !references.some(image => image.page === page.page))) throw new ApiError(422, 'Render every selected PDF or image page before vision extraction.');
    const images = await loadVisionPages(context.state.id, document, references);
    firstPage = pages[0].page;
    lease = await claimAiJob(context.db, context.state.id, document, firstPage, !input.automatic);
    if (!lease) throw new ApiError(423, 'This source is already being processed, or the two background workers are occupied.');
    if (!await consumeRateLimit(context.db, `kimi-extract:${context.state.id}`, KIMI_LIMITS.requestsPerMinute, 60)) throw new ApiError(429, 'This workspace has reached the AI request limit. The automatic queue will resume after one minute.');
    const result = await extractWithKimi(config, document, pages.map(page => page.page), { images, beforeRepair: () => consumeRateLimit(context.db, `kimi-extract:${context.state.id}`, KIMI_LIMITS.requestsPerMinute, 60) });
    // An expired/replaced reader cannot commit after a newer worker owns this page.
    const stillOwned = await context.db.prepare(`UPDATE ai_processing_jobs SET lease_until = ? WHERE ${JOB_IDENTITY} AND lease_token = ? AND state = 'running' AND lease_until > ? RETURNING lease_token`)
      .bind(Date.now() + 60_000, ...jobIdentity(context.state.id, document, firstPage), lease, Date.now()).first();
    if (!stillOwned) throw new ApiError(409, 'This reading lease expired before the result could be saved. A newer worker may already own the page.');
    const before = context.state.candidates.filter(candidate => candidate.documentId === document.id && candidate.documentVersion === document.version).length;
    context.state = await saveAiResult(context.db, context.state.id, context.actor, document, { type: 'add_ai_candidates', caseId: shipment.id, documentId: document.id, documentVersion: document.version, model: result.model, pages: result.pages, proposals: result.proposals, pageReadings: result.pageReadings, visionEvidence: images.map(({ page, imageSha256, width, height }) => ({ page, imageSha256, width, height })) });
    await finishAiJob(context.db, context.state.id, document, firstPage, lease, 'completed');
    return { ...response(context), ai: { added: Math.max(0, context.state.candidates.filter(candidate => candidate.documentId === document.id && candidate.documentVersion === document.version).length - before), rejected: result.rejected, rejectionDiagnostics: result.rejectionDiagnostics, model: result.model, documentId: document.id, pages: result.pages, ...(result.formatRepair ? { formatRepair: result.formatRepair } : {}) } };
  } catch (error) {
    const status = error instanceof KimiError || error instanceof ApiError || error instanceof AiCommitError ? error.status : 500;
    if (lease) await finishAiJob(context.db, context.state.id, document, firstPage, lease, status === 429 ? 'queued' : 'failed', error instanceof Error ? error.message : 'Extraction failed.').catch(() => undefined);
    if (error instanceof KimiError || error instanceof AiCommitError) throw new ApiError(error.status, error.message);
    throw error;
  }
}
