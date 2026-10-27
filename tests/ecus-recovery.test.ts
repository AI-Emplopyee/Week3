import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { saveEcusDraft } from '../lib/ecus-draft-store.ts';
import { EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, type EdaField, type EcusExportForm } from '../lib/ecus-export.ts';
import {
  authenticateEcusDevice, claimEcusExport, createEcusDevice, ECUS_LEASE, enqueueEcusExport, finishEcusExport,
  publicEcusJob, revokeEcusDevice, type EcusDevice, type EcusJob,
} from '../lib/ecus-job-store.ts';
import { getEcusResolution, reconcileEcusJob, syncEcusRecovery } from '../lib/ecus-recovery.ts';
import type { Actor, WorkspaceState } from '../lib/types.ts';

const NOW = Date.parse('2026-10-26T13:00:00.000Z');
const owner: Actor = { id: 'recovery-owner', email: 'recovery-owner@example.invalid', name: 'Synthetic recovery operator' };
const other: Actor = { id: 'recovery-other', email: 'recovery-other@example.invalid', name: 'Other synthetic employee' };
const reason = 'Inspected the ECUS computer and confirmed the draft disposition.';

class Statement {
  database: DatabaseSync; sql: string; values: SQLInputValue[]; before: (sql: string) => void;
  constructor(database: DatabaseSync, sql: string, values: SQLInputValue[] = [], before: (sql: string) => void = () => {}) {
    this.database = database; this.sql = sql; this.values = values; this.before = before;
  }
  bind(...values: SQLInputValue[]) { return new Statement(this.database, this.sql, values, this.before); }
  execute() { this.before(this.sql); return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.values).changes) } }; }
  async run() { return this.execute(); }
  async first() { this.before(this.sql); return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { this.before(this.sql); return { results: this.database.prepare(this.sql).all(...this.values) }; }
}

function form(): EcusExportForm {
  const value = (field: EdaField) => field.key === 'currency' ? 'USD' : ['origin', 'importerCountry'].includes(field.key) ? 'VN'
    : field.key === 'hsCode' ? '12345678' : ['decimal', 'integer'].includes(field.input) ? '1' : 'SYNTHETIC';
  const fields = (catalog: readonly EdaField[]) => Object.fromEntries(catalog.filter(field => field.required).map(field => [field.key, value(field)]));
  return { headers: { ...fields(EDA_HEADER_FIELDS), remarks: 'Synthetic recovery fixture' }, goods: [fields(EDA_GOODS_FIELDS)] };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
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
  function workspace(id = 'recovery-workspace', actor = owner) {
    const state = applyAction(createEmptyWorkspace(id), { type: 'create_case', title: 'Synthetic recovery export', caseType: 'export' }, actor);
    sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.id, state.revision, JSON.stringify(state), 'now', 'now');
    sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.email, actor.id, 'owner', actor.id, 'now');
    return state;
  }
  async function pair(state: WorkspaceState, actor = owner, now = NOW) {
    const paired = await createEcusDevice(db, state.id, actor.id, 'Synthetic ECUS computer', now);
    const device = await authenticateEcusDevice(db, `Bearer ${paired.token}`);
    await claimEcusExport(db, device, true, 'synthetic-recovery-profile', now);
    return device;
  }
  async function submit(state: WorkspaceState, device: EcusDevice) {
    const draft = await saveEcusDraft(db, state, owner, state.cases[0].id, 0, form(), NOW);
    return enqueueEcusExport(db, state, owner, device.id, state.cases[0].id, form(), NOW, draft.revision);
  }
  function job(id: string) { return sqlite.prepare('SELECT * FROM ecus_export_jobs WHERE id = ?').get(id) as EcusJob; }
  async function completed(state: WorkspaceState, device: EcusDevice, status: 'failed' | 'needs_reconciliation' | 'succeeded' = 'needs_reconciliation') {
    const queued = await submit(state, device);
    const claimed = await claimEcusExport(db, device, true, 'synthetic-recovery-profile', NOW + 1);
    assert.ok(claimed); assert.equal(claimed.id, queued.id);
    const result = { jobId: queued.id, leaseToken: claimed.leaseToken, status, message: 'Synthetic terminal helper result',
      ...(status === 'succeeded' ? { draftReference: 'SYNTHETIC-DRAFT', readback: form() } : {}) };
    return finishEcusExport(db, device, result, NOW + 2);
  }
  function interceptOnce(pattern: string, change: () => void) {
    let intercepted = false;
    beforeStatement = sql => { if (!intercepted && sql.includes(pattern)) { intercepted = true; change(); } };
    return () => intercepted;
  }
  return { db, sqlite, workspace, pair, submit, job, completed, interceptOnce };
}

