import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CostLedger, makeRequest, modelBudget, requestBudget, validateResponse, executePilotJob, sha256, ENDPOINT } from '../scripts/openrouter-vision-pilot-core.mjs';
import { parseOptions, preparePilot, previousAttempts } from '../scripts/openrouter-vision-pilot.mjs';
import { kimiExtractionPrompt } from '../lib/kimi.ts';

const model = { id: 'openai/gpt-6.1-terra', canonical_slug: 'openai/gpt-6.1-terra-20261026', context_length: 1050000,
  top_provider: { max_completion_tokens: 128000 }, architecture: { input_modalities: ['text', 'image'] },
  supported_parameters: ['max_tokens', 'reasoning', 'response_format'], reasoning: { supported_efforts: ['medium'] },
  pricing: { prompt: '0.000001', completion: '0.000005', overrides: [{ prompt: '0.000002', completion: '0.0000075' }] } };
const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 200, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
const job = { jobId: 'synthetic-job', packetId: 'synthetic-case', sourceSha256: 'a'.repeat(64), inputImageSha256: sha256(imageBytes), page: 1, width: 100, height: 200 };
const reading = { pageReadings: [{ page: 1, documentType: 'invoice', readability: 'clear' }], candidates: [
  { field: 'invoiceNumber', value: 'INV-100', quote: 'Invoice No: INV-100', page: 1, confidence: 'high', readability: 'clear', evidence: 'vision', bounds: { left: .1, top: .1, right: .5, bottom: .2 } },
] };
const envelope = (content: unknown = reading) => ({ id: 'synthetic-response', provider: 'Synthetic provider', model: model.id, usage: { cost: .01, prompt_tokens: 100, completion_tokens: 100 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });

test('requests contain only current prompt and selected original image, with strict privacy and no fallback', () => {
  const body = makeRequest(model, { ...job, sourceText: 'OLD OCR', referenceAnswer: 'ANSWER KEY' }, imageBytes);
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.reasoning, { effort: 'medium', exclude: true });
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny', require_parameters: true, allow_fallbacks: false, only: ['openai'], max_price: { prompt: 2, completion: 7.5 } });
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.messages[1].content.length, 3);
  const sourceText = body.messages[1].content[0];
  assert.equal(typeof sourceText === 'object' && 'text' in sourceText && sourceText.text, '{"pages":[{"page":1}]}');
  assert.ok(!JSON.stringify(body).includes('ANSWER KEY'));
  assert.ok(!JSON.stringify(body).includes('OLD OCR'));
  assert.throws(() => makeRequest(model, { ...job, inputImageSha256: 'b'.repeat(64) }, imageBytes), /hash_mismatch/);
});

test('budget uses long context overrides, settles sequentially, and halts with a retained reserve on unknown cost', () => {
  assert.equal(modelBudget(model).reservationUsd, 2.22);
  const ledger = new CostLedger(4.5);
  assert.equal(ledger.reserve(4.32), true);
  assert.equal(ledger.reserve(.01), false);
  ledger.settle(.02);
  assert.equal(ledger.reserve(4.32), true);
  ledger.settle(undefined);
  assert.deepEqual(ledger.snapshot(), { limitUsd: 4.5, chargedUsd: .02, reservedUsd: 4.32, halted: true });
  assert.equal(ledger.reserve(.01), false);
  assert.throws(() => modelBudget({ ...model, reasoning: { supported_efforts: ['high'] } }), /unsupported/);
});

test('source validation retains rejected raw facts and applies uncertain-page confidence consistently', () => {
  const result = validateResponse(envelope({ ...reading, candidates: [...reading.candidates, { ...reading.candidates[0], value: 'INVENTED' }] }), model, job);
  assert.equal(result.proposals.length, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected, 1);
  assert.ok(result.rejectionDiagnostics?.[0].reasons.includes('value_not_in_quote'));
  const uncertain = validateResponse(envelope({ ...reading, pageReadings: [{ ...reading.pageReadings[0], readability: 'uncertain' }] }), model, job);
  assert.equal(uncertain.candidates[0].confidence, 'low');
  assert.throws(() => validateResponse({ ...envelope(), model: 'different/model' }, model, job), /model_mismatch/);
  assert.throws(() => validateResponse({ ...envelope(), choices: [{ finish_reason: 'length', message: { content: '' } }] }, model, job), /incomplete/);
});

