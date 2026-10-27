import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEcusExportPayload, compareEcusExportForms, EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, parseEcusExportForm, suggestedEcusExportForm, validateEcusExportForm, type EcusExportForm } from '../lib/ecus-export.ts';
import type { Actor, ShipmentCase } from '../lib/types.ts';

const actor: Actor = { id: 'export-reviewer', name: 'Synthetic export reviewer', email: 'export@example.invalid' };
const shipment = (): ShipmentCase => ({ id: 'export-case', reference: 'SYNTHETIC-EXPORT-1', title: 'Synthetic export', status: 'review', caseType: 'export', assignedTo: actor.name, createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', documentIds: [], fields: {}, goods: [], groupingConfidence: 'high', groupingReason: 'Synthetic fixture', groupingConfirmed: true, synthetic: true, resolutions: [] });
const form = (): EcusExportForm => ({ headers: {
  declarationType: 'B11', customsOffice: 'SYNTHETIC', transportMode: '2', exporterCode: '0123456789', exporterName: 'SYNTHETIC EXPORTER', exporterAddress: 'Synthetic origin address',
  importerName: 'SYNTHETIC OVERSEAS BUYER', importerAddress: 'Synthetic destination address', importerCountry: 'BE', currency: 'USD', invoiceNumber: 'SYNTHETIC-001', invoiceDate: '2026-10-25', invoiceTotal: '20.50',
}, goods: [{ description: 'Synthetic sample item', hsCode: '12345678', origin: 'VN', quantity: '2', unit: 'PCE', unitPrice: '10.25', amount: '20.50' }] });

test('EDA has an independent semantic catalog and incomplete drafts remain editable', () => {
  assert.ok(EDA_HEADER_FIELDS.every(field => field.tab === 'general' && !field.key.startsWith('1.')));
  assert.ok(EDA_GOODS_FIELDS.every(field => field.tab === 'goods' && !field.key.startsWith('1.')));
  assert.deepEqual(parseEcusExportForm({ headers: {}, goods: [] }), { headers: {}, goods: [] });
  assert.ok(validateEcusExportForm({ headers: {}, goods: [] }).some(issue => issue.path === 'goods'));
  assert.deepEqual(validateEcusExportForm(form()), []);
});

test('EDA parser rejects unknown fields, import IDs, structured values and oversized inputs', () => {
  assert.throws(() => parseEcusExportForm({ ...form(), direction: 'import' }), /only headers and goods/);
  assert.throws(() => parseEcusExportForm({ headers: { '1.12': 'forged' }, goods: [] }), /not a supported EDA field/);
  assert.throws(() => parseEcusExportForm({ headers: {}, goods: [{ customsDecision: 'guessed' }] }), /not a supported/);
  assert.throws(() => parseEcusExportForm({ headers: { exporterName: { value: 'nested' } }, goods: [] }), /plain text/);
  assert.throws(() => parseEcusExportForm({ headers: { exporterName: 'x'.repeat(513) }, goods: [] }), /plain text/);
  assert.throws(() => parseEcusExportForm({ headers: {}, goods: Array.from({ length: 501 }, () => ({})) }), /500/);
  assert.throws(() => parseEcusExportForm(JSON.parse('{"headers":{"__proto__":"bad"},"goods":[]}')), /not a supported/);
});

test('EDA parser preserves exact numeric strings and codes without speculative conversion', () => {
  const value = form(); value.goods[0].quantity = '0002.00000001';
  value.headers.exporterName = '  SYNTHETIC EXPORTER  ';
  const result = parseEcusExportForm(value);
  assert.equal(result.goods[0].quantity, '0002.00000001');
  assert.equal(result.headers.exporterName, 'SYNTHETIC EXPORTER');
  assert.equal(value.headers.exporterName, '  SYNTHETIC EXPORTER  ');
  for (const bad of ['1,250.00', '1e3', '-2', 'NaN', 'Infinity', '.5', '1.123456789']) {
    const invalid = form(); invalid.goods[0].quantity = bad;
    assert.throws(() => parseEcusExportForm(invalid), /nonnegative decimal/);
  }
});

test('EDA parsing canonicalizes object key order without changing goods row order', () => {
  const original = form();
  original.goods.push({ ...original.goods[0], description: 'Second item' });
  const reverse = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).reverse());
  const reordered = { goods: original.goods.map(reverse), headers: reverse(original.headers) };
  assert.equal(JSON.stringify(parseEcusExportForm(reordered)), JSON.stringify(parseEcusExportForm(original)));
  assert.deepEqual(parseEcusExportForm(reordered).goods.map(row => row.description), ['Synthetic sample item', 'Second item']);
});

