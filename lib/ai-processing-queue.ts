import { sourcePageNeedsKimi } from './source-completeness.ts';
import type { ShipmentDocument, SourcePage, WorkspaceState } from './types.ts';

export const AUTOMATIC_CONCURRENCY = 2;
export const AUTOMATIC_LEASE_MS = 10 * 60_000;
export type AiJob = { workspace_id: string; document_id: string; document_version: number; sha256: string; page: number; state: string; lease_until: number; available_at: number; attempts: number; started_at: number | null; completed_at: number | null; elapsed_ms: number | null; error: string | null };
export const JOB_IDENTITY = 'workspace_id = ? AND document_id = ? AND document_version = ? AND sha256 = ? AND page = ?';
export function jobIdentity(workspaceId: string, document: Pick<ShipmentDocument, 'id' | 'version' | 'sha256'>, page: number) { return [workspaceId, document.id, document.version, document.sha256, page] as const; }
export const CLAIM_JOB_SQL = `UPDATE ai_processing_jobs SET state = 'running', lease_token = ?, lease_until = ?, started_at = ?, completed_at = NULL, elapsed_ms = NULL, error = NULL, attempts = attempts + 1
WHERE ${JOB_IDENTITY} AND available_at <= ? AND (state = 'queued' OR (state = 'running' AND lease_until <= ?) OR (? = 1 AND state IN ('completed', 'failed')))
AND NOT EXISTS (SELECT 1 FROM deleted_case_documents deleted WHERE deleted.workspace_id = ai_processing_jobs.workspace_id AND deleted.document_id = ai_processing_jobs.document_id)
AND NOT EXISTS (SELECT 1 FROM ai_processing_jobs other WHERE other.workspace_id = ai_processing_jobs.workspace_id AND other.document_id = ai_processing_jobs.document_id AND other.state = 'running' AND other.lease_until > ?)
AND (SELECT COUNT(*) FROM ai_processing_jobs active WHERE active.workspace_id = ai_processing_jobs.workspace_id AND active.state = 'running' AND active.lease_until > ?) < ? RETURNING lease_token`;

/** Previously read pages need an explicit retry, including reads predating job storage. */
export function automaticPageNeedsKimi(state: WorkspaceState, document: ShipmentDocument, page: SourcePage): boolean {
  return !(document.extractionPipeline === 'kimi' && document.aiProcessedPages?.includes(page.page)) && sourcePageNeedsKimi(state, document, page);
}
/** Samples and archived cases never silently enter the live intake queue. */
export function automaticDocuments(state: WorkspaceState): ShipmentDocument[] {
  const liveCases = new Set(state.cases.filter(shipment => !shipment.mergedInto && shipment.status !== 'completed' && shipment.caseType === 'import' && !shipment.sourceCollection).map(shipment => shipment.id));
  return state.documents.filter(document => liveCases.has(document.caseId) && document.active && !document.referenceOnly && !!document.blobKey && !['unsupported', 'failed'].includes(document.extractionStatus) && document.pages.some(page => automaticPageNeedsKimi(state, document, page)));
}
export async function enqueuePage(db: D1Database, workspaceId: string, document: Pick<ShipmentDocument, 'id' | 'version' | 'sha256'>, page: number) {
  // A poll/extraction request can still hold an old workspace after deletion.
  // The tombstone is committed with deletion, so stale readers cannot recreate jobs.
  await db.prepare(`INSERT OR IGNORE INTO ai_processing_jobs (workspace_id, document_id, document_version, sha256, page)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_case_documents WHERE workspace_id = ? AND document_id = ?)`)
    .bind(...jobIdentity(workspaceId, document, page), workspaceId, document.id).run();
}
export async function claimAiJob(db: D1Database, workspaceId: string, document: Pick<ShipmentDocument, 'id' | 'version' | 'sha256'>, page: number, manual = false, now = Date.now()): Promise<string | null> {
  await enqueuePage(db, workspaceId, document, page);
  const token = crypto.randomUUID();
  const row = await db.prepare(CLAIM_JOB_SQL).bind(token, now + AUTOMATIC_LEASE_MS, now, ...jobIdentity(workspaceId, document, page), now, now, manual ? 1 : 0, now, now, AUTOMATIC_CONCURRENCY).first();
  return row ? token : null;
}
export async function finishAiJob(db: D1Database, workspaceId: string, document: Pick<ShipmentDocument, 'id' | 'version' | 'sha256'>, page: number, token: string, state: 'completed' | 'failed' | 'queued', error?: string, now = Date.now()) {
  return db.prepare(`UPDATE ai_processing_jobs SET state = ?, lease_token = NULL, lease_until = 0, available_at = ?, completed_at = ?, elapsed_ms = ? - started_at, error = ? WHERE ${JOB_IDENTITY} AND lease_token = ?`)
    .bind(state, state === 'queued' ? now + 60_000 : 0, now, now, error?.slice(0, 500) ?? null, ...jobIdentity(workspaceId, document, page), token).run();
}