const denied = (status: number) => (error: unknown) => error instanceof Error && 'status' in error && error.status === status;
const resolutionInput = (jobId: string) => ({ jobId, disposition: 'no_draft' as const, reason, confirmed: true as const });

test('operator resolution is append-only, preserves the failed attempt and makes identical requests idempotent', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state);
  const job = await f.completed(state, device, 'failed');
  const saved = await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3);
  assert.equal(saved.id, job.id); assert.equal(saved.status, 'failed');
  assert.equal(f.job(job.id).result_json, job.result_json); assert.equal(f.job(job.id).payload_json, job.payload_json);
  const first = await getEcusResolution(f.db, state.id, job.id); assert.ok(first);
  assert.equal(first.disposition, 'no_draft'); assert.equal(first.actor_id, owner.id); assert.equal(first.actor_name, owner.name);
  assert.equal(first.payload_hash, job.payload_hash); assert.equal(first.reason, reason); assert.ok(first.device_ack_at);
  await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 4);
  assert.deepEqual(await getEcusResolution(f.db, state.id, job.id), first);
  await assert.rejects(reconcileEcusJob(f.db, state, owner, { ...resolutionInput(job.id), disposition: 'draft_kept', draftReference: 'EXISTS' }, NOW + 5), denied(409));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_job_resolutions').get()!.count, 1);
});

test('operator must confirm inspection, provide a useful reason, and identify a kept draft', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device);
  for (const input of [
    { ...resolutionInput(job.id), confirmed: false }, { ...resolutionInput(job.id), reason: 'short' },
    { ...resolutionInput(job.id), reason: 'x'.repeat(2001) }, { ...resolutionInput(job.id), disposition: 'draft_kept' },
  ]) await assert.rejects(reconcileEcusJob(f.db, state, owner, input as Parameters<typeof reconcileEcusJob>[3], NOW + 3), denied(422));
  assert.equal(await getEcusResolution(f.db, state.id, job.id), null);
});

test('queued, running and verified successful jobs cannot be resolved as failed transfers', async t => {
  for (const status of ['queued', 'running', 'succeeded'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state);
    const job = status === 'succeeded' ? await f.completed(state, device, status) : await f.submit(state, device);
    if (status === 'running') assert.ok(await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', NOW + 1));
    await assert.rejects(reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 2), denied(409));
    assert.equal(await getEcusResolution(f.db, state.id, job.id), null);
  }
});

test('an uncertain transfer with a live lease cannot be released merely by revoking its computer', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.submit(state, device);
  assert.ok(await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', NOW + 1));
  await revokeEcusDevice(f.db, state.id, device.id, NOW + 2);
  assert.equal(f.job(job.id).status, 'needs_reconciliation');
  await assert.rejects(reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3), denied(409));
  await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + ECUS_LEASE + 2);
  const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution);
  assert.equal(resolution.ack_method, 'fenced'); assert.ok(resolution.device_ack_at);
});

