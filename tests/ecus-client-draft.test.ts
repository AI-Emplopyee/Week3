import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptSavedEcusDraft, ecusDraftIsDirty, ecusFieldLabel, ecusFormFingerprint, editableEcusDifferences, initialEcusDraftEditor, keepEcusDraftEdits, loadNewestEcusDraft, parseLocalEcusBackup, receiveEcusDraft, restoreEcusDraftBackup, type EcusDraftResponse, type EcusSavedDraft } from '../lib/ecus-client-draft.ts';
import type { EcusExportForm } from '../lib/ecus-export.ts';

const form = (name: string): EcusExportForm => ({ headers: { exporterName: name, invoiceDate: 'unfinished-date' }, goods: [{ description: 'Synthetic goods', quantity: '1.' }] });
const draft = (revision: number, name: string): EcusSavedDraft => ({ revision, form: form(name), updatedAt: '2026-10-26T12:00:00Z', updatedBy: { id: 'synthetic-reviewer', name: 'Synthetic employee' }, sourceFingerprint: 'source-one', workspaceRevision: 10, sourceChanged: false });
const response = (saved: EcusSavedDraft | null, workspaceRevision = 10): EcusDraftResponse => ({ draft: saved, workspaceRevision, sourceFingerprint: 'source-one' });
const initial = () => initialEcusDraftEditor(form('Suggested value'), 10);

test('server draft is authoritative on load; differing browser recovery is offered without adopting it', () => {
  const recovery = { form: form('Unsaved tab value'), baseRevision: 1, sourceFingerprint: 'old-source' };
  const loaded = receiveEcusDraft(initial(), response(draft(2, 'Server value')), recovery);
  assert.equal(loaded.form.headers.exporterName, 'Server value');
  assert.equal(loaded.baseRevision, 2);
  assert.equal(ecusDraftIsDirty(loaded), false);
  assert.deepEqual(loaded.localBackup, recovery);
  const restored = restoreEcusDraftBackup(loaded);
  assert.equal(restored.form.headers.exporterName, 'Unsaved tab value');
  assert.equal(restored.conflict, true);
  assert.equal(ecusDraftIsDirty(restored), true);
  assert.equal(restored.localBackup, null);
});

test('polling preserves unsaved values and flags a newer server version without hiding source changes', () => {
  const loaded = receiveEcusDraft(initial(), response(draft(1, 'Original server value')));
  loaded.form = form('Unsaved editor value');
  const incoming = { ...draft(2, 'Other employee value'), sourceChanged: true };
  const conflict = receiveEcusDraft(loaded, { ...response(incoming, 11), sourceFingerprint: 'source-two' });
  assert.equal(conflict.form.headers.exporterName, 'Unsaved editor value');
  assert.equal(conflict.baseRevision, 1);
  assert.equal(conflict.serverDraft?.revision, 2);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.sourceChanged, true);
  assert.equal(conflict.workspaceRevision, 11);
  assert.equal(conflict.sourceFingerprint, 'source-two');
});

test('conflict choices separately discard edits or prepare explicitly reviewed edits for a CAS save', () => {
  const loaded = receiveEcusDraft(initial(), response(draft(1, 'Original value')));
  loaded.form = form('My reviewed value');
  const conflict = receiveEcusDraft(loaded, response(draft(2, 'Other employee value')));
  const newer = loadNewestEcusDraft(conflict);
  assert.equal(newer.form.headers.exporterName, 'Other employee value');
  assert.equal(newer.baseRevision, 2);
  assert.equal(newer.conflict, false);
  assert.equal(ecusDraftIsDirty(newer), false);
  const kept = keepEcusDraftEdits(conflict);
  assert.equal(kept.form.headers.exporterName, 'My reviewed value');
  assert.equal(kept.baseRevision, 2);
  assert.equal(kept.conflict, false);
  assert.equal(ecusDraftIsDirty(kept), true);
  assert.equal(conflict.form.headers.exporterName, 'My reviewed value');
});

test('clean editors follow newer saved versions; late responses cannot undo an accepted save', () => {
  const loaded = receiveEcusDraft(initial(), response(draft(1, 'First version')));
  const polled = receiveEcusDraft(loaded, response(draft(2, 'Second version'), 11));
  assert.equal(polled.form.headers.exporterName, 'Second version');
  assert.equal(ecusDraftIsDirty(polled), false);
  const saved = acceptSavedEcusDraft(polled, response(draft(3, 'Saved current value'), 12));
  assert.equal(receiveEcusDraft(saved, response(draft(2, 'Old response'), 12)), saved);
  assert.equal(receiveEcusDraft(saved, response(draft(3, 'Old workspace response'), 11)), saved);
  assert.equal(saved.form.headers.exporterName, 'Saved current value');
  assert.throws(() => acceptSavedEcusDraft(saved, response(null)), /not returned/);
});

