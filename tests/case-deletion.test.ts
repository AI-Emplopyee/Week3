import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { caseDeletionCommitGuard, cleanupDeletedCaseFiles, planCaseDeletion, prepareCaseDeletionCleanup } from '../lib/case-deletion.ts';
import { commitSucceeded, prepareWorkspaceCommit, readWorkspaceState } from '../lib/server-persistence.ts';
import { parseMutation } from '../lib/server-validation.ts';
import { storeVisionPage } from '../lib/vision-storage.ts';
import type { Actor, ShipmentDocument } from '../lib/types.ts';

const owner: Actor = { id: 'delete-owner', name: 'Synthetic owner', email: 'owner@example.invalid' };
function fixtures() {
  let state = createEmptyWorkspace('delete-workspace');
  state = applyAction(state, { type: 'create_case', title: 'Delete this case' }, owner);
  state = applyAction(state, { type: 'create_case', title: 'Keep this case' }, owner);
  const [deleted, kept] = state.cases;
  const document = (id: string, caseId: string, blobKey = `${state.id}/${id}`): ShipmentDocument => ({
    id, caseId, name: `${id}.txt`, type: 'other', mime: 'text/plain', size: 20, sha256: id,
    version: 1, active: true, uploadedAt: '2026-11-01T00:00:00Z', pages: [], extractionStatus: 'pending_ai', synthetic: true, blobKey,
  });
  state.documents = [document('remove-document', deleted.id), document('keep-document', kept.id)];
  deleted.documentIds = ['remove-document']; kept.documentIds = ['keep-document'];
  return { state, deleted, kept, document };
}

test('deletion requires explicit final confirmation and a live case', () => {
  const { state, deleted } = fixtures();
  assert.throws(() => parseMutation({ revision: state.revision, action: { type: 'delete_case', caseId: deleted.id } }));
  assert.throws(() => parseMutation({ revision: state.revision, action: { type: 'delete_case', caseId: deleted.id, confirmed: false } }));
  assert.equal(parseMutation({ revision: state.revision, action: { type: 'delete_case', caseId: deleted.id, confirmed: true } }).action.type, 'delete_case');
  assert.throws(() => applyAction(state, { type: 'delete_case', caseId: deleted.id, confirmed: false as true }, owner), /Confirm/);
  assert.throws(() => applyAction(state, { type: 'delete_case', caseId: 'missing', confirmed: true }, owner), /Case not found/);
});

