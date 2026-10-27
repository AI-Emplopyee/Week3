import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSourceVisionPilot, sourceFactMatches } from '../scripts/evaluate-source-vision-pilot.mjs';

function fixture() {
  const page = { jobId: 'job', packetId: 'case', case: 'Synthetic', sourceName: 'invoice.pdf', sourcePath: '/synthetic/invoice.pdf',
    sourceSha256: 'a'.repeat(64), inputImageSha256: 'b'.repeat(64), page: 1,
    expectedGoodsRowCount: 1, goodsRows: [{ rowIndex: 1, goodsCode: 'SKU1', description: 'Synthetic widget' }], reviewOnly: [],
    facts: [{ id: 'header:invoiceNumber', field: 'invoiceNumber', value: 'INV1', comparison: 'identifier', quote: 'Invoice INV1' },
      { id: '1:goodsCode', field: 'goodsCode', rowIndex: 1, value: 'SKU1', comparison: 'identifier', quote: 'SKU1' },
      { id: '1:origin', field: 'origin', rowIndex: 1, value: 'CN', comparison: 'literal', quote: 'Origin CN' }] };
  const gold = { schemaVersion: 1, employeeDeclarationAnswersUsed: false, providerOutputsInspectedForGold: false, pages: [page], scoringPolicy: {}, authorship: 'Synthetic test' };
  const outcome = { requestedModel: 'model', model: 'model', jobId: 'job', packetId: 'case', sourceSha256: page.sourceSha256, inputImageSha256: page.inputImageSha256,
    page: 1, result: { pageReadings: [{ page: 1, readability: 'clear' }], proposals: [
      { field: 'invoiceNumber', value: 'INV1', page: 1 }, { field: 'goodsCode', value: 'SKU1', page: 1, rowIndex: 1 }, { field: 'origin', value: 'CN', page: 1, rowIndex: 1 },
    ] } };
  return { gold, outcome };
}

test('omissions and wording are excluded from populated accuracy but remain visible', () => {
  const { gold, outcome } = fixture();
  outcome.result.proposals = outcome.result.proposals.filter(proposal => proposal.field !== 'origin');
  outcome.result.proposals.push({ field: 'description', value: 'A translated description', page: 1, rowIndex: 1 });
  const report = evaluateSourceVisionPilot(gold, [outcome]).models[0];
  assert.equal(report.filledSourceFactAccuracy, 1);
  assert.equal(report.omitted, 1);
  assert.equal(report.sourceFactCoverage, 2 / 3);
  assert.equal(report.unscoredProposals, 1);
});

test('source country differences are wrong and cannot be replaced by an employee answer', () => {
  const { gold, outcome } = fixture();
  outcome.result.proposals[2].value = 'BE';
  const report = evaluateSourceVisionPilot(gold, [outcome]).models[0];
  assert.equal(report.wrong, 1);
  assert.equal(report.filledSourceFactAccuracy, 2 / 3);
  assert.throws(() => evaluateSourceVisionPilot({ ...gold, employeeDeclarationAnswersUsed: true }, [outcome]));
});

test('duplicate contradictory values are not cherry-picked', () => {
  const { gold, outcome } = fixture();
  outcome.result.proposals.push({ field: 'origin', value: 'BE', page: 1, rowIndex: 1 });
  const report = evaluateSourceVisionPilot(gold, [outcome]).models[0];
  assert.equal(report.wrong, 1);
  assert.equal(report.pages[0].facts[2].actual.length, 2);
});

test('unique source identities align content while row numbering and charges are reported separately', () => {
  const { gold, outcome } = fixture();
  for (const proposal of outcome.result.proposals) if (proposal.rowIndex) proposal.rowIndex = 2;
  outcome.result.proposals.push({ field: 'description', value: 'Transport and packaging charges', page: 1, rowIndex: 3 });
  const report = evaluateSourceVisionPilot(gold, [outcome]).models[0];
  assert.equal(report.filledSourceFactAccuracy, 1);
  assert.equal(report.rowAssignmentFindings, 1);
  assert.equal(report.extraGoodsRows, 1);
  assert.equal(report.missingGoodsRows, 0);
});

test('provider failures, wrong images and duplicate runs are unusable rather than false accuracy', () => {
  const { gold, outcome } = fixture();
  for (const failed of [{ ...outcome, error: 'invalid JSON' }, { ...outcome, inputImageSha256: 'c'.repeat(64) }]) {
    const report = evaluateSourceVisionPilot(gold, [failed]).models[0];
    assert.equal(report.unusableResponses, 1);
    assert.equal(report.filledSourceFactAccuracy, null);
    assert.equal(report.omitted, 0);
  }
  assert.equal(evaluateSourceVisionPilot(gold, [outcome, outcome]).models[0].unusableResponses, 1);
});

