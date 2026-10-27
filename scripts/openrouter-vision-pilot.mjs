import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kimiExtractionPrompt } from '../lib/kimi.ts';
import { jpegDimensions } from '../lib/vision.ts';
import { readBoundedAiResponse } from '../lib/ai-provider.ts';
import { DEFAULT_MODELS, BASELINE_MODEL, sha256, modelDirectory, modelBudget, requestBudget, CostLedger, privateJson, executePilotJob } from './openrouter-vision-pilot-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frozenDirectory = path.join(root, 'outputs/kimi-glm-comparison-terminal-20261020T014245Z');
const frozenSelectionHash = '53c0d4ed703ba7ea81d7a5b017a60f8d96726f2cd2a03083d244cd7561d49a65';
const defaultSelection = path.join(root, 'outputs/vision-source-pilot-20261026/selection.json');
const defaultCatalog = path.join(root, 'outputs/vision-source-pilot-20261026/model-catalog.json');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

export function parseOptions(args) {
  const options = { run: false, includeGlm: false, selection: defaultSelection, catalog: defaultCatalog, maxTokens: 16000, maxCostUsd: 4.5, out: '', apiKeyFile: '', models: '', continueFrom: [], startingSpendUsd: 0, spendReconciled: false, budgetBasis: 'full_context', retryUnbilledRoutes: [] };
  let modeSeen = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--run' || key === '--dry-run') {
      if (modeSeen) throw new Error('choose_one_mode');
      modeSeen = true; options.run = key === '--run';
    } else if (key === '--include-glm') options.includeGlm = true;
    else if (key === '--spend-reconciled') options.spendReconciled = true;
    else if (key === '--retry-unbilled-route') { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('missing_argument'); options.retryUnbilledRoutes.push(value); }
    else if (key === '--continue-from') { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('missing_argument'); options.continueFrom.push(path.resolve(value)); }
    else if (['--selection', '--catalog', '--max-output-tokens', '--max-cost-usd', '--out', '--api-key-file', '--models', '--starting-spend-usd', '--budget-basis'].includes(key)) {
      const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('missing_argument');
      const name = { '--selection': 'selection', '--catalog': 'catalog', '--max-output-tokens': 'maxTokens', '--max-cost-usd': 'maxCostUsd', '--out': 'out', '--api-key-file': 'apiKeyFile', '--models': 'models', '--starting-spend-usd': 'startingSpendUsd', '--budget-basis': 'budgetBasis' }[key];
      options[name] = ['maxTokens', 'maxCostUsd', 'startingSpendUsd'].includes(name) ? Number(value) : ['models', 'budgetBasis'].includes(name) ? value : path.resolve(value);
    } else throw new Error('unknown_argument');
  }
  if (!options.out || options.run && !args.includes('--max-cost-usd')) throw new Error('output_and_explicit_live_budget_required');
  if (options.continueFrom.length && !args.includes('--starting-spend-usd')) throw new Error('continuation_requires_explicit_starting_spend');
  if (!options.continueFrom.length && options.startingSpendUsd) throw new Error('starting_spend_requires_prior_runs');
  if (!['full_context', 'opus_image_estimate'].includes(options.budgetBasis)) throw new Error('unsupported_budget_basis');
  if (options.retryUnbilledRoutes.length && (!options.continueFrom.length || !options.spendReconciled)) throw new Error('routing_retry_requires_reconciled_prior_run');
  new CostLedger(options.maxCostUsd, options.startingSpendUsd);
  return options;
}

