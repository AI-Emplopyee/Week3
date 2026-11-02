import type { Actor, WorkspaceState } from './types';

// Originals are stored separately in R2. This bounds the extracted text, drafts
// and audit history materialized by the current whole-workspace API.
export const MAX_STORED_WORKSPACE_BYTES = 32 * 1024 * 1024;
export const INLINE_WORKSPACE_BYTES = 1_800_000;
export const WORKSPACE_CHUNK_BYTES = 1_000_000;
const STORAGE_FORMAT = 'aicd-workspace-chunks-v1';

export const COMMIT_SQL = `UPDATE workspaces SET state_json = ?, revision = ?, updated_at = ?
  WHERE id = ? AND revision = ? AND EXISTS (
    SELECT 1 FROM workspace_members WHERE workspace_id = workspaces.id AND user_id = ?
  )`;

// Check the unique manifest as well as the revision. A competing writer can
// advance to the same next revision, but cannot commit this snapshot's token.
const committedSnapshot = `EXISTS (
  SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
  WHERE w.id = ? AND w.revision = ? AND w.state_json = ? AND m.user_id = ?
)`;
const insertChunkSql = `INSERT INTO workspace_state_chunks (workspace_id, snapshot_id, chunk_index, content)
  SELECT ?, ?, ?, ? WHERE ${committedSnapshot}`;
const deleteOldChunksSql = `DELETE FROM workspace_state_chunks
  WHERE workspace_id = ? AND snapshot_id <> ? AND ${committedSnapshot}`;

type StorageManifest = {
  id: string;
  revision: number;
  // The team-access transaction uses only the final audit ID to identify its
  // exact successful commit. The complete audit remains in the stored state.
  audit: { id: string }[];
  _storage: { format: typeof STORAGE_FORMAT; snapshotId: string; chunks: number; bytes: number };
};
type StoredRow = {
  id: string;
  revision: number;
  state_json: string;
  chunk_index: number | null;
  content: string | null;
};

function serialize(state: WorkspaceState, expectedRevision: number): { text: string; bytes: Uint8Array } {
  if (state.revision !== expectedRevision + 1) throw new Error('A workspace commit must advance exactly one revision.');
  const text = JSON.stringify(state);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_STORED_WORKSPACE_BYTES) throw new Error('This workspace exceeds the extracted-record storage limit. No changes were saved.');
  return { text, bytes };
}

export type WorkspaceCommitGuard = { sql: string; values: (string | number)[] };
function commitStatement(db: D1Database, state: WorkspaceState, expectedRevision: number, actor: Actor, text: string, guard?: WorkspaceCommitGuard): D1PreparedStatement {
  return db.prepare(COMMIT_SQL + (guard ? ` AND (${guard.sql})` : '')).bind(text, state.revision, new Date().toISOString(), state.id, expectedRevision, actor.id, ...(guard?.values ?? []));
}

/** Compatibility helper for callers that explicitly require an inline state. */
export function prepareCommit(db: D1Database, state: WorkspaceState, expectedRevision: number, actor: Actor): D1PreparedStatement {
  const { text, bytes } = serialize(state, expectedRevision);
  if (bytes.length > INLINE_WORKSPACE_BYTES) throw new Error('Large workspaces must use the atomic prepareWorkspaceCommit batch.');
  return commitStatement(db, state, expectedRevision, actor, text);
}

function splitUtf8(bytes: Uint8Array): string[] {
  const chunks: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + WORKSPACE_CHUNK_BYTES, bytes.length);
    // A code point may span the nominal boundary. Keep its full UTF-8 sequence
    // together so Vietnamese, emoji, and other multibyte text round-trip exactly.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}

/** Execute this entire array in one db.batch(). Result 0 is the revision CAS.
 * Failed CAS operations neither insert chunks nor delete an existing snapshot.
 * D1 rolls the whole transaction back if any subsequent statement fails.
 */
export function prepareWorkspaceCommit(db: D1Database, state: WorkspaceState, expectedRevision: number, actor: Actor, commitGuard?: WorkspaceCommitGuard): D1PreparedStatement[] {
  const { text, bytes } = serialize(state, expectedRevision);
  const chunks = bytes.length > INLINE_WORKSPACE_BYTES ? splitUtf8(bytes) : [];
  const snapshotId = chunks.length ? crypto.randomUUID() : '';
  const lastAudit = state.audit.at(-1);
  const manifest: StorageManifest = {
    id: state.id,
    revision: state.revision,
    audit: lastAudit ? [{ id: lastAudit.id }] : [],
    _storage: { format: STORAGE_FORMAT, snapshotId, chunks: chunks.length, bytes: bytes.length },
  };
  const stored = chunks.length ? JSON.stringify(manifest) : text;
  const guard = [state.id, state.revision, stored, actor.id];
  return [
    commitStatement(db, state, expectedRevision, actor, stored, commitGuard),
    ...chunks.map((content, index) => db.prepare(insertChunkSql).bind(state.id, snapshotId, index, content, ...guard)),
    db.prepare(deleteOldChunksSql).bind(state.id, snapshotId, ...guard),
  ];
}

/** One SELECT reads the manifest and all of its chunks from the same database
 * snapshot. Reading them separately would race with a later commit's cleanup.
 * The membership predicate applies equally to legacy inline and chunked data.
 */
export async function readWorkspaceState(db: D1Database, workspaceId: string, actorId: string): Promise<WorkspaceState | null> {
  const { results } = await db.prepare(`SELECT w.id, w.revision, w.state_json, c.chunk_index, c.content
    FROM workspaces w LEFT JOIN workspace_state_chunks c
      ON c.workspace_id = w.id AND c.snapshot_id = json_extract(w.state_json, '$._storage.snapshotId')
      AND json_extract(w.state_json, '$._storage.format') = ?
    WHERE w.id = ? AND EXISTS (
      SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?
    ) ORDER BY c.chunk_index`).bind(STORAGE_FORMAT, workspaceId, actorId).all<StoredRow>();
  if (!results.length) return null;
  const first = results[0];
  const saved = JSON.parse(first.state_json) as WorkspaceState | StorageManifest;
  let state: WorkspaceState;
  if ('_storage' in saved) {
    const storage = saved._storage;
    if (!storage || storage.format !== STORAGE_FORMAT || saved.id !== first.id || saved.revision !== first.revision ||
      typeof storage.snapshotId !== 'string' || !storage.snapshotId || !Number.isInteger(storage.chunks) ||
      storage.chunks < 1 || storage.chunks > Math.ceil(MAX_STORED_WORKSPACE_BYTES / (WORKSPACE_CHUNK_BYTES - 3)) ||
      !Number.isInteger(storage.bytes) || storage.bytes <= INLINE_WORKSPACE_BYTES || storage.bytes > MAX_STORED_WORKSPACE_BYTES ||
      results.length !== storage.chunks || results.some((row, index) => row.chunk_index !== index || typeof row.content !== 'string')) {
      throw new Error('Stored workspace chunks are incomplete or unsupported.');
    }
    const text = results.map((row) => row.content!).join('');
    if (new TextEncoder().encode(text).length !== storage.bytes) throw new Error('Stored workspace chunks failed the size check.');
    state = JSON.parse(text) as WorkspaceState;
    if (state.revision !== first.revision) throw new Error('Stored workspace revision does not match its snapshot.');
  } else {
    state = saved;
  }
  if (state.id !== first.id) throw new Error('Stored workspace identity does not match its database row.');
  state.revision = first.revision;
  return state;
}

export function commitSucceeded(result: { meta?: { changes?: number } }): boolean { return result.meta?.changes === 1; }
