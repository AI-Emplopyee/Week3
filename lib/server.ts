import { env } from 'cloudflare:workers';
import { ZodError } from 'zod';
import { AuthError, supabaseConfig } from '@/lib/auth-provider';
import { requireAuthActor, runtimeAuthMode } from '@/lib/server-auth';
import { applyAction, createEmptyWorkspace, getIssues, initializeDeclarationDrafts } from '@/lib/engine';
import { commitSucceeded, prepareWorkspaceCommit, readWorkspaceState } from '@/lib/server-persistence';
import { CASE_DELETION_BLOCKED, caseDeletionCommitGuard, caseDeletionGuard, cleanupDeletedCaseFiles, planCaseDeletion, prepareCaseDeletionCleanup } from '@/lib/case-deletion';
import { MAX_JSON_BYTES, MAX_WORKSPACE_BYTES, parseId, sameOrigin } from '@/lib/server-validation';
import type { Action, Actor, WorkspaceResponse, WorkspaceState } from '@/lib/types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: object) { super(message); }
}
type Membership = { workspace_id: string; role: 'owner' | 'reviewer' };
export type WorkspaceContext = { db: D1Database; state: WorkspaceState; actor: Actor; role: 'owner' | 'reviewer' };
export const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: privateHeaders }); }
export async function route(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    if (error instanceof ApiError) return json({ error: error.message, ...error.detail }, error.status);
    if (error instanceof ZodError) return json({ error: error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return json({ error: 'The request contains invalid JSON.' }, 400);
    console.error('AICD request failed:', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: 'The request could not be completed. Please retry. If this continues, contact your workspace owner.' }, 500);
  }
}
export function requireSameOrigin(request: Request): void {
  if (!sameOrigin(request)) throw new ApiError(403, 'This action must originate from the AICD application.');
}
export async function readLimitedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers.get('content-length'));
  if (length > limit) throw new ApiError(413, 'The request is too large.');
  if (!request.body) throw new ApiError(400, 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new ApiError(413, 'The request is too large.'); }
    chunks.push(value);
  }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ApiError(415, 'Use application/json for this request.');
  return JSON.parse(new TextDecoder().decode(await readLimitedBytes(request, MAX_JSON_BYTES)));
}
export function bucket(): R2Bucket {
  if (!env.BUCKET) throw new ApiError(503, 'Original document storage is not available.');
  return env.BUCKET;
}
export async function workspace(request: Request): Promise<WorkspaceContext> {
  const actor = await requireAuthActor(request);
  if (!env.DB) throw new ApiError(503, 'Workspace storage is not available.');
  const db = env.DB;
  // Only a trusted, signed-in identity can claim a matching, owner-created invitation.
  await db.prepare('UPDATE workspace_members SET user_id = ? WHERE email = ? AND user_id IS NULL')
    .bind(actor.id, actor.email).run();
  const requested = new URL(request.url).searchParams.get('workspaceId');
  let membership: Membership | null;
  if (requested) {
    parseId(requested);
    membership = await db.prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ? AND workspace_id = ?')
      .bind(actor.id, requested).first<Membership>();
    if (!membership) throw new ApiError(404, 'Workspace not found.');
  } else {
    membership = await db.prepare("SELECT workspace_id, role FROM workspace_members WHERE user_id = ? ORDER BY CASE WHEN role = 'reviewer' THEN 0 ELSE 1 END, created_at DESC LIMIT 1")
      .bind(actor.id).first<Membership>();
    if (!membership) {
      if (runtimeAuthMode() === 'supabase') {
        // Standalone users need an owner-created membership. Only the explicitly
        // configured, verified owner can bootstrap a completely empty database.
        if (actor.email !== supabaseConfig(env).ownerEmail || await db.prepare('SELECT id FROM workspaces LIMIT 1').first()) throw new ApiError(403, 'Workspace membership is required. Existing identities must be migrated explicitly.');
      }
      const state = createEmptyWorkspace(`ws_${crypto.randomUUID()}`);
      const at = new Date().toISOString();
      // Unique owner_id makes concurrent first visits converge to one personal workspace.
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO workspaces (id, owner_id, revision, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(state.id, actor.id, state.revision, JSON.stringify(state), at, at),
        db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, email, user_id, role, invited_by, created_at) SELECT id, ?, ?, 'owner', ?, ? FROM workspaces WHERE owner_id = ?")
          .bind(actor.email, actor.id, actor.id, at, actor.id),
      ]);
      membership = await db.prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ? LIMIT 1').bind(actor.id).first<Membership>();
    }
  }
  if (!membership) throw new ApiError(403, 'Workspace membership is required.');
  const stored = await readWorkspaceState(db, membership.workspace_id, actor.id);
  if (!stored) throw new ApiError(404, 'Workspace not found.');
  if (env.BUCKET) {
    try { await cleanupDeletedCaseFiles(db, env.BUCKET, stored.id); }
    catch (error) { console.error('Case file cleanup will retry:', error instanceof Error ? error.message : 'Unknown storage error'); }
  }
  const state = initializeDeclarationDrafts(stored);
  return { db, state, actor, role: membership.role };
}
export function response(context: WorkspaceContext): WorkspaceResponse {
  return { state: context.state, actor: context.actor, role: context.role, issues: getIssues(context.state) };
}
export function expectRevision(context: WorkspaceContext, expected: number): void {
  if (context.state.revision !== expected) throw new ApiError(409, 'The workspace changed in another session. Review the latest state before trying again.', response(context));
}
export function assertWorkspaceSize(state: WorkspaceState): void {
  if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_WORKSPACE_BYTES) throw new ApiError(413, 'This pilot workspace has reached its record storage limit. No changes were saved.');
}
export async function mutate(context: WorkspaceContext, expected: number, action: Action): Promise<WorkspaceResponse> {
  expectRevision(context, expected);
  if (action.type === 'settings' && context.role !== 'owner') throw new ApiError(403, 'Only the workspace owner can change settings.');
  if (action.type === 'delete_case' && context.role !== 'owner') throw new ApiError(403, 'Only the workspace owner can delete a case.');
  let next: WorkspaceState;
  try { next = applyAction(context.state, action, context.actor); }
  catch (error) { throw new ApiError(422, error instanceof Error ? error.message : 'This action is not valid for the current case.'); }
  next.revision = expected + 1;
  assertWorkspaceSize(next);
  const deletion = action.type === 'delete_case' ? planCaseDeletion(context.state, action.caseId) : undefined;
  const transferGuard = deletion ? caseDeletionGuard(context.state.id, deletion.caseIds) : undefined;
  if (transferGuard && !await context.db.prepare(`SELECT 1 WHERE ${transferGuard.sql}`).bind(...transferGuard.values).first()) throw new ApiError(422, CASE_DELETION_BLOCKED);
  const commitGuard = deletion ? caseDeletionCommitGuard(context.state.id, deletion.caseIds, context.actor.id) : undefined;
  const results = await context.db.batch([
    ...prepareWorkspaceCommit(context.db, next, expected, context.actor, commitGuard),
    ...(deletion ? prepareCaseDeletionCleanup(context.db, next, context.actor, deletion) : []),
  ]);
  if (!commitSucceeded(results[0])) {
    const stored = await readWorkspaceState(context.db, context.state.id, context.actor.id);
    if (!stored) throw new ApiError(403, 'Workspace membership is required.');
    context.state = initializeDeclarationDrafts(stored);
    if (deletion && !await context.db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'").bind(context.state.id, context.actor.id).first()) throw new ApiError(403, 'Only the workspace owner can delete a case.');
    if (transferGuard && !await context.db.prepare(`SELECT 1 WHERE ${transferGuard.sql}`).bind(...transferGuard.values).first()) throw new ApiError(422, CASE_DELETION_BLOCKED);
    throw new ApiError(409, 'The workspace changed in another session. Review the latest state before trying again.', response(context));
  }
  context.state = next;
  if (deletion && (deletion.originalKeys.length || deletion.visionPrefixes.length)) {
    try { await cleanupDeletedCaseFiles(context.db, bucket(), next.id); }
    catch (error) {
      // The saved deletion remains authoritative even if separate object storage
      // is unavailable. The durable cleanup queue retries on the next visit.
      console.error('Case deleted; original file cleanup will retry:', error instanceof Error ? error.message : 'Unknown storage error');
    }
  }
  return response(context);
}