/** Never resend an attempted model/page, including failed or interrupted requests. */
export async function previousAttempts(directories, jobs, startingSpendUsd, spendReconciled, retryUnbilledRoutes = []) {
  const attempts = new Map(); const evidence = []; let knownSpendUsd = 0; let unknownSpend = false;
  const retryKeys = new Set(retryUnbilledRoutes); const matchedRetries = new Set();
  if (retryKeys.size !== retryUnbilledRoutes.length || retryKeys.size && !spendReconciled) throw new Error('invalid_routing_retry');
  for (const directory of directories) {
    const planBytes = await fs.readFile(path.join(directory, 'plan.json'));
    const plan = JSON.parse(planBytes);
    if (plan.promptSha256 !== sha256(kimiExtractionPrompt()) || plan.frozenSelectionSha256 !== frozenSelectionHash) throw new Error('prior_run_prompt_or_sources_differ');
    async function walk(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name === 'claim.json') {
          const bytes = await fs.readFile(file); const claim = JSON.parse(bytes);
          const job = jobs.find(job => job.jobId === claim.jobId && job.packetId === claim.packetId && job.sourceSha256 === claim.sourceSha256 && job.inputImageSha256 === claim.inputImageSha256);
          if (!job || ![...DEFAULT_MODELS, BASELINE_MODEL].includes(claim.model)) throw new Error('prior_claim_identity_mismatch');
          const key = `${claim.model}:${claim.jobId}`;
          if (attempts.has(key)) throw new Error('duplicate_prior_attempts');
          attempts.set(key, claim); let cost, outcome;
          try { outcome = JSON.parse(await fs.readFile(path.join(folder, 'outcome.json'))); cost = outcome.usage?.cost; }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
          if (retryKeys.has(key)) {
            if (outcome?.error !== 'provider_http_404' || outcome?.result || cost !== undefined && cost !== null) throw new Error('only_reconciled_unbilled_route_failure_can_retry');
            matchedRetries.add(key);
          }
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) knownSpendUsd += cost; else unknownSpend = true;
          evidence.push({ model: claim.model, jobId: claim.jobId, claimSha256: sha256(bytes), costUsd: cost ?? null, routingRetryAuthorized: retryKeys.has(key) });
        }
      }
    }
    await walk(path.join(directory, 'runs'));
  }
  if (startingSpendUsd + 1e-8 < knownSpendUsd || unknownSpend && !spendReconciled) throw new Error('prior_spend_requires_reconciliation');
  if (matchedRetries.size !== retryKeys.size) throw new Error('routing_retry_prior_claim_not_found');
  for (const key of matchedRetries) attempts.delete(key);
  return { attempts, evidence, knownSpendUsd, unknownSpend, externallyReconciled: spendReconciled };
}

async function codeSnapshot() {
  const entries = [];
  async function walk(directory) {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(?:ts|mjs)$/.test(item.name)) entries.push({ path: path.relative(root, file), sha256: sha256(await fs.readFile(file)) });
    }
  }
  await walk(path.join(root, 'lib'));
  for (const name of ['openrouter-vision-pilot.mjs', 'openrouter-vision-pilot-core.mjs']) {
    const file = path.join(root, 'scripts', name); entries.push({ path: path.relative(root, file), sha256: sha256(await fs.readFile(file)) });
  }
  return { sha256: sha256(JSON.stringify(entries)), files: entries };
}