test('deletion removes only the selected case and aliases, preserves shared correspondence and audit, and cannot reuse references', () => {
  const { state, deleted, kept, document } = fixtures();
  state.cases.push({ ...structuredClone(deleted), id: 'merged-alias', reference: 'AICD-0003', mergedInto: deleted.id, documentIds: ['old-version'] });
  state.documents.push({ ...document('old-version', 'merged-alias'), active: false });
  state.emailDrafts = [deleted, kept].map((item, index) => ({ id: `draft-${index}`, caseId: item.id, issueIds: [], recipient: '', subject: 'Question', body: 'Question', status: 'draft' as const, createdBy: owner.id, createdAt: 'now', updatedAt: 'now' }));
  state.emails = [{ id: 'email-shared', messageId: 'shared', sender: 'sender@example.invalid', subject: 'Shared shipment mail', receivedAt: 'now', originalName: 'original.eml', blobKey: `${state.id}/email-shared`, documentIds: ['remove-document', 'keep-document'], sha256: 'shared', shipmentMatches: [deleted, kept].map((item, index) => ({ id: `match-${index}`, caseId: item.id, status: 'matched', evidence: [], reason: 'Synthetic evidence', model: 'synthetic', createdAt: 'now', updatedAt: 'now', decisionSource: 'human' })) }];
  state.snapshots = [deleted, kept].map(item => ({ id: `snapshot-${item.id}`, caseId: item.id, createdAt: 'now', actor: owner.name, version: 1, declaration: structuredClone(item), candidates: [], documents: state.documents.filter(doc => doc.caseId === item.id), issues: [], customsValidation: 'Not yet assessed' }));
  state.handoffs = [deleted, kept].map(item => ({ id: `handoff-${item.id}`, caseId: item.id, snapshotId: `snapshot-${item.id}`, idempotencyKey: item.id, at: 'now', actor: owner.name, connector: 'test', status: 'succeeded', message: 'Synthetic', idaStatus: 'not_transmitted', idcStatus: 'not_registered', customsOutcome: 'not_assessed' }));
  state.clientMemories = [{ id: 'memory-deleted', identity: { importerCode: '123', name: 'Importer', address: '' }, fieldKey: 'importer', value: 'Importer', previousValue: '', reason: 'Synthetic', basis: 'Synthetic', sourceCaseId: deleted.id, sourceReference: deleted.reference, sourceCaseTitle: deleted.title, createdAt: 'now', createdBy: { id: owner.id, name: owner.name }, origin: 'human_correction', status: 'active' }];
  state.emailDrafts[1].automation = { pendingClientMemoryIds: ['memory-deleted'], locale: 'en', sourceFingerprint: 'synthetic', generatedSubject: 'Question', generatedBody: 'Question', questionCount: 1, state: 'ready' };
  const before = structuredClone(state);
  const next = applyAction(state, { type: 'delete_case', caseId: deleted.id, confirmed: true }, owner);
  assert.deepEqual(state, before, 'the input snapshot must not be mutated');
  assert.deepEqual(next.cases.map(item => item.id), [kept.id]);
  assert.deepEqual(next.documents.map(item => item.id), ['keep-document']);
  assert.deepEqual(next.emails[0].documentIds, ['keep-document']);
  assert.equal(next.emails[0].blobKey, `${state.id}/email-shared`);
  assert.deepEqual(next.emails[0].shipmentMatches?.map(item => item.caseId), [kept.id]);
  assert.deepEqual(next.emailDrafts?.map(item => item.caseId), [kept.id]);
  assert.deepEqual(next.snapshots.map(item => item.caseId), [kept.id]);
  assert.deepEqual(next.handoffs.map(item => item.caseId), [kept.id]);
  assert.deepEqual(next.clientMemories, []);
  assert.deepEqual(next.emailDrafts?.[0].automation?.pendingClientMemoryIds, []);
  assert.deepEqual(next.audit.slice(0, before.audit.length), before.audit);
  assert.equal(next.audit.at(-1)?.action, 'case_deleted');
  const afterCreate = applyAction(next, { type: 'create_case', title: 'A later case' }, owner);
  assert.equal(afterCreate.cases.at(-1)?.reference, 'AICD-0004');
  const afterAllDeleted = applyAction(applyAction(afterCreate, { type: 'delete_case', caseId: kept.id, confirmed: true }, owner), { type: 'delete_case', caseId: afterCreate.cases.at(-1)!.id, confirmed: true }, owner);
  assert.equal(applyAction(afterAllDeleted, { type: 'create_case', title: 'First visible case' }, owner).cases[0].reference, 'AICD-0005');
});

test('cleanup plans retain original bytes used by another case, snapshot, or email', () => {
  const { state, deleted, kept, document } = fixtures();
  state.documents.push(document('shared-record', deleted.id, state.documents[1].blobKey));
  state.documents.push(document('email-attachment', deleted.id, `${state.id}/email-shared`));
  state.documents.push(document('snapshot-source', deleted.id));
  state.emails = [{ id: 'email-shared', messageId: 'shared', sender: '', subject: '', receivedAt: 'now', originalName: 'original.eml', blobKey: `${state.id}/email-shared`, documentIds: [], sha256: 'shared' }];
  state.snapshots = [{ id: 'snapshot-kept', caseId: kept.id, createdAt: 'now', actor: owner.name, version: 1, declaration: kept, candidates: [], documents: [state.documents.at(-1)!], issues: [], customsValidation: 'Not yet assessed' }];
  const plan = planCaseDeletion(state, deleted.id);
  assert.deepEqual(plan.originalKeys, [`${state.id}/remove-document`]);
  assert.ok(!plan.visionPrefixes.includes(`${state.id}/vision/snapshot-source/`));
});

