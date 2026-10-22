import { applyAction, initializeDeclarationDrafts } from './engine.ts';
import { commitSucceeded, prepareWorkspaceCommit, readWorkspaceState } from './server-persistence.ts';
import type { Action, Actor, ShipmentDocument, WorkspaceState } from './types.ts';

export class AiCommitError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** Rebase only a validated AI action onto the newest state. Never replay a provider call or overwrite a human snapshot. */
export async function saveAiResult(db: D1Database, workspaceId: string, actor: Actor, source: ShipmentDocument, action: Extract<Action, { type: 'add_ai_candidates' }>): Promise<WorkspaceState> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await readWorkspaceState(db, workspaceId, actor.id);
    if (!stored) throw new AiCommitError(403, 'Workspace membership is required.');
    const state = initializeDeclarationDrafts(stored);
    const current = state.documents.find(document => document.id === source.id && document.active);
    const shipment = state.cases.find(shipment => shipment.id === current?.caseId && !shipment.mergedInto);
    if (!current || current.version !== source.version || current.sha256 !== source.sha256 || current.referenceOnly || !shipment || shipment.status === 'completed') throw new AiCommitError(409, 'The source document or shipment changed while AI was reading. Its outdated result was not saved.');
    // The prompt reads this original only. Regrouping during another page read
    // can move the unchanged source; attach its evidence to its current open case.
    const next = applyAction(state, { ...action, caseId: current.caseId }, actor);
    next.revision = state.revision + 1;
    if (commitSucceeded((await db.batch(prepareWorkspaceCommit(db, next, state.revision, actor)))[0])) return next;
  }
  throw new AiCommitError(409, 'The workspace is changing too quickly to save this AI result. Retry after active edits finish.');
}
