import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateSourceVisionPilot } from './evaluate-source-vision-pilot.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const digits = value => String(value).replace(/\D/g, '');

/** Adapt accepted candidates without rerunning or changing production grounding. */
export function acceptedProposals(candidates, outcome) {
  if (!Array.isArray(candidates)) throw new Error('Missing accepted candidate inventory.');
  return candidates.map(candidate => {
    if (candidate.caseId !== outcome.packetId || candidate.page !== outcome.page
      || candidate.visualEvidence?.imageSha256 !== outcome.inputImageSha256) throw new Error('Accepted candidate source identity mismatch.');
    let rowIndex;
    if (candidate.lineId !== undefined) {
      const match = String(candidate.lineId).match(/:p(\d+):ai-row(\d+)$/);
      if (!match || Number(match[1]) !== outcome.page) throw new Error('Unrecognized accepted goods row identity.');
      rowIndex = Number(match[2]);
    }
    return { field: candidate.field, value: candidate.value, quote: candidate.originalText, page: candidate.page,
      confidence: candidate.confidence, ...(rowIndex === undefined ? {} : { rowIndex }), candidateId: candidate.id };
  });
}

function fieldMatches(rule, field) {
  return rule.fields?.includes(field) || (rule.fieldPattern && new RegExp(rule.fieldPattern).test(field));
}

/** Semantic absence never earns a correct point. These are source-role checks,
 * not guessed real-world answers for missing information. */
export function semanticFindings(page, proposals) {
  return proposals.flatMap((proposal, index) => {
    const matching = page.rules.filter(rule => fieldMatches(rule, proposal.field));
    if (!matching.length) return [];
    return matching.map(rule => {
      let classification = rule.classification;
      if (rule.definiteWrongValuePattern && new RegExp(rule.definiteWrongValuePattern, 'i').test(proposal.value)) classification = 'definite_wrong_field';
      if (rule.definiteWrongDigits?.includes(digits(proposal.value))) classification = 'definite_wrong_field';
      return { index, ruleId: rule.id, field: proposal.field, value: proposal.value, quote: proposal.quote,
        ...(proposal.rowIndex === undefined ? {} : { rowIndex: proposal.rowIndex }), classification,
        sourceQuote: rule.sourceQuote, explanation: rule.explanation };
    });
  });
}

const proposalKey = proposal => [proposal.field, proposal.page, proposal.rowIndex ?? '', normalized(proposal.quote)].join('\u0000');

function inventory(raw, accepted, diagnostics) {
  return raw.map((proposal, index) => {
    const matches = accepted.filter(candidate => proposalKey(candidate) === proposalKey(proposal));
    const rejection = diagnostics.filter(diagnostic => diagnostic.index === index);
    return { index, ...proposal, acceptance: matches.length ? 'accepted' : 'withheld', acceptedValues: matches.map(candidate => candidate.value),
      acceptedCandidateIds: matches.map(candidate => candidate.candidateId), rejectionDiagnostics: rejection };
  });
}

function summarizeStage(source, findings, inventoryCount) {
  const definiteWrongIndexes = new Set(findings.filter(item => item.classification === 'definite_wrong_field').map(item => item.index));
  const unsupportedIndexes = new Set(findings.filter(item => item.classification !== 'definite_wrong_field').map(item => item.index));
  // Positive source facts and extra wrong-field claims have disjoint field scope
  // in the frozen supplement. Negative checks never count as correct claims.
  const definiteWrongFields = definiteWrongIndexes.size;
  const denominator = source.correct + source.wrong + definiteWrongFields;
  return { correctKnownFacts: source.correct, wrongKnownFacts: source.wrong, omittedKnownFacts: source.omitted,
    definiteWrongFields, unsupportedRoleProposals: unsupportedIndexes.size,
    scopedPopulatedClaimAccuracy: denominator ? source.correct / denominator : null,
    knownFactCoverage: source.sourceFactCoverage, extraGoodsRows: source.extraGoodsRows.length,
    missingGoodsRows: source.missingGoodsRows.length, rowAssignmentFindings: source.rowAssignmentFindings.length,
    unscoredProposals: source.unscoredProposals.length, totalProposals: inventoryCount };
}

