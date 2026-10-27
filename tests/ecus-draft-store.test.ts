import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { getEcusDraft, parseEcusDraftForm, saveEcusDraft } from '../lib/ecus-draft-store.ts';
import { validateEcusExportForm, type EcusExportForm } from '../lib/ecus-export.ts';
import { ecusSourceFingerprint } from '../lib/ecus-job-store.ts';
import type { Actor, WorkspaceState } from '../lib/types.ts';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const owner: Actor = { id: 'draft-owner', email: 'draft-owner@example.invalid', name: 'Synthetic draft owner' };
const reviewer: Actor = { id: 'draft-reviewer', email: 'draft-reviewer@example.invalid', name: 'Synthetic second employee' };

class Statement {
  readonly database: DatabaseSync;
  readonly sql: string;
  readonly values: SQLInputValue[];
  readonly before: (sql: string) => void;
  constructor(database: DatabaseSync, sql: string, values: SQLInputValue[] = [], before: (sql: string) => void = () => {}) {
    this.database = database; this.sql = sql; this.values = values; this.before = before;
  }
  bind(...values: SQLInputValue[]) { return new Statement(this.database, this.sql, values, this.before); }
  execute() { this.before(this.sql); return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.values).changes) } }; }
  async run() { return this.execute(); }
  async first() { this.before(this.sql); return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { this.before(this.sql); return { results: this.database.prepare(this.sql).all(...this.values) }; }
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const migration of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(migration, migrations), 'utf8'));
  let beforeStatement: ((sql: string) => void) | undefined;
  const db = {
    prepare(sql: string) { return new Statement(sqlite, sql, [], sql => beforeStatement?.(sql)); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  function workspace(id = 'draft-workspace', actor = owner) {
    let state = createEmptyWorkspace(id);
    for (let index = 0; index < 2; index++) state = applyAction(state, { type: 'create_case', title: `Synthetic export draft ${index + 1}`, caseType: 'export' }, actor);
    sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.id, state.revision, JSON.stringify(state), 'now', 'now');
    sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.email, actor.id, 'owner', actor.id, 'now');
    return state;
  }
  function storeState(state: WorkspaceState) { sqlite.prepare('UPDATE workspaces SET revision = ?, state_json = ? WHERE id = ?').run(state.revision, JSON.stringify(state), state.id); }
  function addReviewer(state: WorkspaceState) { sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, reviewer.email, reviewer.id, 'reviewer', owner.id, 'now'); }
  function interceptOnce(pattern: string, change: () => void) {
    let intercepted = false;
    beforeStatement = sql => { if (!intercepted && sql.includes(pattern)) { intercepted = true; change(); } };
    return () => intercepted;
  }
  function addJob(state: WorkspaceState, status: string, caseId = state.cases[0].id) {
    const id = `synthetic-${crypto.randomUUID()}`;
    sqlite.prepare('INSERT OR IGNORE INTO ecus_devices (id, workspace_id, created_by, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`device-${state.id}`, state.id, owner.id, 'Synthetic computer', 'synthetic', NOW);
    sqlite.prepare('INSERT INTO ecus_export_jobs (id, workspace_id, device_id, case_id, approved_by, source_fingerprint, approval_hash, payload_json, payload_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, state.id, `device-${state.id}`, caseId, owner.id, 'fingerprint', id, '{}', 'synthetic-hash', status, NOW, NOW + 60_000);
    return id;
  }
  function resolve(state: WorkspaceState, jobId: string, disposition: 'no_draft' | 'draft_kept') {
    sqlite.prepare('INSERT INTO ecus_job_resolutions (id, job_id, workspace_id, payload_hash, disposition, actor_id, actor_name, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`resolution-${jobId}`, jobId, state.id, 'synthetic-hash', disposition, owner.id, owner.name, 'Synthetic operator inspection', NOW);
  }
  const count = (table: string) => Number(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  return { db, sqlite, workspace, storeState, addReviewer, interceptOnce, addJob, resolve, count };
}

const incomplete = (): EcusExportForm => ({ headers: { exporterName: '  Nhà xuất khẩu 📦  ', invoiceDate: '2026-', invoiceTotal: '1,2.' }, goods: [{ description: 'Dòng đang nhập\nChưa hoàn tất', quantity: '.', hsCode: 'pending?' }] });
const denied = (status: number) => (error: unknown) => error instanceof Error && 'status' in error && error.status === status;

test('draft parsing preserves unfinished values and whitespace while transfer validation remains strict', () => {
  const form = incomplete();
  assert.deepEqual(parseEcusDraftForm(form), form);
  assert.ok(validateEcusExportForm(form).length);
  assert.deepEqual(parseEcusDraftForm({ headers: {}, goods: [] }), { headers: {}, goods: [] });
  const reversed = { headers: Object.fromEntries(Object.entries(form.headers).reverse()), goods: form.goods };
  assert.equal(JSON.stringify(parseEcusDraftForm(reversed)), JSON.stringify(parseEcusDraftForm(form)));
});

test('draft parsing rejects unknown keys, unsafe values and excessive UTF-8 data', () => {
  for (const value of [
    null, [], { headers: {}, goods: [], hidden: true }, { headers: { extra: 'x' }, goods: [] },
    { headers: {}, goods: [{ nonexistent: '' }] }, { headers: { exporterName: 42 }, goods: [] },
    { headers: { exporterName: 'x\u0000y' }, goods: [] }, { headers: { exporterName: 'x\u001by' }, goods: [] },
    { headers: { exporterName: 'x'.repeat(513) }, goods: [] }, { headers: { currency: 'x'.repeat(65) }, goods: [] },
    { headers: {}, goods: Array.from({ length: 501 }, () => ({})) }, { headers: {}, goods: [undefined] },
  ]) assert.throws(() => parseEcusDraftForm(value), denied(422));
  const huge = { headers: {}, goods: Array.from({ length: 500 }, () => ({ description: '越'.repeat(4000) })) };
  assert.throws(() => parseEcusDraftForm(huge), denied(413));
});

test('saved drafts reopen for another employee without changing the workspace revision and retain audit snapshots', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); f.addReviewer(state);
  const caseId = state.cases[0].id; const originalRevision = state.revision;
  assert.equal(await getEcusDraft(f.db, state.id, caseId, owner.id), null);
  const first = await saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW);
  assert.equal(first.revision, 1); assert.deepEqual(first.form, incomplete()); assert.equal(first.updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(first.updatedBy, { id: owner.id, name: owner.name });
  assert.equal(first.workspaceRevision, originalRevision); assert.equal(first.sourceFingerprint, await ecusSourceFingerprint(state, caseId));
  assert.deepEqual(await getEcusDraft(f.db, state.id, caseId, reviewer.id), first);
  const secondForm = incomplete(); secondForm.headers.exporterName = 'Updated by colleague';
  const second = await saveEcusDraft(f.db, state, reviewer, caseId, 1, secondForm, NOW + 1000);
  assert.equal(second.revision, 2); assert.deepEqual(second.updatedBy, { id: reviewer.id, name: reviewer.name });
  assert.deepEqual(await getEcusDraft(f.db, state.id, caseId, owner.id), second);
  assert.equal(f.sqlite.prepare('SELECT revision FROM workspaces WHERE id = ?').get(state.id)!.revision, originalRevision);
  const history = f.sqlite.prepare('SELECT * FROM ecus_export_draft_history ORDER BY revision').all();
  assert.equal(history.length, 2); assert.deepEqual(JSON.parse(String(history[0].form_json)), incomplete());
  assert.equal(history[0].updated_by, owner.id); assert.equal(history[1].updated_by, reviewer.id);
});

test('drafts are isolated by workspace and case and inaccessible after membership removal', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const caseId = state.cases[0].id;
  await saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW);
  assert.equal(await getEcusDraft(f.db, state.id, state.cases[1].id, owner.id), null);
  const other = f.workspace('other-draft-workspace', reviewer);
  await assert.rejects(getEcusDraft(f.db, state.id, caseId, reviewer.id), denied(403));
  await assert.rejects(saveEcusDraft(f.db, state, reviewer, caseId, 1, incomplete(), NOW), denied(403));
  assert.equal(await getEcusDraft(f.db, other.id, caseId, reviewer.id), null);
  f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(state.id);
  await assert.rejects(getEcusDraft(f.db, state.id, caseId, owner.id), denied(403));
  assert.equal(f.count('ecus_export_draft_history'), 1);
});