test('uncertain completed work requires acknowledgement from its original computer before retry', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device);
  await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3);
  const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution); assert.equal(resolution.device_ack_at, null);
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form(), NOW + 4, 1), denied(409));
  const pending = await syncEcusRecovery(f.db, device, { jobIds: [job.id], acknowledgements: [] }, NOW + 5);
  assert.equal(pending.resolutions.length, 1); assert.equal(pending.resolutions[0].id, resolution.id);
  assert.equal(pending.resolutions[0].payloadHash, job.payload_hash); assert.equal(pending.resolutions[0].disposition, 'no_draft');
  const ack = { jobId: job.id, resolutionId: resolution.id, payloadHash: job.payload_hash };
  const acknowledged = await syncEcusRecovery(f.db, device, { jobIds: [job.id], acknowledgements: [ack] }, NOW + 6);
  assert.ok(acknowledged.acknowledgedResolutionIds.includes(resolution.id));
  const recordedAck = (await getEcusResolution(f.db, state.id, job.id))!.device_ack_at; assert.equal(recordedAck, NOW + 6);
  const duplicate = await syncEcusRecovery(f.db, device, { jobIds: [job.id], acknowledgements: [ack] }, NOW + 7);
  assert.ok(duplicate.acknowledgedResolutionIds.includes(resolution.id));
  assert.equal((await getEcusResolution(f.db, state.id, job.id))!.device_ack_at, recordedAck);
});

test('wrong device, payload hash and resolution identity cannot acknowledge another transfer', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const wrongDevice = await f.pair(state);
  const job = await f.completed(state, device); await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3);
  const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution);
  const correct = { jobId: job.id, resolutionId: resolution.id, payloadHash: job.payload_hash };
  for (const [computer, acknowledgement] of [[wrongDevice, correct], [device, { ...correct, payloadHash: '0'.repeat(64) }], [device, { ...correct, resolutionId: crypto.randomUUID() }]] as const) {
    try {
      const response = await syncEcusRecovery(f.db, computer, { jobIds: [job.id], acknowledgements: [acknowledgement] }, NOW + 4);
      assert.ok(!response.acknowledgedResolutionIds.includes(resolution.id));
      if (computer.id !== device.id) assert.equal(response.resolutions.length, 0);
    } catch (error) { assert.ok(denied(401)(error) || denied(403)(error) || denied(404)(error) || denied(409)(error)); }
    assert.equal((await getEcusResolution(f.db, state.id, job.id))!.device_ack_at, null);
  }
});

test('recording an existing draft preserves the reference and permanently blocks recreation', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device);
  await reconcileEcusJob(f.db, state, owner, { ...resolutionInput(job.id), disposition: 'draft_kept', draftReference: 'EDA-EXISTING-001' }, NOW + 3);
  const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution);
  assert.equal(resolution.draft_reference, 'EDA-EXISTING-001'); assert.equal(resolution.disposition, 'draft_kept');
  await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 1, form(), NOW + 4), denied(409));
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form(), NOW + 4, 1), denied(409));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 1);
});

test('controlled retry creates one child, preserves original evidence and reuses concurrent resubmissions', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const original = await f.completed(state, device, 'failed');
  await reconcileEcusJob(f.db, state, owner, resolutionInput(original.id), NOW + 3);
  const changed = form(); changed.headers.remarks = 'Corrected after inspected failure';
  const draft = await saveEcusDraft(f.db, state, owner, state.cases[0].id, 1, changed, NOW + 4);
  const retries = await Promise.all(Array.from({ length: 5 }, () => enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, changed, NOW + 5, draft.revision)));
  assert.ok(retries.every(job => job.id === retries[0].id)); assert.notEqual(retries[0].id, original.id);
  assert.equal(retries[0].retry_of, original.id); assert.equal(retries[0].draft_revision, 2); assert.equal(retries[0].status, 'queued');
  assert.equal(f.job(original.id).result_json, original.result_json); assert.equal(f.job(original.id).payload_json, original.payload_json);
  assert.equal(JSON.parse(retries[0].payload_json).form.headers.remarks, changed.headers.remarks);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 2);
  const again = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, changed, NOW + 6, 2);
  assert.equal(again.id, retries[0].id);
});

test('retry can reuse identical approved values only after explicit resolution', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const original = await f.completed(state, device, 'failed');
  await reconcileEcusJob(f.db, state, owner, resolutionInput(original.id), NOW + 3);
  const retry = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form(), NOW + 4, 1);
  assert.notEqual(retry.id, original.id); assert.equal(retry.retry_of, original.id);
  assert.deepEqual(JSON.parse(retry.payload_json).form, JSON.parse(original.payload_json).form);
});

