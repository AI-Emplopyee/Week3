import { EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, type EdaField, type EcusExportForm } from './ecus-export.ts';
import { ecusSourceFingerprint, EcusTransferError } from './ecus-job-store.ts';
import type { Actor, WorkspaceState } from './types.ts';

export type EcusDraft = {
  revision: number;
  form: EcusExportForm;
  updatedAt: string;
  updatedBy: { id: string; name: string };
  sourceFingerprint: string;
  workspaceRevision: number;
};

type DraftRow = {
  revision: number; form_json: string; updated_at: number; updated_by: string; updated_by_name: string;
  source_fingerprint: string; source_workspace_revision: number;
};

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fieldLimit = (field: EdaField) => field.input === 'textarea' ? 4000 : field.input === 'code' ? 64 : 512;

function draftFields(value: unknown, fields: readonly EdaField[], path: string): Record<string, string> {
  if (!plainObject(value)) throw new EcusTransferError(422, `${path} must be an object.`);
  const allowed = new Map(fields.map(field => [field.key, field]));
  for (const [key, input] of Object.entries(value)) {
    const field = allowed.get(key);
    if (!field) throw new EcusTransferError(422, `${path}.${key} is not a supported EDA field.`);
    if (typeof input !== 'string' || input.length > fieldLimit(field) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
      throw new EcusTransferError(422, `${path}.${key} must be bounded plain text.`);
    }
  }
  // Saving work in progress must preserve unfinished dates, numbers and outer
  // whitespace. Submit applies the separate, stricter transfer validation.
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field.key)).map(field => [field.key, value[field.key] as string]));
}

export function parseEcusDraftForm(value: unknown): EcusExportForm {
  if (!plainObject(value) || Object.keys(value).some(key => !['headers', 'goods'].includes(key)) || !Object.hasOwn(value, 'headers') || !Object.hasOwn(value, 'goods')) {
    throw new EcusTransferError(422, 'EDA draft must contain only headers and goods.');
  }
  if (!Array.isArray(value.goods) || value.goods.length > 500) throw new EcusTransferError(422, 'EDA goods must be an array of at most 500 rows.');
  const rows: Array<Record<string, string>> = [];
  for (let index = 0; index < value.goods.length; index++) rows.push(draftFields(value.goods[index], EDA_GOODS_FIELDS, `goods[${index}]`));
  const form = { headers: draftFields(value.headers, EDA_HEADER_FIELDS, 'headers'), goods: rows };
  if (new TextEncoder().encode(JSON.stringify(form)).length > 512 * 1024) throw new EcusTransferError(413, 'The saved export form exceeds the size limit.');
  return form;
}

function publicDraft(row: DraftRow): EcusDraft {
  return {
    revision: row.revision, form: parseEcusDraftForm(JSON.parse(row.form_json)), updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: { id: row.updated_by, name: row.updated_by_name }, sourceFingerprint: row.source_fingerprint, workspaceRevision: row.source_workspace_revision,
  };
}

