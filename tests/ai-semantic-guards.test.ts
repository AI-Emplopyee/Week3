import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticProposalRejections } from '../lib/ai-semantic-guards.ts';
import { groundKimiProposals } from '../lib/kimi.ts';
import { ECUS_FORM_FIELDS } from '../lib/ecus-form.ts';
import { createEmptyWorkspace } from '../lib/engine.ts';
import { applyFixtureAction } from './helpers/kimi-fixtures.ts';
import type { AiSourceProposal, DocumentType, ShipmentDocument } from '../lib/types.ts';

const proposal = (field: string, value: string, quote: string, rowIndex?: number): AiSourceProposal => ({ field, value, quote, rowIndex, page: 1, confidence: 'high', readability: 'clear' });
const reasons = (item: AiSourceProposal, documentType: DocumentType = 'invoice', rowProposals: AiSourceProposal[] = [item]) => semanticProposalRejections(item, { field: item.field, documentType, rowProposals });
const source = (text: string): ShipmentDocument => ({ id: 'semantic-document', caseId: 'semantic-case', name: 'synthetic.txt', mime: 'text/plain', size: text.length,
  sha256: 'a'.repeat(64), version: 1, active: true, uploadedAt: '', synthetic: true, type: 'other', extractionStatus: 'extracted', pages: [{ page: 1, text, textSource: 'office' }] });

test('tax identifiers cannot become countries, while unfamiliar literal country names remain available', () => {
  for (const item of [proposal('exporterCountry', 'VAT: ZZ123456789', 'VAT: ZZ123456789'), proposal('exporterCountryCode', 'ZZ', 'VAT: ZZ123456789'), proposal('origin', 'ZZ123456789', 'Tax number: ZZ123456789', 1)]) assert.deepEqual(reasons(item), ['country_tax_identifier']);
  for (const item of [proposal('exporterCountry', 'Unfamiliar Country', 'Unfamiliar Country'), proposal('origin', 'ZZ', 'Country of origin: ZZ', 1), proposal('exporterCountry', 'Belgium', 'VAT registered; country: Belgium')]) assert.deepEqual(reasons(item), []);
});

test('all catalog year components require four digits and never accept a transport identifier', () => {
  for (const field of ECUS_FORM_FIELDS.filter(field => field.input === 'year')) {
    const key = field.sourceField ?? field.key;
    assert.deepEqual(reasons(proposal(key, '12345678901', 'MAWB: 12345678901')), ['invalid_year_shape']);
    assert.deepEqual(reasons(proposal(key, '2024', 'Year: 2024')), []);
  }
});

test('competing reference and date labels are checked next to the selected value', () => {
  assert.deepEqual(reasons(proposal('contractNumber', 'PO-7', 'Your order reference: PO-7')), ['order_reference_not_contract']);
  assert.deepEqual(reasons(proposal('contractNumber', 'PO-7', 'Contract: C-1; Purchase order: PO-7')), ['order_reference_not_contract']);
  assert.deepEqual(reasons(proposal('contractNumber', 'C-1', 'Purchase order: PO-7; Contract: C-1')), []);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Pickup date: 2025-03-02')), ['pickup_not_departure']);
  assert.deepEqual(reasons(proposal('transitDepartureDate2', '2025-03-02', 'Departure date: 2025-03-02')), []);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Flight: XY123 Date: 2025-03-02')), ['flight_date_not_departure']);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Chuyến bay: XY123 Ngày: 2025-03-02')), ['flight_date_not_departure']);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Flight: XY123 Departure date: 2025-03-02')), []);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Departure Flight XY123: 2025-03-02')), []);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'Departure: 2025-03-01; Flight XY123 Date: 2025-03-02')), ['flight_date_not_departure']);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-01', 'Departure: 2025-03-01; Flight XY123 Date: 2025-03-02')), []);
  assert.deepEqual(reasons(proposal('transportDepartureDate', '2025-03-02', 'ETD for flight XY123: 2025-03-02')), []);
  assert.deepEqual(reasons(proposal('transportMethod', 'EXPRESS GLOBAL', 'Service: EXPRESS GLOBAL')), ['courier_product_not_transport_mode']);
  assert.deepEqual(reasons(proposal('transportMethod', 'Air freight', 'Transport mode: Air freight')), []);
});

test('transport parties require commercial role evidence only for commercial names', () => {
  assert.deepEqual(reasons(proposal('importer', 'Example Limited', 'To Example Limited'), 'air_waybill'), ['transport_party_not_commercial_party']);
  assert.deepEqual(reasons(proposal('exporter', 'Example Limited', 'Shipper: Example Limited'), 'bill_of_lading'), ['transport_party_not_commercial_party']);
  assert.deepEqual(reasons(proposal('importer', 'Agent Ltd', 'Consignee: Agent Ltd; Importer: Buyer Ltd'), 'air_waybill'), ['transport_party_not_commercial_party']);
  assert.deepEqual(reasons(proposal('importer', 'Buyer Ltd', 'Consignee: Agent Ltd; Importer: Buyer Ltd'), 'air_waybill'), []);
  assert.deepEqual(reasons(proposal('importer', 'Buyer Ltd', 'Invoice to: Buyer Ltd'), 'air_waybill'), []);
  assert.deepEqual(reasons(proposal('transportConsignee', 'Example Limited', 'To Example Limited'), 'air_waybill'), []);
  assert.deepEqual(reasons(proposal('importerTelephone', '+84123456789', 'To Example Limited +84123456789'), 'air_waybill'), []);
  assert.deepEqual(reasons(proposal('exporter', 'Example Limited', 'Example Limited'), 'invoice'), []);
});

