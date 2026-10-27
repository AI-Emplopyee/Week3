import type { Actor, ShipmentCase } from './types.ts';

/** A supported EDA draft subset, not the complete VNACCS export declaration or legal validation. */
export type EcusExportForm = { headers: Record<string, string>; goods: Array<Record<string, string>> };
export type EdaField = { key: string; labelVi: string; labelEn: string; required: boolean; input: 'text' | 'textarea' | 'code' | 'decimal' | 'integer' | 'date'; tab: 'general' | 'goods' };
const header = (key: string, labelVi: string, labelEn: string, input: EdaField['input'] = 'text', required = false): EdaField => ({ key, labelVi, labelEn, input, required, tab: 'general' });
const goods = (key: string, labelVi: string, labelEn: string, input: EdaField['input'] = 'text', required = false): EdaField => ({ key, labelVi, labelEn, input, required, tab: 'goods' });

/** Semantic export keys deliberately do not reuse the import declaration indicator catalog. */
export const EDA_HEADER_FIELDS: readonly EdaField[] = Object.freeze([
  header('declarationType', 'Mã loại hình xuất khẩu', 'Export declaration type', 'code', true),
  header('customsOffice', 'Cơ quan hải quan', 'Customs office code', 'code', true),
  header('transportMode', 'Mã phương thức vận chuyển', 'Transport mode code', 'code', true),
  header('exporterCode', 'Mã số thuế người xuất khẩu', 'Exporter tax code', 'code', true),
  header('exporterName', 'Tên người xuất khẩu', 'Exporter name', 'text', true),
  header('exporterAddress', 'Địa chỉ người xuất khẩu', 'Exporter address', 'textarea', true),
  header('exporterTelephone', 'Điện thoại người xuất khẩu', 'Exporter telephone'),
  header('importerName', 'Tên người nhập khẩu ở nước ngoài', 'Overseas importer name', 'text', true),
  header('importerAddress', 'Địa chỉ người nhập khẩu', 'Importer address', 'textarea', true),
  header('importerCountry', 'Mã nước người nhập khẩu', 'Importer country code', 'code', true),
  header('customsAgentCode', 'Mã đại lý hải quan', 'Customs agent code', 'code'),
  header('cargoIdentification', 'Số định danh hàng hóa xuất khẩu', 'Registered export cargo identification'),
  header('packageCount', 'Số lượng kiện', 'Package count', 'integer'),
  header('packageUnit', 'Mã đơn vị kiện', 'Package unit code', 'code'),
  header('grossWeight', 'Tổng trọng lượng', 'Gross weight', 'decimal'),
  header('grossWeightUnit', 'Mã đơn vị trọng lượng', 'Weight unit code', 'code'),
  header('storageLocation', 'Mã địa điểm lưu kho', 'Customs storage location code', 'code'),
  header('transportName', 'Tên phương tiện / chuyến bay', 'Vessel or flight identifier'),
  header('transportCode', 'Mã phương tiện vận chuyển', 'Transport identifier code', 'code'),
  header('departureDate', 'Ngày khởi hành', 'Departure date', 'date'),
  header('loadingLocationCode', 'Mã địa điểm xếp hàng', 'Loading location code', 'code'),
  header('loadingLocationName', 'Tên địa điểm xếp hàng', 'Loading location name'),
  header('unloadingLocationCode', 'Mã địa điểm dỡ hàng', 'Unloading location code', 'code'),
  header('unloadingLocationName', 'Tên địa điểm dỡ hàng', 'Unloading location name'),
  header('invoiceForm', 'Phân loại hình thức hóa đơn', 'Invoice form code', 'code'),
  header('invoiceNumber', 'Số hóa đơn', 'Invoice number'),
  header('invoiceDate', 'Ngày hóa đơn', 'Invoice date', 'date'),
  header('paymentMethod', 'Mã phương thức thanh toán', 'Payment method code', 'code'),
  header('incoterm', 'Điều kiện giao hàng', 'Incoterm', 'code'),
  header('currency', 'Mã đồng tiền hóa đơn', 'Invoice currency code', 'code', true),
  header('invoiceTotal', 'Tổng trị giá hóa đơn', 'Invoice total', 'decimal'),
  header('contractNumber', 'Số hợp đồng', 'Contract number'),
  header('contractDate', 'Ngày hợp đồng', 'Contract date', 'date'),
  header('previousDeclarationNumber', 'Số tờ khai tạm nhập tương ứng (tái xuất)', 'Previous temporary-import declaration (re-export)'),
  header('remarks', 'Ghi chú', 'Remarks', 'textarea'),
].map(field => Object.freeze(field)));