export function evaluateWeek3Vision(gold, rubric, outcomes) {
  if (rubric?.schemaVersion !== 1 || rubric.frozenBeforeFreshOutputs !== true
    || rubric.baselineOutputsPreviouslyInspected !== true || !Array.isArray(rubric.pages)) throw new Error('Invalid frozen development rubric.');
  if (rubric.pages.length !== gold.pages.length || rubric.pages.some(page => !gold.pages.some(source => source.jobId === page.jobId))) throw new Error('Rubric page scope mismatch.');
  for (const page of rubric.pages) {
    const source = gold.pages.find(item => item.jobId === page.jobId);
    const facts = new Set(source.facts.flatMap(fact => [fact.field, ...(fact.fieldAliases ?? [])]));
    if (page.rules.some(rule => (rule.classification === 'definite_wrong_field' || rule.definiteWrongValuePattern || rule.definiteWrongDigits)
      && [...facts].some(field => fieldMatches(rule, field)))) throw new Error('Definite semantic checks overlap scored facts; would double-count a claim.');
  }
  const rawReport = evaluateSourceVisionPilot(gold, outcomes);
  const models = rawReport.models.map(model => {
    const pages = model.pages.map(rawSource => {
      if (rawSource.status !== 'usable') return { jobId: rawSource.jobId, status: rawSource.status, problem: rawSource.problem };
      const outcome = outcomes.find(item => (item.requestedModel ?? item.model) === model.model && item.jobId === rawSource.jobId);
      const semanticPage = rubric.pages.find(page => page.jobId === rawSource.jobId);
      let accepted;
      try { accepted = acceptedProposals(outcome.result.candidates, outcome); }
      catch (error) { return { jobId: rawSource.jobId, status: 'unusable', problem: error.message }; }
      const adapted = { ...outcome, result: { ...outcome.result, proposals: accepted } };
      const acceptedSource = evaluateSourceVisionPilot(gold, [adapted]).models[0].pages.find(page => page.jobId === rawSource.jobId);
      if (acceptedSource.status !== 'usable') return { jobId: rawSource.jobId, status: 'unusable', problem: acceptedSource.problem };
      const raw = outcome.result.proposals;
      const rawFindings = semanticFindings(semanticPage, raw), acceptedFindings = semanticFindings(semanticPage, accepted);
      const rawInventory = inventory(raw, accepted, outcome.result.rejectionDiagnostics ?? []);
      const transitions = rawSource.facts.map(fact => ({ id: fact.id, field: fact.field, raw: fact.status,
        accepted: acceptedSource.facts.find(item => item.id === fact.id).status, rawActual: fact.actual,
        acceptedActual: acceptedSource.facts.find(item => item.id === fact.id).actual }));
      const rawWrong = rawFindings.filter(finding => finding.classification === 'definite_wrong_field');
      const rawUnsupported = rawFindings.filter(finding => finding.classification !== 'definite_wrong_field');
      const blocked = findings => new Set(findings.filter(finding => rawInventory[finding.index].acceptance === 'withheld').map(finding => finding.index)).size;
      const disposition = {
        correctFactsWithheld: transitions.filter(item => item.raw === 'correct' && item.accepted === 'omitted').length,
        wrongFactsWithheld: transitions.filter(item => item.raw === 'wrong' && item.accepted === 'omitted').length,
        correctFactsChangedToWrong: transitions.filter(item => item.raw === 'correct' && item.accepted === 'wrong').length,
        wrongFactsChangedToCorrect: transitions.filter(item => item.raw === 'wrong' && item.accepted === 'correct').length,
        definiteWrongFieldsBlocked: blocked(rawWrong), unsupportedRoleProposalsBlocked: blocked(rawUnsupported),
        rawProposalsWithheld: rawInventory.filter(item => item.acceptance === 'withheld').length,
        acceptedWithoutRawProvenanceMatch: accepted.filter(candidate => !raw.some(proposal => proposalKey(proposal) === proposalKey(candidate))),
      };
      return { jobId: rawSource.jobId, case: rawSource.case, sourcePath: rawSource.sourcePath, page: rawSource.page, status: 'usable',
        raw: summarizeStage(rawSource, rawFindings, raw.length), accepted: summarizeStage(acceptedSource, acceptedFindings, accepted.length), disposition,
        facts: transitions, rawSemanticFindings: rawFindings, acceptedSemanticFindings: acceptedFindings,
        rawExtraGoodsRows: rawSource.extraGoodsRows, acceptedExtraGoodsRows: acceptedSource.extraGoodsRows,
        rawInventory, acceptedInventory: accepted, rawUnscoredProposals: rawSource.unscoredProposals, acceptedUnscoredProposals: acceptedSource.unscoredProposals };
    });
    const usable = pages.filter(page => page.status === 'usable');
    const stageSummary = key => {
      const total = field => usable.reduce((sum, page) => sum + page[key][field], 0);
      const fields = ['correctKnownFacts', 'wrongKnownFacts', 'omittedKnownFacts', 'definiteWrongFields', 'unsupportedRoleProposals', 'extraGoodsRows', 'missingGoodsRows', 'rowAssignmentFindings', 'unscoredProposals', 'totalProposals'];
      const summary = Object.fromEntries(fields.map(field => [field, total(field)]));
      const filled = summary.correctKnownFacts + summary.wrongKnownFacts;
      summary.scopedPopulatedClaimAccuracy = filled + summary.definiteWrongFields ? summary.correctKnownFacts / (filled + summary.definiteWrongFields) : null;
      summary.knownFactCoverage = filled + summary.omittedKnownFacts ? filled / (filled + summary.omittedKnownFacts) : null;
      return summary;
    };
    const dispositionFields = ['correctFactsWithheld', 'wrongFactsWithheld', 'correctFactsChangedToWrong', 'wrongFactsChangedToCorrect', 'definiteWrongFieldsBlocked', 'unsupportedRoleProposalsBlocked', 'rawProposalsWithheld'];
    return { model: model.model, raw: stageSummary('raw'), accepted: stageSummary('accepted'),
      disposition: Object.fromEntries(dispositionFields.map(field => [field, usable.reduce((sum, page) => sum + page.disposition[field], 0)])),
      usablePages: usable.length, unusablePages: pages.filter(page => page.status === 'unusable').length,
      pagesNotRun: pages.filter(page => page.status === 'not_run').length, pages };
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), rubricScope: rubric.scope, scoringPolicy: rubric.scoringPolicy,
    caution: 'A reused development diagnostic, not a holdout or whole-form accuracy. Unsupported roles, missing facts, wrong rows, and unusable responses are reported separately. Blocking a wrong proposal is not correct model reading.',
    unknownOutcomes: rawReport.unknownOutcomes, models };
}