test('EDA date, country, currency and HS formats reject malformed populated values', () => {
  for (const bad of ['2026-02-29', '2026-04-31', '25/10/2026', '2026-10-25T00:00:00Z']) {
    const value = form(); value.headers.invoiceDate = bad;
    assert.throws(() => parseEcusExportForm(value), /valid YYYY-MM-DD/);
  }
  const leap = form(); leap.headers.invoiceDate = '2024-02-29'; assert.doesNotThrow(() => parseEcusExportForm(leap));
  const country = form(); country.goods[0].origin = 'Vietnam'; assert.throws(() => parseEcusExportForm(country), /country code/);
  const currency = form(); currency.headers.currency = '$'; assert.throws(() => parseEcusExportForm(currency));
  const hs = form(); hs.goods[0].hsCode = '1234-5678'; assert.throws(() => parseEcusExportForm(hs), /4 to 10 digits/);
});

test('minimum handoff checks reject blank required values, zero quantity and incomplete paired units', () => {
  const value = form(); value.headers.exporterCode = ' '; value.goods[0].quantity = '0.000'; value.headers.grossWeight = '12';
  const paths = validateEcusExportForm(value).map(issue => issue.path);
  assert.ok(paths.includes('headers.exporterCode'));
  assert.ok(paths.includes('goods[0].quantity'));
  assert.ok(paths.includes('headers.grossWeightUnit'));
  assert.throws(() => buildEcusExportPayload(value, shipment(), actor, 4), /required/);
});

test('re-export references need a declaration number and explicit line association', () => {
  const value = form(); value.goods[0].previousDeclarationLine = '2';
  assert.ok(validateEcusExportForm(value).some(issue => issue.path === 'headers.previousDeclarationNumber'));
  value.headers.previousDeclarationNumber = 'SYNTHETIC-TEMP-IMPORT';
  assert.deepEqual(validateEcusExportForm(value), []);
  value.goods.push({ ...value.goods[0], previousDeclarationLine: '' });
  assert.ok(validateEcusExportForm(value).some(issue => issue.path === 'goods[1].previousDeclarationLine'));
});

test('building a draft rejects every non-export direction and archived or merged exports', () => {
  for (const caseType of ['import', 'unknown', 'reference', 'unsupported'] as const) assert.throws(() => buildEcusExportPayload(form(), { ...shipment(), caseType }, actor, 1), /explicitly classified export/);
  assert.throws(() => buildEcusExportPayload(form(), { ...shipment(), status: 'completed' }, actor, 1), /active/);
  assert.throws(() => buildEcusExportPayload(form(), { ...shipment(), mergedInto: 'other' }, actor, 1), /active/);
  for (const revision of [-1, 0.5, NaN]) assert.throws(() => buildEcusExportPayload(form(), shipment(), actor, revision), /revision/);
});