export async function preparePilot(options) {
  const selectedBytes = await fs.readFile(options.selection);
  const selected = JSON.parse(selectedBytes);
  if (!exactKeys(selected, ['schemaVersion', 'pages']) || selected.schemaVersion !== 1 || !Array.isArray(selected.pages) || selected.pages.length !== 4
    || selected.pages.some(page => !exactKeys(page, ['jobId', 'packetId', 'reason']) || ![page.jobId, page.packetId, page.reason].every(item => typeof item === 'string'))
    || new Set(selected.pages.map(page => page.jobId)).size !== 4 || new Set(selected.pages.map(page => page.packetId)).size !== 4) throw new Error('four_distinct_original_cases_required');
  const frozenBytes = await fs.readFile(path.join(frozenDirectory, 'selection.json'));
  if (sha256(frozenBytes) !== frozenSelectionHash) throw new Error('frozen_selection_modified');
  const frozen = JSON.parse(frozenBytes);
  const jobs = [];
  for (const page of selected.pages) {
    const job = frozen.jobs.find(job => job.jobId === page.jobId && job.packetIds.includes(page.packetId));
    const packet = frozen.packets.find(packet => packet.id === page.packetId);
    const source = packet?.sources.find(source => source.sha256 === job?.sourceSha256);
    if (!job || !source || /to\s*khai/i.test(source.name)) throw new Error('selected_page_not_original_source');
    const bytes = await fs.readFile(job.imagePath);
    if (sha256(bytes) !== job.inputImageSha256 || sha256(await fs.readFile(source.originalPath)) !== source.sha256) throw new Error('original_input_hash_mismatch');
    const dimensions = jpegDimensions(bytes);
    if (dimensions.width !== job.width || dimensions.height !== job.height) throw new Error('original_dimensions_mismatch');
    jobs.push({ ...job, packetId: packet.id, case: packet.folder, sourceSize: source.size, reason: page.reason });
  }
  // Predeclared order: three small diagnostic pages before the dense ten-row invoice.
  jobs.push(jobs.shift());
  const catalogBytes = await fs.readFile(options.catalog);
  const catalog = JSON.parse(catalogBytes);
  if (sha256(await fs.readFile(catalog.sourceCatalogPath)) !== catalog.sourceCatalogSha256) throw new Error('catalog_provenance_mismatch');
  const ids = options.models ? options.models.split(',') : [...DEFAULT_MODELS, ...(options.includeGlm ? [BASELINE_MODEL] : [])];
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => ![...DEFAULT_MODELS, BASELINE_MODEL].includes(id))) throw new Error('unsupported_model_subset');
  const models = ids.map(id => {
    const model = catalog.models.find(model => model.id === id); if (!model) throw new Error('catalog_model_missing');
    modelBudget(model, options.maxTokens); return model;
  });
  const prior = await previousAttempts(options.continueFrom, jobs, options.startingSpendUsd, options.spendReconciled, options.retryUnbilledRoutes);
  const code = await codeSnapshot();
  return { jobs, models, attempted: prior.attempts, plan: { schemaVersion: 1, mode: options.run ? 'live' : 'dry_run_no_inference', createdAt: new Date().toISOString(),
    continuation: { startingSpendUsd: options.startingSpendUsd, knownPriorSpendUsd: prior.knownSpendUsd, priorUnknownSpend: prior.unknownSpend, externallyReconciled: prior.externallyReconciled, attempts: prior.evidence },
    maxCostUsd: options.maxCostUsd, maxOutputTokens: options.maxTokens, budgetBasis: options.budgetBasis, maximumCalls: models.length * jobs.length,
    selectionSha256: sha256(selectedBytes), frozenSelectionSha256: frozenSelectionHash, catalogSha256: sha256(catalogBytes), sourceCatalogSha256: catalog.sourceCatalogSha256,
    promptSha256: sha256(kimiExtractionPrompt()), code, jobs, models: models.map(model => ({ ...model, pilotBudget: requestBudget(model, jobs[0], options.maxTokens, options.budgetBasis) })),
    policy: { onePagePerRequest: true, originalImagesOnly: true, referenceAnswersRead: false, repairCalls: 0, automaticRetries: 0, productionChanged: false,
      privacy: 'ZDR required, data collection denied, required parameters, no provider fallback',
      budget: 'Sequential input allowance plus capped output reservation at highest catalog tier; full model context by default, or explicitly selected Opus image estimate recorded in pilotBudget. Replace with reported cost; retain reservation and halt on unknown spend. An estimated input allowance is not an enforced token ceiling. Rates and provider caps are assumptions; account/key limits are the external ceiling.',
      scoring: 'Independent source-gold evaluator runs only after outcomes are saved; first-pass results differ from production automatic-repair policy.' } } };
}