test('empty valid readings report no accuracy and full omissions', () => {
  const { gold, outcome } = fixture();
  outcome.result.proposals = [];
  const report = evaluateSourceVisionPilot(gold, [outcome]).models[0];
  assert.equal(report.filledSourceFactAccuracy, null);
  assert.equal(report.omitted, 3);
  assert.equal(report.sourceFactCoverage, 0);
});

test('numeric punctuation may vary but source phone digits, dates and amounts cannot change', () => {
  assert.equal(sourceFactMatches({ value: '1690.25', comparison: 'decimal' }, '1.690,25'), true);
  assert.equal(sourceFactMatches({ value: '1690.25', comparison: 'decimal' }, '1,690.25'), true);
  assert.equal(sourceFactMatches({ value: '4', comparison: 'decimal', acceptedEquivalentValues: ['4,000'] }, '4,000'), true);
  assert.equal(sourceFactMatches({ value: '4', comparison: 'decimal', acceptedEquivalentValues: ['4,000'] }, '4000'), false);
  assert.equal(sourceFactMatches({ value: '+840839102875', comparison: 'phone' }, '(+84) 083 9102875'), true);
  assert.equal(sourceFactMatches({ value: '+840839102875', comparison: 'phone' }, '+84839102875'), false);
  assert.equal(sourceFactMatches({ value: '2016-04-08', comparison: 'date', acceptedEquivalentValues: ['08/04/2016'] }, '2016-04-09'), false);
  assert.equal(sourceFactMatches({ value: '2016-04-08', comparison: 'date' }, '8 April 2016'), true);
  assert.equal(sourceFactMatches({ value: '2016-04-08', comparison: 'date' }, '08APR2016'), true);
  assert.equal(sourceFactMatches({ value: '2016-04-08', comparison: 'date' }, '2016-02-31'), false);
  assert.equal(sourceFactMatches({ value: 'EY0441', comparison: 'token' }, 'EY0441/08APR2016'), true);
  assert.equal(sourceFactMatches({ value: 'EY0441', comparison: 'token' }, 'EY0442'), false);
  assert.equal(sourceFactMatches({ value: 'DAT', comparison: 'token' }, 'DAT Delivered at Terminal HO CHI MINH CITY'), true);
  assert.equal(sourceFactMatches({ value: 'DAT', comparison: 'token' }, 'DAP Delivered At Place'), false);
  assert.equal(sourceFactMatches({ value: '2172.09', comparison: 'decimal' }, '2.172,09'), true);
});

test('local source gold remains frozen and each selected image matches its original-page fingerprint', async context => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'outputs/vision-source-pilot-20261026');
  const freezeBytes = await fs.readFile(path.join(directory, 'source-gold-freeze.json')).catch(() => null);
  if (!freezeBytes) { context.skip('Private real-source pilot fixtures are not distributed with the repository.'); return; }
  const freeze = JSON.parse(freezeBytes.toString());
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(freeze.frozenBeforeNewProviderOutputs, true);
  for (const file of freeze.files) assert.equal(sha256(await fs.readFile(path.join(root, file.path))), file.sha256);
  const gold = JSON.parse(await fs.readFile(path.join(directory, 'source-gold.json'), 'utf8'));
  const selectionBytes = await fs.readFile(path.join(directory, 'selection.json'));
  assert.equal(sha256(selectionBytes), gold.selectionSha256);
  assert.equal(gold.pages.length, 4);
  assert.equal(new Set(gold.pages.map((page: { packetId: string }) => page.packetId)).size, 4);
  assert.equal(gold.employeeDeclarationAnswersUsed, false);
  assert.equal(gold.providerOutputsInspectedForGold, false);
  assert.match(gold.authorship, /not an independent human-validated/);
  for (const page of gold.pages) {
    assert.equal(sha256(await fs.readFile(page.imagePath)), page.inputImageSha256, page.jobId);
    assert.equal(sha256(await fs.readFile(page.sourcePath)), page.sourceSha256, page.sourceName);
    const frozenPage = freeze.sources.find((item: { jobId: string }) => item.jobId === page.jobId);
    assert.equal(frozenPage?.inputImageSha256, page.inputImageSha256);
    assert.equal(frozenPage?.page, page.page);
    assert.ok(page.facts.every((fact: { quote: string }) => fact.quote.trim().length));
  }
});
