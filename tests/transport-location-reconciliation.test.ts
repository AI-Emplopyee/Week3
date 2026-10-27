import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeclarationEntry } from '../lib/declaration.ts';
import { applyAction } from '../lib/engine.ts';
import { buildShipmentFacts, getEcusEvidenceIssues, syncShipmentDeclaration } from '../lib/shipment-autofill.ts';
import { projectTransportLocations } from '../lib/transport-location-reconciliation.ts';
import type { Actor, Candidate, ShipmentDocument, WorkspaceState } from '../lib/types.ts';

const actor: Actor = { id: 'mapping-reviewer', name: 'Mapping reviewer', email: 'mapping@example.invalid' };
const at = '2026-10-26T00:00:00.000Z';
function fixture() {
  const state: WorkspaceState = {
    id: 'mapping-fixture', name: 'Synthetic mapping checks', revision: 0,
    cases: [{ id: 'shipment', reference: 'SYNTHETIC-MAPPING', title: 'Synthetic mapping checks', status: 'review',
      caseType: 'import', assignedTo: actor.name, createdAt: at, updatedAt: at, documentIds: [], fields: {}, goods: [],
      groupingConfidence: 'high', groupingReason: 'Synthetic fixture', groupingConfirmed: true, synthetic: true,
      resolutions: [], declarationDraft: { schemaVersion: 1, fields: [] } }],
    documents: [], candidates: [], audit: [], emails: [], snapshots: [], handoffs: [],
    settings: { inboxProvider: 'gmail', inboxAddress: '', inboxStatus: 'not_connected', defaultReviewer: actor.name },
  };
  const shipment = state.cases[0];
  function addSource(id: string, type: ShipmentDocument['type'], facts: [string, string][]) {
    const document: ShipmentDocument = { id, caseId: shipment.id, name: `${id}.txt`, type, mime: 'text/plain',
      size: 1, sha256: `synthetic-${id}`, version: 1, active: true, uploadedAt: at, synthetic: true,
      extractionStatus: 'extracted', extractionPipeline: 'kimi', aiStatus: 'completed', aiProcessedPages: [1],
      pages: [{ page: 1, documentType: type, text: facts.map(([field, value]) => `${field}: ${value}`).join('\n'),
        textSource: 'manual', aiReadability: 'clear' }] };
    state.documents.push(document);
    shipment.documentIds.push(id);
    for (const [index, [field, value]] of facts.entries()) state.candidates.push({
      id: `${id}-${index}`, caseId: shipment.id, documentId: id, documentVersion: 1, field, value,
      originalText: `${field}: ${value}`, page: 1, location: 'Synthetic source line', method: 'kimi:test_fixture',
      confidence: 'high', readability: 'clear', normalizations: [],
    });
  }
  const value = (field: string) => getDeclarationEntry(shipment.declarationDraft, field)?.value;
  return { state, shipment, addSource, value, sync: () => syncShipmentDeclaration(state, shipment, actor) };
}

test('transport codes fill their code/name controls with original evidence and never invent review', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['portOfDischarge', 'VN-SGN-SSS'], ['portOfDischargeCode', 'SGN'],
    ['portOfLoadingCode', 'BRU'], ['packageCount', '1'], ['packageUnit', 'Piece']]);
  const original = structuredClone(state.candidates);
  sync();
  assert.equal((value('1.33') as { code: string }).code, 'VNSGN');
  assert.match((value('1.33') as { name: string }).name, /Ho.?Chi.?Minh/i);
  assert.equal((value('1.34') as { code: string }).code, 'BEBRU');
  assert.match((value('1.34') as { name: string }).name, /Brussel/i);
  const destination = getDeclarationEntry(shipment.declarationDraft, '1.33')!;
  assert.ok(destination.provenance.some(proof => proof.kind === 'document' && proof.quote.includes('VN-SGN-SSS')));
  assert.match(destination.reason, /transport-location:/);
  assert.equal(destination.review, null);
  assert.equal(destination.codeVerification, 'unverified');
  assert.deepEqual(value('1.27'), { kind: 'quantity', amount: '1', unitCode: '' });
  assert.ok(getEcusEvidenceIssues(state, shipment).some(issue => issue.ecusFieldKey === 'packageUnit' && issue.id.endsWith(':invalid')));
  assert.deepEqual(state.candidates, original);
  const first = structuredClone(shipment.declarationDraft);
  sync();
  assert.deepEqual(shipment.declarationDraft, first);
});

test('an actual transport code supplies a name instead of a generic contract port allowance', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('contract', 'contract', [['portOfLoading', 'Any port in Belgium'], ['portOfDischarge', 'Any port in Vietnam']]);
  addSource('awb', 'air_waybill', [['portOfLoadingCode', 'BRU'], ['portOfDischargeCode', 'SGN']]);
  sync();
  assert.match((value('1.33') as { name: string }).name, /Ho.?Chi.?Minh/i);
  assert.match((value('1.34') as { name: string }).name, /Brussel/i);
  const facts = buildShipmentFacts(state, shipment);
  assert.equal(facts.portOfDischarge.excludedCandidates?.[0].value, 'Any port in Vietnam');
  assert.ok(getDeclarationEntry(shipment.declarationDraft, '1.33')!.sourceCandidateIds?.includes('awb-1'));
});