test('single request writes private evidence, masks reflected key, and never repeats a durable claim', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-test-'));
  const apiKey = 'synthetic-secret-not-real'; let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${apiKey}`);
    return Response.json({ ...envelope(), extra: apiKey });
  };
  try {
    const result = await executePilotJob({ model, job, imageBytes, apiKey, directory, ledger: new CostLedger(4.5), fetchImpl });
    assert.ok('result' in result);
    assert.equal(result.result.candidates[0].value, 'INV-100');
    assert.equal((result.usage as { cost: number }).cost, .01);
    const raw = await fs.readFile(path.join(directory, 'response.private.json'), 'utf8');
    assert.ok(!raw.includes(apiKey)); assert.ok(raw.includes('[REDACTED_API_KEY]'));
    assert.equal((await fs.stat(path.join(directory, 'outcome.json'))).mode & 0o777, 0o600);
    assert.ok(!(await fs.readFile(path.join(directory, 'request.json'), 'utf8')).includes(apiKey));
    await assert.rejects(executePilotJob({ model, job, imageBytes, apiKey, directory, ledger: new CostLedger(4.5), fetchImpl }), /EEXIST/);
    assert.equal(calls, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('HTTP and network failures never retry; missing spend halts subsequent calls', async () => {
  for (const kind of ['http', 'network']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-fail-'));
    let calls = 0; const ledger = new CostLedger(4.5);
    const fetchImpl: typeof fetch = async () => { calls++; if (kind === 'network') throw new Error('private detail'); return Response.json({ error: { message: 'private detail' } }, { status: 503 }); };
    try {
      const result = await executePilotJob({ model, job, imageBytes, apiKey: 'synthetic', directory, ledger, fetchImpl });
      assert.equal(calls, 1); assert.equal(ledger.halted, true); assert.equal(ledger.reservedUsd, 2.22);
      assert.ok(!JSON.stringify(result).includes('private detail'));
      const skipped = await executePilotJob({ model, job, imageBytes, apiKey: 'synthetic', directory: path.join(directory, 'other'), ledger, fetchImpl });
      assert.ok('skipped' in skipped && skipped.skipped); assert.equal(calls, 1);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
});

test('dry preparation verifies four frozen original pages without reading key or reference answers', async () => {
  assert.throws(() => parseOptions(['--run', '--out', '/tmp/example']), /explicit_live_budget/);
  const options = parseOptions(['--dry-run', '--out', '/tmp/unused-pilot-output', '--api-key-file', '/missing/never-read-key']);
  const result = await preparePilot(options);
  assert.equal(result.jobs.length, 4);
  assert.equal(result.models.length, 3);
  assert.equal(result.plan.mode, 'dry_run_no_inference');
  assert.equal(result.plan.policy.referenceAnswersRead, false);
  assert.ok(!JSON.stringify(result.plan).includes('never-read-key'));
  assert.equal(result.jobs.at(-1)?.packetId, 'tokhai-76a082a307d4');
});

test('continuation excludes every prior claim and requires reconciled unknown spend', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-continuation-'));
  try {
    await fs.mkdir(path.join(directory, 'runs', 'model', 'job'), { recursive: true });
    await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify({ promptSha256: sha256(kimiExtractionPrompt()), frozenSelectionSha256: '53c0d4ed703ba7ea81d7a5b017a60f8d96726f2cd2a03083d244cd7561d49a65' }));
    await fs.writeFile(path.join(directory, 'runs', 'model', 'job', 'claim.json'), JSON.stringify({ ...job, model: model.id }));
    await assert.rejects(previousAttempts([directory], [job], .204344, false), /reconciliation/);
    const result = await previousAttempts([directory], [job], .204344, true);
    assert.equal(result.attempts.has(`${model.id}:${job.jobId}`), true);
    assert.equal(result.unknownSpend, true);
    const retryKey = `${model.id}:${job.jobId}`;
    await assert.rejects(previousAttempts([directory], [job], .204344, true, [retryKey]), /only_reconciled/);
    const outcomeFile = path.join(directory, 'runs', 'model', 'job', 'outcome.json');
    await fs.writeFile(outcomeFile, JSON.stringify({ error: 'provider_http_404', usage: null }));
    const retry = await previousAttempts([directory], [job], .204344, true, [retryKey]);
    assert.equal(retry.attempts.has(retryKey), false);
    assert.equal(retry.evidence[0].routingRetryAuthorized, true);
    await fs.writeFile(outcomeFile, JSON.stringify({ error: 'transport_or_validation_failure', usage: { cost: .1 } }));
    await assert.rejects(previousAttempts([directory], [job], .204344, true, [retryKey]), /only_reconciled/);
    const ledger = new CostLedger(4.5, .204344);
    assert.equal(ledger.reserve(4.32), false);
    assert.equal(ledger.reserve(4.16), true);
    assert.throws(() => parseOptions(['--dry-run', '--out', '/tmp/unused', '--continue-from', directory]), /explicit_starting_spend/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Opus image estimate is explicit and conservative, leaves other models unchanged, and pins the previously used provider', () => {
  const opus = { ...model, id: 'anthropic/claude-opus-5.5', context_length: 1000000, pricing: { prompt: '0.000004', completion: '0.000020', overrides: [] } };
  const budget = requestBudget(opus, job, 16000, 'opus_image_estimate');
  assert.equal(budget.basis, 'opus_image_estimate');
  assert.ok('estimatedInputTokens' in budget);
  assert.ok(budget.estimatedInputTokens > 79000);
  assert.ok(budget.reservationUsd > 16000 * budget.completion && budget.reservationUsd < modelBudget(opus).reservationUsd);
  assert.ok(budget.estimateAssumption?.includes('no documented end-to-end tokenizer guarantee'));
  assert.equal(requestBudget(model, job, 16000, 'opus_image_estimate').basis, 'full_context');
  assert.equal(requestBudget(model, job, 16000, 'opus_image_estimate').reservationUsd, 2.22);
  assert.deepEqual(makeRequest(opus, job, imageBytes).provider.only, ['amazon-bedrock']);
});
