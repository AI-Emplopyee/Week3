import { hashAuthKey } from './auth-persistence.ts';
import { buildEcusExportPayload, compareEcusExportForms, parseEcusExportForm, type EcusExportForm, type EcusExportPayload } from './ecus-export.ts';
import { readWorkspaceState } from './server-persistence.ts';
import type { Actor, WorkspaceState } from './types.ts';
import type { EcusResolution } from './ecus-recovery.ts';

export const ECUS_JOB_LIFETIME = 24 * 60 * 60 * 1000;
export const ECUS_LEASE = 30 * 60 * 1000;
export const ECUS_DEVICE_FRESHNESS = 60 * 1000;
export type EcusDevice = { id: string; workspace_id: string; created_by: string; label: string; token_hash: string; created_at: number; revoked_at: number | null; last_seen: number; ready: number; profile_id: string };
export type EcusJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_reconciliation' | 'cancelled';
export type EcusJob = { id: string; workspace_id: string; device_id: string; case_id: string; approved_by: string; source_fingerprint: string; approval_hash: string; payload_json: string; payload_hash: string; status: EcusJobStatus; created_at: number; expires_at: number; claimed_at: number | null; lease_token: string | null; lease_until: number | null; finished_at: number | null; draft_reference: string | null; message: string; result_json: string | null; draft_revision: number | null; retry_of: string | null };
export class EcusTransferError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Recheck authority inside each mutating SQL statement. An authenticated request
// may be in flight when its pairing is revoked or its owner loses access.
const pairedOwnerExists = `EXISTS (SELECT 1 FROM workspace_members m
  WHERE m.workspace_id = d.workspace_id AND m.user_id = d.created_by AND m.role = 'owner')`;
const currentDeviceExists = `EXISTS (SELECT 1 FROM ecus_devices d
  WHERE d.id = ? AND d.workspace_id = ? AND d.token_hash = ? AND d.revoked_at IS NULL AND ${pairedOwnerExists})`;
const submissionAllowed = `EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ? AND w.revision = ?)
  AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
  AND EXISTS (SELECT 1 FROM ecus_devices d WHERE d.id = ? AND d.workspace_id = ?
    AND d.revoked_at IS NULL AND d.ready = 1 AND d.last_seen >= ? AND d.profile_id = ? AND d.profile_id <> '' AND ${pairedOwnerExists})`;

export async function ecusSourceFingerprint(state: WorkspaceState, caseId: string): Promise<string> {
  const shipment = state.cases.find(item => item.id === caseId);
  if (!shipment || shipment.caseType !== 'export' || shipment.mergedInto) throw new EcusTransferError(422, 'Select an export shipment before submitting an EDA draft.');
  return hashAuthKey(JSON.stringify({ shipment, documents: state.documents.filter(item => item.caseId === caseId && item.active) }));
}

export async function createEcusDevice(db: D1Database, workspaceId: string, actorId: string, label: string, now = Date.now()) {
  const id = `ecus_${crypto.randomUUID()}`;
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const token = `${id}.${secret}`;
  const result = await db.prepare(`INSERT INTO ecus_devices (id, workspace_id, created_by, label, token_hash, created_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner')`)
    .bind(id, workspaceId, actorId, label, await hashAuthKey(token), now, workspaceId, actorId).run();
  if (!result.meta.changes) throw new EcusTransferError(403, 'Only the workspace owner can pair a computer.');
  return { id, label, token };
}

export async function authenticateEcusDevice(db: D1Database, authorization: string | null): Promise<EcusDevice> {
  const match = /^Bearer (ecus_[a-f0-9-]{36}\.[a-f0-9]{64})$/.exec(authorization || '');
  if (!match) throw new EcusTransferError(401, 'A valid ECUS device key is required.');
  const id = match[1].split('.')[0];
  const device = await db.prepare(`SELECT d.* FROM ecus_devices d WHERE d.id = ? AND d.token_hash = ? AND d.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = d.workspace_id AND m.user_id = d.created_by AND m.role = 'owner')`)
    .bind(id, await hashAuthKey(match[1])).first<EcusDevice>();
  if (!device) throw new EcusTransferError(401, 'The ECUS device key is invalid or revoked.');
  return device;
}

export async function revokeEcusDevice(db: D1Database, workspaceId: string, deviceId: string, now = Date.now()) {
  await db.batch([
    db.prepare('UPDATE ecus_devices SET revoked_at = ?, ready = 0 WHERE id = ? AND workspace_id = ?').bind(now, deviceId, workspaceId),
    db.prepare("UPDATE ecus_export_jobs SET status = CASE WHEN status = 'running' THEN 'needs_reconciliation' ELSE 'cancelled' END, finished_at = ?, message = 'Computer disconnected. Inspect ECUS before repeating a transfer.' WHERE device_id = ? AND workspace_id = ? AND status IN ('queued', 'running')").bind(now, deviceId, workspaceId),
  ]);
}