test('a cancelled job that was never claimed can be released without a helper acknowledgement', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.submit(state, device);
  await revokeEcusDevice(f.db, state.id, device.id, NOW + 1);
  assert.equal(f.job(job.id).status, 'cancelled'); assert.equal(f.job(job.id).claimed_at, null);
  await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 2);
  const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution); assert.ok(resolution.device_ack_at);
  const nextComputer = await f.pair(state, owner, NOW + 3);
  const retry = await enqueueEcusExport(f.db, state, owner, nextComputer.id, state.cases[0].id, form(), NOW + 4, 1);
  assert.equal(retry.retry_of, job.id); assert.equal(retry.device_id, nextComputer.id);
});

test('Submit requires the exact latest saved form and refuses stale or unsaved browser values', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const caseId = state.cases[0].id;
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, form(), NOW, 1), denied(409));
  await saveEcusDraft(f.db, state, owner, caseId, 0, form(), NOW);
  const changed = form(); changed.headers.remarks = 'Unsaved browser edit';
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, changed, NOW + 1, 1), denied(409));
  await saveEcusDraft(f.db, state, owner, caseId, 1, changed, NOW + 2);
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, changed, NOW + 3, 1), denied(409));
  const accepted = await enqueueEcusExport(f.db, state, owner, device.id, caseId, changed, NOW + 4, 2);
  assert.equal(accepted.draft_revision, 2); assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 1);
});

test('Submit rechecks saved form content, revision, source and workspace state at insertion', async t => {
  for (const change of ['revision', 'form', 'source', 'workspace'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const caseId = state.cases[0].id;
    await saveEcusDraft(f.db, state, owner, caseId, 0, form(), NOW);
    const intercepted = f.interceptOnce('INSERT OR IGNORE INTO ecus_export_jobs', () => {
      if (change === 'workspace') f.sqlite.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').run(state.id);
      if (change === 'revision') f.sqlite.prepare('UPDATE ecus_export_drafts SET revision = revision + 1 WHERE workspace_id = ?').run(state.id);
      if (change === 'source') f.sqlite.prepare("UPDATE ecus_export_drafts SET source_fingerprint = 'changed-source' WHERE workspace_id = ?").run(state.id);
      if (change === 'form') { const changed = form(); changed.headers.remarks = 'A concurrent employee edit'; f.sqlite.prepare('UPDATE ecus_export_drafts SET form_json = ? WHERE workspace_id = ?').run(JSON.stringify(changed), state.id); }
    });
    await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, form(), NOW + 1, 1), denied(409));
    assert.ok(intercepted()); assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 0);
  }
});

test('recovery acknowledgement rechecks device and owner authority at the write', async t => {
  for (const change of ['revoked', 'owner'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device);
    await reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3);
    const resolution = await getEcusResolution(f.db, state.id, job.id); assert.ok(resolution);
    const intercepted = f.interceptOnce('UPDATE ecus_job_resolutions', () => {
      if (change === 'revoked') f.sqlite.prepare('UPDATE ecus_devices SET revoked_at = ? WHERE id = ?').run(NOW + 4, device.id);
      else f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, owner.id);
    });
    const response = await syncEcusRecovery(f.db, device, { jobIds: [job.id], acknowledgements: [{ jobId: job.id, resolutionId: resolution.id, payloadHash: job.payload_hash }] }, NOW + 4);
    assert.ok(intercepted()); assert.deepEqual(response.acknowledgedResolutionIds, []); assert.deepEqual(response.resolutions, []);
    assert.equal((await getEcusResolution(f.db, state.id, job.id))!.device_ack_at, null);
  }
});

test('late callbacks after an inspected recovery cannot mutate the original attempt or its retry', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const original = await f.submit(state, device);
  const claim = await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', NOW + 1); assert.ok(claim);
  const afterExpiry = NOW + ECUS_LEASE + 2;
  assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', afterExpiry), null);
  assert.equal(f.job(original.id).status, 'needs_reconciliation');
  await reconcileEcusJob(f.db, state, owner, resolutionInput(original.id), afterExpiry + 1);
  const resolution = await getEcusResolution(f.db, state.id, original.id); assert.ok(resolution);
  await syncEcusRecovery(f.db, device, { jobIds: [original.id], acknowledgements: [{ jobId: original.id, resolutionId: resolution.id, payloadHash: original.payload_hash }] }, afterExpiry + 2);
  const retry = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form(), afterExpiry + 3, 1);
  const before = f.job(original.id);
  await finishEcusExport(f.db, device, { jobId: original.id, leaseToken: claim.leaseToken, status: 'succeeded', readback: form(), draftReference: 'LATE-REFERENCE', message: 'Late synthetic result after recovery' }, afterExpiry + 4);
  assert.deepEqual(f.job(original.id), before); assert.deepEqual(f.job(retry.id), retry);
  assert.equal((await getEcusResolution(f.db, state.id, original.id))!.id, resolution.id);
});