class Statement {
  readonly database: DatabaseSync;
  readonly sql: string;
  readonly values: SQLInputValue[];
  constructor(database: DatabaseSync, sql: string, values: SQLInputValue[] = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values: SQLInputValue[]) { return new Statement(this.database, this.sql, values); }
  async run() { return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.values).changes) } }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const db = {
    prepare(sql: string) { return new Statement(sqlite, sql); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const fixture = fixtures();
  const { state, deleted } = fixture;
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(state.id, owner.id, state.revision, JSON.stringify(state), 'now', 'now');
  sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, owner.email, owner.id, 'owner', owner.id, 'now');
  sqlite.prepare('INSERT INTO ai_processing_jobs (workspace_id, document_id, document_version, sha256, page) VALUES (?, ?, 1, ?, 1)').run(state.id, 'remove-document', 'remove-document');
  sqlite.prepare('INSERT INTO ecus_export_drafts (workspace_id, case_id, revision, form_json, source_fingerprint, source_workspace_revision, updated_by, updated_by_name, updated_at, save_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0, ?)').run(state.id, deleted.id, '{}', 'source', state.revision, owner.id, owner.name, 'save-delete');
  sqlite.prepare('INSERT INTO ecus_export_draft_history (id, workspace_id, case_id, revision, form_json, source_fingerprint, source_workspace_revision, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0)').run('save-delete', state.id, deleted.id, '{}', 'source', state.revision, owner.id, owner.name);
  const next = applyAction(state, { type: 'delete_case', caseId: deleted.id, confirmed: true }, owner);
  const plan = planCaseDeletion(state, deleted.id);
  const statements = (actor = owner) => [
    ...prepareWorkspaceCommit(db, next, state.revision, actor, caseDeletionCommitGuard(state.id, plan.caseIds, actor.id)),
    ...prepareCaseDeletionCleanup(db, next, actor, plan),
  ];
  const count = (table: string) => Number(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  function job(status: string) {
    sqlite.prepare('INSERT INTO ecus_devices (id, workspace_id, created_by, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)').run('device', state.id, owner.id, 'Synthetic', 'token');
    sqlite.prepare('INSERT INTO ecus_export_jobs (id, workspace_id, device_id, case_id, approved_by, source_fingerprint, approval_hash, payload_json, payload_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 100)').run('job', state.id, 'device', deleted.id, owner.id, 'source', 'approval', '{}', 'hash', status);
  }
  function resolve(acknowledged: boolean) {
    sqlite.prepare('INSERT INTO ecus_job_resolutions (id, job_id, workspace_id, payload_hash, disposition, actor_id, actor_name, reason, created_at, device_ack_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run('resolution', 'job', state.id, 'hash', 'draft_kept', owner.id, owner.name, 'Synthetic inspection', acknowledged ? 1 : null);
  }
  return { ...fixture, db, sqlite, next, plan, statements, count, job, resolve };
}

test('case deletion commits state, AI/draft cleanup and durable object cleanup together', async () => {
  const f = database();
  try {
    const results = await f.db.batch(f.statements());
    assert.equal(commitSucceeded(results[0]), true);
    assert.deepEqual(await readWorkspaceState(f.db, f.state.id, owner.id), f.next);
    for (const table of ['ai_processing_jobs', 'ecus_export_drafts', 'ecus_export_draft_history']) assert.equal(f.count(table), 0);
    assert.equal(f.count('case_file_cleanup'), 1);
  } finally { f.sqlite.close(); }
});

test('stale or demoted writers cannot delete records, saved forms, jobs or originals', async () => {
  for (const failure of ['stale', 'demoted', 'outsider']) {
    const f = database();
    try {
      if (failure === 'stale') f.sqlite.prepare('UPDATE workspaces SET revision = revision + 1').run();
      if (failure === 'demoted') f.sqlite.prepare("UPDATE workspace_members SET role = 'reviewer'").run();
      const results = await f.db.batch(f.statements(failure === 'outsider' ? { ...owner, id: 'outsider' } : owner));
      assert.ok(results.every(result => result.meta.changes === 0));
      assert.equal(f.count('ai_processing_jobs'), 1);
      assert.equal(f.count('ecus_export_drafts'), 1);
      assert.equal(f.count('ecus_export_draft_history'), 1);
      assert.equal(f.count('case_file_cleanup'), 0);
    } finally { f.sqlite.close(); }
  }
});

test('ECUS jobs appearing before the commit block deletion until terminal or acknowledged recovery', async () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled', 'needs_reconciliation', 'succeeded']) {
    const f = database();
    try {
      const planned = f.statements();
      f.job(status); // The transfer appeared after the caller planned deletion.
      const results = await f.db.batch(planned);
      assert.equal(commitSucceeded(results[0]), status === 'succeeded');
      assert.equal(f.count('ecus_export_jobs'), 1, 'immutable transfer history stays');
      assert.equal(f.count('case_file_cleanup'), status === 'succeeded' ? 1 : 0);
      if (['failed', 'cancelled', 'needs_reconciliation'].includes(status)) {
        f.resolve(false);
        assert.equal(commitSucceeded((await f.db.batch(f.statements()))[0]), false);
        f.sqlite.prepare('UPDATE ecus_job_resolutions SET device_ack_at = 1').run();
        assert.equal(commitSucceeded((await f.db.batch(f.statements()))[0]), true);
        assert.equal(f.count('ecus_job_resolutions'), 1);
      }
    } finally { f.sqlite.close(); }
  }
});

