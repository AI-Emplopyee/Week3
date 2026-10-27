import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { consumeRateLimit } from './auth-persistence';
import { authenticateEcusDevice, claimEcusExport, createEcusDevice, enqueueEcusExport, finishEcusExport, publicEcusJob, revokeEcusDevice, ecusSourceFingerprint, EcusTransferError, ECUS_DEVICE_FRESHNESS, type EcusDevice, type EcusJob } from './ecus-job-store';
import { getEcusDraft, saveEcusDraft } from './ecus-draft-store';
import { acknowledgeFencedEcusResolutions, getEcusResolution, reconcileEcusJob, syncEcusRecovery, type EcusResolution } from './ecus-recovery';
import { parseEcusExportForm } from './ecus-export';
import { ApiError, expectRevision, json, readJson, requireSameOrigin, workspace, type WorkspaceContext } from './server';
import { runtimeAuthMode } from './server-auth';

const id = z.string().min(1).max(160);
const companionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('poll'), ready: z.boolean(), profileId: z.string().max(160) }).strict(),
  z.object({ action: z.literal('result'), jobId: id, leaseToken: z.string().uuid(), status: z.enum(['succeeded', 'failed', 'needs_reconciliation']), draftReference: z.string().min(1).max(160).optional(), readback: z.unknown().optional(), message: z.string().max(1000) }).strict(),
  z.object({ action: z.literal('recovery_sync'), jobIds: z.array(id).max(100), acknowledgements: z.array(z.object({ jobId: id, resolutionId: id, payloadHash: z.string().length(64) }).strict()).max(100) }).strict(),
]);

/** Domain errors get a useful client status without exposing database exceptions. */
export async function ecusRequest(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); }
  catch (error) { if (error instanceof EcusTransferError) throw new ApiError(error.status, error.message); throw error; }
}

export async function ecusStatus(request: Request) {
  const context = await workspace(request);
  const caseId = new URL(request.url).searchParams.get('caseId');
  if (caseId && !context.state.cases.some(item => item.id === caseId)) throw new ApiError(404, 'Shipment not found.');
  // Expiry must become visible even when an interrupted Windows helper never polls again.
  const now = Date.now();
  await context.db.batch([
    context.db.prepare("UPDATE ecus_export_jobs SET status = 'needs_reconciliation', finished_at = ?, message = 'Transfer interrupted. Inspect ECUS; automatic recreation is disabled.' WHERE workspace_id = ? AND status = 'running' AND lease_until < ?").bind(now, context.state.id, now),
    context.db.prepare("UPDATE ecus_export_jobs SET status = 'cancelled', finished_at = ?, message = 'Queued approval expired. No ECUS transfer was started.' WHERE workspace_id = ? AND status = 'queued' AND expires_at < ?").bind(now, context.state.id, now),
  ]);
  await acknowledgeFencedEcusResolutions(context.db, context.state.id, now);
  const devices = await context.db.prepare('SELECT * FROM ecus_devices WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at').bind(context.state.id).all<EcusDevice>();
  const jobs = caseId ? await context.db.prepare('SELECT * FROM ecus_export_jobs WHERE workspace_id = ? AND case_id = ? ORDER BY rowid DESC LIMIT 20').bind(context.state.id, caseId).all<EcusJob>() : { results: [] };
  const resolutions = caseId ? await context.db.prepare('SELECT r.* FROM ecus_job_resolutions r JOIN ecus_export_jobs j ON j.id = r.job_id WHERE r.workspace_id = ? AND j.case_id = ?').bind(context.state.id, caseId).all<EcusResolution>() : { results: [] };
  const resolved = new Map(resolutions.results.map(item => [item.job_id, item]));
  return json({ devices: devices.results.map(device => ({ id: device.id, label: device.label, lastSeen: device.last_seen, ready: device.ready === 1 && device.last_seen >= Date.now() - ECUS_DEVICE_FRESHNESS, profileId: device.profile_id })),
    jobs: jobs.results.map(job => publicEcusJob(job, true, resolved.get(job.id) ?? null)) });
}

async function draftResponse(context: WorkspaceContext, caseId: string) {
  const sourceFingerprint = await ecusSourceFingerprint(context.state, caseId);
  const draft = await getEcusDraft(context.db, context.state.id, caseId, context.actor.id);
  return { draft: draft ? { ...draft, sourceChanged: draft.sourceFingerprint !== sourceFingerprint } : null,
    sourceFingerprint, workspaceRevision: context.state.revision };
}

