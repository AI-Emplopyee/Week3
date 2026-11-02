import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { AUTOMATIC_LEASE_MS, CLAIM_JOB_SQL, automaticDocuments, automaticPageNeedsKimi, claimAiJob, enqueuePage, finishAiJob } from '../lib/ai-processing-queue.ts';
import { saveAiResult } from '../lib/ai-result-persistence.ts';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { prepareWorkspaceCommit, readWorkspaceState } from '../lib/server-persistence.ts';
import type { Actor, ShipmentDocument } from '../lib/types.ts';

const actor: Actor = { id: 'owner', name: 'Synthetic owner', email: 'owner@example.invalid' };
class Statement {
  database: DatabaseSync; sql: string; values: SQLInputValue[];
  constructor(database: DatabaseSync, sql: string, values: SQLInputValue[] = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values: SQLInputValue[]) { return new Statement(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async run() { return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.values).changes) } }; }
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0000_charming_ghost_rider', '0002_workspace_state_chunks', '0003_ai_processing_jobs', '0006_case_file_cleanup']) sqlite.exec(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8'));
  const state = createEmptyWorkspace('ws_jobs');
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(state.id, actor.id, 0, JSON.stringify(state), 'now', 'now');
  sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?, ?, ?)').run(state.id, actor.email, actor.id, 'owner', actor.id, 'now');
  const db = { prepare(sql: string) { return new Statement(sqlite, sql); }, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { db, sqlite, state };
}
const document = (id: string): ShipmentDocument => ({ id, caseId: 'case', name: `${id}.pdf`, version: 1, sha256: 'a'.repeat(64), mime: 'application/pdf', type: 'other', size: 1, active: true, blobKey: `ws_jobs/${id}`, synthetic: true, uploadedAt: '', extractionStatus: 'pending_ai', extractionPipeline: 'kimi', pages: [{ page: 1, text: '' }, { page: 2, text: '' }] });

test('durable claims prevent duplicates, cap concurrency at two, and protect token ownership', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const first = document('a'), second = document('b'), third = document('c');
    const a = await claimAiJob(db, state.id, first, 1, false, 1000);
    assert.ok(a);
    assert.equal(await claimAiJob(db, state.id, first, 1, false, 1000), null);
    assert.equal(await claimAiJob(db, state.id, first, 2, false, 1000), null, 'one document cannot run overlapping pages');
    const b = await claimAiJob(db, state.id, second, 1, false, 1000);
    assert.ok(b);
    assert.equal(await claimAiJob(db, state.id, third, 1, false, 1000), null);
    assert.equal((await finishAiJob(db, state.id, first, 1, 'wrong', 'completed', undefined, 2000)).meta.changes, 0);
    await finishAiJob(db, state.id, first, 1, a!, 'completed', undefined, 2000);
    assert.ok(await claimAiJob(db, state.id, third, 1, false, 2000));
    const saved = sqlite.prepare('SELECT state, elapsed_ms FROM ai_processing_jobs WHERE document_id = ? AND page = 1').get('a');
    assert.deepEqual({ ...saved }, { state: 'completed', elapsed_ms: 1000 });
    assert.equal(await claimAiJob(db, state.id, first, 1, false, 3000), null, 'completed/rejected reads never loop automatically');
  } finally { sqlite.close(); }
});

test('rate limits wait; provider failures require deliberate retry; crashed leases can recover', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const source = document('source');
    const lease = await claimAiJob(db, state.id, source, 1, false, 1000);
    await finishAiJob(db, state.id, source, 1, lease!, 'queued', 'Rate limit', 2000);
    assert.equal(await claimAiJob(db, state.id, source, 1, false, 61999), null);
    const resumed = await claimAiJob(db, state.id, source, 1, false, 62000);
    assert.ok(resumed);
    await finishAiJob(db, state.id, source, 1, resumed!, 'failed', 'Provider failure', 63000);
    assert.equal(await claimAiJob(db, state.id, source, 1, false, 64000), null);
    const manual = await claimAiJob(db, state.id, source, 1, true, 64000);
    assert.ok(manual);
    assert.ok(await claimAiJob(db, state.id, source, 1, false, 64000 + AUTOMATIC_LEASE_MS));
    assert.equal((await finishAiJob(db, state.id, source, 1, manual!, 'completed')).meta.changes, 0, 'expired reader cannot finish a replacement lease');
  } finally { sqlite.close(); }
});

