import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptedProposals, evaluateWeek3Vision } from '../scripts/evaluate-week3-vision.mjs';

function fixture() {
  const page = { jobId: 'job', packetId: 'case', case: 'Synthetic', sourceName: 'source.pdf', sourcePath: '/synthetic/source.pdf',
    sourceSha256: 'a'.repeat(64), inputImageSha256: 'b'.repeat(64), page: 1, expectedGoodsRowCount: 1,
    goodsRows: [{ rowIndex: 1, goodsCode: 'SKU1' }], reviewOnly: [],
    facts: [{ id: 'invoice', field: 'invoiceNumber', value: 'INV1', comparison: 'identifier', quote: 'Invoice INV1' },
      { id: 'code', field: 'goodsCode', rowIndex: 1, value: 'SKU1', comparison: 'identifier', quote: 'SKU1' },
      { id: 'origin', field: 'origin', rowIndex: 1, value: 'CN', comparison: 'literal', quote: 'Origin CN' }] };
  const gold = { schemaVersion: 1, employeeDeclarationAnswersUsed: false, providerOutputsInspectedForGold: false, pages: [page], scoringPolicy: {}, authorship: 'Synthetic' };
  const rubric = { schemaVersion: 1, frozenBeforeFreshOutputs: true, baselineOutputsPreviouslyInspected: true, pages: [{ jobId: 'job', rules: [
    { id: 'wrong-country', fields: ['exporterCountry'], classification: 'unsupported_role', definiteWrongValuePattern: 'VAT', sourceQuote: 'VAT 12345', explanation: 'Tax ID is not country.' },
    { id: 'order-role', fields: ['contractNumber'], classification: 'unsupported_role', sourceQuote: 'Order P1', explanation: 'Order not contract.' },
  ] }] };
  const proposals = [{ field: 'invoiceNumber', value: 'INV1', quote: 'Invoice INV1', page: 1 },
    { field: 'goodsCode', value: 'SKU1', quote: 'SKU1', page: 1, rowIndex: 1 },
    { field: 'origin', value: 'CN', quote: 'Origin CN', page: 1, rowIndex: 1 },
    { field: 'exporterCountry', value: 'VAT 12345', quote: 'VAT 12345', page: 1 },
    { field: 'contractNumber', value: 'P1', quote: 'Order P1', page: 1 }];
  const candidates = proposals.map((proposal, index) => ({ id: `c${index}`, caseId: 'case', page: 1, field: proposal.field,
    value: proposal.value, originalText: proposal.quote, ...(proposal.rowIndex ? { lineId: `doc:v1:p1:ai-row${proposal.rowIndex}` } : {}),
    visualEvidence: { imageSha256: page.inputImageSha256 }, confidence: 'high' }));
  const outcome = { model: 'model', requestedModel: 'model', jobId: 'job', packetId: 'case', sourceSha256: page.sourceSha256,
    inputImageSha256: page.inputImageSha256, page: 1, result: { pageReadings: [{ page: 1, readability: 'clear' }], proposals, candidates, rejectionDiagnostics: [] } };
  return { gold, rubric, outcome };
}

test('definite wrong fields affect the scoped rate while unsupported roles remain separate', () => {
  const { gold, rubric, outcome } = fixture();
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.raw.correctKnownFacts, 3);
  assert.equal(model.raw.definiteWrongFields, 1);
  assert.equal(model.raw.unsupportedRoleProposals, 1);
  assert.equal(model.raw.scopedPopulatedClaimAccuracy, 3 / 4);
  assert.deepEqual(model.accepted, model.raw);
});

test('blocking bad fields does not claim the model read them correctly or reward blank checks', () => {
  const { gold, rubric, outcome } = fixture();
  outcome.result.candidates = outcome.result.candidates.filter(candidate => !['exporterCountry', 'contractNumber'].includes(candidate.field));
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.raw.scopedPopulatedClaimAccuracy, 3 / 4);
  assert.equal(model.accepted.scopedPopulatedClaimAccuracy, 1);
  assert.equal(model.accepted.correctKnownFacts, 3);
  assert.equal(model.disposition.definiteWrongFieldsBlocked, 1);
  assert.equal(model.disposition.unsupportedRoleProposalsBlocked, 1);
  assert.equal(model.disposition.rawProposalsWithheld, 2);
});