export async function enqueueEcusExport(db: D1Database, state: WorkspaceState, actor: Actor, deviceId: string, caseId: string, form: EcusExportForm, now = Date.now(), expectedDraftRevision = 1): Promise<EcusJob> {
  const shipment = state.cases.find(item => item.id === caseId);
  if (!shipment || shipment.caseType !== 'export' || shipment.status === 'completed' || shipment.mergedInto) throw new EcusTransferError(422, 'An open export shipment is required. Import declarations cannot be sent to EDA.');
  const device = await db.prepare(`SELECT d.* FROM ecus_devices d WHERE d.id = ? AND d.workspace_id = ? AND d.revoked_at IS NULL AND ${pairedOwnerExists}`).bind(deviceId, state.id).first<EcusDevice>();
  if (!device || !device.ready || device.last_seen < now - ECUS_DEVICE_FRESHNESS || !device.profile_id) throw new EcusTransferError(409, 'Open the configured Windows helper and verify its ECUS export profile before submitting.');
  const sourceFingerprint = await ecusSourceFingerprint(state, caseId);
  const payload = buildEcusExportPayload(form, shipment, actor, state.revision);
  const payloadJson = JSON.stringify(payload);
  if (new TextEncoder().encode(payloadJson).length > 512 * 1024) throw new EcusTransferError(413, 'The export draft exceeds the transfer size limit.');
  const draft = await db.prepare('SELECT revision, form_json, source_fingerprint FROM ecus_export_drafts WHERE workspace_id = ? AND case_id = ?')
    .bind(state.id, caseId).first<{ revision: number; form_json: string; source_fingerprint: string }>();
  if (!Number.isSafeInteger(expectedDraftRevision) || !draft || draft.revision !== expectedDraftRevision || draft.source_fingerprint !== sourceFingerprint
    || compareEcusExportForms(payload.form, parseEcusExportForm(JSON.parse(draft.form_json))).length) {
    throw new EcusTransferError(409, 'Save the latest reviewed export form before submitting.');
  }
  const draftMatches = `EXISTS (SELECT 1 FROM ecus_export_drafts WHERE workspace_id = ? AND case_id = ? AND revision = ? AND form_json = ? AND source_fingerprint = ?)`;
  const guard = [state.id, state.revision, state.id, actor.id, deviceId, state.id, now - ECUS_DEVICE_FRESHNESS, device.profile_id];
  const draftGuard = [state.id, caseId, expectedDraftRevision, draft.form_json, sourceFingerprint];
  const latest = await db.prepare('SELECT * FROM ecus_export_jobs WHERE workspace_id = ? AND case_id = ? ORDER BY rowid DESC LIMIT 1').bind(state.id, caseId).first<EcusJob>();
  let retryOf: string | null = null;
  if (latest) {
    const resolution = await db.prepare('SELECT * FROM ecus_job_resolutions WHERE job_id = ? AND workspace_id = ? AND payload_hash = ?')
      .bind(latest.id, state.id, latest.payload_hash).first<EcusResolution>();
    if (resolution) {
      if (resolution.disposition !== 'no_draft') throw new EcusTransferError(409, 'An employee retained the existing ECUS draft. A second draft is blocked.');
      if (!resolution.device_ack_at) throw new EcusTransferError(409, 'Wait for the original Windows helper to acknowledge the recovery decision.');
      retryOf = latest.id;
    } else {
      const existing = await db.prepare(`SELECT * FROM ecus_export_jobs WHERE id = ? AND workspace_id = ? AND ${submissionAllowed} AND ${draftMatches}`)
        .bind(latest.id, state.id, ...guard, ...draftGuard).first<EcusJob>();
      if (existing && existing.source_fingerprint === sourceFingerprint && !compareEcusExportForms(payload.form, (JSON.parse(existing.payload_json) as EcusExportPayload).form).length) return existing;
      throw new EcusTransferError(409, 'This shipment already has a transfer. Inspect and resolve its ECUS draft before creating another.');
    }
  }
  // Include the resolved parent, not approval time: one new attempt per decision,
  // while concurrent/repeated Submit converges on the same immutable job.
  const approvalHash = await hashAuthKey(JSON.stringify({ caseId, sourceFingerprint, form: payload.form, retryOf }));
  const id = `ecus_job_${crypto.randomUUID()}`;
  await db.prepare(`INSERT OR IGNORE INTO ecus_export_jobs
    (id, workspace_id, device_id, case_id, approved_by, source_fingerprint, approval_hash, payload_json, payload_hash, created_at, expires_at, draft_revision, retry_of)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${submissionAllowed} AND ${draftMatches}
      AND NOT EXISTS (SELECT 1 FROM ecus_export_jobs j WHERE j.workspace_id = ? AND j.case_id = ?
        AND NOT EXISTS (SELECT 1 FROM ecus_job_resolutions r WHERE r.job_id = j.id AND r.workspace_id = j.workspace_id AND r.payload_hash = j.payload_hash AND r.disposition = 'no_draft' AND r.device_ack_at IS NOT NULL))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM ecus_export_jobs p JOIN ecus_job_resolutions r ON r.job_id = p.id
        WHERE p.id = ? AND p.workspace_id = ? AND p.case_id = ? AND r.payload_hash = p.payload_hash AND r.disposition = 'no_draft' AND r.device_ack_at IS NOT NULL))`)
    .bind(id, state.id, deviceId, caseId, actor.id, sourceFingerprint, approvalHash, payloadJson, await hashAuthKey(payloadJson), now, now + ECUS_JOB_LIFETIME,
      expectedDraftRevision, retryOf, ...guard, ...draftGuard, state.id, caseId, retryOf, retryOf, state.id, caseId).run();
  const saved = await db.prepare(`SELECT * FROM ecus_export_jobs WHERE workspace_id = ? AND case_id = ? AND approval_hash = ? AND ${submissionAllowed} AND ${draftMatches}`)
    .bind(state.id, caseId, approvalHash, ...guard, ...draftGuard).first<EcusJob>();
  if (!saved) throw new EcusTransferError(409, 'The shipment, saved form or recovery decision changed. Reload and review again.');
  return saved;
}