test('deleted documents cannot be re-enqueued or retried by stale requests', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const source = document('deleted');
    const lease = await claimAiJob(db, state.id, source, 1, false, 1000);
    assert.ok(lease);
    sqlite.exec('BEGIN IMMEDIATE');
    sqlite.prepare('INSERT INTO deleted_case_documents (workspace_id, document_id) VALUES (?, ?)').run(state.id, source.id);
    sqlite.prepare('DELETE FROM ai_processing_jobs WHERE workspace_id = ? AND document_id = ?').run(state.id, source.id);
    sqlite.exec('COMMIT');

    await enqueuePage(db, state.id, source, 1);
    await enqueuePage(db, state.id, source, 2);
    assert.equal(await claimAiJob(db, state.id, source, 1, false, 2000), null);
    assert.equal(await claimAiJob(db, state.id, source, 1, true, 2000), null);
    assert.equal(await claimAiJob(db, state.id, { ...source, version: 2 }, 1, true, 2000), null);
    assert.equal((await finishAiJob(db, state.id, source, 1, lease!, 'completed', undefined, 2000)).meta.changes, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_processing_jobs WHERE document_id = ?').get(source.id)?.count, 0);
    assert.ok(await claimAiJob(db, state.id, document('remaining'), 1, false, 2000));

    const otherWorkspaceId = 'ws_other';
    sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(otherWorkspaceId, 'other-owner', 0, JSON.stringify({ ...state, id: otherWorkspaceId }), 'now', 'now');
    assert.ok(await claimAiJob(db, otherWorkspaceId, source, 1, false, 2000), 'a deletion in one workspace never blocks another workspace');
  } finally { sqlite.close(); }
});

test('a tombstone arriving between enqueue and claim prevents a stale queued row from running', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const source = document('delete-during-claim');
    let deleted = false;
    const racing = { prepare(sql: string) {
      if (sql === CLAIM_JOB_SQL && !deleted) {
        deleted = true;
        sqlite.prepare('INSERT INTO deleted_case_documents (workspace_id, document_id) VALUES (?, ?)').run(state.id, source.id);
      }
      return db.prepare(sql);
    } } as D1Database;
    assert.equal(await claimAiJob(racing, state.id, source, 1, true, 1000), null);
    const job = sqlite.prepare('SELECT state, attempts FROM ai_processing_jobs WHERE document_id = ?').get(source.id);
    assert.deepEqual({ ...job }, { state: 'queued', attempts: 0 });
  } finally { sqlite.close(); }
});

test('automatic intake ignores sample collections, references, closed and unsupported originals', () => {
  let state = createEmptyWorkspace('ws_scan');
  state = applyAction(state, { type: 'intake', documents: [{ ...document('live'), pages: [{ page: 1, text: '' }] }] }, actor);
  const source = state.documents[0];
  assert.equal(automaticDocuments(state).length, 1);
  state.cases[0].sourceCollection = { name: 'Samples', folder: 'sample/folder' };
  assert.equal(automaticDocuments(state).length, 0);
  delete state.cases[0].sourceCollection;
  source.referenceOnly = true;
  assert.equal(automaticDocuments(state).length, 0);
  delete source.referenceOnly;
  source.extractionStatus = 'unsupported';
  assert.equal(automaticDocuments(state).length, 0);
  source.extractionStatus = 'pending_ai';
  state.cases[0].status = 'completed';
  assert.equal(automaticDocuments(state).length, 0);
});

test('legacy rejected readings never trigger automatic paid retries while unread pages continue', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const intake = applyAction(state, { type: 'intake', documents: [document('legacy')] }, actor);
    const source = intake.documents[0];
    source.aiProcessedPages = [1];
    source.aiRejectedPages = [1];
    source.pages[0].aiReadability = 'clear';
    assert.equal(automaticDocuments(intake).length, 1, 'the second, unread page remains automatic');
    assert.deepEqual(source.pages.filter(page => automaticPageNeedsKimi(intake, source, page)).map(page => page.page), [2]);
    source.aiProcessedPages.push(2);
    source.pages[1].aiReadability = 'uncertain';
    assert.equal(automaticDocuments(intake).length, 0, 'legacy failed validation never creates a fresh automatic job');
    assert.ok(await claimAiJob(db, state.id, source, 1, true), 'an explicit manual retry remains available');
  } finally { sqlite.close(); }
});

test('AI commits rebase onto a saved human edit and reject a replaced source', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const intake = applyAction(state, { type: 'intake', documents: [{ ...document('a'), mime: 'text/plain', name: 'a.txt', pages: [{ page: 1, text: 'Invoice INV-42' }] }] }, actor);
    intake.revision = 1;
    await db.batch(prepareWorkspaceCommit(db, intake, 0, actor));
    const source = intake.documents[0];
    const edited = applyAction(intake, { type: 'review_field', caseId: source.caseId, field: 'invoiceNumber', value: 'MANUAL-42', reason: 'Human checked the signed invoice.' }, actor);
    edited.revision = 2;
    await db.batch(prepareWorkspaceCommit(db, edited, 1, actor));
    const action = { type: 'add_ai_candidates' as const, caseId: source.caseId, documentId: source.id, documentVersion: source.version, model: 'kimi-test', pages: [1], proposals: [{ field: 'invoiceNumber', value: 'INV-42', quote: 'Invoice INV-42', page: 1, confidence: 'high' as const }], pageReadings: [{ page: 1, documentType: 'invoice' as const, readability: 'clear' as const }] };
    const saved = await saveAiResult(db, state.id, actor, source, action);
    assert.equal(saved.revision, 3);
    assert.equal(saved.cases[0].fields.invoiceNumber.value, 'MANUAL-42');
    const changed = structuredClone(saved);
    changed.documents[0].version++;
    changed.revision++;
    await db.batch(prepareWorkspaceCommit(db, changed, saved.revision, actor));
    await assert.rejects(() => saveAiResult(db, state.id, actor, source, action), /outdated result was not saved/);
    assert.equal((await readWorkspaceState(db, state.id, actor.id))?.revision, 4);
  } finally { sqlite.close(); }
});

