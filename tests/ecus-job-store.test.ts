import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { getEcusDraft, saveEcusDraft } from '../lib/ecus-draft-store.ts';
import { EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, type EdaField, type EcusExportForm } from '../lib/ecus-export.ts';
import {
  authenticateEcusDevice, claimEcusExport, createEcusDevice, ECUS_DEVICE_FRESHNESS, ECUS_JOB_LIFETIME, ECUS_LEASE,
  enqueueEcusExport, finishEcusExport, revokeEcusDevice, type EcusJob,
} from '../lib/ecus-job-store.ts';
import type { Actor, WorkspaceState } from '../lib/types.ts';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const owner: Actor = { id: 'owner', email: 'owner@example.invalid', name: 'Synthetic owner' };
const reviewer: Actor = { id: 'reviewer', email: 'reviewer@example.invalid', name: 'Synthetic reviewer' };

/** Run production SQL against SQLite; batches are atomic and cannot interleave. */
class Statement {
  database: DatabaseSync;
  sql: string;
  values: SQLInputValue[];
  before: (sql: string) => void;
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
  for (const migration of ['0000_charming_ghost_rider.sql', '0002_workspace_state_chunks.sql', '0004_ecus_export_jobs.sql', '0005_ecus_drafts_and_recovery.sql']) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  let beforeStatement: ((sql: string) => void) | undefined;
  const db = {
    prepare(sql: string) { return new Statement(sqlite, sql, [], sql => beforeStatement?.(sql)); },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  function workspace(id = 'ws_test', actor = owner) {
    let state = createEmptyWorkspace(id);
    for (let index = 0; index < 2; index++) state = applyAction(state, { type: 'create_case', title: `Synthetic export ${index + 1}`, caseType: 'export' }, actor);
    sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.id, state.revision, JSON.stringify(state), 'now', 'now');
    sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(id, actor.email, actor.id, 'owner', actor.id, 'now');
    return state;
  }
  function save(state: WorkspaceState) {
    sqlite.prepare('UPDATE workspaces SET revision = ?, state_json = ? WHERE id = ?').run(state.revision, JSON.stringify(state), state.id);
  }
  function job(id: string): EcusJob { return sqlite.prepare('SELECT * FROM ecus_export_jobs WHERE id = ?').get(id) as EcusJob; }
  async function pair(state: WorkspaceState, actor = owner) {
    for (const shipment of state.cases) {
      if (!await getEcusDraft(db, state.id, shipment.id, actor.id)) await saveEcusDraft(db, state, actor, shipment.id, 0, exportForm(), NOW);
    }
    const paired = await createEcusDevice(db, state.id, actor.id, 'Synthetic Windows computer', NOW);
    const device = await authenticateEcusDevice(db, `Bearer ${paired.token}`);
    assert.equal(await claimEcusExport(db, device, true, 'synthetic-uia-profile', NOW), null);
    return { device, token: paired.token };
  }
  function interceptOnce(pattern: string, change: () => void) {
    let intercepted = false;
    beforeStatement = sql => { if (!intercepted && sql.includes(pattern)) { intercepted = true; change(); } };
    return () => intercepted;
  }
  return { db, sqlite, workspace, save, job, pair, interceptOnce };
}

/** Complete only this application's required EDA subset, using explicit synthetic values. */
function exportForm(): EcusExportForm {
  const value = (field: EdaField) => field.key === 'currency' ? 'USD' : ['origin', 'importerCountry'].includes(field.key) ? 'VN'
    : field.key === 'hsCode' ? '12345678' : ['decimal', 'integer'].includes(field.input) ? '1' : field.input === 'date' ? '2026-10-25' : 'SYNTHETIC';
  const values = (fields: readonly EdaField[]) => Object.fromEntries(fields.filter(field => field.required).map(field => [field.key, value(field)]));
  return { headers: { ...values(EDA_HEADER_FIELDS), remarks: 'Hàng hóa 📦 / +^%{} / literal text' }, goods: [values(EDA_GOODS_FIELDS)] };
}

const denied = (status: number) => (error: unknown) => error instanceof Error && 'status' in error && error.status === status;

