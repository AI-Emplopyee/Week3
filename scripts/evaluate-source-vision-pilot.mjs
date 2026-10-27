import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const identifier = value => text(value).replace(/[\s.\-/]/g, '');
const goodsFields = new Set(['goodsCode', 'goodsModel', 'description', 'hsCode', 'origin', 'quantity', 'unit', 'quantity2', 'unit2', 'unitPrice', 'amount', 'vatRate', 'dutyRate']);

function sourceDate(value) {
  const literal = text(value);
  let parts = literal.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  let year, month, day;
  if (parts) [, year, month, day] = parts;
  else {
    parts = literal.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (parts) [, day, month, year] = parts;
    else {
      parts = literal.match(/^(\d{1,2})\s*([a-z]+)\s*(\d{4})$/);
      if (!parts) return undefined;
      [, day, , year] = parts;
      const index = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(parts[2].slice(0, 3));
      if (index < 0) return undefined;
      month = String(index + 1);
    }
  }
  const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(result) ? result : undefined;
}

function decimal(value) {
  let literal = text(value).replace(/\s*(?:kg|kgs|kilograms?)$/, '').replace(/\s/g, '');
  // Accept explicit grouped monetary spellings; an ambiguous comma-only
  // quantity is accepted only through a frozen source-literal equivalent.
  if (/^-?\d{1,3}(?:\.\d{3})+,\d+$/.test(literal)) literal = literal.replaceAll('.', '').replace(',', '.');
  else if (/^-?\d{1,3}(?:,\d{3})+\.\d+$/.test(literal)) literal = literal.replaceAll(',', '');
  else if (/^-?\d+,\d{1,2}$/.test(literal)) literal = literal.replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(literal)) return undefined;
  const negative = literal.startsWith('-');
  const [whole, fraction = ''] = literal.replace(/^-/, '').split('.');
  const number = `${whole.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`;
  return negative && number !== '0' ? `-${number}` : number;
}