test('an independently supported airport name is not undone by a repeated short-code reading', () => {
  const { addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['portOfLoadingCode', 'BRU']]);
  addSource('transport-copy', 'bill_of_lading', [['portOfLoading', 'BRU']]);
  sync();
  assert.deepEqual(value('1.34'), { kind: 'location', code: 'BEBRU', name: 'Brussel (Bruxelles)' });
});

test('unresolved route labels and generic port allowances remain reviewable, with no guessed name', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['portOfDischarge', 'ZZ-XXX-AAA'], ['portOfDischargeCode', 'XXX']]);
  addSource('contract', 'contract', [['portOfLoading', 'Any port in Belgium']]);
  sync();
  assert.equal((value('1.33') as { name: string }).name, '');
  assert.equal(value('1.34'), undefined);
  const issues = getEcusEvidenceIssues(state, shipment);
  assert.ok(issues.some(issue => issue.ecusFieldKey === 'portOfDischarge' && issue.candidateIds.includes('awb-0')));
  assert.ok(issues.some(issue => issue.ecusFieldKey === 'portOfLoading'));
});

test('specific competing locations remain a conflict after generic text is removed', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('contract', 'contract', [['portOfDischarge', 'Any port in Vietnam']]);
  addSource('awb-a', 'air_waybill', [['portOfDischarge', 'Hanoi']]);
  addSource('awb-b', 'air_waybill', [['portOfDischarge', 'Ho Chi Minh City']]);
  sync();
  assert.equal(value('1.33'), undefined);
  assert.equal(buildShipmentFacts(state, shipment).portOfDischarge.status, 'conflict');
  assert.ok(getEcusEvidenceIssues(state, shipment).some(issue => issue.ecusFieldKey === 'portOfDischarge' && issue.id.endsWith(':conflict')));
});

test('a known contradictory code and name on the same page require review', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['portOfDischargeCode', 'SGN'], ['portOfDischarge', 'Bruxelles']]);
  sync();
  assert.deepEqual(value('1.33'), { kind: 'location', code: 'VNSGN', name: '' });
  assert.ok(getEcusEvidenceIssues(state, shipment).some(issue => issue.ecusFieldKey === 'portOfDischarge' && issue.id.endsWith(':conflict')));
  const fact = buildShipmentFacts(state, shipment).portOfDischarge;
  assert.equal(fact.status, 'conflict');
  assert.equal(fact.alternatives.length, 2);
});

test('low confidence, stale, reference-only, goods and party-address readings cannot supply a city', () => {
  const { state, addSource } = fixture();
  addSource('awb', 'air_waybill', [['portOfDischargeCode', 'SGN']]);
  const original = state.candidates[0];
  const project = (candidate: Candidate, docs = state.documents) => projectTransportLocations([candidate], docs, () => true);
  for (const candidate of [{ ...original, confidence: 'low' as const }, { ...original, readability: 'uncertain' as const },
    { ...original, documentVersion: 2 }, { ...original, lineId: 'item' }, { ...original, field: 'importerAddress' }]) {
    assert.deepEqual(project(candidate), [candidate]);
  }
  assert.deepEqual(project(original, [{ ...state.documents[0], referenceOnly: true }]), [original]);
  assert.deepEqual(projectTransportLocations([original], state.documents, () => false), [original]);
});

test('manual declarations retain their exact location choices during mapping refresh', () => {
  const { shipment, addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['portOfDischargeCode', 'SGN']]);
  sync();
  const entry = getDeclarationEntry(shipment.declarationDraft, '1.33')!;
  entry.generatedBy = undefined;
  entry.value = { kind: 'location', code: 'VNSGN', name: 'Employee-selected location' };
  entry.provenance = [{ kind: 'manual', note: 'Employee checked this location.' }];
  sync();
  assert.equal((value('1.33') as { name: string }).name, 'Employee-selected location');
});

test('an employee accepting the literal phone source keeps that exact value after normalization', () => {
  const { state, shipment, addSource, value, sync } = fixture();
  addSource('awb', 'air_waybill', [['importer', 'Example Vietnam Co. Ltd.'], ['importerTelephone', '+840812345678']]);
  addSource('invoice', 'invoice', [['importer', 'Example Vietnam Co. Ltd.'], ['importerTelephone', '(+84) 8 1234 5678']]);
  sync();
  assert.deepEqual(value('1.16'), { kind: 'text', text: '+84812345678' });
  const accepted = applyAction(state, { type: 'review_field', caseId: shipment.id, field: 'importerTelephone',
    candidateId: 'awb-1', value: '+840812345678', reason: 'Employee explicitly chose this printed source value.' }, actor);
  const updated = accepted.cases.find(item => item.id === shipment.id)!;
  assert.equal(updated.fields.importerTelephone.value, '+840812345678');
  assert.deepEqual(getDeclarationEntry(updated.declarationDraft, '1.16')!.value, { kind: 'text', text: '+840812345678' });
  syncShipmentDeclaration(accepted, updated, actor);
  assert.deepEqual(getDeclarationEntry(updated.declarationDraft, '1.16')!.value, { kind: 'text', text: '+840812345678' });
});
