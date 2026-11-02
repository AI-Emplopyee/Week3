import type { Actor, WorkspaceState } from './types.ts';

export type CaseDeletionPlan = { caseIds: string[]; documentIds: string[]; retiredDocumentIds: string[]; originalKeys: string[]; visionPrefixes: string[] };

/** Preserve the sequence across deletion; a new case must never reuse a deleted reference. */
export function caseSequence(state: WorkspaceState): number {
  return Math.max(state.caseSequence ?? 0, ...state.cases.map(shipment => {
    const match = /^AICD-(\d+)$/.exec(shipment.reference);
    return match ? Number(match[1]) : 0;
  }));
}

export function planCaseDeletion(state: WorkspaceState, caseId: string): CaseDeletionPlan {
  const shipment = state.cases.find(item => item.id === caseId && !item.mergedInto);
  if (!shipment) throw new Error('Case not found. Reload the shipment list.');
  const caseIds = new Set([caseId]);
  // Old merged aliases otherwise keep pointing to a nonexistent destination.
  for (let changed = true; changed;) {
    changed = false;
    for (const item of state.cases) if (item.mergedInto && caseIds.has(item.mergedInto) && !caseIds.has(item.id)) {
      caseIds.add(item.id); changed = true;
    }
  }
  const documents = state.documents.filter(item => caseIds.has(item.caseId));
  const documentIds = new Set(documents.map(item => item.id));
  const snapshotDocuments = state.snapshots.filter(item => caseIds.has(item.caseId)).flatMap(item => item.documents);
  const candidateDocuments = [...documents, ...snapshotDocuments];
  const retainedSnapshots = state.snapshots.filter(item => !caseIds.has(item.caseId));
  const retainedLiveDocuments = state.documents.filter(item => !documentIds.has(item.id));
  const retainedLiveIds = new Set(retainedLiveDocuments.map(item => item.id));
  const retainedDocuments = [
    ...retainedLiveDocuments,
    ...retainedSnapshots.flatMap(item => item.documents),
  ];
  const retainedKeys = new Set([
    ...retainedDocuments.map(item => item.blobKey),
    ...state.emails.map(item => item.blobKey),
  ].filter((key): key is string => !!key));
  const retainedDocumentIds = new Set(retainedDocuments.map(item => item.id));
  return {
    caseIds: [...caseIds], documentIds: [...documentIds],
    // Snapshot-only records can be the last owner after an earlier case deletion.
    // A document that still lives in another case must never be tombstoned.
    retiredDocumentIds: [...new Set(candidateDocuments.filter(item => !retainedLiveIds.has(item.id)).map(item => item.id))],
    originalKeys: [...new Set(candidateDocuments.flatMap(item => item.blobKey && item.blobKey.startsWith(`${state.id}/`) && !retainedKeys.has(item.blobKey) ? [item.blobKey] : []))],
    visionPrefixes: [...new Set(candidateDocuments.filter(item => !retainedDocumentIds.has(item.id)).map(item => `${state.id}/vision/${item.id}/`))],
  };
}

/** Called on the engine's cloned state, only after the UI's second confirmation. */
export function deleteCase(state: WorkspaceState, caseId: string, confirmed: boolean, actor: Actor): void {
  if (confirmed !== true) throw new Error('Confirm case deletion again before continuing.');
  const plan = planCaseDeletion(state, caseId);
  const ids = new Set(plan.caseIds);
  const documentIds = new Set(plan.documentIds);
  const removedCases = state.cases.filter(item => ids.has(item.id));
  state.caseSequence = caseSequence(state);
  state.cases = state.cases.filter(item => !ids.has(item.id));
  state.documents = state.documents.filter(item => !documentIds.has(item.id));
  state.candidates = state.candidates.filter(item => !ids.has(item.caseId) && !documentIds.has(item.documentId));
  state.snapshots = state.snapshots.filter(item => !ids.has(item.caseId));
  state.handoffs = state.handoffs.filter(item => !ids.has(item.caseId));
  if (state.emailDrafts) state.emailDrafts = state.emailDrafts.filter(item => !ids.has(item.caseId));
  const removedMemoryIds = new Set(state.clientMemories?.filter(item => ids.has(item.sourceCaseId)).map(item => item.id));
  if (state.clientMemories) state.clientMemories = state.clientMemories.filter(item => !removedMemoryIds.has(item.id));
  for (const item of state.cases) if (item.dismissedClientMemoryIds) item.dismissedClientMemoryIds = item.dismissedClientMemoryIds.filter(id => !removedMemoryIds.has(id));
  for (const draft of state.emailDrafts ?? []) if (draft.automation?.pendingClientMemoryIds) {
    draft.automation.pendingClientMemoryIds = draft.automation.pendingClientMemoryIds.filter(id => !removedMemoryIds.has(id));
  }
  // A saved email can belong to several shipments. Retain its original while
  // removing only this case's links and deleted attachment identifiers.
  for (const email of state.emails) {
    email.documentIds = email.documentIds.filter(id => !documentIds.has(id));
    if (email.shipmentMatches) email.shipmentMatches = email.shipmentMatches.filter(match => !ids.has(match.caseId));
  }
  state.audit.push({
    id: `audit_${crypto.randomUUID()}`, caseId, at: new Date().toISOString(), actor: actor.name,
    action: 'case_deleted', reason: 'Case deletion confirmed twice by the workspace owner.',
    before: { cases: removedCases.map(item => ({ id: item.id, reference: item.reference, title: item.title })), documentCount: documentIds.size },
    after: null,
  });
}

export const CASE_DELETION_BLOCKED = 'Resolve the ECUS transfer and wait for the Windows helper to acknowledge recovery before deleting this case.';