async function paths(directory) {
  return (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? paths(path.join(directory, entry.name)) : entry.name === 'outcome.json' ? [path.join(directory, entry.name)] : []))).flat().sort();
}

async function main() {
  const [rubricPath, runDirectory, outputPath] = process.argv.slice(2);
  if (!rubricPath || !runDirectory || !outputPath) throw new Error('Usage: node scripts/evaluate-week3-vision.mjs <semantic-rubric.json> <run-directory> <new-report.json>');
  const rubricBytes = await fs.readFile(rubricPath), rubric = JSON.parse(rubricBytes);
  const freeze = JSON.parse(await fs.readFile(path.join(path.dirname(rubricPath), 'semantic-rubric-freeze.json'), 'utf8'));
  if (!freeze.frozenBeforeFreshOutputs || freeze.rubricSha256 !== sha(rubricBytes)) throw new Error('Semantic rubric no longer matches freeze.');
  for (const file of freeze.evaluatorFiles ?? []) if (sha(await fs.readFile(file.path)) !== file.sha256) throw new Error('Evaluator changed after semantic freeze.');
  const goldBytes = await fs.readFile(rubric.sourceGoldPath), gold = JSON.parse(goldBytes);
  if (sha(goldBytes) !== rubric.sourceGoldSha256) throw new Error('Original source gold changed.');
  for (const page of gold.pages) if (sha(await fs.readFile(page.sourcePath)) !== page.sourceSha256 || sha(await fs.readFile(page.imagePath)) !== page.inputImageSha256) throw new Error('Original source/image changed.');
  const files = await paths(runDirectory), bytes = await Promise.all(files.map(file => fs.readFile(file)));
  const report = evaluateWeek3Vision(gold, rubric, bytes.map(value => JSON.parse(value)));
  report.provenance = { rubricPath: path.resolve(rubricPath), rubricSha256: sha(rubricBytes), sourceGoldSha256: sha(goldBytes),
    evaluatorSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), inputOutcomes: files.map((file, index) => ({ path: path.resolve(file), sha256: sha(bytes[index]) })) };
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ path: path.resolve(outputPath), models: report.models.map(model => Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'pages'))) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
