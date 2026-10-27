import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { kimiExtractionPrompt, kimiPageImagePrompt, parseKimiContent, validateKimiPageReadings, groundKimiProposals } from '../lib/kimi.ts';
import { jpegDataUrl, jpegDimensions } from '../lib/vision.ts';
import { readBoundedAiResponse } from '../lib/ai-provider.ts';

export const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODELS = ['anthropic/claude-opus-5.5', 'openai/gpt-6.1-terra', 'google/gemini-4-argon'];
export const BASELINE_MODEL = 'z-ai/glm-5.3-flash';
export const APPROVED_PROVIDERS = { 'anthropic/claude-opus-5.5': ['amazon-bedrock'], 'openai/gpt-6.1-terra': ['openai'], 'google/gemini-4-argon': ['google-vertex', 'google-ai-studio'], 'z-ai/glm-5.3-flash': ['z-ai'] };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const modelDirectory = id => `${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${sha256(id).slice(0, 8)}`;
export async function privateJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

/** Catalog rates are per token; request price ceilings are dollars per million. */
export function modelBudget(model, maxTokens = 16000) {
  const effort = model.id === BASELINE_MODEL ? 'low' : 'medium';
  if (![...DEFAULT_MODELS, BASELINE_MODEL].includes(model.id)
    || !model.architecture?.input_modalities?.includes('image')
    || !['max_tokens', 'reasoning', 'response_format'].every(key => model.supported_parameters?.includes(key))
    || !model.reasoning?.supported_efforts?.includes(effort)
    || !Number.isInteger(model.context_length) || model.context_length < 1
    || !Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 24000
    || maxTokens > model.top_provider?.max_completion_tokens) throw new Error('unsupported_model_configuration');
  const prices = [model.pricing, ...(model.pricing.overrides ?? [])];
  if (prices.some(price => !positive(price.prompt) || !positive(price.completion))) throw new Error('invalid_catalog_prices');
  const prompt = Math.max(...prices.map(price => Number(price.prompt)));
  const completion = Math.max(...prices.map(price => Number(price.completion)), Number(model.pricing.internal_reasoning ?? 0));
  const request = Number(model.pricing.request ?? 0);
  if (!Number.isFinite(request) || request < 0 || Number(model.pricing.image ?? 0) > prompt) throw new Error('unsupported_additional_price');
  return { effort, maxTokens, prompt, completion, request,
    reservationUsd: Math.ceil((model.context_length * prompt + maxTokens * completion + request) * 1e9) / 1e9,
    maxPrice: { prompt: prompt * 1e6, completion: completion * 1e6 } };
}

export class CostLedger {
  constructor(limitUsd, startingSpendUsd = 0) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 100 || !Number.isFinite(startingSpendUsd) || startingSpendUsd < 0 || startingSpendUsd > limitUsd) throw new Error('invalid_budget');
    this.limitUsd = limitUsd; this.chargedUsd = startingSpendUsd; this.reservedUsd = 0; this.halted = false;
  }
  reserve(amount) {
    if (this.halted || this.reservedUsd || !Number.isFinite(amount) || amount <= 0 || this.chargedUsd + amount > this.limitUsd + 1e-10) return false;
    this.reservedUsd = amount; return true;
  }
  settle(actual) {
    if (!this.reservedUsd) throw new Error('no_reservation');
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) { this.halted = true; return; }
    if (actual > this.reservedUsd + 1e-8) this.halted = true;
    this.chargedUsd += actual; this.reservedUsd = 0;
    if (this.chargedUsd > this.limitUsd) this.halted = true;
  }
  snapshot() { return { limitUsd: this.limitUsd, chargedUsd: this.chargedUsd, reservedUsd: this.reservedUsd, halted: this.halted }; }
}