test('dropping correctly read source facts decreases coverage and explicitly counts withholding', () => {
  const { gold, rubric, outcome } = fixture();
  outcome.result.candidates = outcome.result.candidates.filter(candidate => candidate.field !== 'origin');
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.raw.knownFactCoverage, 1);
  assert.equal(model.accepted.knownFactCoverage, 2 / 3);
  assert.equal(model.accepted.omittedKnownFacts, 1);
  assert.equal(model.disposition.correctFactsWithheld, 1);
  assert.equal(model.accepted.wrongKnownFacts, 0);
});

test('grounded evidence uses originalText and goods lineId, not nonexistent quote/rowIndex', () => {
  const { outcome } = fixture();
  const accepted = acceptedProposals(outcome.result.candidates, outcome);
  assert.equal(accepted[2].quote, 'Origin CN');
  assert.equal(accepted[2].rowIndex, 1);
  assert.equal(accepted[0].rowIndex, undefined);
  assert.throws(() => acceptedProposals([{ ...outcome.result.candidates[2], lineId: 'doc:v1:p2:ai-row1' }], outcome));
  assert.throws(() => acceptedProposals([{ ...outcome.result.candidates[0], caseId: 'other' }], outcome));
  assert.throws(() => acceptedProposals([{ ...outcome.result.candidates[0], visualEvidence: { imageSha256: 'other' } }], outcome));
});

test('grounding changes to a wrong source value are exposed independently of raw accuracy', () => {
  const { gold, rubric, outcome } = fixture();
  outcome.result.candidates[2].value = 'BE';
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.raw.wrongKnownFacts, 0);
  assert.equal(model.accepted.wrongKnownFacts, 1);
  assert.equal(model.disposition.correctFactsChangedToWrong, 1);
});

test('empty accepted inventory is full withholding, not 100 percent correctness', () => {
  const { gold, rubric, outcome } = fixture();
  outcome.result.candidates = [];
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.accepted.scopedPopulatedClaimAccuracy, null);
  assert.equal(model.accepted.knownFactCoverage, 0);
  assert.equal(model.disposition.correctFactsWithheld, 3);
  assert.equal(model.disposition.rawProposalsWithheld, 5);
});

test('duplicates and bad source identities remain unusable; rows stay outside scalar rates', () => {
  const { gold, rubric, outcome } = fixture();
  assert.equal(evaluateWeek3Vision(gold, rubric, [outcome, outcome]).models[0].unusablePages, 1);
  const copy = structuredClone(outcome); copy.result.candidates[0].visualEvidence.imageSha256 = 'wrong';
  assert.equal(evaluateWeek3Vision(gold, rubric, [copy]).models[0].unusablePages, 1);
  outcome.result.proposals.push({ field: 'description', value: 'Shipment summary', quote: 'Shipment summary', page: 1, rowIndex: 2 });
  const model = evaluateWeek3Vision(gold, rubric, [outcome]).models[0];
  assert.equal(model.raw.extraGoodsRows, 1);
  assert.equal(model.accepted.extraGoodsRows, 0);
  assert.equal(model.raw.scopedPopulatedClaimAccuracy, 3 / 4);
});

test('one populated claim cannot be double-counted by a definite semantic and known fact rule', () => {
  const { gold, rubric, outcome } = fixture();
  rubric.pages[0].rules[0].fields = ['origin'];
  assert.throws(() => evaluateWeek3Vision(gold, rubric, [outcome]), /double-count/);
});

test('private development rubric and original image fingerprints remain frozen', async context => {
  const root = path.resolve(import.meta.dirname, '..');
  const directory = path.join(root, 'outputs/week3-glm-improvement-20261026');
  const freezeBytes = await fs.readFile(path.join(directory, 'semantic-rubric-freeze.json')).catch(() => null);
  if (!freezeBytes) { context.skip('Private source rubric is not distributed in CI.'); return; }
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const freeze = JSON.parse(freezeBytes.toString());
  const bytes = await fs.readFile(path.join(directory, 'semantic-rubric.json'));
  assert.equal(sha(bytes), freeze.rubricSha256);
  const rubric = JSON.parse(bytes.toString());
  assert.equal(rubric.baselineOutputsPreviouslyInspected, true);
  assert.equal(rubric.frozenBeforeFreshOutputs, true);
  assert.match(rubric.scope, /not.*holdout/);
  assert.equal(sha(await fs.readFile(rubric.sourceGoldPath)), rubric.sourceGoldSha256);
  for (const page of rubric.pages) {
    assert.equal(sha(await fs.readFile(page.sourcePath)), page.sourceSha256);
    assert.equal(sha(await fs.readFile(page.imagePath)), page.inputImageSha256);
  }
});