test('cleanup storage failures are retryable and never touch another workspace or retained files', async () => {
  const f = database();
  try {
    await f.db.batch(f.statements());
    const objects = new Set([`${f.state.id}/remove-document`, `${f.state.id}/vision/remove-document/v1/page.jpg`, `${f.state.id}/keep-document`, `${f.state.id}/email-shared`, 'other-workspace/original']);
    let unavailable = true;
    const storage = {
      async delete(keys: string | string[]) {
        if (unavailable) throw new Error('Storage unavailable');
        for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
      },
      async list({ prefix }: { prefix: string }) { return { objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    } as unknown as Pick<R2Bucket, 'delete' | 'list'>;
    await assert.rejects(cleanupDeletedCaseFiles(f.db, storage, f.state.id), /unavailable/);
    assert.equal(f.count('case_file_cleanup'), 1);
    unavailable = false;
    await cleanupDeletedCaseFiles(f.db, storage, f.state.id);
    assert.deepEqual([...objects], [`${f.state.id}/keep-document`, `${f.state.id}/email-shared`, 'other-workspace/original']);
    assert.equal(f.count('case_file_cleanup'), 0);
    await cleanupDeletedCaseFiles(f.db, storage, f.state.id);
  } finally { f.sqlite.close(); }
});

test('failure to queue object cleanup rolls the entire deletion back', async () => {
  const f = database();
  try {
    f.sqlite.exec("CREATE TRIGGER reject_cleanup BEFORE INSERT ON case_file_cleanup BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END;");
    await assert.rejects(f.db.batch(f.statements()), /cleanup unavailable/);
    assert.deepEqual(await readWorkspaceState(f.db, f.state.id, owner.id), f.state);
    assert.equal(f.count('ai_processing_jobs'), 1);
    assert.equal(f.count('ecus_export_drafts'), 1);
  } finally { f.sqlite.close(); }
});

test('a page put paused across case deletion is fenced even after its first cleanup completed', async () => {
  const f = database();
  try {
    const objects = new Set([`${f.state.id}/remove-document`, `${f.state.id}/keep-document`]);
    let resume!: () => void;
    let putStarted!: () => void;
    const started = new Promise<void>(resolve => { putStarted = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    let failCleanup = false;
    const storage = {
      async put(key: string) { putStarted(); await paused; objects.add(key); },
      async delete(keys: string | string[]) {
        if (failCleanup) throw new Error('Temporary delete failure');
        for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
      },
      async list({ prefix }: { prefix: string }) { return { objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    } as unknown as Pick<R2Bucket, 'put' | 'delete' | 'list'>;
    const lateKey = `${f.state.id}/vision/remove-document/v1/hash/1/image.jpg`;
    const pending = storeVisionPage(f.db, storage, f.state.id, 'remove-document', lateKey, new Uint8Array([1]));
    await started;
    await f.db.batch(f.statements());
    await cleanupDeletedCaseFiles(f.db, storage, f.state.id);
    assert.equal(f.count('case_file_cleanup'), 0);
    failCleanup = true;
    resume();
    assert.equal(await pending, false, 'the deleted document never receives an accepted raster');
    assert.equal(f.count('case_file_cleanup'), 1, 'the late write has a new durable retry');
    failCleanup = false;
    await cleanupDeletedCaseFiles(f.db, storage, f.state.id);
    assert.deepEqual([...objects], [`${f.state.id}/keep-document`]);
    assert.equal(f.count('case_file_cleanup'), 0);
  } finally { f.sqlite.close(); }
});

test('deleting the last snapshot owner cleans a previously deleted document and upgrades its late-write tombstone', async () => {
  const f = database();
  try {
    // The document now belongs to B (deleted), but A (kept) holds its old review snapshot.
    const original = f.state.documents.find(item => item.id === 'remove-document')!;
    f.state.snapshots = [{ id: 'snapshot-before-move', caseId: f.kept.id, createdAt: 'now', actor: owner.name, version: 1,
      declaration: structuredClone(f.kept), candidates: [], documents: [structuredClone(original)], issues: [], customsValidation: 'Not yet assessed' }];
    f.sqlite.prepare('UPDATE workspaces SET state_json = ? WHERE id = ?').run(JSON.stringify(f.state), f.state.id);
    const deleteSnapshotFirst = planCaseDeletion(f.state, f.kept.id);
    assert.ok(!deleteSnapshotFirst.retiredDocumentIds.includes(original.id), 'a live document in another case cannot be tombstoned');
    const raster = `${f.state.id}/vision/${original.id}/v1/hash/1/image.jpg`;
    const objects = new Set([original.blobKey!, raster, `${f.state.id}/keep-document`, 'another-workspace/file']);
    const storage = {
      async put(key: string) { objects.add(key); },
      async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
      async list({ prefix }: { prefix: string }) { return { objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    } as unknown as Pick<R2Bucket, 'put' | 'delete' | 'list'>;
    const firstPlan = planCaseDeletion(f.state, f.deleted.id);
    const first = applyAction(f.state, { type: 'delete_case', caseId: f.deleted.id, confirmed: true }, owner);
    await f.db.batch([
      ...prepareWorkspaceCommit(f.db, first, f.state.revision, owner, caseDeletionCommitGuard(f.state.id, firstPlan.caseIds, owner.id)),
      ...prepareCaseDeletionCleanup(f.db, first, owner, firstPlan),
    ]);
    await cleanupDeletedCaseFiles(f.db, storage, f.state.id);
    assert.equal(f.sqlite.prepare('SELECT cleanup_vision FROM deleted_case_documents WHERE document_id = ?').get(original.id)!.cleanup_vision, 0);
    assert.ok(objects.has(original.blobKey!)); assert.ok(objects.has(raster));
    assert.ok(!first.documents.some(item => item.id === original.id));

    const lastPlan = planCaseDeletion(first, f.kept.id);
    assert.ok(lastPlan.retiredDocumentIds.includes(original.id));
    const last = applyAction(first, { type: 'delete_case', caseId: f.kept.id, confirmed: true }, owner);
    await f.db.batch([
      ...prepareWorkspaceCommit(f.db, last, first.revision, owner, caseDeletionCommitGuard(first.id, lastPlan.caseIds, owner.id)),
      ...prepareCaseDeletionCleanup(f.db, last, owner, lastPlan),
    ]);
    await cleanupDeletedCaseFiles(f.db, storage, first.id);
    assert.equal(f.sqlite.prepare('SELECT cleanup_vision FROM deleted_case_documents WHERE document_id = ?').get(original.id)!.cleanup_vision, 1);
    assert.deepEqual([...objects], ['another-workspace/file']);
    assert.equal(await storeVisionPage(f.db, storage, first.id, original.id, raster, new Uint8Array([1])), false);
    assert.deepEqual([...objects], ['another-workspace/file']);
  } finally { f.sqlite.close(); }
});