export async function ecusDraft(request: Request) {
  if (request.method !== 'GET') requireSameOrigin(request);
  const context = await workspace(request);
  if (request.method === 'GET') {
    const caseId = id.parse(new URL(request.url).searchParams.get('caseId'));
    return json(await draftResponse(context, caseId));
  }
  const input = z.object({ caseId: id, revision: z.number().int().nonnegative(), draftRevision: z.number().int().nonnegative(), form: z.unknown(), sourceConfirmed: z.boolean().optional() }).strict().parse(await readJson(request));
  try {
    expectRevision(context, input.revision);
    const current = await draftResponse(context, input.caseId);
    if (current.draft?.sourceChanged && input.sourceConfirmed !== true) throw new EcusTransferError(409, 'Shipment evidence changed. Review the form against the current documents before saving.');
    const draft = await saveEcusDraft(context.db, context.state, context.actor, input.caseId, input.draftRevision, input.form);
    return json({ draft: { ...draft, sourceChanged: false }, sourceFingerprint: current.sourceFingerprint, workspaceRevision: context.state.revision });
  } catch (error) {
    if ((error instanceof EcusTransferError || error instanceof ApiError) && error.status === 409) {
      const current = await workspace(request);
      return json({ error: error.message, ...await draftResponse(current, input.caseId) }, 409);
    }
    throw error;
  }
}

export async function ecusReconcile(request: Request) {
  requireSameOrigin(request);
  const context = await workspace(request);
  const input = z.object({ jobId: id, disposition: z.enum(['no_draft', 'draft_kept']), reason: z.string().trim().min(10).max(2000),
    confirmed: z.literal(true), draftReference: z.string().trim().max(160).optional() }).strict().parse(await readJson(request));
  const job = await reconcileEcusJob(context.db, context.state, context.actor, input);
  return json({ job: publicEcusJob(job, true, await getEcusResolution(context.db, context.state.id, job.id)) });
}

export async function ecusDevices(request: Request) {
  requireSameOrigin(request);
  const context = await workspace(request);
  if (context.role !== 'owner') throw new ApiError(403, 'Only the workspace owner can connect or disconnect ECUS computers.');
  const input = await readJson(request);
  if (request.method === 'DELETE') {
    const { deviceId } = z.object({ deviceId: id }).strict().parse(input);
    await revokeEcusDevice(context.db, context.state.id, deviceId);
    return json({ disconnected: true });
  }
  const { label } = z.object({ label: z.string().trim().min(1).max(100) }).strict().parse(input);
  if (!await consumeRateLimit(context.db, `ecus-pair:${context.state.id}`, 10, 3600)) throw new ApiError(429, 'Too many computers paired. Try again later.');
  return json(await createEcusDevice(context.db, context.state.id, context.actor.id, label), 201);
}

export async function submitEcusExport(request: Request) {
  requireSameOrigin(request);
  const context = await workspace(request);
  const input = z.object({ revision: z.number().int().nonnegative(), draftRevision: z.number().int().positive(), caseId: id, deviceId: id, confirmed: z.literal(true), form: z.unknown() }).strict().parse(await readJson(request));
  expectRevision(context, input.revision);
  let form;
  try { form = parseEcusExportForm(input.form); }
  catch (error) { throw new ApiError(422, error instanceof Error ? error.message : 'Invalid export form.'); }
  try {
    const job = await enqueueEcusExport(context.db, context.state, context.actor, input.deviceId, input.caseId, form, Date.now(), input.draftRevision);
    return json({ job: publicEcusJob(job, true, await getEcusResolution(context.db, context.state.id, job.id)) }, 202);
  } catch (error) {
    if (error instanceof EcusTransferError) throw error;
    // Form validation has no private database details; keep unexpected failures generic.
    throw new ApiError(422, 'The export form could not be submitted. Complete the required fields and reload if the shipment changed.');
  }
}

export async function ecusCompanion(request: Request) {
  // Do not call workspace(): a paired native computer uses its own scoped key, not browser cookies.
  const mode = runtimeAuthMode();
  if (!['local', 'supabase'].includes(mode)) throw new ApiError(503, 'Configure application authentication before connecting ECUS.');
  if (!env.DB) throw new ApiError(503, 'ECUS transfer storage is unavailable.');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, 'Cross-origin companion requests are not allowed.');
  const device = await authenticateEcusDevice(env.DB, request.headers.get('authorization'));
  if (!await consumeRateLimit(env.DB, `ecus-device:${device.id}`, 60, 60)) throw new ApiError(429, 'Poll the ECUS queue less frequently.');
  const input = companionInput.parse(await readJson(request));
  if (input.action === 'poll') return json({ job: await claimEcusExport(env.DB, device, input.ready, input.profileId) });
  if (input.action === 'recovery_sync') return json(await syncEcusRecovery(env.DB, device, input));
  let readback;
  let resultStatus = input.status;
  let resultMessage = input.message;
  if (input.readback !== undefined) {
    try { readback = parseEcusExportForm(input.readback); }
    catch {
      resultStatus = 'needs_reconciliation';
      resultMessage = 'The ECUS readback contains unsupported fields or values. Inspect the saved draft.';
    }
  }
  return json({ job: publicEcusJob(await finishEcusExport(env.DB, device, { ...input, status: resultStatus, message: resultMessage, readback })) });
}