test('pairing is owner-only and device secrets are hashed, scoped, revocable and invalid after owner removal', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace();
  f.sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, reviewer.email, reviewer.id, 'reviewer', owner.id, 'now');
  await assert.rejects(createEcusDevice(f.db, state.id, reviewer.id, 'Forbidden', NOW), denied(403));
  await assert.rejects(createEcusDevice(f.db, 'other-workspace', owner.id, 'Forbidden', NOW), denied(403));
  const { device, token } = await f.pair(state);
  assert.equal(device.workspace_id, state.id);
  assert.equal(device.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(device.token_hash, token);
  await assert.rejects(authenticateEcusDevice(f.db, `Bearer ${token.slice(0, -1)}Z`), denied(401));
  await assert.rejects(authenticateEcusDevice(f.db, null), denied(401));
  await revokeEcusDevice(f.db, 'another-workspace', device.id, NOW + 1);
  assert.equal((await authenticateEcusDevice(f.db, `Bearer ${token}`)).id, device.id);
  await revokeEcusDevice(f.db, state.id, device.id, NOW + 2);
  await assert.rejects(authenticateEcusDevice(f.db, `Bearer ${token}`), denied(401));
  const second = await f.pair(state);
  f.sqlite.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run('reviewer', state.id, owner.id);
  await assert.rejects(authenticateEcusDevice(f.db, `Bearer ${second.token}`), denied(401));
  f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, owner.id);
  await assert.rejects(authenticateEcusDevice(f.db, `Bearer ${second.token}`), denied(401));
});

test('enqueue requires fresh configured device, workspace scope, membership and current revision', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const form = exportForm(); const caseId = state.cases[0].id;
  await assert.rejects(enqueueEcusExport(f.db, state, owner, 'unknown-device', caseId, form, NOW), denied(409));
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, form, NOW + ECUS_DEVICE_FRESHNESS + 1), denied(409));
  await claimEcusExport(f.db, device, false, '', NOW);
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, form, NOW), denied(409));
  await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW);
  await assert.rejects(enqueueEcusExport(f.db, state, { ...owner, id: 'outsider' }, device.id, caseId, form, NOW), denied(409));
  const foreign = f.workspace('ws_other', { ...owner, id: 'other-owner', email: 'other@example.invalid' });
  await assert.rejects(enqueueEcusExport(f.db, foreign, owner, device.id, foreign.cases[0].id, form, NOW), denied(409));
  f.save({ ...state, revision: state.revision + 1 });
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, caseId, form, NOW), denied(409));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 0);
});

test('enqueue freezes the exact Unicode payload and repeated or concurrent submissions reuse one job', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const form = exportForm();
  const jobs = await Promise.all(Array.from({ length: 3 }, () => enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW)));
  assert.ok(jobs.every(job => job.id === jobs[0].id));
  assert.equal(jobs[0].payload_hash, createHash('sha256').update(jobs[0].payload_json, 'utf8').digest('hex'));
  assert.deepEqual(JSON.parse(jobs[0].payload_json).form, form);
  form.headers.remarks = 'Edited after submitting';
  assert.notEqual(JSON.parse(f.job(jobs[0].id).payload_json).form.headers.remarks, form.headers.remarks);
  await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW), denied(409));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 1);
});

test('identical EDA forms with reordered JSON keys reuse the approved job', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const form = exportForm();
  const first = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
  const reverse = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).reverse());
  const again = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, { headers: reverse(form.headers), goods: form.goods.map(reverse) }, NOW + 1);
  assert.equal(again.id, first.id);
});

test('queued work is cancelled if approved source changes or reviewer loses access', async t => {
  for (const change of ['source', 'membership'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    f.sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, reviewer.email, reviewer.id, 'reviewer', owner.id, 'now');
    const job = await enqueueEcusExport(f.db, state, reviewer, device.id, state.cases[0].id, exportForm(), NOW);
    if (change === 'source') { state.cases[0].title = 'Changed evidence context'; state.revision++; f.save(state); }
    else f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, reviewer.id);
    assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1), null);
    assert.equal(f.job(job.id).status, 'cancelled');
    assert.equal(f.job(job.id).claimed_at, null);
  }
});

test('concurrent polls claim exactly one job and never run two jobs on one device', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const jobs = await Promise.all(state.cases.map(shipment => enqueueEcusExport(f.db, state, owner, device.id, shipment.id, exportForm(), NOW)));
  const polls = await Promise.all(Array.from({ length: 6 }, () => claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1)));
  assert.equal(polls.filter(Boolean).length, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM ecus_export_jobs WHERE status = 'running'").get()!.count, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM ecus_export_jobs WHERE status = 'queued'").get()!.count, 1);
  assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 2), null);
  const claimed = polls.find(Boolean)!;
  assert.ok(jobs.some(job => job.id === claimed.id));
  assert.equal(claimed.payloadHash, f.job(claimed.id).payload_hash);
  assert.equal(claimed.payloadJson, f.job(claimed.id).payload_json);
  assert.equal(Date.parse(claimed.expiresAt), NOW + ECUS_JOB_LIFETIME);
  assert.equal(Date.parse(claimed.leaseExpiresAt), NOW + 1 + ECUS_LEASE);
});