test('a competing human commit between the AI read and save retries only the guarded save', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const intake = applyAction(state, { type: 'intake', documents: [{ ...document('race'), mime: 'text/plain', name: 'race.txt', pages: [{ page: 1, text: 'Invoice INV-RACE' }] }] }, actor);
    intake.revision = 1;
    await db.batch(prepareWorkspaceCommit(db, intake, 0, actor));
    const source = intake.documents[0];
    let competing = true;
    let saveAttempts = 0;
    const racing = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      saveAttempts++;
      if (competing) {
        competing = false;
        const human = applyAction(intake, { type: 'review_field', caseId: source.caseId, field: 'invoiceNumber', value: 'HUMAN-RACE', reason: 'Signed original checked during AI reading.' }, actor);
        human.revision = 2;
        await db.batch(prepareWorkspaceCommit(db, human, 1, actor));
      }
      return db.batch(statements);
    } } as D1Database;
    const result = await saveAiResult(racing, state.id, actor, source, { type: 'add_ai_candidates', caseId: source.caseId, documentId: source.id, documentVersion: source.version, model: 'kimi-test', pages: [1], proposals: [], pageReadings: [{ page: 1, documentType: 'invoice', readability: 'clear' }] });
    assert.equal(saveAttempts, 2);
    assert.equal(result.revision, 3);
    assert.equal(result.cases[0].fields.invoiceNumber.value, 'HUMAN-RACE');
    const reference = structuredClone(result);
    reference.documents[0].referenceOnly = true;
    reference.revision++;
    await db.batch(prepareWorkspaceCommit(db, reference, result.revision, actor));
    await assert.rejects(() => saveAiResult(db, state.id, actor, source, { type: 'add_ai_candidates', caseId: source.caseId, documentId: source.id, documentVersion: source.version, model: 'kimi-test', pages: [1], proposals: [] }), /outdated result was not saved/);
  } finally { sqlite.close(); }
});

test('an unchanged original regrouped during reading saves into its current open case and preserves destination edits', async () => {
  const { db, sqlite, state } = fixture();
  try {
    const intake = applyAction(state, { type: 'intake', documents: [{ ...document('regroup'), mime: 'text/plain', name: 'regroup.txt', pages: [{ page: 1, text: 'Invoice INV-GROUP' }] }] }, actor);
    intake.revision = 1;
    await db.batch(prepareWorkspaceCommit(db, intake, 0, actor));
    const source = structuredClone(intake.documents[0]);
    let grouped = applyAction(intake, { type: 'move_documents', documentIds: [source.id], title: 'Confirmed shipment destination' }, actor);
    const target = grouped.documents.find(document => document.id === source.id)!.caseId;
    assert.notEqual(target, source.caseId);
    grouped = applyAction(grouped, { type: 'review_field', caseId: target, field: 'invoiceNumber', value: 'HUMAN-GROUP', reason: 'Checked the grouped originals.' }, actor);
    grouped.revision = 2;
    await db.batch(prepareWorkspaceCommit(db, grouped, 1, actor));
    const action = { type: 'add_ai_candidates' as const, caseId: source.caseId, documentId: source.id, documentVersion: source.version, model: 'kimi-test', pages: [1], proposals: [{ field: 'invoiceNumber', value: 'INV-GROUP', quote: 'Invoice INV-GROUP', page: 1, confidence: 'high' as const }], pageReadings: [{ page: 1, documentType: 'invoice' as const, readability: 'clear' as const }] };
    const saved = await saveAiResult(db, state.id, actor, source, action);
    assert.equal(saved.documents.find(document => document.id === source.id)!.caseId, target);
    assert.equal(saved.cases.find(shipment => shipment.id === target)!.fields.invoiceNumber.value, 'HUMAN-GROUP');
    assert.ok(saved.candidates.some(candidate => candidate.documentId === source.id && candidate.caseId === target));
    const closed = structuredClone(saved);
    closed.cases.find(shipment => shipment.id === target)!.status = 'completed';
    closed.revision++;
    await db.batch(prepareWorkspaceCommit(db, closed, saved.revision, actor));
    await assert.rejects(() => saveAiResult(db, state.id, actor, source, action), /outdated result was not saved/);
  } finally { sqlite.close(); }
});