export async function claimEcusExport(db: D1Database, device: EcusDevice, ready: boolean, profileId: string, now = Date.now()) {
  const identity = [device.id, device.workspace_id, device.token_hash];
  const heartbeat = await db.batch([
    db.prepare(`UPDATE ecus_devices SET last_seen = ?, ready = ?, profile_id = ? WHERE id = ? AND workspace_id = ? AND ${currentDeviceExists}`)
      .bind(now, ready ? 1 : 0, profileId, device.id, device.workspace_id, ...identity),
    db.prepare(`UPDATE ecus_export_jobs SET status = 'needs_reconciliation', finished_at = ?, message = 'Transfer interrupted. Inspect ECUS; automatic recreation is disabled.' WHERE device_id = ? AND workspace_id = ? AND status = 'running' AND lease_until < ? AND ${currentDeviceExists}`)
      .bind(now, device.id, device.workspace_id, now, ...identity),
    db.prepare(`UPDATE ecus_export_jobs SET status = 'cancelled', finished_at = ?, message = 'Queued approval expired. No ECUS transfer was started.' WHERE device_id = ? AND workspace_id = ? AND status = 'queued' AND expires_at < ? AND ${currentDeviceExists}`)
      .bind(now, device.id, device.workspace_id, now, ...identity),
  ]);
  if (!heartbeat[0].meta.changes) throw new EcusTransferError(401, 'The ECUS device key is invalid or revoked.');
  if (!ready || !profileId) return null;
  const next = await db.prepare("SELECT * FROM ecus_export_jobs WHERE device_id = ? AND workspace_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1").bind(device.id, device.workspace_id).first<EcusJob>();
  if (!next) return null;
  const state = await readWorkspaceState(db, device.workspace_id, next.approved_by);
  let currentFingerprint = '';
  if (state) try { currentFingerprint = await ecusSourceFingerprint(state, next.case_id); } catch { /* no longer an export case */ }
  if (!state || currentFingerprint !== next.source_fingerprint) {
    await db.prepare(`UPDATE ecus_export_jobs SET status = 'cancelled', finished_at = ?, message = 'Shipment evidence or access changed after approval. Review again.' WHERE id = ? AND device_id = ? AND workspace_id = ? AND status = 'queued' AND ${currentDeviceExists}`)
      .bind(now, next.id, device.id, device.workspace_id, ...identity).run();
    return null;
  }
  const leaseToken = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE ecus_export_jobs SET status = 'running', claimed_at = ?, lease_until = ?, lease_token = ?
    WHERE id = ? AND device_id = ? AND workspace_id = ? AND status = 'queued' AND expires_at >= ?
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND revision = ?)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      AND ${currentDeviceExists}
      AND EXISTS (SELECT 1 FROM ecus_devices WHERE id = ? AND ready = 1 AND profile_id = ? AND last_seen >= ?)
      AND (retry_of IS NULL OR EXISTS (SELECT 1 FROM ecus_job_resolutions r JOIN ecus_export_jobs p ON p.id = r.job_id WHERE p.id = ecus_export_jobs.retry_of AND r.payload_hash = p.payload_hash AND r.disposition = 'no_draft' AND r.device_ack_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM ecus_export_jobs WHERE device_id = ? AND status = 'running') RETURNING *`)
    .bind(now, now + ECUS_LEASE, leaseToken, next.id, device.id, device.workspace_id, now, state.id, state.revision,
      state.id, next.approved_by, ...identity, device.id, profileId, now - ECUS_DEVICE_FRESHNESS, device.id).first<EcusJob>();
  return claimed ? { id: claimed.id, payloadJson: claimed.payload_json, payloadHash: claimed.payload_hash, leaseToken,
    expiresAt: new Date(claimed.expires_at).toISOString(), leaseExpiresAt: new Date(claimed.lease_until!).toISOString() } : null;
}

export type EcusResult = { jobId: string; leaseToken: string; status: 'succeeded' | 'failed' | 'needs_reconciliation'; draftReference?: string; readback?: EcusExportForm; message: string };
export async function finishEcusExport(db: D1Database, device: EcusDevice, result: EcusResult, now = Date.now()) {
  const identity = [device.id, device.workspace_id, device.token_hash];
  const job = await db.prepare(`SELECT * FROM ecus_export_jobs WHERE id = ? AND device_id = ? AND workspace_id = ? AND lease_token = ? AND ${currentDeviceExists}`)
    .bind(result.jobId, device.id, device.workspace_id, result.leaseToken, ...identity).first<EcusJob>();
  if (!job) throw new EcusTransferError(404, 'Transfer not found for this computer.');
  // Retain a first delayed readback after timeout, but never replace a terminal
  // result or add evidence after an employee has already resolved that attempt.
  const delayed = job.status === 'needs_reconciliation' && job.result_json === null;
  if (job.status !== 'running' && !delayed) return job;
  let status = result.status;
  let message = result.message;
  const differences = result.readback ? compareEcusExportForms((JSON.parse(job.payload_json) as EcusExportPayload).form, parseEcusExportForm(result.readback)) : [];
  if (status === 'succeeded') {
    if (!result.draftReference?.trim() || !result.readback) { status = 'needs_reconciliation'; message = 'ECUS did not return a draft reference and complete saved-field readback.'; }
    else if (differences.length) { status = 'needs_reconciliation'; message = `${differences.length} saved ECUS values differ from the approved export form.`; }
  }
  if (delayed || (job.lease_until || 0) < now) { status = 'needs_reconciliation'; message = 'Transfer result arrived after interruption or lease expiry. Inspect ECUS before continuing.'; }
  const storedResult = JSON.stringify({ ...result, status, message, differences });
  await db.prepare(`UPDATE ecus_export_jobs SET status = ?, finished_at = ?, draft_reference = ?, message = ?, result_json = ? WHERE id = ? AND device_id = ? AND workspace_id = ?
    AND (status = 'running' OR (status = 'needs_reconciliation' AND result_json IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ecus_job_resolutions WHERE job_id = ecus_export_jobs.id)
    AND lease_token = ? AND ${currentDeviceExists}`)
    .bind(status, now, result.draftReference || null, message, storedResult, job.id, device.id, device.workspace_id, result.leaseToken, ...identity).run();
  const saved = await db.prepare(`SELECT * FROM ecus_export_jobs WHERE id = ? AND workspace_id = ? AND ${currentDeviceExists}`)
    .bind(job.id, device.workspace_id, ...identity).first<EcusJob>();
  if (!saved) throw new EcusTransferError(401, 'The ECUS device key is invalid or revoked.');
  return saved;
}

export function publicEcusJob(job: EcusJob, includePayload = false, resolution: EcusResolution | null = null) {
  const result = job.result_json ? JSON.parse(job.result_json) as { readback?: EcusExportForm } : null;
  const readback = result?.readback ?? null;
  const differences = readback ? compareEcusExportForms((JSON.parse(job.payload_json) as EcusExportPayload).form, readback) : [];
  return { id: job.id, deviceId: job.device_id, status: job.status, createdAt: new Date(job.created_at).toISOString(), message: job.message, draftReference: job.draft_reference,
    retryOf: job.retry_of, readback, differences, resolution: resolution ? { id: resolution.id, disposition: resolution.disposition,
      actorName: resolution.actor_name, reason: resolution.reason, createdAt: new Date(resolution.created_at).toISOString(),
      draftReference: resolution.draft_reference, deviceAcknowledged: resolution.device_ack_at !== null } : null,
    ...(includePayload ? { payload: JSON.parse(job.payload_json) as EcusExportPayload } : {}) };
}