/** Explicitly estimated input allowance; unlike output max_tokens this is not an API-enforced bound. */
export function requestBudget(model, job, maxTokens = 16000, basis = 'full_context') {
  const budget = modelBudget(model, maxTokens);
  if (!['full_context', 'opus_image_estimate'].includes(basis)) throw new Error('unsupported_budget_basis');
  if (basis === 'full_context' || model.id !== 'anthropic/claude-opus-5.5') return { ...budget, basis: 'full_context' };
  const textUtf8Bytes = Buffer.byteLength(kimiExtractionPrompt()) + Buffer.byteLength(JSON.stringify({ pages: [{ page: job.page }] })) + Buffer.byteLength(kimiPageImagePrompt(job.page));
  const visualTokenCap = 4784;
  const estimatedInputTokens = 2 * textUtf8Bytes + 2 * visualTokenCap + 10000;
  return { ...budget, basis, estimatedInputTokens, textUtf8Bytes, visualTokenCap, framingAllowance: 10000,
    estimateAssumption: 'Twice exact UTF-8 text bytes, twice documented per-image visual-token cap, plus 10,000 framing tokens. Conservative estimate only; no documented end-to-end tokenizer guarantee. Halt if observed input or cost exceeds allowance.',
    imageCapSource: 'https://platform.claude.com/docs/en/build-with-claude/vision',
    reservationUsd: Math.ceil((estimatedInputTokens * budget.prompt + maxTokens * budget.completion + budget.request) * 1e9) / 1e9 };
}

export function makeRequest(model, job, imageBytes, maxTokens = 16000) {
  if (sha256(imageBytes) !== job.inputImageSha256) throw new Error('image_hash_mismatch');
  const dimensions = jpegDimensions(imageBytes);
  if (dimensions.width !== job.width || dimensions.height !== job.height) throw new Error('image_dimensions_mismatch');
  const budget = modelBudget(model, maxTokens);
  return { model: model.id, stream: false, max_tokens: maxTokens, usage: { include: true },
    reasoning: { effort: budget.effort, exclude: true }, response_format: { type: 'json_object' },
    provider: { zdr: true, data_collection: 'deny', require_parameters: true, allow_fallbacks: false, only: APPROVED_PROVIDERS[model.id], max_price: budget.maxPrice },
    messages: [{ role: 'system', content: kimiExtractionPrompt() }, { role: 'user', content: [
      { type: 'text', text: JSON.stringify({ pages: [{ page: job.page }] }) },
      { type: 'text', text: kimiPageImagePrompt(job.page) },
      { type: 'image_url', image_url: { url: jpegDataUrl(imageBytes) } },
    ] }],
  };
}

export function validateResponse(envelope, model, job) {
  if (![model.id, model.canonical_slug].filter(Boolean).includes(envelope.model)) throw new Error('returned_model_mismatch');
  if (envelope.error || envelope.choices?.length !== 1 || envelope.choices[0]?.finish_reason !== 'stop'
    || typeof envelope.choices[0]?.message?.content !== 'string') throw new Error('incomplete_or_invalid_response');
  const content = envelope.choices[0].message.content;
  let proposals = parseKimiContent(content);
  // Production's first pass requires strict JSON; repair is deliberately excluded from this pilot.
  const literal = content;
  const pages = [{ page: job.page, text: '' }];
  const pageReadings = validateKimiPageReadings(pages, JSON.parse(literal).pageReadings, true);
  proposals = proposals.map(proposal => pageReadings.some(page => page.page === proposal.page && page.readability === 'uncertain')
    ? { ...proposal, readability: 'uncertain', confidence: 'low' } : proposal);
  const document = { id: `pilot-${job.sourceSha256.slice(0, 24)}`, caseId: job.packetId, name: 'original.pdf', mime: 'application/pdf', size: job.sourceSize ?? 1,
    sha256: job.sourceSha256, version: 1, active: true, uploadedAt: '', synthetic: false, type: 'other', extractionPipeline: 'kimi', extractionStatus: 'pending_ai', pages };
  const grounded = groundKimiProposals(document, pages, proposals, model.id, [{ page: job.page, imageSha256: job.inputImageSha256, width: job.width, height: job.height }], pageReadings);
  return { proposals, pageReadings, ...grounded };
}

