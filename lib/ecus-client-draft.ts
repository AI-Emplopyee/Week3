import { EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, type EdaField, type EcusExportDifference, type EcusExportForm } from './ecus-export.ts';

export type EcusSavedDraft = { revision: number; form: EcusExportForm; updatedAt: string; updatedBy: { id: string; name: string }; sourceFingerprint: string; workspaceRevision: number; sourceChanged: boolean };
export type EcusDraftResponse = { draft: EcusSavedDraft | null; sourceFingerprint: string; workspaceRevision: number };
export type EcusLocalBackup = { form: EcusExportForm; baseRevision: number; sourceFingerprint: string };
export type EcusDraftEditor = {
  form: EcusExportForm; baseForm: EcusExportForm; baseRevision: number; serverDraft: EcusSavedDraft | null;
  loaded: boolean; conflict: boolean; sourceChanged: boolean; sourceFingerprint: string; workspaceRevision: number;
  localBackup: EcusLocalBackup | null;
};

/** Browser recovery accepts bounded incomplete text; submission validation remains separate. */
export function parseLocalEcusBackup(value: unknown): EcusLocalBackup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const form = data.form as EcusExportForm | undefined;
  const fieldsValid = (record: unknown, fields: readonly EdaField[]) => !!record && typeof record === 'object' && !Array.isArray(record) && Object.entries(record).every(([key, text]) => {
    const field = fields.find(item => item.key === key);
    return !!field && typeof text === 'string' && text.length <= (field.input === 'textarea' ? 4000 : field.input === 'code' ? 64 : 512) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
  });
  if (!form || Object.keys(form).some(key => key !== 'headers' && key !== 'goods') || !fieldsValid(form.headers, EDA_HEADER_FIELDS) || !Array.isArray(form.goods) || form.goods.length > 500 || !form.goods.every(row => fieldsValid(row, EDA_GOODS_FIELDS)) || new TextEncoder().encode(JSON.stringify(form)).length > 512 * 1024) return null;
  return { form: structuredClone(form), baseRevision: Number.isSafeInteger(data.baseRevision) && (data.baseRevision as number) >= 0 ? data.baseRevision as number : 0, sourceFingerprint: typeof data.sourceFingerprint === 'string' ? data.sourceFingerprint : '' };
}

export function ecusFormFingerprint(form: EcusExportForm): string {
  const ordered = (record: Record<string, string>, fields: readonly EdaField[]) => Object.fromEntries(fields.filter(field => record[field.key] !== undefined && record[field.key] !== '').map(field => [field.key, record[field.key]]));
  return JSON.stringify({ headers: ordered(form.headers, EDA_HEADER_FIELDS), goods: form.goods.map(row => ordered(row, EDA_GOODS_FIELDS)) });
}
export function ecusDraftIsDirty(editor: EcusDraftEditor): boolean { return ecusFormFingerprint(editor.form) !== ecusFormFingerprint(editor.baseForm); }
export function initialEcusDraftEditor(form: EcusExportForm, workspaceRevision: number): EcusDraftEditor {
  return { form: structuredClone(form), baseForm: structuredClone(form), baseRevision: 0, serverDraft: null, loaded: false, conflict: false, sourceChanged: false, sourceFingerprint: '', workspaceRevision, localBackup: null };
}

/** A polling response may update context; it never overwrites unsaved edits. */
export function receiveEcusDraft(editor: EcusDraftEditor, response: EcusDraftResponse, localBackup: EcusLocalBackup | null = null): EcusDraftEditor {
  const revision = response.draft?.revision || 0;
  if (editor.loaded && (revision < editor.baseRevision || response.workspaceRevision < editor.workspaceRevision)) return editor;
  const next = { ...editor, serverDraft: response.draft, loaded: true, sourceFingerprint: response.sourceFingerprint, sourceChanged: !!response.draft?.sourceChanged || editor.sourceChanged || (editor.loaded && editor.sourceFingerprint !== response.sourceFingerprint), workspaceRevision: response.workspaceRevision };
  if (!editor.loaded || (revision !== editor.baseRevision && !ecusDraftIsDirty(editor))) {
    const form = structuredClone(response.draft?.form || editor.form);
    return { ...next, form, baseForm: structuredClone(form), baseRevision: revision, conflict: false, sourceChanged: response.draft?.sourceChanged || false,
      localBackup: !editor.loaded && localBackup && ecusFormFingerprint(localBackup.form) !== ecusFormFingerprint(form) ? localBackup : editor.localBackup };
  }
  return { ...next, conflict: revision !== editor.baseRevision };
}