test('saving and browser recovery preserve unfinished formats and outer whitespace', () => {
  const value = form('  Employee typed text  ');
  const backup = parseLocalEcusBackup({ form: value, baseRevision: 4, sourceFingerprint: 'source' });
  assert.ok(backup);
  assert.deepEqual(backup.form, value);
  assert.equal(backup.form.goods[0].quantity, '1.');
  assert.equal(backup.form.headers.invoiceDate, 'unfinished-date');
  value.headers.exporterName = 'later mutation';
  assert.equal(backup.form.headers.exporterName, '  Employee typed text  ');
  const saved = acceptSavedEcusDraft(initial(), response({ ...draft(5, ''), form: backup.form }));
  assert.equal(ecusDraftIsDirty(saved), false);
  assert.deepEqual(saved.form, backup.form);
});

test('source changes warn even before the first server save and remain flagged until explicit saving', () => {
  const loaded = receiveEcusDraft(initial(), response(null));
  loaded.form = form('Unsaved suggested or typed values');
  const changed = receiveEcusDraft(loaded, { ...response(null, 11), sourceFingerprint: 'source-two' });
  assert.equal(changed.sourceChanged, true);
  assert.equal(changed.form.headers.exporterName, 'Unsaved suggested or typed values');
  const polled = receiveEcusDraft(changed, { ...response(null, 11), sourceFingerprint: 'source-two' });
  assert.equal(polled.sourceChanged, true);
  const saved = acceptSavedEcusDraft(polled, { draft: { ...draft(1, 'Unsaved suggested or typed values'), sourceFingerprint: 'source-two', workspaceRevision: 11 }, sourceFingerprint: 'source-two', workspaceRevision: 11 });
  assert.equal(saved.sourceChanged, false);
});

test('a delayed save response cannot regress a newer observed draft or source revision', () => {
  const loaded = receiveEcusDraft(initial(), response(draft(1, 'Original')));
  loaded.form = form('My edits');
  const conflict = receiveEcusDraft(loaded, response(draft(3, 'Newer saved version'), 11));
  assert.equal(acceptSavedEcusDraft(conflict, response(draft(2, 'My edits'), 11)), conflict);
  const sourceChanged = receiveEcusDraft(loaded, { ...response(draft(1, 'Original'), 12), sourceFingerprint: 'new-source' });
  assert.equal(acceptSavedEcusDraft(sourceChanged, response(draft(2, 'My edits'), 11)), sourceChanged);
});

test('recovery accepts older browser copies but rejects unsupported keys and oversized fields or rows', () => {
  assert.equal(parseLocalEcusBackup({ form: form('Legacy'), submittedFingerprint: 'old' })?.baseRevision, 0);
  for (const invalid of [
    { headers: { '1.12': 'import value' }, goods: [] },
    { headers: { exporterName: 'x'.repeat(513) }, goods: [] },
    { headers: { declarationType: 'x'.repeat(65) }, goods: [] },
    { headers: { exporterName: '\u0000' }, goods: [] },
    { headers: {}, goods: Array.from({ length: 501 }, () => ({})) },
    { headers: {}, goods: [], direction: 'import' },
  ]) assert.equal(parseLocalEcusBackup({ form: invalid }), null);
});

test('dirty comparison ignores JSON key order and absent empty fields, but preserves meaningful whitespace and row order', () => {
  const first: EcusExportForm = { headers: { exporterName: 'Synthetic', invoiceNumber: 'TEST', remarks: '' }, goods: [{ description: 'First', quantity: '1.' }, { description: 'Second' }] };
  const reordered: EcusExportForm = { headers: { invoiceNumber: 'TEST', exporterName: 'Synthetic' }, goods: [{ quantity: '1.', description: 'First' }, { description: 'Second' }] };
  assert.equal(ecusFormFingerprint(first), ecusFormFingerprint(reordered));
  assert.notEqual(ecusFormFingerprint(first), ecusFormFingerprint({ ...first, headers: { ...first.headers, exporterName: ' Synthetic' } }));
  assert.notEqual(ecusFormFingerprint(first), ecusFormFingerprint({ ...first, goods: [...first.goods].reverse() }));
});

test('review comparisons identify changed, extra and missing unfinished values with bilingual field labels', () => {
  const expected = form('Server name');
  const actual = form('Local name'); actual.goods.push({ quantity: 'invalid draft value' });
  const differences = editableEcusDifferences(expected, actual);
  assert.deepEqual(differences.map(value => value.path), ['headers.exporterName', 'goods.length', 'goods[1].quantity']);
  assert.equal(differences[2].actual, 'invalid draft value');
  assert.match(ecusFieldLabel('goods[1].quantity', 'en'), /Goods row 2/);
  assert.match(ecusFieldLabel('goods[1].quantity', 'vi'), /Dòng hàng 2/);
  assert.equal(ecusFieldLabel('goods.length', 'en'), 'Goods row count');
});
