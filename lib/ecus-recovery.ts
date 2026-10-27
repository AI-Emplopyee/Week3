import { EcusTransferError, type EcusDevice, type EcusJob } from './ecus-job-store.ts';
import type { Actor, WorkspaceState } from './types.ts';

export type EcusResolution = {
  id: string; job_id: string; workspace_id: string; payload_hash: string;
  disposition: 'no_draft' | 'draft_kept'; actor_id: string; actor_name: string;
  reason: string; created_at: number; draft_reference: string | null;
  device_ack_at: number | null; ack_method: string | null;
};
export type EcusResolutionInput = { jobId: string; disposition: 'no_draft' | 'draft_kept'; reason: string; confirmed: true; draftReference?: string };
export type EcusRecoverySyncInput = { jobIds: string[]; acknowledgements: Array<{ jobId: string; resolutionId: string; payloadHash: string }> };

const currentDevice = `EXISTS (SELECT 1 FROM ecus_devices d WHERE d.id = ? AND d.workspace_id = ? AND d.token_hash = ? AND d.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = d.workspace_id AND m.user_id = d.created_by AND m.role = 'owner'))`;
const memberExists = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)`;

export async function getEcusResolution(db: D1Database, workspaceId: string, jobId: string) {
  return db.prepare('SELECT * FROM ecus_job_resolutions WHERE workspace_id = ? AND job_id = ?').bind(workspaceId, jobId).first<EcusResolution>();
}

/** A revoked key plus an expired lease fences the former worker. The employee's
 * inspection remains required; only the subsequent device acknowledgement is waived. */
export async function acknowledgeFencedEcusResolutions(db: D1Database, workspaceId: string, now = Date.now()) {
  await db.prepare(`UPDATE ecus_job_resolutions SET device_ack_at = ?, ack_method = 'fenced'
    WHERE workspace_id = ? AND device_ack_at IS NULL AND EXISTS (
      SELECT 1 FROM ecus_export_jobs j JOIN ecus_devices d ON d.id = j.device_id
      WHERE j.id = ecus_job_resolutions.job_id AND j.workspace_id = ecus_job_resolutions.workspace_id
        AND j.payload_hash = ecus_job_resolutions.payload_hash AND d.revoked_at IS NOT NULL
        AND (j.lease_until IS NULL OR j.lease_until <= ?))`).bind(now, workspaceId, now).run();
}

/** Record an employee decision; never rewrite the original result or queue work. */
export async function reconcileEcusJob(db: D1Database, state: WorkspaceState, actor: Actor, input: EcusResolutionInput, now = Date.now()): Promise<EcusJob> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const reference = typeof input.draftReference === 'string' ? input.draftReference.trim() : '';
  if (input.confirmed !== true || !['no_draft', 'draft_kept'].includes(input.disposition) || reason.length < 10 || reason.length > 2000
    || reference.length > 160 || /[\u0000-\u001f\u007f]/.test(reference) || (input.disposition === 'draft_kept' && !reference)) {
    throw new EcusTransferError(422, 'Confirm your ECUS inspection, provide a reason of 10–2000 characters, and identify any retained draft.');
  }
  const job = await db.prepare(`SELECT * FROM ecus_export_jobs WHERE id = ? AND workspace_id = ? AND ${memberExists}`)
    .bind(input.jobId, state.id, state.id, actor.id).first<EcusJob>();
  if (!job) throw new EcusTransferError(404, 'Transfer not found in this workspace.');
  if (!['failed', 'cancelled', 'needs_reconciliation'].includes(job.status)) throw new EcusTransferError(409, 'Only failed or interrupted transfers can be reconciled.');
  // A terminal authenticated callback proves the helper finished. A timeout or
  // revocation by itself cannot prove an unexpired native operation has stopped.
  if (job.lease_until && job.lease_until > now && !job.result_json) {
    throw new EcusTransferError(409, 'The Windows helper may still be working. Wait for its result or lease expiry before recording recovery.');
  }
  const device = await db.prepare('SELECT revoked_at FROM ecus_devices WHERE id = ? AND workspace_id = ?').bind(job.device_id, state.id).first<{ revoked_at: number | null }>();
  const prewrite = job.claimed_at === null || (job.status === 'failed' && !!job.result_json);
  const fenced = device?.revoked_at != null && (job.lease_until === null || job.lease_until <= now);
  const acknowledged = prewrite || fenced;
  const draftReference = input.disposition === 'draft_kept' ? reference : null;
  const id = `ecus_resolution_${crypto.randomUUID()}`;
  await db.prepare(`INSERT OR IGNORE INTO ecus_job_resolutions
    (id, job_id, workspace_id, payload_hash, disposition, actor_id, actor_name, reason, created_at, draft_reference, device_ack_at, ack_method)
    SELECT ?, j.id, j.workspace_id, j.payload_hash, ?, ?, ?, ?, ?, ?, ?, ? FROM ecus_export_jobs j
    WHERE j.id = ? AND j.workspace_id = ? AND j.payload_hash = ? AND j.status IN ('failed', 'cancelled', 'needs_reconciliation')
      AND (j.lease_until IS NULL OR j.lease_until <= ? OR j.result_json IS NOT NULL)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND revision = ?) AND ${memberExists}`)
    .bind(id, input.disposition, actor.id, actor.name, reason, now, draftReference, acknowledged ? now : null,
      prewrite ? 'not_written' : fenced ? 'fenced' : null, job.id, state.id, job.payload_hash, now, state.id, state.revision, state.id, actor.id).run();
  const saved = await db.prepare(`SELECT * FROM ecus_job_resolutions WHERE job_id = ? AND workspace_id = ?
    AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND revision = ?) AND ${memberExists}`)
    .bind(job.id, state.id, state.id, state.revision, state.id, actor.id).first<EcusResolution>();
  if (!saved) throw new EcusTransferError(409, 'Workspace access or the transfer changed. Reload before recording recovery.');
  if (saved.disposition !== input.disposition || saved.reason !== reason || saved.draft_reference !== draftReference) {
    throw new EcusTransferError(409, 'Another recovery decision is already recorded. Decisions cannot be overwritten.');
  }
  await acknowledgeFencedEcusResolutions(db, state.id, now);
  return job;
}

/** The original computer must durably fence its journal before acknowledging.
 * Scope both reads and writes to its current pairing; never accept a browser ACK. */
export async function syncEcusRecovery(db: D1Database, device: EcusDevice, input: EcusRecoverySyncInput, now = Date.now()) {
  if (!Array.isArray(input.jobIds) || input.jobIds.length > 100 || !Array.isArray(input.acknowledgements) || input.acknowledgements.length > 100
    || input.jobIds.some(id => typeof id !== 'string' || !id || id.length > 160)
    || input.acknowledgements.some(ack => !ack || [ack.jobId, ack.resolutionId, ack.payloadHash].some(value => typeof value !== 'string' || !value || value.length > 160))) {
    throw new EcusTransferError(422, 'Invalid recovery synchronization.');
  }
  const identity = [device.id, device.workspace_id, device.token_hash];
  if (!await db.prepare(`SELECT 1 WHERE ${currentDevice}`).bind(...identity).first()) throw new EcusTransferError(401, 'The ECUS computer is no longer paired.');
  const acknowledgedResolutionIds: string[] = [];
  for (const ack of input.acknowledgements) {
    const saved = await db.prepare(`UPDATE ecus_job_resolutions SET device_ack_at = COALESCE(device_ack_at, ?), ack_method = COALESCE(ack_method, 'helper')
      WHERE id = ? AND job_id = ? AND workspace_id = ? AND payload_hash = ? AND ${currentDevice}
        AND EXISTS (SELECT 1 FROM ecus_export_jobs j WHERE j.id = ecus_job_resolutions.job_id AND j.device_id = ? AND j.workspace_id = ? AND j.payload_hash = ecus_job_resolutions.payload_hash)
      RETURNING id`).bind(now, ack.resolutionId, ack.jobId, device.workspace_id, ack.payloadHash, ...identity, device.id, device.workspace_id).first<{ id: string }>();
    if (saved) acknowledgedResolutionIds.push(saved.id);
  }
  const ids = [...new Set([...input.jobIds, ...input.acknowledgements.map(item => item.jobId)])];
  const rows = ids.length ? await db.prepare(`SELECT r.* FROM ecus_job_resolutions r JOIN ecus_export_jobs j ON j.id = r.job_id
    WHERE r.workspace_id = ? AND j.workspace_id = ? AND j.device_id = ? AND r.payload_hash = j.payload_hash
      AND j.id IN (${ids.map(() => '?').join(',')}) AND ${currentDevice}`)
    .bind(device.workspace_id, device.workspace_id, device.id, ...ids, ...identity).all<EcusResolution>() : { results: [] };
  return { resolutions: rows.results.map(row => ({ id: row.id, jobId: row.job_id, payloadHash: row.payload_hash, disposition: row.disposition,
    actorName: row.actor_name, reason: row.reason, createdAt: new Date(row.created_at).toISOString() })), acknowledgedResolutionIds };
}
