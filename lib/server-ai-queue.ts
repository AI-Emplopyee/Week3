import { documentAiConfiguration } from '@/lib/ai-provider';
import { z } from 'zod';
import { env } from 'cloudflare:workers';
import { automaticDocuments, automaticPageNeedsKimi, claimAiJob, finishAiJob, enqueuePage, type AiJob, AUTOMATIC_CONCURRENCY } from '@/lib/ai-processing-queue';
import { emailMatchingInputFingerprint } from '@/lib/email-shipment-ai';
import { matchEmailsInContext } from '@/lib/server-email-grouping';
import type { WorkspaceContext } from '@/lib/server';
import { kimiStatus } from '@/lib/kimi';
import { ApiError, json, readJson, requireSameOrigin, workspace } from '@/lib/server';
import { runtimeAuthMode } from '@/lib/server-auth';

/** The local launcher polls this durable queue even when every browser tab is closed. */
export async function pendingAiJobs(request: Request) {
  requireSameOrigin(request);
  if (runtimeAuthMode() !== 'local') throw new ApiError(404, 'Local background processing is unavailable in this deployment.');
  const context = await workspace(request);
  const status = kimiStatus(documentAiConfiguration(env));
  if (!status.configured || env.AICD_BACKGROUND_PROCESSING !== '1') return json({ configured: false, jobs: [], concurrency: AUTOMATIC_CONCURRENCY });
  const input = z.object({ failure: z.object({ documentId: z.string().max(160), documentVersion: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().positive(), error: z.string().max(500) }).strict().optional() }).strict().parse(await readJson(request));
  const documents = automaticDocuments(context.state);
  if (input.failure) {
    const failure = input.failure;
    const document = documents.find(document => document.id === failure.documentId && document.version === failure.documentVersion && document.sha256 === failure.sha256 && document.pages.some(page => page.page === failure.page));
    if (document) {
      const token = await claimAiJob(context.db, context.state.id, document, failure.page);
      if (token) await finishAiJob(context.db, context.state.id, document, failure.page, token, 'failed', failure.error);
    }
    return json({ recorded: true });
  }
  for (const document of documents) for (const page of document.pages.filter(page => automaticPageNeedsKimi(context.state, document, page))) await enqueuePage(context.db, context.state.id, document, page.page);
  const { results } = await context.db.prepare('SELECT * FROM ai_processing_jobs WHERE workspace_id = ? ORDER BY attempts, page, document_id').bind(context.state.id).all<AiJob>();
  const now = Date.now();
  const jobs = results.filter(job => job.available_at <= now && (job.state === 'queued' || job.state === 'running' && job.lease_until <= now)).flatMap(job => {
    const document = documents.find(document => document.id === job.document_id && document.version === job.document_version && document.sha256 === job.sha256);
    const page = document?.pages.find(page => page.page === job.page);
    return document && page && automaticPageNeedsKimi(context.state, document, page) ? [{ document, page: job.page }] : [];
  });
  // One document at a time; two different originals may be read in parallel.
  const selected = jobs.filter((job, index) => jobs.findIndex(other => other.document.id === job.document.id) === index).slice(0, AUTOMATIC_CONCURRENCY);
  const awaitingPages = results.some(job => documents.some(document => document.id === job.document_id && document.version === job.document_version && document.sha256 === job.sha256 && document.pages.some(page => page.page === job.page && automaticPageNeedsKimi(context.state, document, page))) && ['queued', 'running'].includes(job.state));
  if (!selected.length && !awaitingPages) await matchOneBackgroundEmail(context);
  return json({ configured: true, revision: context.state.revision, jobs: selected, concurrency: AUTOMATIC_CONCURRENCY, recent: results.filter(job => job.started_at).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)).slice(0, 20) });
}

/** Read each unchanged email/evidence set once. Failed and no-match runs never spin. */
async function matchOneBackgroundEmail(context: WorkspaceContext) {
  const excluded = new Set(context.state.cases.filter(shipment => !!shipment.sourceCollection).flatMap(shipment => shipment.documentIds));
  for (const email of context.state.emails) {
    if (email.documentIds.length && email.documentIds.every(id => excluded.has(id))) continue;
    const identity = { id: `email-match_${email.id}`, version: 1, sha256: await emailMatchingInputFingerprint(context.state, [email.id]) };
    const token = await claimAiJob(context.db, context.state.id, identity, 0);
    if (!token) continue;
    try {
      await matchEmailsInContext(context, [email.id]);
      await finishAiJob(context.db, context.state.id, identity, 0, token, 'completed');
    } catch (error) {
      await finishAiJob(context.db, context.state.id, identity, 0, token, error instanceof ApiError && error.status === 429 ? 'queued' : 'failed', error instanceof Error ? error.message : 'Email matching failed.');
    }
    return;
  }
}
