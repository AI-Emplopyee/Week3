// Exercise saved drafts, HTTP authorization, recovery and the durable queue
// with synthetic values in a separate disposable workspace only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EDA_HEADER_FIELDS, EDA_GOODS_FIELDS } from '../lib/ecus-export.ts';

const base = new URL(process.argv[2] || 'http://127.0.0.1:5184');
if (process.env.AICD_SMOKE_ISOLATED !== '1') throw new Error('Set AICD_SMOKE_ISOLATED=1 only for a separate disposable workspace. Never use shipment records.');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Only a loopback development server is supported.');
async function responseJson(response, path, expected) {
  const text = await response.text();
  assert.equal(response.status, expected, `${path} returned unexpected HTTP status`);
  if (response.headers.get('content-type')?.includes('application/json')) return JSON.parse(text);
  assert.ok(expected >= 400, 'Successful API responses must be JSON');
  return { error: text };
}
async function request(path, body, expected = 200, extra = {}) {
  const response = await fetch(new URL(path, base), { method: 'POST', headers: { Origin: base.origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  return responseJson(response, path, expected);
}
async function get(path) {
  return responseJson(await fetch(new URL(path, base), { cache: 'no-store' }), path, 200);
}
const auth = await get('/api/auth/status');
assert.equal(auth.mode, 'local');
let workspace = await get('/api/workspace');
const unique = crypto.randomUUID();
workspace = await request('/api/workspace', { revision: workspace.state.revision, action: { type: 'create_case', title: `SYNTHETIC ECUS HTTP ${unique}`, caseType: 'export' } });
const shipment = workspace.state.cases.find(item => item.title.endsWith(unique));
const paired = await request('/api/ecus/devices', { label: 'SYNTHETIC HTTP helper' }, 201);
const authorization = { Authorization: `Bearer ${paired.token}` };
try {
  await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 401);
  await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 403, { ...authorization, Origin: 'https://unrelated.invalid' });
  await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 200, authorization);
  const value = field => field.key === 'currency' ? 'USD' : ['origin', 'importerCountry'].includes(field.key) ? 'VN'
    : field.key === 'hsCode' ? '12345678' : ['decimal', 'integer'].includes(field.input) ? '1' : 'SYNTHETIC';
  const fields = catalog => Object.fromEntries(catalog.filter(field => field.required).map(field => [field.key, value(field)]));
  const form = { headers: fields(EDA_HEADER_FIELDS), goods: [fields(EDA_GOODS_FIELDS)] };
  const draftPath = `/api/ecus/draft?caseId=${encodeURIComponent(shipment.id)}`;
  const initial = await get(draftPath);
  assert.equal(initial.draft, null);
  assert.equal(initial.workspaceRevision, workspace.state.revision);
  assert.match(initial.sourceFingerprint, /^[a-f0-9]{64}$/);

  // Saving unfinished dates/decimals and surrounding whitespace must not run
  // transfer validation or lose what an employee has typed.
  const incomplete = { headers: { invoiceNumber: '  SYNTHETIC unfinished  ', invoiceDate: '2026-', remarks: '  preserve outer whitespace  ' }, goods: [{ description: ' unfinished goods ', quantity: '1.' }] };
  const firstSave = { caseId: shipment.id, revision: initial.workspaceRevision, draftRevision: 0, form: incomplete, sourceConfirmed: false };
  const savedIncomplete = await request('/api/ecus/draft', firstSave);
  assert.equal(savedIncomplete.draft.revision, 1);
  assert.deepEqual(savedIncomplete.draft.form, incomplete);
  assert.deepEqual((await get(draftPath)).draft, savedIncomplete.draft);
  await request('/api/ecus/draft', { ...firstSave, form: { headers: {}, goods: [] } }, 409);
  await request('/api/ecus/draft', { ...firstSave, draftRevision: 1, revision: initial.workspaceRevision - 1 }, 409);
  assert.deepEqual((await get(draftPath)).draft.form, incomplete, 'Conflicting writes must preserve the saved draft');

  workspace = await request('/api/workspace', { revision: workspace.state.revision, action: { type: 'update_case', caseId: shipment.id, title: shipment.title + ' revised source' } });
  const changedSource = await get(draftPath);
  assert.equal(changedSource.draft.sourceChanged, true);
  assert.notEqual(changedSource.sourceFingerprint, initial.sourceFingerprint);
  const reviewedSave = { ...firstSave, revision: changedSource.workspaceRevision, draftRevision: 1, form };
  const sourceConflict = await request('/api/ecus/draft', reviewedSave, 409);
  assert.equal(sourceConflict.draft.sourceChanged, true);
  assert.deepEqual(sourceConflict.draft.form, incomplete);
  const savedComplete = await request('/api/ecus/draft', { ...reviewedSave, sourceConfirmed: true });
  assert.equal(savedComplete.draft.revision, 2);
  assert.deepEqual((await get(draftPath)).draft.form, form);
  const input = { revision: savedComplete.workspaceRevision, draftRevision: savedComplete.draft.revision, caseId: shipment.id, deviceId: paired.id, confirmed: true, form };
  await request('/api/ecus/submit', { ...input, confirmed: false }, 400);
  await request('/api/ecus/submit', { ...input, revision: input.revision - 1 }, 409);
  await request('/api/ecus/submit', { ...input, draftRevision: input.draftRevision - 1 }, 409);
  const accepted = await request('/api/ecus/submit', input, 202);
  const repeated = await request('/api/ecus/submit', input, 202);
  assert.equal(accepted.job.id, repeated.job.id);
  const claim = await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 200, authorization);
  assert.equal(claim.job.id, accepted.job.id);
  assert.equal(createHash('sha256').update(claim.job.payloadJson, 'utf8').digest('hex'), claim.job.payloadHash);
  assert.deepEqual(JSON.parse(claim.job.payloadJson).form, form);
  const secondClaim = await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 200, authorization);
  assert.equal(secondClaim.job, null);
  const readback = structuredClone(form);
  readback.goods[0].quantity = '2';
  const result = { action: 'result', jobId: claim.job.id, leaseToken: claim.job.leaseToken, status: 'needs_reconciliation', draftReference: 'SYNTHETIC-NO-NATIVE-DRAFT', message: 'Synthetic mismatched callback; no ECUS operation occurred.', readback };
  const interrupted = await request('/api/ecus/companion', result, 200, authorization);
  assert.equal(interrupted.job.status, 'needs_reconciliation');
  assert.ok(interrupted.job.differences.some(difference => difference.path === 'goods[0].quantity' && difference.expected === '1' && difference.actual === '2'));
  const replayedResult = await request('/api/ecus/companion', { ...result, status: 'succeeded', readback: form }, 200, authorization);
  assert.equal(replayedResult.job.status, 'needs_reconciliation');
  assert.deepEqual(replayedResult.job.differences, interrupted.job.differences);

  const recoveryInput = { jobId: claim.job.id, disposition: 'no_draft', reason: 'Synthetic smoke verification: no native ECUS action occurred and no draft exists.', confirmed: true };
  await request('/api/ecus/reconcile', { ...recoveryInput, confirmed: false }, 400);
  const recovered = await request('/api/ecus/reconcile', recoveryInput);
  assert.equal(recovered.job.id, claim.job.id);
  assert.equal(recovered.job.status, 'needs_reconciliation', 'Recovery must preserve the original terminal result');
  assert.equal(recovered.job.resolution.disposition, 'no_draft');
  assert.equal(recovered.job.resolution.deviceAcknowledged, false);
  await request('/api/ecus/submit', input, 409);
  const synchronized = await request('/api/ecus/companion', { action: 'recovery_sync', jobIds: [claim.job.id], acknowledgements: [] }, 200, authorization);
  const decision = synchronized.resolutions.find(item => item.jobId === claim.job.id);
  assert.ok(decision, 'The paired helper must receive the reviewed recovery');
  assert.equal(decision.payloadHash, claim.job.payloadHash);
  assert.equal(decision.disposition, 'no_draft');
  assert.equal(decision.reason, recoveryInput.reason);
  assert.ok(decision.actorName);
  assert.ok(Number.isFinite(Date.parse(decision.createdAt)));
  assert.deepEqual(synchronized.acknowledgedResolutionIds, []);
  const acknowledgement = { jobId: decision.jobId, resolutionId: decision.id, payloadHash: decision.payloadHash };
  const acknowledged = await request('/api/ecus/companion', { action: 'recovery_sync', jobIds: [claim.job.id], acknowledgements: [acknowledgement] }, 200, authorization);
  assert.ok(acknowledged.acknowledgedResolutionIds.includes(decision.id));
  const repeatedAck = await request('/api/ecus/companion', { action: 'recovery_sync', jobIds: [claim.job.id], acknowledgements: [acknowledgement] }, 200, authorization);
  assert.ok(repeatedAck.acknowledgedResolutionIds.includes(decision.id), 'Lost acknowledgement responses must be safely repeatable');

  const retry = await request('/api/ecus/submit', input, 202);
  const repeatedRetry = await request('/api/ecus/submit', input, 202);
  assert.notEqual(retry.job.id, claim.job.id);
  assert.equal(retry.job.retryOf, claim.job.id);
  assert.equal(retry.job.id, repeatedRetry.job.id, 'Identical resubmission must create exactly one retry');
  const retryClaim = await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 200, authorization);
  assert.equal(retryClaim.job.id, retry.job.id);
  assert.equal(createHash('sha256').update(retryClaim.job.payloadJson, 'utf8').digest('hex'), retryClaim.job.payloadHash);
  assert.deepEqual(JSON.parse(retryClaim.job.payloadJson).form, form);
  const completed = await request('/api/ecus/companion', { ...result, jobId: retryClaim.job.id, leaseToken: retryClaim.job.leaseToken, status: 'succeeded', draftReference: 'SYNTHETIC-RETRY-NO-NATIVE-DRAFT', readback: form }, 200, authorization);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal((await request('/api/ecus/companion', { action: 'poll', ready: true, profileId: 'synthetic' }, 200, authorization)).job, null);

  const status = await get(`/api/ecus/status?caseId=${encodeURIComponent(shipment.id)}`);
  assert.equal(status.jobs.length, 2, 'Recovery must retain the original job and create only one child');
  const oldJob = status.jobs.find(item => item.id === accepted.job.id);
  const newJob = status.jobs.find(item => item.id === retry.job.id);
  assert.equal(oldJob.status, 'needs_reconciliation');
  assert.deepEqual(oldJob.differences, interrupted.job.differences);
  assert.equal(oldJob.resolution.id, decision.id);
  assert.equal(oldJob.resolution.reason, recoveryInput.reason);
  assert.equal(oldJob.resolution.deviceAcknowledged, true);
  assert.equal(newJob.status, 'succeeded');
  assert.equal(newJob.retryOf, oldJob.id);
  assert.deepEqual((await get(draftPath)).draft.form, form);
  for (const device of status.devices) {
    assert.equal(device.token, undefined);
    assert.equal(device.token_hash, undefined);
  }
  console.log('PASS incomplete draft persistence/reload, stale edit and submit conflicts, HTTP authentication/origin checks, queue deduplication, exclusive claims, payload hashes, mismatch evidence, audited recovery synchronization/acknowledgement, exactly one retry and retained history. No native ECUS operation occurred.');
} finally {
  const response = await fetch(new URL('/api/ecus/devices', base), { method: 'DELETE', headers: { Origin: base.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: paired.id }) });
  assert.equal(response.status, 200);
}