test('callbacks require the original device, workspace and exact lease token', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const secondDevice = await f.pair(state);
  const otherOwner = { ...owner, id: 'other-owner', email: 'other@example.invalid' };
  const other = f.workspace('ws_other', otherOwner); const foreignDevice = await f.pair(other, otherOwner);
  const job = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, exportForm(), NOW);
  assert.equal(await claimEcusExport(f.db, foreignDevice.device, true, 'synthetic-uia-profile', NOW + 1), null);
  const claimed = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
  const result = { jobId: job.id, leaseToken: claimed.leaseToken, status: 'failed' as const, message: 'No UI changes occurred.' };
  for (const foreign of [secondDevice.device, foreignDevice.device, { ...device, workspace_id: other.id }]) await assert.rejects(finishEcusExport(f.db, foreign, result, NOW + 2), denied(404));
  await assert.rejects(finishEcusExport(f.db, device, { ...result, leaseToken: crypto.randomUUID() }, NOW + 2), denied(404));
  assert.equal(f.job(job.id).status, 'running');
});

test('success requires a saved reference and complete matching readback, including blank fields and goods count', async t => {
  for (const scenario of ['missing-reference', 'missing-readback', 'missing-field', 'changed-field', 'unexpected-blank', 'extra-row', 'matching'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    const form = exportForm();
    const job = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
    const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
    const readback = structuredClone(form);
    if (scenario === 'missing-field') delete readback.headers.exporterName;
    if (scenario === 'changed-field') readback.goods[0].quantity = '2';
    if (scenario === 'unexpected-blank') readback.headers.invoiceNumber = 'Unexpected default';
    if (scenario === 'extra-row') readback.goods.push({ ...readback.goods[0] });
    const finished = await finishEcusExport(f.db, device, {
      jobId: job.id, leaseToken: claim.leaseToken, status: 'succeeded', message: 'Read back saved draft.',
      ...(scenario !== 'missing-reference' ? { draftReference: 'SYNTHETIC-DRAFT-1' } : {}),
      ...(scenario !== 'missing-readback' ? { readback } : {}),
    }, NOW + 2);
    assert.equal(finished.status, scenario === 'matching' ? 'succeeded' : 'needs_reconciliation', scenario);
    assert.equal(f.job(job.id).status, finished.status);
    const repeat = await finishEcusExport(f.db, device, { jobId: job.id, leaseToken: claim.leaseToken, status: 'failed', message: 'Must not replace the first result.' }, NOW + 3);
    assert.equal(repeat.result_json, finished.result_json);
    assert.equal(repeat.status, finished.status);
  }
});

test('queued approvals expire without claim and expired running leases never automatically retry', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const form = exportForm();
  const first = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
  const second = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[1].id, form, NOW);
  const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
  assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + ECUS_JOB_LIFETIME + 1), null);
  assert.equal(f.job(claim.id).status, 'needs_reconciliation');
  const queued = [first, second].find(job => job.id !== claim.id)!;
  assert.equal(f.job(queued.id).status, 'cancelled');
  assert.equal(f.job(queued.id).claimed_at, null);
  assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + ECUS_JOB_LIFETIME + 2), null);
  const late = await finishEcusExport(f.db, device, { jobId: claim.id, leaseToken: claim.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-DRAFT', readback: form, message: 'Late result.' }, NOW + ECUS_JOB_LIFETIME + 3);
  assert.equal(late.status, 'needs_reconciliation');
});

test('completion after lease expiry is reconciliation even without another poll', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
  const form = exportForm(); const job = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
  const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
  const result = await finishEcusExport(f.db, device, { jobId: job.id, leaseToken: claim.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-DRAFT', readback: form, message: 'Late result.' }, NOW + ECUS_LEASE + 2);
  assert.equal(result.status, 'needs_reconciliation');
  assert.match(result.message, /lease expir/i);
  assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + ECUS_LEASE + 3), null);
});

test('revoking a device cancels queued work and preserves uncertainty for running work', async t => {
  const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device, token } = await f.pair(state);
  const jobs = await Promise.all(state.cases.map(shipment => enqueueEcusExport(f.db, state, owner, device.id, shipment.id, exportForm(), NOW)));
  const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
  await revokeEcusDevice(f.db, state.id, device.id, NOW + 2);
  await assert.rejects(authenticateEcusDevice(f.db, `Bearer ${token}`), denied(401));
  assert.equal(f.job(claim.id).status, 'needs_reconciliation');
  assert.equal(f.job(jobs.find(job => job.id !== claim.id)!.id).status, 'cancelled');
  assert.equal((f.sqlite.prepare('SELECT ready FROM ecus_devices WHERE id = ?').get(device.id)!).ready, 0);
});