test('the first delayed helper result supplies comparison evidence but never clears reconciliation or permits a duplicate', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const original = await f.submit(state, device);
  const claim = await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', NOW + 1); assert.ok(claim);
  const afterExpiry = NOW + ECUS_LEASE + 2;
  await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', afterExpiry);
  const readback = form(); readback.goods[0].quantity = '2';
  const late = await finishEcusExport(f.db, device, { jobId: original.id, leaseToken: claim.leaseToken, status: 'succeeded', readback, draftReference: 'LATE-FOUND-DRAFT', message: 'Delayed saved draft readback' }, afterExpiry + 1);
  assert.equal(late.status, 'needs_reconciliation'); assert.equal(late.draft_reference, 'LATE-FOUND-DRAFT');
  const publicJob = publicEcusJob(late, true, null);
  assert.deepEqual(publicJob.readback, readback);
  assert.ok(publicJob.differences.some(item => item.path === 'goods[0].quantity' && item.expected === '1' && item.actual === '2'));
  const repeated = await finishEcusExport(f.db, device, { jobId: original.id, leaseToken: claim.leaseToken, status: 'failed', message: 'Must not replace the first delayed evidence' }, afterExpiry + 2);
  assert.deepEqual(repeated, late);
  await assert.rejects(saveEcusDraft(f.db, state, owner, state.cases[0].id, 1, form(), afterExpiry + 3), denied(409));
  const resubmitted = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form(), afterExpiry + 3, 1);
  assert.equal(resubmitted.id, original.id); assert.equal(resubmitted.status, 'needs_reconciliation');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 1);
});

test('resolution writes are scoped and recheck membership and workspace revision at commit', async t => {
  for (const change of ['membership', 'revision'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device, 'failed');
    const intercepted = f.interceptOnce('INSERT', () => {
      if (change === 'membership') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(state.id);
      else f.sqlite.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').run(state.id);
    });
    await assert.rejects(reconcileEcusJob(f.db, state, owner, resolutionInput(job.id), NOW + 3), error => denied(403)(error) || denied(409)(error));
    assert.ok(intercepted()); assert.equal(await getEcusResolution(f.db, state.id, job.id), null);
  }
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.completed(state, device, 'failed');
  const foreign = f.workspace('foreign-recovery', other);
  await assert.rejects(reconcileEcusJob(f.db, foreign, other, resolutionInput(job.id), NOW + 3), denied(404));
  assert.equal(await getEcusResolution(f.db, foreign.id, job.id), null);
});

test('recovery display exposes approved and actual values without exposing the helper lease', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const device = await f.pair(state); const job = await f.submit(state, device);
  const claimed = await claimEcusExport(f.db, device, true, 'synthetic-recovery-profile', NOW + 1); assert.ok(claimed);
  const readback = form(); readback.headers.exporterName = 'Different saved value';
  const finished = await finishEcusExport(f.db, device, { jobId: job.id, leaseToken: claimed.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-DIFFERENCE', readback, message: 'Synthetic readback' }, NOW + 2);
  assert.equal(finished.status, 'needs_reconciliation');
  const publicJob = publicEcusJob(finished, true, null);
  assert.deepEqual(publicJob.readback, readback);
  assert.ok(publicJob.differences.some(item => item.path === 'headers.exporterName' && item.expected === 'SYNTHETIC' && item.actual === 'Different saved value'));
  assert.equal(publicJob.payload!.form.headers.exporterName, 'SYNTHETIC');
  assert.ok(!JSON.stringify(publicJob).includes(claimed.leaseToken));
});