async function checkLiveCatalog(models, maxTokens) {
  const response = await fetch('https://openrouter.ai/api/v1/models', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('live_catalog_unavailable');
  const raw = await readBoundedAiResponse(response, 8 * 1024 * 1024);
  const catalog = JSON.parse(raw);
  for (const expected of models) {
    const actual = catalog.data?.find(model => model.id === expected.id);
    if (!actual || JSON.stringify(modelBudget(actual, maxTokens)) !== JSON.stringify(modelBudget(expected, maxTokens))
      || actual.canonical_slug !== expected.canonical_slug) throw new Error('live_catalog_changed_review_before_spending');
  }
  return { checkedAt: new Date().toISOString(), sha256: sha256(raw), models: catalog.data.filter(model => models.some(expected => expected.id === model.id)) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const prepared = await preparePilot(options);
  // Only new directories are accepted: never overwrite frozen data or repeat a crashed run.
  await fs.mkdir(options.out, { mode: 0o700 });
  await privateJson(path.join(options.out, 'plan.json'), prepared.plan);
  await fs.writeFile(path.join(options.out, 'prompt.txt'), kimiExtractionPrompt(), { flag: 'wx', mode: 0o600 });
  if (!options.run) {
    await privateJson(path.join(options.out, 'summary.json'), { mode: 'dry_run_no_inference', calls: 0, models: prepared.models.map(model => model.id), pages: prepared.jobs.length, maxCostUsd: options.maxCostUsd });
    console.log(JSON.stringify({ mode: 'dry_run_no_inference', calls: 0, output: options.out })); return;
  }
  // Credential is read only for an explicit live run, never added to saved metadata.
  const apiKey = (options.apiKeyFile ? await fs.readFile(options.apiKeyFile, 'utf8') : process.env.OPENROUTER_API_KEY ?? '').trim();
  if (!/^sk-or-[A-Za-z0-9_-]{12,}$/.test(apiKey)) throw new Error('openrouter_key_missing_or_invalid');
  await privateJson(path.join(options.out, 'live-catalog.json'), await checkLiveCatalog(prepared.models, options.maxTokens));
  const ledger = new CostLedger(options.maxCostUsd, options.startingSpendUsd); const outcomes = [];
  for (const model of prepared.models) {
    for (const job of prepared.jobs) {
      if (prepared.attempted.has(`${model.id}:${job.jobId}`)) { outcomes.push({ model: model.id, jobId: job.jobId, skipped: true, reason: 'previously_attempted_no_resend' }); continue; }
      if ((await codeSnapshot()).sha256 !== prepared.plan.code.sha256) throw new Error('code_changed_during_pilot');
      const outcome = await executePilotJob({ model, job, apiKey, ledger, maxTokens: options.maxTokens, budgetBasis: options.budgetBasis, imageBytes: await fs.readFile(job.imagePath),
        directory: path.join(options.out, 'runs', modelDirectory(model.id), job.jobId) });
      outcomes.push({ model: model.id, jobId: job.jobId, ...(outcome.skipped ? outcome : { error: outcome.error ?? null, elapsedMs: outcome.elapsedMs, usage: outcome.usage }) });
      console.log(JSON.stringify({ model: model.id, page: job.page, status: outcome.skipped ? 'skipped_budget_guard' : outcome.error ? 'failed' : 'completed', budget: ledger.snapshot() }));
      if (ledger.halted) break;
    }
    if (ledger.halted) break;
  }
  await privateJson(path.join(options.out, 'summary.json'), { mode: 'live', completedAt: new Date().toISOString(), codeUnchanged: (await codeSnapshot()).sha256 === prepared.plan.code.sha256,
    calls: outcomes.filter(outcome => !outcome.skipped).length, budget: ledger.snapshot(), outcomes });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never echo provider bodies, credentials, or runtime exception details to stdout.
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'pilot_setup_or_filesystem_failure';
    console.error(`Pilot stopped: ${code}`); process.exitCode = 1;
  });
}