test('shipment summary headings cannot create goods rows, but genuine Equipment items remain', () => {
  const summary = proposal('description', 'Equipment', 'Description of contents: Equipment', 1);
  assert.deepEqual(reasons(summary, 'air_waybill'), ['shipment_summary_not_goods_row']);
  const contentStatement = proposal('description', 'Equipment', 'Content / Commerce Control Statement / RC Equipment', 1);
  assert.deepEqual(reasons(contentStatement, 'air_waybill'), ['shipment_summary_not_goods_row']);
  const sku = proposal('goodsCode', 'M-120', 'Part number: M-120', 1);
  assert.deepEqual(reasons(summary, 'air_waybill', [summary, sku]), []);
  assert.deepEqual(reasons(contentStatement, 'air_waybill', [contentStatement, sku]), []);
  for (const invalidItem of [
    proposal('goodsCode', '12345678901', 'MAWB: 12345678901', 1),
    { ...sku, confidence: 'low' as const, readability: 'uncertain' as const },
    proposal('goodsCode', '12345678901', 'SKU: M-120; MAWB: 12345678901', 1),
    proposal('quantity', '2', 'Item 2 Quantity: 3', 1),
  ]) assert.deepEqual(reasons(contentStatement, 'air_waybill', [contentStatement, invalidItem]), ['shipment_summary_not_goods_row']);
  const quantity = proposal('quantity', '2', 'Item 1 Quantity: 2', 1);
  assert.deepEqual(reasons(summary, 'air_waybill', [summary, quantity]), []);
  assert.deepEqual(reasons(proposal('description', 'Equipment', 'Equipment', 1), 'invoice'), []);
});

test('charge rows are withheld with their same-row numeric cells and combined amounts remain unclassified', () => {
  const charge = proposal('description', 'Transport & Packing', 'Transport & Packing 45.00', 2);
  const amount = proposal('amount', '45.00', 'Transport & Packing 45.00', 2);
  assert.deepEqual(reasons(charge, 'invoice', [charge, amount]), ['charge_not_goods_row']);
  assert.deepEqual(reasons(amount, 'invoice', [charge, amount]), ['charge_not_goods_row']);
  assert.deepEqual(reasons(proposal('freightAmount', '45.00', 'Transport & Packing 45.00')), ['combined_charge_not_freight_only']);
  assert.deepEqual(reasons(proposal('freightAmount', '45.00', 'Freight charge: 45.00')), []);
  assert.deepEqual(reasons(proposal('freightAmount', '45.00', 'Transport & Packing: 80.00; Freight charge: 45.00')), []);
  assert.deepEqual(reasons(proposal('description', 'Freight cost calculator', 'Freight cost calculator', 1)), []);
  assert.deepEqual(reasons(proposal('description', 'Packing machine', 'Packing machine', 1)), []);
});

test('grounding passes current page classification, keeps raw proposals unchanged, and rejects invalid siblings before row decisions', () => {
  const summary = proposal('description', 'Equipment', 'Description of contents: Equipment', 1);
  const sku = proposal('goodsCode', 'MADE-UP-120', 'Part number: OTHER', 1);
  const importer = proposal('importer', 'Example Ltd', 'Consignee: Example Ltd');
  const doc = source([summary.quote, sku.quote, importer.quote].join('\n'));
  const proposals = [summary, sku, importer]; const before = JSON.stringify(proposals);
  const result = groundKimiProposals(doc, doc.pages, proposals, 'glm-5.3-flash', [], [{ page: 1, documentType: 'air_waybill', readability: 'clear' }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected, 3);
  assert.ok(result.rejectionDiagnostics?.some(item => item.index === 0 && item.reasons.includes('shipment_summary_not_goods_row')));
  assert.ok(result.rejectionDiagnostics?.some(item => item.index === 1 && item.reasons.includes('value_not_in_quote')));
  assert.ok(result.rejectionDiagnostics?.some(item => item.index === 2 && item.reasons.includes('transport_party_not_commercial_party')));
  assert.equal(JSON.stringify(proposals), before);
});

test('new rejected proposals do not replace an employee-reviewed country', () => {
  const actor = { id: 'reviewer', name: 'Synthetic reviewer', email: 'reviewer@example.invalid' };
  const text = 'COMMERCIAL INVOICE\nInvoice No: INV-7\nVAT: ZZ123456789';
  let state = applyFixtureAction(createEmptyWorkspace('semantic-tests'), { type: 'intake', documents: [{ id: 'doc', name: 'invoice.txt', mime: 'text/plain', size: text.length, sha256: 'synthetic', pages: [{ page: 1, text }], extractionStatus: 'extracted', synthetic: true }] }, actor);
  const caseId = state.cases[0].id;
  state = applyFixtureAction(state, { type: 'review_field', caseId, field: 'exporterCountry', value: 'Belgium', reason: 'Employee verified the commercial original.' }, actor);
  const reviewed = structuredClone(state.cases[0].fields.exporterCountry);
  const changed = applyFixtureAction(state, { type: 'add_ai_candidates', caseId, documentId: 'doc', documentVersion: 1, model: 'glm-5.3-flash', pages: [1],
    proposals: [proposal('invoiceNumber', 'INV-7', 'Invoice No: INV-7'), proposal('exporterCountry', 'VAT: ZZ123456789', 'VAT: ZZ123456789')],
    pageReadings: [{ page: 1, documentType: 'invoice', readability: 'clear' }] }, actor);
  assert.equal(changed.cases[0].fields.exporterCountry.value, reviewed.value);
  assert.equal(state.cases[0].fields.exporterCountry.value, 'Belgium');
  assert.ok(JSON.stringify(changed.audit).includes('country_tax_identifier'));
  assert.ok(!changed.candidates.some(candidate => candidate.field === 'exporterCountry' && candidate.value.startsWith('VAT:')));
});