test('only open export cases and valid draft revisions can be saved', async t => {
  for (const invalid of ['import', 'completed', 'merged', 'missing'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const caseId = state.cases[0].id;
    if (invalid === 'import') state.cases[0].caseType = 'import';
    if (invalid === 'completed') state.cases[0].status = 'completed';
    if (invalid === 'merged') state.cases[0].mergedInto = state.cases[1].id;
    await assert.rejects(saveEcusDraft(f.db, state, owner, invalid === 'missing' ? 'absent' : caseId, 0, incomplete(), NOW), denied(422));
    assert.equal(f.count('ecus_export_drafts'), 0);
  }
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace();
  for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, revision, incomplete(), NOW), denied(422));
  await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 5, incomplete(), NOW), denied(409));
  assert.equal(f.count('ecus_export_drafts'), 0);
});

test('concurrent initial and later saves admit one writer and never overwrite the winner', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); f.addReviewer(state); const caseId = state.cases[0].id;
  for (const revision of [0, 1]) {
    const outcomes = await Promise.allSettled([owner, reviewer].map(actor => saveEcusDraft(f.db, state, actor, caseId, revision, { headers: { exporterName: actor.name }, goods: [] }, NOW + revision)));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
    assert.ok(denied(409)(rejected.reason));
    const winner = outcomes.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof saveEcusDraft>>>;
    assert.deepEqual(await getEcusDraft(f.db, state.id, caseId, owner.id), winner.value);
    assert.equal(f.count('ecus_export_draft_history'), revision + 1);
  }
});