export function sourceFactMatches(fact, value) {
  const alternatives = [fact.value, ...(fact.acceptedEquivalentValues ?? [])];
  if (fact.comparison === 'phone') {
    const digits = input => text(input).replace(/[\s().\-/]/g, '');
    return alternatives.some(expected => digits(expected) === digits(value));
  }
  if (fact.comparison === 'identifier') return alternatives.some(expected => identifier(expected) === identifier(value));
  if (fact.comparison === 'decimal') {
    if (alternatives.some(expected => text(expected) === text(value))) return true;
    return decimal(value) !== undefined && decimal(value) === decimal(fact.value);
  }
  if (fact.comparison === 'date') return sourceDate(value) !== undefined && sourceDate(value) === sourceDate(fact.value);
  if (fact.comparison === 'token') {
    const escaped = String(fact.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(String(value).replace(/\s+/g, ' '));
  }
  return alternatives.some(expected => text(expected) === text(value));
}

function protocolProblem(outcome, page) {
  if (outcome.error) return `Provider or response failure: ${String(outcome.error)}`;
  if (outcome.packetId !== page.packetId || outcome.page !== page.page || outcome.sourceSha256 !== page.sourceSha256 || outcome.inputImageSha256 !== page.inputImageSha256)
    return 'Outcome identity does not match the frozen original page.';
  const result = outcome.result;
  if (!result || !Array.isArray(result.proposals) || !Array.isArray(result.pageReadings)) return 'Missing proposals/pageReadings arrays.';
  if (result.pageReadings.length !== 1 || result.pageReadings[0]?.page !== page.page || !['clear', 'uncertain'].includes(result.pageReadings[0]?.readability)) return 'Missing or mismatched page reading.';
  if (result.proposals.some(proposal => !proposal || typeof proposal.field !== 'string' || typeof proposal.value !== 'string' || !proposal.value.trim() || proposal.page !== page.page || (proposal.rowIndex !== undefined && (!Number.isInteger(proposal.rowIndex) || proposal.rowIndex < 1 || proposal.rowIndex > 500)))) return 'Invalid proposal shape, page or goods row index.';
  return undefined;
}

function rowAlignment(page, proposals) {
  const rowIndexes = [...new Set(proposals.filter(proposal => proposal.rowIndex !== undefined && goodsFields.has(proposal.field)).map(proposal => proposal.rowIndex))];
  const expected = new Map(page.goodsRows.map(row => [identifier(row.goodsCode), row.rowIndex]));
  const rowCodes = new Map(rowIndexes.map(row => [row, [...new Set(proposals.filter(proposal => proposal.rowIndex === row && proposal.field === 'goodsCode').map(proposal => identifier(proposal.value)))]]));
  const mapped = new Map(), extraGoodsRows = [], rowAssignmentFindings = [];
  for (const row of rowIndexes) {
    const codes = rowCodes.get(row);
    const code = codes.length === 1 ? codes[0] : undefined;
    const unique = code && [...rowCodes.values()].filter(values => values.includes(code)).length === 1;
    const byCode = unique ? expected.get(code) : undefined;
    if (byCode !== undefined) {
      mapped.set(row, byCode);
      if (byCode !== row) rowAssignmentFindings.push({ rowIndex: row, expectedRowIndex: byCode, goodsCode: code, kind: 'different_row_index', note: 'Fact accuracy is aligned by the unique source goods code; row assignment is reported separately.' });
    } else if (page.goodsRows.some(expectedRow => expectedRow.rowIndex === row)) mapped.set(row, row);
    else extraGoodsRows.push({ rowIndex: row, goodsCodes: codes, proposals: proposals.filter(proposal => proposal.rowIndex === row) });
    if (codes.length > 1) rowAssignmentFindings.push({ rowIndex: row, kind: 'multiple_goods_codes_on_row', goodsCodes: codes });
    if (code && !unique) rowAssignmentFindings.push({ rowIndex: row, kind: 'repeated_goods_code', goodsCode: code });
    if (code && !expected.has(code)) rowAssignmentFindings.push({ rowIndex: row, kind: 'unknown_goods_code', goodsCode: code });
  }
  for (const proposal of proposals.filter(proposal => proposal.rowIndex !== undefined && !goodsFields.has(proposal.field))) rowAssignmentFindings.push({ kind: 'header_assigned_to_goods_row', field: proposal.field, rowIndex: proposal.rowIndex, value: proposal.value });
  return { mapped, extraGoodsRows, rowAssignmentFindings, observedGoodsRows: rowIndexes.length };
}

function evaluatePage(page, outcome) {
  const identity = { jobId: page.jobId, packetId: page.packetId, case: page.case, sourceName: page.sourceName, sourcePath: page.sourcePath, page: page.page, inputImageSha256: page.inputImageSha256 };
  const problem = protocolProblem(outcome, page);
  if (problem) return { ...identity, status: 'unusable', problem, correct: 0, wrong: 0, omitted: 0 };
  const proposals = outcome.result.proposals;
  const alignment = rowAlignment(page, proposals);
  const evaluated = new Set();
  const facts = page.facts.map(fact => {
    const fields = [fact.field, ...(fact.fieldAliases ?? [])];
    const supplied = proposals.filter(proposal => fields.includes(proposal.field) && (fact.rowIndex === undefined ? proposal.rowIndex === undefined : alignment.mapped.get(proposal.rowIndex) === fact.rowIndex));
    for (const proposal of supplied) evaluated.add(proposal);
    const status = !supplied.length ? 'omitted' : supplied.every(proposal => sourceFactMatches(fact, proposal.value)) ? 'correct' : 'wrong';
    return { id: fact.id, field: fact.field, ...(fact.rowIndex === undefined ? {} : { rowIndex: fact.rowIndex }), status, expected: fact.value, expectedSourceQuote: fact.quote,
      actual: supplied.map(proposal => ({ field: proposal.field, value: proposal.value, quote: proposal.quote, rowIndex: proposal.rowIndex, confidence: proposal.confidence })) };
  });
  const count = status => facts.filter(fact => fact.status === status).length;
  const correct = count('correct'), wrong = count('wrong'), omitted = count('omitted');
  return { ...identity, status: 'usable', correct, wrong, omitted, filledSourceFactAccuracy: correct + wrong ? correct / (correct + wrong) : null,
    sourceFactCoverage: (correct + wrong) / facts.length, expectedFacts: facts.length, expectedGoodsRows: page.expectedGoodsRowCount,
    observedGoodsRows: alignment.observedGoodsRows, extraGoodsRows: alignment.extraGoodsRows, rowAssignmentFindings: alignment.rowAssignmentFindings,
    missingGoodsRows: page.goodsRows.filter(row => ![...alignment.mapped.values()].includes(row.rowIndex)),
    facts, unscoredProposals: proposals.filter(proposal => !evaluated.has(proposal)), manualReviewChecks: page.reviewOnly,
    groundingRejected: outcome.result.rejected ?? null, elapsedMs: outcome.elapsedMs ?? null, usage: outcome.usage ?? null,
    limitations: ['Descriptions and fields outside frozen diagnostic facts are not automatically marked correct.', 'Proposal accuracy is measured before application mapping; grounding rejection counts are reported independently.'] };
}

/** Pure source-fact scorer. No model calls, employee answers, production mapping,
 * fuzzy string judge or response-dependent edits to expected facts are used. */
export function evaluateSourceVisionPilot(gold, outcomes) {
  if (gold?.schemaVersion !== 1 || !Array.isArray(gold.pages) || !gold.pages.length || !Array.isArray(outcomes)) throw new Error('Invalid source pilot inputs.');
  if (gold.employeeDeclarationAnswersUsed !== false || gold.providerOutputsInspectedForGold !== false) throw new Error('Gold must be source-only and frozen before pilot outputs.');
  const models = [...new Set(outcomes.map(outcome => outcome.requestedModel ?? outcome.model).filter(Boolean))];
  const unknownOutcomes = outcomes.filter(outcome => !gold.pages.some(page => page.jobId === outcome.jobId)).map(outcome => ({ model: outcome.requestedModel ?? outcome.model, jobId: outcome.jobId }));
  const reports = models.map(model => {
    const pages = gold.pages.map(page => {
      const matching = outcomes.filter(outcome => (outcome.requestedModel ?? outcome.model) === model && outcome.jobId === page.jobId);
      if (!matching.length) return { jobId: page.jobId, packetId: page.packetId, status: 'not_run', expectedFacts: page.facts.length };
      if (matching.length > 1) return { jobId: page.jobId, packetId: page.packetId, status: 'unusable', problem: 'Duplicate outcomes for one model/page; do not select the best response.', correct: 0, wrong: 0, omitted: 0 };
      return evaluatePage(page, matching[0]);
    });
    const usable = pages.filter(page => page.status === 'usable');
    const total = key => usable.reduce((sum, page) => sum + page[key], 0);
    const correct = total('correct'), wrong = total('wrong'), omitted = total('omitted');
    return { model, correct, wrong, omitted, filledSourceFactAccuracy: correct + wrong ? correct / (correct + wrong) : null,
      sourceFactCoverage: correct + wrong + omitted ? (correct + wrong) / (correct + wrong + omitted) : null,
      usablePages: usable.length, unusableResponses: pages.filter(page => page.status === 'unusable').length, pagesNotRun: pages.filter(page => page.status === 'not_run').length,
      extraGoodsRows: usable.reduce((sum, page) => sum + page.extraGoodsRows.length, 0), rowAssignmentFindings: usable.reduce((sum, page) => sum + page.rowAssignmentFindings.length, 0),
      missingGoodsRows: usable.reduce((sum, page) => sum + page.missingGoodsRows.length, 0), unscoredProposals: usable.reduce((sum, page) => sum + page.unscoredProposals.length, 0), pages };
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: gold.scoringPolicy, goldAuthorship: gold.authorship, models: reports, unknownOutcomes,
    comparisonWarning: 'This diagnostic pilot is not whole-form accuracy. Compare correctness together with omissions, row errors, unscored facts, unusable pages and cost. No percentage is reported when no scored facts were populated.' };
}

async function outcomePaths(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? outcomePaths(path.join(directory, entry.name)) : entry.name === 'outcome.json' ? [path.join(directory, entry.name)] : []));
  return nested.flat().sort();
}

