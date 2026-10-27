import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVietnamTelephoneCandidates } from '../lib/telephone-reconciliation.ts';
import { isShipmentFactClear } from '../lib/shipment-autofill.ts';
import type { Candidate, ShipmentDocument, WorkspaceState } from '../lib/types.ts';

function source(id: string): ShipmentDocument {
  return { id, caseId: 'shipment', name: `${id}.pdf`, type: 'invoice', mime: 'application/pdf', size: 100,
    sha256: id === 'first' ? 'a'.repeat(64) : 'b'.repeat(64), version: 1, active: true,
    uploadedAt: '2026-10-26T00:00:00Z', pages: [{ page: 1, text: '', aiReadability: 'clear', textSource: 'kimi', documentType: 'invoice' }],
    extractionPipeline: 'kimi', aiProcessedPages: [1], extractionStatus: 'extracted', synthetic: true };
}
function candidate(documentId: string, field: string, value: string, extra: Partial<Candidate> = {}): Candidate {
  return { id: `${documentId}:${field}`, caseId: 'shipment', documentId, documentVersion: 1, field, value,
    originalText: field.endsWith('Telephone') ? `Phone: ${value}` : value,
    page: 1, location: 'Page 1', method: 'kimi:test:source_vision_proposal', confidence: 'high', confidenceScore: 97,
    readability: 'clear', visualEvidence: { imageSha256: 'c'.repeat(64), bounds: [.1, .1, .3, .1], textAgreement: false },
    normalizations: [], ...extra };
}
function fixture(party = 'importer') {
  return { documents: [source('first'), source('second')], candidates: [
    candidate('first', party, 'Example Vietnam Co. Ltd.'),
    candidate('first', `${party}Telephone`, '+840812345678'),
    candidate('second', party, 'EXAMPLE VIETNAM CO., LTD'),
    candidate('second', `${party}Telephone`, '(+84) 8 1234 5678'),
  ] };
}
const clear = () => true;
function grounded(candidates: Candidate[], documents: ShipmentDocument[]) {
  const state: WorkspaceState = { id: 'workspace', name: 'Test', revision: 1, cases: [], documents, candidates,
    audit: [], emails: [], snapshots: [], handoffs: [], settings: { inboxProvider: 'gmail', inboxAddress: '', inboxStatus: 'not_connected', defaultReviewer: '' } };
  return (field: string, evidence: Candidate[]) => isShipmentFactClear(state, field, evidence);
}

test('independent same-party quotation can resolve the single extra zero, preserving all original evidence', () => {
  for (const party of ['importer', 'exporter']) {
    const { candidates, documents } = fixture(party), before = structuredClone(candidates);
    const result = projectVietnamTelephoneCandidates(candidates, documents, clear);
    const phones = result.filter(value => value.field.endsWith('Telephone'));
    assert.deepEqual(phones.map(value => value.value), ['+84812345678', '+84812345678']);
    assert.deepEqual(candidates, before);
    for (const phone of phones) {
      const original = candidates.find(value => value.id === phone.id)!;
      for (const key of ['id', 'caseId', 'documentId', 'documentVersion', 'page', 'originalText', 'visualEvidence', 'confidenceScore'] as const) assert.deepEqual(phone[key], original[key]);
      assert.equal(phone.normalizations[0].before, original.value);
      assert.equal(phone.normalizations[0].after, phone.value);
      assert.match(phone.normalizations[0].reason, /second.*page 1/);
    }
    assert.deepEqual(projectVietnamTelephoneCandidates(result, documents, clear), result, 'Projection is idempotent');
  }
});

test('no independent source, different source digits or different party keeps the conflict for review', () => {
  const mutations: ((candidates: Candidate[], documents: ShipmentDocument[]) => void)[] = [
    (values) => values.splice(2),
    (values) => { values[3].value = '+84899998888'; values[3].originalText = 'Phone: +84899998888'; },
    (values) => { values[2].value = 'Another Vietnam Company'; },
    (values) => { values[2].field = 'exporter'; },
    (values) => { values[2].page = 2; },
    (values) => { values[3].originalText = 'Phone: unreadable'; },
    (_, docs) => { docs[1].sha256 = docs[0].sha256; },
    (values) => values.push(candidate('first', 'importerCode', 'ID-111'), candidate('second', 'importerCode', 'ID-222')),
    (values) => { values[3].caseId = 'other-shipment'; },
  ];
  for (const mutate of mutations) {
    const { candidates, documents } = fixture(); mutate(candidates, documents);
    assert.deepEqual(projectVietnamTelephoneCandidates(candidates, documents, clear), candidates);
  }
});

test('uncertain, stale, reference or unprocessed evidence cannot repair a phone', () => {
  const mutations: ((candidates: Candidate[], documents: ShipmentDocument[]) => void)[] = [
    (values) => { values[3].confidence = 'medium'; },
    (values) => { values[3].readability = 'uncertain'; },
    (values) => { values[3].method = 'browser_local_ocr'; },
    (values) => { values[3].documentVersion = 2; },
    (values) => { values[3].lineId = 'goods'; },
    (_, docs) => { docs[1].referenceOnly = true; },
    (_, docs) => { docs[1].active = false; },
    (_, docs) => { docs[1].aiProcessedPages = []; },
    (_, docs) => { docs[1].pages[0].aiReadability = 'uncertain'; },
  ];
  for (const mutate of mutations) {
    const { candidates, documents } = fixture(); mutate(candidates, documents);
    assert.deepEqual(projectVietnamTelephoneCandidates(candidates, documents, clear), candidates);
  }
  const { candidates, documents } = fixture();
  assert.deepEqual(projectVietnamTelephoneCandidates(candidates, documents, () => false), candidates);
});

