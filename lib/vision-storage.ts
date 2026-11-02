import { cleanupDeletedCaseFiles, type CaseDeletionPlan } from './case-deletion.ts';

/** A deletion can finish while R2 is accepting a previously authorized render.
 * The durable document marker outlives its first cleanup pass and fences that
 * late write. Return false so the uploader cannot use the deleted source. */
export async function storeVisionPage(
  db: D1Database,
  storage: Pick<R2Bucket, 'put' | 'delete' | 'list'>,
  workspaceId: string,
  documentId: string,
  key: string,
  raster: Uint8Array,
): Promise<boolean> {
  if (!key.startsWith(`${workspaceId}/vision/${documentId}/`)) throw new Error('Invalid source page storage key.');
  await storage.put(key, raster, { httpMetadata: { contentType: 'image/jpeg' } });
  const deleted = await db.prepare('SELECT cleanup_vision FROM deleted_case_documents WHERE workspace_id = ? AND document_id = ?')
    .bind(workspaceId, documentId).first<{ cleanup_vision: number }>();
  if (!deleted) return true;
  // Existing snapshots in another case can still own these exact page bytes.
  if (deleted.cleanup_vision) {
    const plan: CaseDeletionPlan = { caseIds: [], documentIds: [], retiredDocumentIds: [documentId], originalKeys: [key], visionPrefixes: [] };
    try {
      await db.prepare('INSERT INTO case_file_cleanup (id, workspace_id, plan_json, created_at) VALUES (?, ?, ?, ?)')
        .bind(`late-vision-${crypto.randomUUID()}`, workspaceId, JSON.stringify(plan), new Date().toISOString()).run();
    } catch (error) {
      // If the database cannot enqueue cleanup, immediately remove this write.
      await storage.delete(key);
      throw error;
    }
    try { await cleanupDeletedCaseFiles(db, storage, workspaceId); }
    catch { /* The durable plan remains available for the next workspace visit. */ }
  }
  return false;
}
