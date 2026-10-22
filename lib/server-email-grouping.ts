import { documentAiConfiguration } from '@/lib/ai-provider';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/auth-persistence';
import { EMAIL_SHIPMENT_AI_LIMITS, emailMatchingInputFingerprint, planEmailShipmentMatches } from '@/lib/email-shipment-ai';
import { isEmailMatchCurrent } from '@/lib/email-grouping';
import { initializeDeclarationDrafts } from '@/lib/engine';
import { readWorkspaceState } from '@/lib/server-persistence';
import { KimiError, kimiStatus, KIMI_LIMITS } from '@/lib/kimi';
import { ApiError, expectRevision, mutate, readJson, requireSameOrigin, workspace, type WorkspaceContext } from '@/lib/server';

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const schema = z.object({ revision: z.number().int().nonnegative(), emailIds: z.array(id).min(1).max(200).optional() }).strict();

export async function matchEmailsInContext(context: WorkspaceContext, requestedIds: string[]) {
  const emailIds = [...new Set(requestedIds)];
  if (!emailIds.length || emailIds.some(id => !context.state.emails.some(email => email.id === id))) throw new ApiError(400, 'Select stored emails in this workspace.');
  const config = documentAiConfiguration(env);
  if (!kimiStatus(config).configured) throw new ApiError(503, 'An administrator must configure GLM-5.3-Flash on the server before matching emails.');
  if (!await consumeRateLimit(context.db, `kimi-extract:${context.state.id}`, KIMI_LIMITS.requestsPerMinute, 60)) throw new ApiError(429, 'The AI request limit was reached. Saved emails are safe; resume matching in one minute.');
  try {
    const selected = emailIds.slice(0, EMAIL_SHIPMENT_AI_LIMITS.maxEmails);
    const fingerprint = await emailMatchingInputFingerprint(context.state, selected);
    const plan = await planEmailShipmentMatches(config, context.state, selected);
    let saved;
    for (let attempt = 0; attempt < 8; attempt++) {
      const latest = await readWorkspaceState(context.db, context.state.id, context.actor.id);
      if (!latest) throw new ApiError(403, 'Workspace membership is required.');
      context.state = initializeDeclarationDrafts(latest);
      if (await emailMatchingInputFingerprint(context.state, selected) !== fingerprint) throw new ApiError(409, 'Email or shipment evidence changed during matching. The outdated match was not saved.');
      try { saved = await mutate(context, context.state.revision, { type: 'apply_email_matches', emailIds: plan.emailIds, matches: plan.matches, model: plan.model, truncated: plan.truncated }); break; }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 409 || attempt === 7) throw error; }
    }
    if (!saved) throw new ApiError(409, 'Email matches could not be saved while the workspace was changing.');
    return { ...saved, grouping: { processedIds: plan.emailIds, omittedEmailIds: [...plan.omittedEmailIds, ...emailIds.slice(selected.length)], truncated: plan.truncated, rejected: plan.rejected, matched: plan.matches.filter(match => match.decision === 'link').length, needsReview: plan.matches.filter(match => match.decision === 'review').length } };
  } catch (error) {
    if (error instanceof KimiError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

export async function requestEmailGrouping(request: Request) {
  requireSameOrigin(request);
  const context = await workspace(request);
  const input = schema.parse(await readJson(request));
  expectRevision(context, input.revision);
  const pending = context.state.emails.filter(email => email.aiGroupingStatus !== 'complete' || email.shipmentMatches?.some(match => match.status !== 'rejected' && !isEmailMatchCurrent(context.state, match)));
  const selected = input.emailIds ?? [...(pending.length ? pending : context.state.emails)].sort((a, b) => (a.aiGroupedAt ?? '').localeCompare(b.aiGroupedAt ?? '')).map(email => email.id);
  if (!selected.length) throw new ApiError(422, 'Import an email before matching it to a shipment.');
  // The planner reports omissions; it never implies this bounded call checked an entire inbox.
  return matchEmailsInContext(context, selected);
}