const memberExists = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)`;
const unresolvedTransfer = `EXISTS (SELECT 1 FROM ecus_export_jobs j WHERE j.workspace_id = ? AND j.case_id = ?
  AND NOT EXISTS (SELECT 1 FROM ecus_job_resolutions r WHERE r.job_id = j.id AND r.workspace_id = j.workspace_id
    AND r.payload_hash = j.payload_hash AND r.disposition = 'no_draft'))`;

async function requireMember(db: D1Database, workspaceId: string, actorId: string) {
  if (!await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, actorId).first()) {
    throw new EcusTransferError(403, 'Workspace membership is required to read or save the export form.');
  }
}

export async function getEcusDraft(db: D1Database, workspaceId: string, caseId: string, actorId: string): Promise<EcusDraft | null> {
  await requireMember(db, workspaceId, actorId);
  const row = await db.prepare(`SELECT * FROM ecus_export_drafts WHERE workspace_id = ? AND case_id = ? AND ${memberExists}`)
    .bind(workspaceId, caseId, workspaceId, actorId).first<DraftRow>();
  return row ? publicDraft(row) : null;
}

/** Compare-and-swap the separate draft and append its exact audit snapshot atomically. */
export async function saveEcusDraft(db: D1Database, state: WorkspaceState, actor: Actor, caseId: string, expectedDraftRevision: number, value: unknown, now = Date.now()): Promise<EcusDraft> {
  if (!Number.isSafeInteger(expectedDraftRevision) || expectedDraftRevision < 0 || expectedDraftRevision >= Number.MAX_SAFE_INTEGER) {
    throw new EcusTransferError(422, 'A valid saved-form revision is required.');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new EcusTransferError(422, 'A valid workspace revision is required.');
  const shipment = state.cases.find(item => item.id === caseId);
  if (!shipment || shipment.caseType !== 'export' || shipment.status === 'completed' || shipment.mergedInto) {
    throw new EcusTransferError(422, 'An open export shipment is required to save an EDA form.');
  }
  const form = parseEcusDraftForm(value);
  const formJson = JSON.stringify(form);
  const sourceFingerprint = await ecusSourceFingerprint(state, caseId);
  const saveId = `ecus_save_${crypto.randomUUID()}`;
  const nextRevision = expectedDraftRevision + 1;
  const results = await db.batch([
    db.prepare(`INSERT INTO ecus_export_drafts
      (workspace_id, case_id, revision, form_json, source_fingerprint, source_workspace_revision, updated_by, updated_by_name, updated_at, save_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND revision = ?) AND ${memberExists}
        AND NOT ${unresolvedTransfer}
        AND (? = 0 OR EXISTS (SELECT 1 FROM ecus_export_drafts WHERE workspace_id = ? AND case_id = ? AND revision = ?))
      ON CONFLICT(workspace_id, case_id) DO UPDATE SET revision = excluded.revision, form_json = excluded.form_json,
        source_fingerprint = excluded.source_fingerprint, source_workspace_revision = excluded.source_workspace_revision,
        updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at, save_id = excluded.save_id
      WHERE ecus_export_drafts.revision = ?`)
      .bind(state.id, caseId, nextRevision, formJson, sourceFingerprint, state.revision, actor.id, actor.name, now, saveId,
        state.id, state.revision, state.id, actor.id, state.id, caseId, expectedDraftRevision, state.id, caseId, expectedDraftRevision, expectedDraftRevision),
    db.prepare(`INSERT INTO ecus_export_draft_history
      (id, workspace_id, case_id, revision, form_json, source_fingerprint, source_workspace_revision, updated_by, updated_by_name, updated_at)
      SELECT save_id, workspace_id, case_id, revision, form_json, source_fingerprint, source_workspace_revision, updated_by, updated_by_name, updated_at
      FROM ecus_export_drafts WHERE workspace_id = ? AND case_id = ? AND save_id = ?`)
      .bind(state.id, caseId, saveId),
  ]);
  if (!results[0].meta.changes) {
    await requireMember(db, state.id, actor.id);
    if (await db.prepare(`SELECT 1 WHERE ${unresolvedTransfer}`).bind(state.id, caseId).first()) {
      throw new EcusTransferError(409, 'Resolve the existing ECUS transfer before editing this form.');
    }
    throw new EcusTransferError(409, 'The saved form or shipment changed. Reload the latest version before saving.');
  }
  // Read this save's immutable record, not the mutable latest row: another
  // employee may already have saved the next revision before this response.
  const saved = await db.prepare(`SELECT * FROM ecus_export_draft_history WHERE id = ? AND workspace_id = ? AND ${memberExists}`)
    .bind(saveId, state.id, state.id, actor.id).first<DraftRow>();
  if (!saved) throw new EcusTransferError(403, 'Workspace access changed while saving the export form.');
  return publicDraft(saved);
}