export const EDA_GOODS_FIELDS: readonly EdaField[] = Object.freeze([
  goods('description', 'Mô tả hàng hóa', 'Goods description', 'textarea', true),
  goods('hsCode', 'Mã HS xuất khẩu đã rà soát', 'Reviewed export HS code', 'code', true),
  goods('origin', 'Mã nước xuất xứ', 'Origin country code', 'code', true),
  goods('quantity', 'Số lượng', 'Quantity', 'decimal', true),
  goods('unit', 'Mã đơn vị tính', 'Quantity unit code', 'code', true),
  goods('unitPrice', 'Đơn giá hóa đơn', 'Invoice unit price', 'decimal', true),
  goods('amount', 'Trị giá hóa đơn dòng hàng', 'Goods invoice amount', 'decimal', true),
  goods('goodsCode', 'Mã hàng', 'Product code'),
  goods('previousDeclarationLine', 'Dòng hàng tờ khai tạm nhập (tái xuất)', 'Previous temporary-import goods line (re-export)', 'integer'),
].map(field => Object.freeze(field)));

export type EcusExportValidationIssue = { path: string; message: string };
export type EcusExportDifference = { path: string; expected: string; actual: string; message: string };
export type EcusExportPayload = {
  schemaVersion: 1; direction: 'export'; operation: 'create_draft'; caseId: string; reference: string;
  workspaceRevision: number; approvedBy: string; approvedAt: string; form: EcusExportForm;
};
const ownObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fieldLimit = (field: EdaField) => field.input === 'textarea' ? 4000 : field.input === 'code' ? 64 : 512;

function parseFields(value: unknown, fields: readonly EdaField[], path: string): Record<string, string> {
  if (!ownObject(value)) throw new Error(`${path} must be an object.`);
  const allowed = new Map(fields.map(field => [field.key, field]));
  const result: Record<string, string> = {};
  for (const [key, input] of Object.entries(value)) {
    const field = allowed.get(key);
    if (!field) throw new Error(`${path}.${key} is not a supported EDA field.`);
    if (typeof input !== 'string' || input.length > fieldLimit(field) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) throw new Error(`${path}.${key} must be bounded plain text.`);
    const text = input.trim();
    if (text) {
      if (field.input === 'decimal' && !/^\d{1,18}(?:\.\d{1,8})?$/.test(text)) throw new Error(`${path}.${key} must be a nonnegative decimal, using a dot and no grouping separators.`);
      if (field.input === 'integer' && !/^\d{1,9}$/.test(text)) throw new Error(`${path}.${key} must be a nonnegative whole number.`);
      if (field.input === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text)) throw new Error(`${path}.${key} must be a valid YYYY-MM-DD date.`);
      if (field.input === 'code' && !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/.test(text)) throw new Error(`${path}.${key} must contain a literal code without control characters.`);
      if (['origin', 'importerCountry'].includes(key) && !/^[A-Z]{2}$/.test(text)) throw new Error(`${path}.${key} must be an explicit two-letter uppercase country code.`);
      if (key === 'currency' && !/^[A-Z]{3}$/.test(text)) throw new Error(`${path}.${key} must be an explicit three-letter uppercase currency code.`);
      if (key === 'hsCode' && !/^\d{4,10}$/.test(text)) throw new Error(`${path}.${key} must contain 4 to 10 digits; classification still requires review.`);
    }
    result[key] = text;
  }
  // Request-property order is not part of employee approval. Persist one order
  // so an equivalent retry cannot receive a different approval/idempotency hash.
  return Object.fromEntries(fields.filter(field => Object.hasOwn(result, field.key)).map(field => [field.key, result[field.key]]));
}

