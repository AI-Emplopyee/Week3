import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateResponse, privateJson } from './openrouter-vision-pilot-core.mjs';

/** Offline compatibility assessment only. Remove one complete outer Markdown
 * fence, then require the current production parser and grounding validation.
 * No prose removal, JSON repair, field correction or provider retry is allowed. */
export function recoverExactFence(envelope, model, job) {
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return undefined;
  const match = content.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (!match) return undefined;
  const literal = match[1];
  const recoveredEnvelope = structuredClone(envelope);
  recoveredEnvelope.choices[0].message.content = literal;
  const result = validateResponse(recoveredEnvelope, model, job);
  const source = JSON.parse(literal).candidates;
  const facts = values => values.map(({ field, value, quote, page, rowIndex }) => [field, value, quote, page, rowIndex ?? null]);
  if (JSON.stringify(facts(source)) !== JSON.stringify(facts(result.proposals))) throw new Error('Recovery changed source field values or evidence.');
  return { result, originalContentSha256: sha256(content), unfencedContentSha256: sha256(literal) };
}

async function outcomes(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await outcomes(file));
    else if (entry.name === 'outcome.json') result.push(file);
  }
  return result.sort();
}

async function main() {
  const [liveDirectory, sidecarDirectory] = process.argv.slice(2);
  if (!liveDirectory || !sidecarDirectory) throw new Error('Usage: node --experimental-strip-types scripts/recover-source-vision-fences.mjs <original-run-directory> <new-sidecar-directory>');
  globalThis.fetch = () => { throw new Error('Offline recovery prohibits network calls.'); };
  const originalRoot = path.resolve(liveDirectory), outputRoot = path.resolve(sidecarDirectory);
  if (outputRoot === originalRoot || outputRoot.startsWith(`${originalRoot}${path.sep}`)) throw new Error('Recovery sidecars must be separate from the original run.');
  const planBytes = await fs.readFile(path.join(originalRoot, 'plan.json')), plan = JSON.parse(planBytes);
  const files = await outcomes(path.join(originalRoot, 'runs'));
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const entries = [];
  for (const file of files) {
    const originalBytes = await fs.readFile(file), outcome = JSON.parse(originalBytes);
    const model = plan.models.find(model => model.id === outcome.requestedModel);
    const job = plan.jobs.find(job => job.jobId === outcome.jobId && job.packetId === outcome.packetId);
    if (!model || !job) throw new Error('Original outcome is not in the run plan.');
    const metadata = { mode: 'offline_exact_fence_recovery', originalOutcomePath: file, originalOutcomeSha256: sha256(originalBytes),
      firstPassError: outcome.error ?? null, firstPassUsable: !outcome.error, networkCalls: 0, sourceFieldValuesChanged: false };
    let copy = { ...outcome, formatCompatibility: { ...metadata, recovered: false } };
    if (outcome.error === 'transport_or_validation_failure' && outcome.httpStatus === 200) {
      const responsePath = path.join(path.dirname(file), 'response.private.json');
      const responseBytes = await fs.readFile(responsePath);
      if (sha256(responseBytes) !== outcome.rawResponseSha256) throw new Error('Original response fingerprint changed.');
      try {
        const recovered = recoverExactFence(JSON.parse(responseBytes), model, job);
        if (recovered) {
          copy = { ...outcome, result: recovered.result, formatCompatibility: { ...metadata, recovered: true,
            classification: 'first_pass_format_compatibility_failure', originalResponsePath: responsePath, originalResponseSha256: sha256(responseBytes),
            originalContentSha256: recovered.originalContentSha256, unfencedContentSha256: recovered.unfencedContentSha256 } };
          delete copy.error;
        }
      } catch (error) {
        copy.formatCompatibility.recoveryRejected = error instanceof Error ? error.message : 'Strict parsing rejected the unfenced response.';
      }
    }
    const target = path.join(outputRoot, path.relative(originalRoot, file));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await privateJson(target, copy);
    if (sha256(await fs.readFile(file)) !== sha256(originalBytes)) throw new Error('Original outcome changed during recovery.');
    entries.push({ jobId: outcome.jobId, model: outcome.requestedModel, outcomePath: target, ...copy.formatCompatibility });
  }
  const summary = { schemaVersion: 1, createdAt: new Date().toISOString(), mode: 'offline_exact_fence_recovery', originalRun: originalRoot,
    originalPlanSha256: sha256(planBytes), scriptSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))), networkCalls: 0,
    originalOutcomesModified: false, goldRead: false, recoveredResponses: entries.filter(entry => entry.recovered).length, entries,
    limitations: ['Original first-pass failures remain failures in the original run.', 'This sidecar assesses existing content after removing one exact JSON code fence; it is not a successful first-pass integration or a new provider result.', 'No JSON repair, fact correction, prompt change or additional model request is performed.'] };
  await privateJson(path.join(outputRoot, 'format-recovery-summary.json'), summary);
  console.log(JSON.stringify({ sidecar: outputRoot, recoveredResponses: summary.recoveredResponses, networkCalls: 0, originalOutcomesModified: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