async function main() {
  const [goldPath, outcomesDirectory, outputPath] = process.argv.slice(2);
  if (!goldPath || !outcomesDirectory || !outputPath) throw new Error('Usage: node scripts/evaluate-source-vision-pilot.mjs <source-gold.json> <runner-output-directory> <new-report.json>');
  const bytes = await fs.readFile(goldPath), gold = JSON.parse(bytes);
  const freeze = JSON.parse(await fs.readFile(path.join(path.dirname(goldPath), 'source-gold-freeze.json'), 'utf8'));
  if (!freeze.frozenBeforeNewProviderOutputs || !freeze.files.some(file => path.basename(file.path) === path.basename(goldPath) && file.sha256 === hash(bytes))) throw new Error('Gold does not match its pre-run freeze.');
  for (const page of gold.pages) {
    if (hash(await fs.readFile(page.imagePath)) !== page.inputImageSha256 || hash(await fs.readFile(page.sourcePath)) !== page.sourceSha256) throw new Error('A frozen source or page image changed.');
  }
  const files = await outcomePaths(outcomesDirectory);
  const outcomes = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
  const report = evaluateSourceVisionPilot(gold, outcomes);
  report.goldSha256 = hash(bytes);
  report.inputOutcomes = await Promise.all(files.map(async file => ({ path: file, sha256: hash(await fs.readFile(file)) })));
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ report: path.resolve(outputPath), models: report.models.map(model => Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'pages'))), unknownOutcomes: report.unknownOutcomes.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