test('an unrelated rejected proposal on a processed page does not poison grounded accepted phone evidence', () => {
  const { candidates, documents } = fixture();
  documents[0].aiProcessedPages = [1, 2];
  documents[0].aiRejectedPages = [2];
  documents[0].pages.push({ ...documents[0].pages[0], page: 2 });
  candidates.push(
    { ...candidates[0], id: 'first:importer:page2', page: 2 },
    { ...candidates[1], id: 'first:importerTelephone:page2', page: 2 },
  );
  const result = projectVietnamTelephoneCandidates(candidates, documents, grounded(candidates, documents));
  assert.deepEqual(result.filter(candidate => candidate.field === 'importerTelephone').map(candidate => candidate.value),
    ['+84812345678', '+84812345678', '+84812345678']);
  assert.equal(candidates.at(-1)?.value, '+840812345678', 'Original accepted candidate stays unchanged');
});

test('partially rejected pages still require grounded evidence for the individual phone and party', () => {
  for (const index of [2, 3]) {
    const { candidates, documents } = fixture();
    documents[1].aiRejectedPages = [1];
    delete candidates[index].visualEvidence;
    // The page has no matching text, so the retained quotation alone is no proof.
    assert.equal(grounded(candidates, documents)(candidates[index].field, [candidates[index]]), false);
    assert.deepEqual(projectVietnamTelephoneCandidates(candidates, documents, grounded(candidates, documents)), candidates);
  }
});

test('phone projection never guesses domestic prefixes, multiple numbers, extensions, other country codes or missing digits', () => {
  for (const value of ['0812345678', '84 8 1234 5678', '+84 8 1234 5678 ext 2', '+84 8 1234 5678 / 9', '+8401234', '+32 8 1234 5678']) {
    const { candidates, documents } = fixture();
    candidates[1].value = value; candidates[1].originalText = `Phone: ${value}`;
    assert.deepEqual(projectVietnamTelephoneCandidates(candidates, documents, clear), candidates, value);
  }
});

function transportPhoneFixture() {
  const data = fixture();
  data.documents[0].type = 'air_waybill';
  data.documents[0].pages[0].documentType = 'air_waybill';
  data.documents[0].pages.push({ ...data.documents[0].pages[0], page: 2 });
  data.documents[0].aiProcessedPages = [1, 2];
  data.candidates[0].field = 'houseConsignee';
  data.candidates[0].originalText = `To ${data.candidates[0].value}`;
  data.candidates.push({ ...structuredClone(data.candidates[1]), id: 'first:importerTelephone:page2', page: 2 });
  return data;
}

test('accepted transport-party identity and an exact duplicate page preserve independently corroborated phone spelling', () => {
  const { candidates, documents } = transportPhoneFixture(), before = structuredClone(candidates);
  const result = projectVietnamTelephoneCandidates(candidates, documents, grounded(candidates, documents));
  assert.deepEqual(result.filter(value => value.field === 'importerTelephone').map(value => value.value), ['+84812345678', '+84812345678', '+84812345678']);
  assert.equal(result[0].field, 'houseConsignee', 'Phone ownership does not change declaration party role');
  assert.equal(result.some(value => value.documentId === 'first' && value.field === 'importer'), false);
  assert.deepEqual(candidates, before);
});

test('transport phone identity cannot borrow across documents/versions or bypass local conflicts, weak evidence, or a missing commercial party', () => {
  const mutations: ((candidates: Candidate[], documents: ShipmentDocument[]) => void)[] = [
    (values, docs) => { values[4].documentId = 'third'; const other = structuredClone(docs[0]); other.id = 'third'; other.sha256 = 'd'.repeat(64); docs.push(other); },
    (values, docs) => { values[4].documentVersion = 2; docs[0].version = 2; },
    values => { values[4].originalText = 'Telephone: +840812345678'; },
    values => { values[4].value = '+8408 12345678'; values[4].originalText = 'Phone: +8408 12345678'; },
    values => values.push(candidate('first', 'houseConsignee', 'Another Company', { id: 'local-conflict', page: 2 })),
    values => values.push(candidate('first', 'houseConsignee', 'Example Vietnam Co. Ltd.', { id: 'local-uncertain', page: 2, readability: 'uncertain' })),
    values => { values[2].field = 'transportConsignee'; },
    values => { delete values[0].visualEvidence; },
  ];
  for (const mutate of mutations) {
    const { candidates, documents } = transportPhoneFixture(); mutate(candidates, documents);
    const result = projectVietnamTelephoneCandidates(candidates, documents, grounded(candidates, documents));
    assert.equal(result.find(value => value.id === 'first:importerTelephone:page2')?.value, candidates[4].value);
  }
});