/** A transaction-level guard closes the race with a new or newly claimed ECUS job. */
export function caseDeletionGuard(workspaceId: string, caseIds: string[]): { sql: string; values: string[] } {
  if (!caseIds.length) throw new Error('A case is required for deletion.');
  return {
    sql: `NOT EXISTS (SELECT 1 FROM ecus_export_jobs j WHERE j.workspace_id = ?
      AND j.case_id IN (SELECT value FROM json_each(?)) AND (
        j.status IN ('queued', 'running') OR
        (j.status <> 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM ecus_job_resolutions r WHERE r.job_id = j.id AND r.workspace_id = j.workspace_id
          AND r.payload_hash = j.payload_hash AND r.device_ack_at IS NOT NULL
        ))
      ))`,
    values: [workspaceId, JSON.stringify(caseIds)],
  };
}

export function caseDeletionCommitGuard(workspaceId: string, caseIds: string[], actorId: string): { sql: string; values: string[] } {
  const transfer = caseDeletionGuard(workspaceId, caseIds);
  return {
    sql: `${transfer.sql} AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner')`,
    values: [...transfer.values, workspaceId, actorId],
  };
}

/** Attach these statements to the same workspace CAS transaction. The unique
 * deletion audit ID prevents cleanup when another request won the revision. */
export function prepareCaseDeletionCleanup(db: D1Database, state: WorkspaceState, actor: Actor, plan: CaseDeletionPlan): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
    WHERE w.id = ? AND w.revision = ? AND json_extract(w.state_json, '$.audit[#-1].id') = ?
      AND m.user_id = ? AND m.role = 'owner')`;
  const audit = state.audit.at(-1);
  if (audit?.action !== 'case_deleted') throw new Error('Deletion cleanup requires its matching audit.');
  const values = [state.id, state.revision, audit.id, actor.id];
  const statements: D1PreparedStatement[] = [];
  // Bound JSON arrays keep both query count and SQL parameter count small even
  // for cases with many attachments or merged aliases.
  if (plan.retiredDocumentIds.length) {
    const documents = plan.retiredDocumentIds.map(id => ({ id, cleanupVision: plan.visionPrefixes.includes(`${state.id}/vision/${id}/`) ? 1 : 0 }));
    statements.push(db.prepare(`INSERT INTO deleted_case_documents (workspace_id, document_id, cleanup_vision)
      SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.cleanupVision') FROM json_each(?) WHERE ${guard}
      ON CONFLICT(workspace_id, document_id) DO UPDATE SET cleanup_vision = MAX(deleted_case_documents.cleanup_vision, excluded.cleanup_vision)`)
      .bind(state.id, JSON.stringify(documents), ...values));
    statements.push(db.prepare(`DELETE FROM ai_processing_jobs WHERE workspace_id = ? AND document_id IN (SELECT value FROM json_each(?)) AND ${guard}`)
      .bind(state.id, JSON.stringify(plan.retiredDocumentIds), ...values));
  }
  // Saved-form edits are part of this case. Immutable transfer payloads and
  // recovery records stay in their own tables and can never be replayed.
  for (const table of ['ecus_export_drafts', 'ecus_export_draft_history']) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND case_id IN (SELECT value FROM json_each(?)) AND ${guard}`)
      .bind(state.id, JSON.stringify(plan.caseIds), ...values));
  }
  if (plan.originalKeys.length || plan.visionPrefixes.length) statements.push(db.prepare(`INSERT INTO case_file_cleanup (id, workspace_id, plan_json, created_at)
    SELECT ?, ?, ?, ? WHERE ${guard}`).bind(audit.id, state.id, JSON.stringify(plan), audit.at, ...values));
  return statements;
}

/** Originals are separate storage, so delete only after the state commit. */
export async function deleteCaseFiles(storage: Pick<R2Bucket, 'delete' | 'list'>, plan: CaseDeletionPlan): Promise<void> {
  for (let offset = 0; offset < plan.originalKeys.length; offset += 1000) await storage.delete(plan.originalKeys.slice(offset, offset + 1000));
  for (const prefix of plan.visionPrefixes) {
    let cursor: string | undefined;
    do {
      const listed = await storage.list({ prefix, cursor });
      if (listed.objects.length) await storage.delete(listed.objects.map(item => item.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

/** Failures leave the transactionally queued plan for the next workspace visit.
 * Repeating a deletion is safe: object keys contain immutable document IDs. */
export async function cleanupDeletedCaseFiles(db: D1Database, storage: Pick<R2Bucket, 'delete' | 'list'>, workspaceId: string): Promise<void> {
  const { results } = await db.prepare('SELECT id, plan_json FROM case_file_cleanup WHERE workspace_id = ? ORDER BY created_at LIMIT 5')
    .bind(workspaceId).all<{ id: string; plan_json: string }>();
  for (const row of results) {
    const plan = JSON.parse(row.plan_json) as CaseDeletionPlan;
    // The queue is created only by the server, but retain workspace containment
    // even if a stored cleanup record is damaged.
    if (!Array.isArray(plan.originalKeys) || !Array.isArray(plan.visionPrefixes) ||
      plan.originalKeys.some(key => typeof key !== 'string' || !key.startsWith(`${workspaceId}/`)) ||
      plan.visionPrefixes.some(prefix => typeof prefix !== 'string' || !prefix.startsWith(`${workspaceId}/vision/`) || !prefix.endsWith('/'))) {
      throw new Error('Invalid case file cleanup record.');
    }
    await deleteCaseFiles(storage, plan);
    await db.prepare('DELETE FROM case_file_cleanup WHERE workspace_id = ? AND id = ? AND plan_json = ?')
      .bind(workspaceId, row.id, row.plan_json).run();
  }
}