/** Explicitly choose the newer saved form, discarding current editor values. */
export function loadNewestEcusDraft(editor: EcusDraftEditor): EcusDraftEditor {
  if (!editor.serverDraft) return editor;
  const form = structuredClone(editor.serverDraft.form);
  return { ...editor, form, baseForm: structuredClone(form), baseRevision: editor.serverDraft.revision, conflict: false, sourceChanged: editor.serverDraft.sourceChanged, localBackup: null };
}

/** Called only after an employee compares and confirms keeping their local edits. */
export function keepEcusDraftEdits(editor: EcusDraftEditor): EcusDraftEditor {
  return { ...editor, baseForm: structuredClone(editor.serverDraft?.form || editor.baseForm), baseRevision: editor.serverDraft?.revision || 0, conflict: false, localBackup: null };
}
export function restoreEcusDraftBackup(editor: EcusDraftEditor): EcusDraftEditor {
  if (!editor.localBackup) return editor;
  const backup = editor.localBackup;
  return { ...editor, form: structuredClone(backup.form), baseRevision: backup.baseRevision, conflict: backup.baseRevision !== (editor.serverDraft?.revision || 0), localBackup: null };
}
export function acceptSavedEcusDraft(editor: EcusDraftEditor, response: EcusDraftResponse): EcusDraftEditor {
  if (!response.draft) throw new Error('The saved EDA draft was not returned.');
  if (response.draft.revision < Math.max(editor.baseRevision, editor.serverDraft?.revision || 0) || response.workspaceRevision < editor.workspaceRevision) return editor;
  const form = structuredClone(response.draft.form);
  return { ...editor, form, baseForm: structuredClone(form), baseRevision: response.draft.revision, serverDraft: response.draft, loaded: true, conflict: false, sourceChanged: response.draft.sourceChanged, sourceFingerprint: response.sourceFingerprint, workspaceRevision: response.workspaceRevision, localBackup: null };
}

/** Comparison of unfinished drafts deliberately does not require valid dates/numbers. */
export function editableEcusDifferences(expected: EcusExportForm, actual: EcusExportForm): EcusExportDifference[] {
  const result: EcusExportDifference[] = [];
  const compare = (left: Record<string, string>, right: Record<string, string>, fields: readonly EdaField[], prefix: string) => {
    for (const field of fields) if ((left[field.key] || '') !== (right[field.key] || '')) result.push({ path: `${prefix}.${field.key}`, expected: left[field.key] || '', actual: right[field.key] || '', message: '' });
  };
  compare(expected.headers, actual.headers, EDA_HEADER_FIELDS, 'headers');
  if (expected.goods.length !== actual.goods.length) result.push({ path: 'goods.length', expected: String(expected.goods.length), actual: String(actual.goods.length), message: '' });
  for (let index = 0; index < Math.max(expected.goods.length, actual.goods.length); index++) compare(expected.goods[index] || {}, actual.goods[index] || {}, EDA_GOODS_FIELDS, `goods[${index}]`);
  return result;
}

export function ecusFieldLabel(path: string, locale: 'vi' | 'en'): string {
  if (path === 'goods.length') return locale === 'vi' ? 'Số dòng hàng' : 'Goods row count';
  const goodsMatch = /^goods\[(\d+)\]\.(.+)$/.exec(path);
  const key = goodsMatch?.[2] || path.replace(/^headers\./, '');
  const field = (goodsMatch ? EDA_GOODS_FIELDS : EDA_HEADER_FIELDS).find(item => item.key === key);
  const label = field ? locale === 'vi' ? field.labelVi : field.labelEn : path;
  return goodsMatch ? `${locale === 'vi' ? 'Dòng hàng' : 'Goods row'} ${Number(goodsMatch[1]) + 1} · ${label}` : label;
}