test('approved export payload is a detached deep-frozen snapshot with no signing operation', () => {
  const original = form(); const source = shipment();
  const payload = buildEcusExportPayload(original, source, actor, 42);
  original.headers.exporterName = 'Changed later'; original.goods[0].amount = '999'; source.reference = 'Changed reference';
  assert.equal(payload.form.headers.exporterName, 'SYNTHETIC EXPORTER');
  assert.equal(payload.form.goods[0].amount, '20.50');
  assert.equal(payload.reference, 'SYNTHETIC-EXPORT-1');
  assert.equal(payload.operation, 'create_draft'); assert.equal(payload.direction, 'export'); assert.equal(payload.workspaceRevision, 42);
  assert.equal(payload.approvedBy, actor.name); assert.ok(Number.isFinite(Date.parse(payload.approvedAt)));
  for (const object of [payload, payload.form, payload.form.headers, payload.form.goods, payload.form.goods[0]]) assert.ok(Object.isFrozen(object));
  assert.throws(() => { payload.form.goods[0].amount = 'changed'; }, TypeError);
});

test('read-back checks every populated approved value and unexpected known values', () => {
  const expected = form(); const actual = structuredClone(expected);
  assert.deepEqual(compareEcusExportForms(expected, actual), []);
  actual.headers.remarks = 'Unexpected declaration data'; actual.goods[0].origin = 'CN'; delete actual.headers.exporterAddress;
  const differences = compareEcusExportForms(expected, actual);
  assert.deepEqual(differences.map(value => value.path).sort(), ['goods[0].origin', 'headers.exporterAddress', 'headers.remarks']);
  assert.match(differences.find(value => value.path === 'headers.remarks')!.message, /unexpected/);
});

test('read-back rejects extra or missing rows and does not silently reorder or round numbers', () => {
  const expected = form(); expected.goods.push({ ...expected.goods[0], description: 'Second synthetic item' });
  const swapped = { ...expected, goods: [...expected.goods].reverse() };
  assert.equal(compareEcusExportForms(expected, swapped).filter(value => value.path.endsWith('.description')).length, 2);
  assert.ok(compareEcusExportForms(expected, { ...expected, goods: [expected.goods[0]] }).some(value => value.path === 'goods.length'));
  assert.ok(compareEcusExportForms(form(), { ...form(), goods: [...form().goods, {}] }).some(value => value.path === 'goods.length'));
  const changed = form(); changed.goods[0].amount = '20.5';
  assert.ok(compareEcusExportForms(form(), changed).some(value => value.path === 'goods[0].amount'));
});

test('export suggestions use reviewed current sources only, never the import declaration or transport cargo ID', () => {
  const source = shipment();
  const reviewed = { source: 'manual' as const, reason: 'Synthetic review', reviewedBy: actor.name, reviewedAt: '2026-10-25T12:00:00Z', stale: false, unverified: false };
  source.fields = { exporter: { ...reviewed, value: 'Reviewed exporter' }, importer: { ...reviewed, value: 'Stale buyer', stale: true }, currency: { ...reviewed, value: 'USD', unverified: true }, invoiceNumber: { ...reviewed, value: 'INV-SYNTHETIC' }, billOfLading: { ...reviewed, value: 'NOT-A-CARGO-ID' } };
  source.goods = [{ id: 'reviewed', description: 'Reviewed item', quantity: '1', unit: 'PCE', unitPrice: '10', amount: '10', hsCode: '12345678', origin: 'VN', dutyRate: '', vatRate: '', reviewed: true, manual: true }, { id: 'unreviewed', description: 'Unread item', quantity: '', unit: '', unitPrice: '', amount: '', hsCode: '', origin: '', dutyRate: '', vatRate: '', reviewed: false, manual: false }];
  const suggested = suggestedEcusExportForm(source);
  assert.equal(suggested.headers.exporterName, 'Reviewed exporter');
  assert.equal(suggested.headers.importerName, undefined); assert.equal(suggested.headers.currency, undefined);
  assert.equal(suggested.headers.cargoIdentification, undefined); assert.equal(suggested.goods.length, 1);
  assert.equal(suggested.goods[0].description, 'Reviewed item');
  assert.deepEqual(suggestedEcusExportForm({ ...source, caseType: 'import' }), { headers: {}, goods: [] });
});