test('stale authenticated device objects cannot poll, submit or finish after revocation or loss of their owner', async t => {
  for (const removal of ['revoked', 'owner-removed', 'owner-demoted'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    const form = exportForm(); const job = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
    const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
    if (removal === 'revoked') await revokeEcusDevice(f.db, state.id, device.id, NOW + 2);
    else if (removal === 'owner-removed') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, owner.id);
    else f.sqlite.prepare("UPDATE workspace_members SET role = 'reviewer' WHERE workspace_id = ? AND user_id = ?").run(state.id, owner.id);
    const before = f.job(job.id);
    await assert.rejects(claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 3), denied(401));
    await assert.rejects(enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW + 3), denied(409));
    await assert.rejects(finishEcusExport(f.db, device, { jobId: job.id, leaseToken: claim.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-DRAFT', readback: form, message: 'Stale credential.' }, NOW + 3), denied(404));
    assert.deepEqual(f.job(job.id), before, removal);
  }
});

test('enqueue authorization and device readiness are checked atomically at insertion', async t => {
  for (const removal of ['owner', 'reviewer', 'revoked', 'not-ready', 'stale', 'changed-profile'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    f.sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, reviewer.email, reviewer.id, 'reviewer', owner.id, 'now');
    const intercepted = f.interceptOnce('INSERT OR IGNORE INTO ecus_export_jobs', () => {
      if (removal === 'owner' || removal === 'reviewer') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, removal === 'owner' ? owner.id : reviewer.id);
      else if (removal === 'revoked') f.sqlite.prepare('UPDATE ecus_devices SET revoked_at = ? WHERE id = ?').run(NOW, device.id);
      else if (removal === 'not-ready') f.sqlite.prepare('UPDATE ecus_devices SET ready = 0 WHERE id = ?').run(device.id);
      else if (removal === 'stale') f.sqlite.prepare('UPDATE ecus_devices SET last_seen = ? WHERE id = ?').run(NOW - ECUS_DEVICE_FRESHNESS - 1, device.id);
      else f.sqlite.prepare("UPDATE ecus_devices SET profile_id = 'another-profile' WHERE id = ?").run(device.id);
    });
    await assert.rejects(enqueueEcusExport(f.db, state, reviewer, device.id, state.cases[0].id, exportForm(), NOW), denied(409));
    assert.equal(intercepted(), true, removal);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM ecus_export_jobs').get()!.count, 0, removal);
  }
});

test('claim rechecks approver membership, pairing owner and device readiness after reading the source', async t => {
  for (const removal of ['owner', 'reviewer', 'revoked', 'not-ready', 'profile'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    f.sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, reviewer.email, reviewer.id, 'reviewer', owner.id, 'now');
    const job = await enqueueEcusExport(f.db, state, reviewer, device.id, state.cases[0].id, exportForm(), NOW);
    const intercepted = f.interceptOnce("UPDATE ecus_export_jobs SET status = 'running'", () => {
      if (removal === 'owner' || removal === 'reviewer') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, removal === 'owner' ? owner.id : reviewer.id);
      else if (removal === 'revoked') f.sqlite.prepare('UPDATE ecus_devices SET revoked_at = ? WHERE id = ?').run(NOW, device.id);
      else if (removal === 'not-ready') f.sqlite.prepare('UPDATE ecus_devices SET ready = 0 WHERE id = ?').run(device.id);
      else f.sqlite.prepare("UPDATE ecus_devices SET profile_id = 'another-profile' WHERE id = ?").run(device.id);
    });
    assert.equal(await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1), null, removal);
    assert.equal(intercepted(), true, removal);
    assert.equal(f.job(job.id).status, 'queued', removal);
    assert.equal(f.job(job.id).claimed_at, null, removal);
  }
});

test('completion cannot commit success if pairing authority disappears after result validation', async t => {
  for (const removal of ['owner', 'revoked'] as const) {
    const f = fixture(); t.after(() => f.sqlite.close()); const state = f.workspace(); const { device } = await f.pair(state);
    const form = exportForm(); const job = await enqueueEcusExport(f.db, state, owner, device.id, state.cases[0].id, form, NOW);
    const claim = (await claimEcusExport(f.db, device, true, 'synthetic-uia-profile', NOW + 1))!;
    const intercepted = f.interceptOnce('UPDATE ecus_export_jobs SET status = ?', () => {
      if (removal === 'owner') f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(state.id, owner.id);
      else f.sqlite.prepare('UPDATE ecus_devices SET revoked_at = ? WHERE id = ?').run(NOW, device.id);
    });
    await assert.rejects(finishEcusExport(f.db, device, { jobId: job.id, leaseToken: claim.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-DRAFT', readback: form, message: 'Verified.' }, NOW + 2), denied(401));
    assert.equal(intercepted(), true, removal);
    assert.equal(f.job(job.id).status, 'running', removal);
    assert.equal(f.job(job.id).result_json, null, removal);
  }
});