const safeIdentity = value => typeof value === 'string' && /^[\w:/ .-]{1,180}$/.test(value) ? value : null;
function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost', 'cost_details', 'prompt_tokens_details', 'completion_tokens_details']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
    else if (value[key] && typeof value[key] === 'object') result[key] = Object.fromEntries(Object.entries(value[key]).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0));
  }
  return result;
}

/** One durable claim, one request, no automatic retry or repair. Unknown spend stops the run. */
export async function executePilotJob({ model, job, imageBytes, apiKey, directory, ledger, maxTokens = 16000, budgetBasis = 'full_context', timeoutMs = 180000, fetchImpl = fetch }) {
  const request = makeRequest(model, job, imageBytes, maxTokens);
  const budget = requestBudget(model, job, maxTokens, budgetBasis);
  if (!ledger.reserve(budget.reservationUsd)) return { skipped: true, reason: ledger.halted ? 'spend_unknown_or_guard_halted' : 'insufficient_conservative_budget' };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString(); const start = performance.now();
  const requestText = JSON.stringify(request);
  const identity = { schemaVersion: 1, model: model.id, requestedModel: model.id, jobId: job.jobId, packetId: job.packetId, page: job.page,
    sourceSha256: job.sourceSha256, inputImageSha256: job.inputImageSha256, promptHash: sha256(request.messages[0].content), requestHash: sha256(requestText), startedAt };
  // Exclusive file creation prevents a restart from issuing the same request twice.
  await privateJson(path.join(directory, 'claim.json'), { ...identity, reservationUsd: budget.reservationUsd, budget });
  await privateJson(path.join(directory, 'request.json'), { ...identity, request: { ...request, messages: [request.messages[0], { role: 'user', content: request.messages[1].content.map(part => part.type === 'image_url' ? { type: 'image_url', imageSha256: job.inputImageSha256 } : part) }] } });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let envelope, outcome, httpStatus = null, rawResponseSha256 = null;
  try {
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: requestText });
    httpStatus = response.status;
    const raw = await readBoundedAiResponse(response, 2 * 1024 * 1024);
    rawResponseSha256 = sha256(raw);
    // Never persist a reflected credential, even in a private provider-error response.
    const storedRaw = apiKey ? raw.replaceAll(apiKey, '[REDACTED_API_KEY]') : raw;
    await fs.writeFile(path.join(directory, 'response.private.json'), storedRaw, { flag: 'wx', mode: 0o600 });
    try { envelope = JSON.parse(raw); } catch { throw new Error('invalid_response_json'); }
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    outcome = { result: validateResponse(envelope, model, job) };
  } catch (error) {
    const known = error instanceof Error && /^(returned_model_mismatch|incomplete_or_invalid_response|invalid_response_json|provider_http_\d{3})$/.test(error.message);
    outcome = { error: controller.signal.aborted ? 'request_timeout_spend_unknown' : known ? error.message : 'transport_or_validation_failure' };
  } finally { clearTimeout(timer); }
  const usage = safeUsage(envelope?.usage);
  ledger.settle(usage?.cost);
  const inputEstimateExceeded = budget.basis === 'opus_image_estimate' && typeof usage?.prompt_tokens === 'number' && usage.prompt_tokens > budget.estimatedInputTokens;
  if (inputEstimateExceeded) ledger.halted = true;
  const result = { ...identity, resolvedModel: safeIdentity(envelope?.model), provider: safeIdentity(envelope?.provider), responseId: safeIdentity(envelope?.id),
    elapsedMs: Math.round(performance.now() - start), httpStatus, usage, rawResponseSha256, budget, inputEstimateExceeded, ledger: ledger.snapshot(), ...outcome };
  await privateJson(path.join(directory, 'outcome.json'), result);
  return result;
}