test('save rechecks membership and workspace revision at the actual write', async t => {
  for (const change of ['membership', 'revision'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace();
    const intercepted = f.interceptOnce('INSERT INTO ecus_export_drafts', () => {
      if (change === 'membership') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(state.id);
      else f.sqlite.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').run(state.id);
    });
    await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 0, incomplete(), NOW), denied(change === 'membership' ? 403 : 409));
    assert.ok(intercepted()); assert.equal(f.count('ecus_export_drafts'), 0); assert.equal(f.count('ecus_export_draft_history'), 0);
  }
});

test('source fingerprint and observed workspace revision advance on the next accepted save', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const caseId = state.cases[0].id;
  const first = await saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW);
  state.cases[0].title = 'Changed shipment evidence'; state.revision++; f.storeState(state);
  const second = await saveEcusDraft(f.db, state, owner, caseId, 1, incomplete(), NOW + 1);
  assert.notEqual(second.sourceFingerprint, first.sourceFingerprint); assert.equal(second.workspaceRevision, state.revision);
  assert.equal(f.sqlite.prepare('SELECT source_fingerprint FROM ecus_export_draft_history WHERE revision = 1').get()!.source_fingerprint, first.sourceFingerprint);
});

test('every previous transfer blocks edits until the operator records that no ECUS draft remains', async t => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'needs_reconciliation', 'cancelled']) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const caseId = state.cases[0].id;
    const jobId = f.addJob(state, status);
    await assert.rejects(saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW), denied(409));
    f.resolve(state, jobId, 'no_draft');
    const saved = await saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW + 1);
    assert.equal(saved.revision, 1);
  }
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const caseId = state.cases[0].id;
  const jobId = f.addJob(state, 'needs_reconciliation'); f.resolve(state, jobId, 'draft_kept');
  await assert.rejects(saveEcusDraft(f.db, state, owner, caseId, 0, incomplete(), NOW), denied(409));
});

test('a transfer appearing during save blocks that write, while jobs for another case do not', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace();
  f.addJob(state, 'queued', state.cases[1].id);
  await saveEcusDraft(f.db, state, owner, state.cases[0].id, 0, incomplete(), NOW);
  const intercepted = f.interceptOnce('INSERT INTO ecus_export_drafts', () => { f.addJob(state, 'queued'); });
  await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 1, incomplete(), NOW), denied(409));
  assert.ok(intercepted()); assert.equal(f.count('ecus_export_draft_history'), 1);
});

test('audit insertion failure rolls the draft write back atomically', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace();
  await saveEcusDraft(f.db, state, owner, state.cases[0].id, 0, incomplete(), NOW);
  f.sqlite.exec("CREATE TRIGGER fail_synthetic_audit BEFORE INSERT ON ecus_export_draft_history BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
  await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 1, { headers: { exporterName: 'Must not persist' }, goods: [] }, NOW + 1), /synthetic storage failure/);
  assert.equal((await getEcusDraft(f.db, state.id, state.cases[0].id, owner.id))!.revision, 1);
  assert.equal(f.count('ecus_export_draft_history'), 1);
});