/** Parse an incomplete draft; never infer codes, round numbers, or turn import data into EDA. */
export function parseEcusExportForm(value: unknown): EcusExportForm {
  if (!ownObject(value) || Object.keys(value).some(key => !['headers', 'goods'].includes(key)) || !Object.hasOwn(value, 'headers') || !Object.hasOwn(value, 'goods')) throw new Error('EDA form must contain only headers and goods.');
  if (!Array.isArray(value.goods) || value.goods.length > 500) throw new Error('EDA goods must be an array of at most 500 rows.');
  return { headers: parseFields(value.headers, EDA_HEADER_FIELDS, 'headers'), goods: value.goods.map((row, index) => parseFields(row, EDA_GOODS_FIELDS, `goods[${index}]`)) };
}

/** Minimum application handoff checks, not an assertion that every EDA requirement is satisfied. */
export function validateEcusExportForm(value: EcusExportForm): EcusExportValidationIssue[] {
  let form: EcusExportForm;
  try { form = parseEcusExportForm(value); } catch (error) { return [{ path: 'form', message: error instanceof Error ? error.message : 'Invalid EDA form.' }]; }
  const issues: EcusExportValidationIssue[] = [];
  const required = (record: Record<string, string>, fields: readonly EdaField[], prefix: string) => {
    for (const field of fields) if (field.required && !record[field.key]) issues.push({ path: `${prefix}.${field.key}`, message: `${field.labelEn} is required for this handoff.` });
  };
  required(form.headers, EDA_HEADER_FIELDS, 'headers');
  if (!form.goods.length) issues.push({ path: 'goods', message: 'At least one goods row is required.' });
  form.goods.forEach((row, index) => {
    required(row, EDA_GOODS_FIELDS, `goods[${index}]`);
    if (row.quantity && !/[1-9]/.test(row.quantity)) issues.push({ path: `goods[${index}].quantity`, message: 'Goods quantity must be greater than zero.' });
    if (row.previousDeclarationLine && !/[1-9]/.test(row.previousDeclarationLine)) issues.push({ path: `goods[${index}].previousDeclarationLine`, message: 'A previous declaration line starts at 1.' });
    if (row.previousDeclarationLine && !form.headers.previousDeclarationNumber) issues.push({ path: 'headers.previousDeclarationNumber', message: 'A previous declaration number is required when a previous goods line is supplied.' });
    if (form.headers.previousDeclarationNumber && !row.previousDeclarationLine) issues.push({ path: `goods[${index}].previousDeclarationLine`, message: 'Identify the previous goods line for this re-export row.' });
  });
  for (const [amount, unit] of [['packageCount', 'packageUnit'], ['grossWeight', 'grossWeightUnit']] as const) {
    if (Boolean(form.headers[amount]) !== Boolean(form.headers[unit])) issues.push({ path: `headers.${form.headers[amount] ? unit : amount}`, message: `${amount} and ${unit} must be supplied together.` });
  }
  return issues;
}

