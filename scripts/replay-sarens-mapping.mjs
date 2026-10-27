/** Offline regression replay of the four frozen Sarens GLM readings.
 * node --experimental-strip-types scripts/replay-sarens-mapping.mjs --code-root <root> --out <new-directory> [--baseline <replay-report.json>]
 * No provider calls, credentials, answer keys, live workspace or frozen-input writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const frozen = path.join(root, 'outputs/kimi-glm-comparison-terminal-20261020T014245Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const filesBelow = async folder => (await Promise.all((await fs.readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? filesBelow(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))).flat();
const sourceHashes = async codeRoot => Promise.all([...(await filesBelow(path.join(codeRoot, 'lib'))), path.join(codeRoot, 'scripts/tokhai-benchmark-utils.mjs')].sort().map(async filename => ({ path: path.relative(codeRoot, filename), sha256: hash(await fs.readFile(filename)) })));
const targetFields = new Map([['1.16', 'Importer phone'], ['1.27', 'Packages'], ['1.28', 'Gross weight'], ['1.31', 'Transport'], ['1.32', 'Arrival date'], ['1.33', 'Unloading location'], ['1.34', 'Loading location'], ['1.74', 'Supplier HS code'], ['1.78', 'Goods description'], ['1.79', 'Origin']]);
const actor = { id: 'sarens-offline-regression', name: 'Offline regression replay', email: '' };
const args = process.argv.slice(2);
let codeRoot = root, output, baselinePath;
for (let index = 0; index < args.length; index++) {
  const flag = args[index], value = args[++index];
  if (!value) throw new Error('Each argument requires a path.');
  if (flag === '--code-root') codeRoot = path.resolve(value);
  else if (flag === '--out') output = path.resolve(value);
  else if (flag === '--baseline') baselinePath = path.resolve(value);
  else throw new Error(`Unknown argument: ${flag}`);
}
if (!output) throw new Error('Use --out <new-directory>; output directories are never overwritten.');
if ([frozen, path.join(root, 'outputs/glm-form-improvement-20261020')].some(folder => output === folder || output.startsWith(folder + path.sep))) throw new Error('Cannot write inside frozen benchmark or prior evaluation directories.');
if (await fs.stat(output).catch(() => null)) throw new Error('Output already exists. Use a new directory to preserve the earlier run.');
let attemptedNetworkCalls = 0;
globalThis.fetch = async () => { attemptedNetworkCalls++; throw new Error('Network is disabled for saved-reading regression replay.'); };

const verifiedInputs = [];
const snapshot = await read(path.join(frozen, 'snapshot-manifest.json'));
const frozenHashes = new Map(snapshot.files.map(item => [item.path, item.sha256]));
async function verifiedRead(relative) {
  const filename = path.join(frozen, relative), bytes = await fs.readFile(filename);
  if (!frozenHashes.has(relative) || hash(bytes) !== frozenHashes.get(relative)) throw new Error(`Frozen input failed integrity check: ${relative}`);
  verifiedInputs.push({ path: filename, sha256: hash(bytes) });
  return JSON.parse(bytes);
}
const selection = await verifiedRead('selection.json');
const plan = await verifiedRead('plan.json');
const planHash = frozenHashes.get('plan.json');
if (plan.selectionSha256 !== frozenHashes.get('selection.json')) throw new Error('Plan and frozen selection differ.');
const variant = plan.variants.find(item => item.id === 'glm53-flash-low');
if (!variant || variant.model !== 'glm-5.3-flash' || selection.packets.length !== 4 || selection.jobs.length !== 22) throw new Error('Unexpected pilot scope or model.');
const originalSources = new Map(selection.packets.flatMap(packet => packet.sources).map(source => [source.sha256, source]));
for (const source of originalSources.values()) {
  if (/to[\s_-]*khai/i.test(source.name.normalize('NFD').replace(/\p{M}/gu, ''))) throw new Error('Employee declaration cannot enter replay input.');
  if (hash(await fs.readFile(source.originalPath)) !== source.sha256) throw new Error(`Original fingerprint changed: ${source.name}`);
  verifiedInputs.push({ path: source.originalPath, sha256: source.sha256 });
}
for (const job of selection.jobs) {
  if (hash(await fs.readFile(job.imagePath)) !== job.inputImageSha256) throw new Error(`Source page image changed: ${job.jobId}`);
  verifiedInputs.push({ path: job.imagePath, sha256: job.inputImageSha256 });
}
const codeHashes = await sourceHashes(codeRoot);
const codeManifestPath = path.join(codeRoot, 'code-manifest.json');
if (await fs.stat(codeManifestPath).catch(() => null)) {
  for (const item of (await read(codeManifestPath)).files) if (hash(await fs.readFile(path.join(codeRoot, item.path))) !== item.sha256) throw new Error(`Before-code snapshot changed: ${item.path}`);
}
const engine = await import(pathToFileURL(path.join(codeRoot, 'lib/engine.ts')).href);
const utils = await import(pathToFileURL(path.join(codeRoot, 'scripts/tokhai-benchmark-utils.mjs')).href);
const observations = new Map();
for (const job of selection.jobs) {
  const reading = await verifiedRead(`runs/${variant.id}/readings/${job.jobId}.json`);
  if (reading.variantId !== variant.id || reading.model !== variant.model || reading.planHash !== planHash || reading.sharedPromptHash !== plan.sharedPromptHash || reading.jobId !== job.jobId || stable(reading.settings) !== stable(variant.settings) || !utils.readingMatches(reading, originalSources.get(job.sourceSha256), { ...job, imageSha256: job.inputImageSha256 }, variant.promptHash, variant.model)) throw new Error(`Saved result identity differs: ${job.jobId}`);
  observations.set(job.jobId, reading);
}
const baselineBytes = baselinePath ? await fs.readFile(baselinePath) : null;
const baseline = baselineBytes ? JSON.parse(baselineBytes) : null;
if (baseline && (baseline.model !== variant.model || baseline.planHash !== planHash || baseline.mode !== 'unassisted_saved_reading_replay' || stable(baseline.readingHashes) !== stable(verifiedInputs.filter(item => item.path.includes('/readings/'))))) throw new Error('Baseline does not use the identical saved readings and replay mode.');

function components(shipment, state) {
  const goods = new Map(shipment.goods.map((row, index) => [row.id, `goods:${index + 1}`]));
  const documents = new Map(state.documents.map(document => [document.id, document]));
  const result = [];
  for (const field of shipment.declarationDraft?.fields || []) {
    if (field.applicability !== 'applicable' || field.stale) continue;
    const scope = field.goodsLineId ? goods.get(field.goodsLineId) : 'header';
    if (!scope) throw new Error('Declaration field points to an absent goods row.');
    const entries = field.fieldId === '1.26' && field.value.rows ? [['reference', field.value.rows.map(row => row.reference).filter(Boolean)]] : Object.entries(field.value).filter(([key]) => key !== 'kind' && key !== 'rows');
    for (const [component, value] of entries) {
      if (value === '' || value === undefined || value === null || Array.isArray(value) && !value.length) continue;
      result.push({ scope, fieldId: field.fieldId, component, value, label: targetFields.get(field.fieldId) || field.fieldId, codeVerification: field.codeVerification || null, reason: field.reason || '', basis: field.basis || '', provenance: (field.provenance || []).map(item => ({ documentId: item.documentId || null, sourceName: documents.get(item.documentId)?.name || null, sourceSha256: documents.get(item.documentId)?.sha256 || null, page: item.page || null, quote: item.quote || '', imageSha256: item.visualEvidence?.imageSha256 || null })) });
    }
  }
  return result.sort((left, right) => `${left.scope}|${left.fieldId}|${left.component}`.localeCompare(`${right.scope}|${right.fieldId}|${right.component}`, 'en', { numeric: true }));
}
const componentKey = item => `${item.scope}|${item.fieldId}|${item.component}`;
function comparison(before = [], after = []) {
  const left = new Map(before.map(item => [componentKey(item), item])), right = new Map(after.map(item => [componentKey(item), item]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(key => {
    const previous = left.get(key), current = right.get(key), item = current || previous;
    return { scope: item.scope, fieldId: item.fieldId, component: item.component, label: item.label, before: previous?.value ?? null, after: current?.value ?? null, change: stable(previous?.value ?? null) === stable(current?.value ?? null) ? 'unchanged' : previous ? current ? 'changed' : 'cleared' : 'filled', beforeProvenance: previous?.provenance || [], afterProvenance: current?.provenance || [], afterReason: current?.reason || '', afterBasis: current?.basis || '' };
  });
}
const generatedAt = new Date().toISOString();
const packetResults = [];
for (const packet of selection.packets) {
  let state = engine.createEmptyWorkspace(packet.id);
  const documents = packet.sources.map(source => ({ id: `doc-${source.sha256.slice(0, 24)}`, caseId: '', name: source.name, mime: source.mime, size: source.size, sha256: source.sha256, pages: selection.jobs.filter(job => job.sourceSha256 === source.sha256).map(job => ({ page: job.page, text: '' })), type: 'other', version: 1, active: true, extractionStatus: 'pending_ai', extractionPipeline: 'kimi', uploadedAt: generatedAt, synthetic: false }));
  state = engine.applyAction(state, { type: 'intake', sourceCollection: { name: 'Frozen Sarens mapping regression', folder: packet.folder, caseType: packet.caseType }, documents }, actor);
  const shipmentId = state.cases[0].id, failures = [], timings = [];
  for (const job of selection.jobs.filter(job => job.packetIds.includes(packet.id))) {
    const reading = observations.get(job.jobId);
    timings.push({ sourceSha256: job.sourceSha256, page: job.page, elapsedMs: reading.elapsedMs, at: reading.at, success: !reading.error });
    if (reading.error) { failures.push({ sourceSha256: job.sourceSha256, page: job.page, stage: 'saved_provider_outcome', error: reading.error }); continue; }
    const result = reading.result;
    try { state = engine.applyAction(state, { type: 'add_ai_candidates', caseId: shipmentId, documentId: `doc-${job.sourceSha256.slice(0, 24)}`, documentVersion: 1, model: result.model, pages: result.pages, proposals: structuredClone(result.proposals), pageReadings: structuredClone(result.pageReadings), visionEvidence: structuredClone(reading.visionEvidence) }, actor); }
    catch (error) { failures.push({ sourceSha256: job.sourceSha256, page: job.page, stage: 'current_code_apply', error: error.message }); }
  }
  state = utils.confirmBenchmarkGrouping(state, actor);
  const shipment = state.cases.find(item => item.id === shipmentId);
  const values = components(shipment, state);
  const prior = baseline?.packets.find(item => item.packetId === packet.id);
  if (baseline && !prior) throw new Error(`Baseline missing packet: ${packet.id}`);
  const differences = prior ? comparison(prior.components, values) : [];
  const rawTargetProposals = selection.jobs.filter(job => job.packetIds.includes(packet.id)).flatMap(job => (observations.get(job.jobId).result?.proposals || []).filter(proposal => /phone|telephone|package|loading|port|arrival|flight|transport|vessel|weight|description|origin|hsCode/i.test(proposal.field)).map(proposal => ({ sourceName: job.sourceName, sourceSha256: job.sourceSha256, imageSha256: job.inputImageSha256, page: job.page, ...proposal })));
  packetResults.push({ packetId: packet.id, folder: packet.folder, caseType: packet.caseType, sourceDocuments: documents.length, assignedPages: timings.length, savedProviderFailures: timings.filter(item => !item.success).length, ...utils.packetReadiness(state.documents, failures, packet.caseType), failures, goodsRows: shipment.goods.length, components: values, targetValues: values.filter(item => targetFields.has(item.fieldId)), rawTargetProposals, differences, changedComponents: differences.filter(item => item.change !== 'unchanged').length, state, issues: engine.getIssues(state, shipmentId) });
}
if (stable(await sourceHashes(codeRoot)) !== stable(codeHashes)) throw new Error('Production files changed during replay. Re-run against a stable code snapshot.');
if (attemptedNetworkCalls) throw new Error('Replay attempted a network call.');
for (const input of verifiedInputs) if (hash(await fs.readFile(input.path)) !== input.sha256) throw new Error('Input mutated during replay.');
const report = { schemaVersion: 1, generatedAt, mode: 'unassisted_saved_reading_replay', model: variant.model, variantId: variant.id, settings: variant.settings, planHash, promptHash: variant.promptHash, codeRoot, sourceCodeHashes: codeHashes, scriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), readingHashes: verifiedInputs.filter(item => item.path.includes('/readings/')), inputIntegrity: verifiedInputs, baseline: baselinePath ? { path: baselinePath, sha256: hash(baselineBytes) } : null, scope: { packets: 4, savedPageOutcomes: 22, newProviderCalls: 0, networkAttempts: attemptedNetworkCalls, employeeAnswerValuesRead: false, newSourceReviews: false, historicalAssistedEnrichmentApplied: false, frozenInputsModified: false, liveWorkspaceModified: false, groupingAssumption: utils.BENCHMARK_GROUPING_ASSUMPTION }, limitations: ['Reuses the same four development shipments and 22 old GLM page outcomes; this is not a fresh model accuracy test or a holdout.', 'Replays saved proposals through current evidence validation and mapping. It does not rerun the current extraction prompt or regenerate missing source proposals.', 'Does not apply the historical AI-assisted context overrides or later enrichment calls used in the published 75.7% result. Current raw-reading results need not reproduce that assisted result.', 'Differences describe deterministic mapping behavior, not independent customs correctness or approval. Supplier HS/origin must not be replaced with employee answer values.', 'Unchanged source-reading failures and low-confidence evidence remain unresolved; automatic source grouping is not evaluated.'], summary: { cases: packetResults.length, goodsRows: packetResults.reduce((sum, item) => sum + item.goodsRows, 0), applyFailures: packetResults.reduce((sum, item) => sum + item.failures.filter(failure => failure.stage === 'current_code_apply').length, 0), changedComponents: packetResults.reduce((sum, item) => sum + item.changedComponents, 0), changedTargetComponents: packetResults.reduce((sum, item) => sum + item.differences.filter(difference => difference.change !== 'unchanged' && targetFields.has(difference.fieldId)).length, 0), hsOriginChanges: packetResults.flatMap(item => item.differences.filter(difference => difference.change !== 'unchanged' && ['1.74', '1.79'].includes(difference.fieldId)).map(difference => ({ packetId: item.packetId, ...difference }))) }, packets: packetResults };
await fs.mkdir(output, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(output, 'replay-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
const display = value => value === null ? '(blank)' : typeof value === 'string' ? value : JSON.stringify(value);
const escape = value => display(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sarens saved-reading mapping replay</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:36px auto;padding:0 20px;color:#153139}table{border-collapse:collapse;width:100%;font-size:14px;margin:20px 0}th,td{border:1px solid #cad4d6;padding:9px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#edf3f3}.note{background:#fff5dd;padding:16px}details{margin:12px 0}small{display:block;color:#4b5f66}code{overflow-wrap:anywhere}</style><h1>Sarens saved-reading mapping replay</h1><p>${escape(variant.model)} · ${selection.packets.length} cases · 22 saved page outcomes · 0 new provider calls</p><p class="note">This is a replay of old source readings through current code. It is not a fresh AI accuracy score. The historical assisted enrichment is not applied.</p><p>${baseline ? `${report.summary.changedComponents} changed populated components; ${report.summary.hsOriginChanges.length} HS/origin changes.` : 'Baseline captured before the mapping fixes.'}</p>${packetResults.map(packet => `<section><h2>${escape(packet.folder)}</h2><p>${packet.goodsRows} goods rows · reading ${escape(packet.readingStatus)} · ${packet.failures.length} saved/apply failures</p><table><caption>${baseline ? 'Before/after mapping changes' : 'Focused baseline fields'}</caption><thead><tr><th>Scope / field</th><th>${baseline ? 'Before' : 'Value'}</th>${baseline ? '<th>After</th><th>Source evidence</th>' : ''}</tr></thead><tbody>${(baseline ? packet.differences.filter(item => item.change !== 'unchanged') : packet.targetValues).map(item => `<tr><th>${escape(item.scope)} · ${escape(item.label)} · ${escape(item.component)}</th><td>${escape(baseline ? item.before : item.value)}</td>${baseline ? `<td>${escape(item.after)}</td><td>${item.afterProvenance.map(evidence => `${escape(evidence.sourceName || '')}, p${evidence.page || '?'}: ${escape(evidence.quote)}`).join('<br>')}<small>${escape(item.afterReason)}</small></td>` : ''}</tr>`).join('') || `<tr><td colspan="4">No changes.</td></tr>`}</tbody></table></section>`).join('')}<h2>Limits</h2><ul>${report.limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul><p>Full inputs, source hashes, raw proposals, provenance, states and differences are in <a href="replay-report.json">replay-report.json</a>.</p></html>`;
await fs.writeFile(path.join(output, 'replay-report.html'), html, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ report: path.join(output, 'replay-report.json'), ...report.summary, newProviderCalls: 0 }, null, 2));
if (report.summary.applyFailures) process.exitCode = 1;