/** Exact read-back comparison after outer-whitespace trimming; absent/blank are equivalent. */
export function compareEcusExportForms(expected: EcusExportForm, actual: EcusExportForm): EcusExportDifference[] {
  const before = parseEcusExportForm(expected); const after = parseEcusExportForm(actual);
  const differences: EcusExportDifference[] = [];
  const compare = (left: Record<string, string>, right: Record<string, string>, fields: readonly EdaField[], prefix: string) => {
    for (const field of fields) {
      const wanted = left[field.key] || ''; const found = right[field.key] || '';
      if (wanted !== found) differences.push({ path: `${prefix}.${field.key}`, expected: wanted, actual: found, message: wanted ? 'ECUS read-back does not match the approved value.' : 'ECUS contains an unexpected nonblank value.' });
    }
  };
  compare(before.headers, after.headers, EDA_HEADER_FIELDS, 'headers');
  if (before.goods.length !== after.goods.length) differences.push({ path: 'goods.length', expected: String(before.goods.length), actual: String(after.goods.length), message: 'ECUS goods row count does not match the approved form.' });
  for (let index = 0; index < Math.max(before.goods.length, after.goods.length); index++) compare(before.goods[index] || {}, after.goods[index] || {}, EDA_GOODS_FIELDS, `goods[${index}]`);
  return differences;
}

export function buildEcusExportPayload(value: EcusExportForm, shipment: ShipmentCase, actor: Actor, revision: number): EcusExportPayload {
  if (shipment.caseType !== 'export' || shipment.mergedInto || shipment.status === 'completed') throw new Error('Only an active, explicitly classified export shipment can create an EDA draft.');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('A valid workspace revision is required.');
  if (!shipment.id || !shipment.reference || !actor.name?.trim()) throw new Error('Shipment and employee identity are required.');
  const form = parseEcusExportForm(value); const issues = validateEcusExportForm(form);
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  Object.freeze(form.headers); form.goods.forEach(Object.freeze); Object.freeze(form.goods); Object.freeze(form);
  return Object.freeze({ schemaVersion: 1, direction: 'export', operation: 'create_draft', caseId: shipment.id, reference: shipment.reference, workspaceRevision: revision, approvedBy: actor.name, approvedAt: new Date().toISOString(), form });
}

/** Reviewed source facts are suggestions for employee EDA review, never an export approval. */
export function suggestedEcusExportForm(shipment: ShipmentCase): EcusExportForm {
  if (shipment.caseType !== 'export') return { headers: {}, goods: [] };
  const headers: Record<string, string> = {};
  const sources: Record<string, string> = {
    exporterCode: 'exporterCode', exporterName: 'exporter', exporterAddress: 'exporterAddress', exporterTelephone: 'exporterTelephone',
    importerName: 'importer', importerAddress: 'importerAddress', importerCountry: 'importerCountry',
    invoiceNumber: 'invoiceNumber', invoiceDate: 'invoiceDate', currency: 'currency', invoiceTotal: 'invoiceTotal',
    contractNumber: 'contractNumber', contractDate: 'contractDate', incoterm: 'incoterm',
    packageCount: 'packageCount', packageUnit: 'packageUnit', grossWeight: 'grossWeight', grossWeightUnit: 'grossWeightUnit',
    transportName: 'vessel', departureDate: 'departureDate', loadingLocationName: 'portOfLoading', unloadingLocationName: 'portOfDischarge',
  };
  for (const [key, sourceKey] of Object.entries(sources)) {
    const source = shipment.fields[sourceKey];
    if (!source || source.stale || source.unverified || !source.reviewedBy || !source.reviewedAt || !source.value.trim()) continue;
    try { Object.assign(headers, parseFields({ [key]: source.value }, EDA_HEADER_FIELDS, 'headers')); } catch { /* Invalid source formatting must be entered deliberately. */ }
  }
  const rows = shipment.goods.filter(row => row.reviewed).map(row => {
    const result: Record<string, string> = {};
    for (const field of EDA_GOODS_FIELDS) {
      const value = (row as unknown as Record<string, unknown>)[field.key];
      if (typeof value !== 'string' || !value.trim()) continue;
      try { Object.assign(result, parseFields({ [field.key]: value }, EDA_GOODS_FIELDS, 'goods')); } catch { /* Unsupported source values stay blank. */ }
    }
    return result;
  });
  return { headers, goods: rows.length ? rows : [{}] };
}
