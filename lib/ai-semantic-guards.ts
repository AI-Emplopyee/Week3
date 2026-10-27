import { ECUS_FORM_FIELDS } from './ecus-form.ts';
import type { AiSourceProposal, DocumentType } from './types.ts';

export type AiSemanticRejection = 'country_tax_identifier' | 'invalid_year_shape' | 'order_reference_not_contract'
  | 'pickup_not_departure' | 'flight_date_not_departure' | 'courier_product_not_transport_mode' | 'transport_party_not_commercial_party'
  | 'shipment_summary_not_goods_row' | 'charge_not_goods_row' | 'combined_charge_not_freight_only';
type SemanticContext = { field: string; documentType: DocumentType; rowProposals: readonly AiSourceProposal[] };
const sourceKey = (field: typeof ECUS_FORM_FIELDS[number]) => field.sourceField ?? field.key;
const yearFields = new Set(ECUS_FORM_FIELDS.filter(field => field.input === 'year').map(sourceKey));
const goodsFields = new Set([...ECUS_FORM_FIELDS.filter(field => field.tab === 'goods' && !field.readOnly).map(sourceKey), 'goodsModel']);
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const taxLabel = /\b(?:vat|tva|btw|eori|tin|tax\s*(?:id|no\.?|number)|ma\s+so\s+thue)\b/;
const contractLabel = /\b(?:contract|agreement|hop dong)(?:\s*(?:no\.?|number|reference|ref\.?|so))?\s*[:#]?/g;
const orderLabel = /\b(?:(?:purchase|sales|your|our|customer)\s+)?order(?:\s*(?:no\.?|number|reference|ref\.?))?\s*[:#]?|\bdon dat hang\b/g;
const departureLabel = /\b(?:(?:departure|departed|departing|etd)(?:\s+(?:for\s+)?flight)?|sailing date|ngay khoi hanh(?:\s+chuyen bay)?)\b/g;
const pickupLabel = /\b(?:pick[ -]?up|collection|collected|ngay nhan hang|ngay lay hang)\b/g;
const importerLabels = /\b(?:importer|buyer|purchaser|invoice to|bill to|sold to|nguoi nhap khau|nguoi mua)\b/g;
const exporterLabels = /\b(?:exporter|seller|vendor|nguoi xuat khau|nguoi ban)\b/g;
const transportPartyLabels = /\b(?:shipper|consignee|from|to|nguoi gui|nguoi nhan)\b/g;

/** Compare the role nearest each occurrence of the selected value, rather than any label elsewhere in the quote. */
function conflictingRole(quote: string, value: string, conflicting: RegExp, supported: RegExp): boolean {
  const q = fold(quote), v = fold(value);
  if (!v) return false;
  const starts = [...q.matchAll(new RegExp(escaped(v), 'g'))].map(match => match.index!);
  if (!starts.length) return false;
  const lastLabel = (prefix: string, pattern: RegExp) => {
    const match = [...prefix.matchAll(new RegExp(pattern.source, 'g'))].at(-1);
    return match ? match.index! + match[0].length : -1;
  };
  return starts.every(start => {
    const prefix = q.slice(Math.max(0, start - 160), start);
    const wrong = lastLabel(prefix, conflicting), right = lastLabel(prefix, supported);
    return wrong >= 0 && wrong > right;
  });
}

function isChargeDescription(value: string): boolean {
  const text = fold(value);
  const chargeNoun = /\b(?:charges?|costs?|fees?|surcharges?)[\s:.-]*$/;
  const service = /\b(?:transport(?:ation)?|freight|shipping|carriage|pack(?:ag)?ing|handling|insurance)\b/;
  if (chargeNoun.test(text) && service.test(text)) return true;
  return /^(?:transport(?:ation)?|freight|shipping|carriage)\s*(?:and|&|\+|\/)\s*pack(?:ag)?ing(?:\s*(?:charges?|costs?|fees?))?[\s:.-]*$/.test(text);
}

function isSummaryDescription(proposal: AiSourceProposal): boolean {
  return /\b(?:description of (?:contents|shipment)|shipment (?:description|contents|summary)|nature and quantity of goods|loai hang)\s*[:=-]?/.test(fold(proposal.quote))
    || /^\s*(?:contents?|noi dung hang hoa)\s*(?:[:=-]|\/\s*(?:commerce|commercial)\s+control\s+statement\b)/.test(fold(proposal.quote));
}

function hasItemEvidence(row: readonly AiSourceProposal[]): boolean {
  // A generic name such as Equipment can be a genuine item. Require a quoted
  // item identifier or explicitly item-scoped quantity, not package totals.
  return row.some(proposal => {
    if (proposal.confidence !== 'high' || proposal.readability !== 'clear') return false;
    const value = fold(proposal.value), quote = fold(proposal.quote);
    if (['goodsCode', 'goodsModel'].includes(proposal.field) && /[0-9]/.test(value) && value.length >= 3) {
      const label = '(?:sku|part(?:\\s*(?:number|no\\.?|code|#))?|(?:item|article|product|material)\\s*(?:number|no\\.?|code|#)|model(?:\\s*(?:number|no\\.?|code|#))?|ma\\s+(?:hang|vat tu))';
      return new RegExp(`\\b${label}\\s*[:#=-]?\\s*${escaped(value)}(?:\\b|$)`).test(quote);
    }
    return proposal.field === 'quantity' && new RegExp(`\\b(?:item|line|article)\\s*(?:no\\.?|number|#)?\\s*\\d+\\b.*\\b(?:qty|quantity)\\s*[:=-]?\\s*${escaped(value)}(?:\\b|$)`).test(quote);
  });
}

/** Reject explicit semantic contradictions only. Never extract, infer or replace a value.
 * Sibling evidence must already have passed quote/page/bounds grounding. These
 * checks apply to incoming proposals, never to employee-approved stored values. */
export function semanticProposalRejections(proposal: AiSourceProposal, context: SemanticContext): AiSemanticRejection[] {
  const { field, documentType, rowProposals } = context;
  const value = fold(proposal.value), quote = fold(proposal.quote);
  const reasons: AiSemanticRejection[] = [];
  if (/(?:country(?:code)?|^origin)$/i.test(field)) {
    const taxValue = taxLabel.test(value);
    const taxNumber = taxLabel.test(quote) && (/^(?:[a-z]{0,3}[\s.-]*)?\d[\d\s.-]{5,}$/.test(value)
      || /^[a-z]{2,3}$/.test(value) && new RegExp(`\\b${escaped(value)}[ .-]*\\d{5,}`).test(quote));
    if (taxValue || taxNumber) reasons.push('country_tax_identifier');
  }
  if (yearFields.has(field) && !/^\d{4}$/.test(proposal.value.trim())) reasons.push('invalid_year_shape');
  if (field === 'contractNumber' && conflictingRole(proposal.quote, proposal.value, orderLabel, contractLabel)) reasons.push('order_reference_not_contract');
  if (/^(?:transport|transit)DepartureDate\d*$/.test(field) && conflictingRole(proposal.quote, proposal.value, pickupLabel, departureLabel)) reasons.push('pickup_not_departure');
  if (/^(?:transport|transit)DepartureDate\d*$/.test(field) && conflictingRole(proposal.quote, proposal.value,
    /\b(?:flight|chuyen bay)\b/g, departureLabel)) reasons.push('flight_date_not_departure');
  if (['transportMethod', 'transportMode'].includes(field)) {
    const literalMode = /^(?:air|air freight|by air|sea|sea freight|ocean|road|rail|inland waterway|multimodal|hang khong|duong bien|duong bo|duong sat)$/;
    if (!literalMode.test(value) && /\b(?:express|worldwide|economy|priority|expedited|courier service)\b/.test(value)) reasons.push('courier_product_not_transport_mode');
  }
  const transportPage = ['air_waybill', 'bill_of_lading'].includes(documentType);
  if (transportPage && ['importer', 'exporter'].includes(field)) {
    const labels = field === 'importer' ? importerLabels : exporterLabels;
    if (!new RegExp(labels.source).test(quote) || conflictingRole(proposal.quote, proposal.value, transportPartyLabels, labels)) reasons.push('transport_party_not_commercial_party');
  }
  if (proposal.rowIndex !== undefined && goodsFields.has(field)) {
    const descriptions = rowProposals.filter(item => item.field === 'description');
    if (descriptions.some(item => isChargeDescription(item.value))) reasons.push('charge_not_goods_row');
    if (transportPage && descriptions.some(isSummaryDescription) && !hasItemEvidence(rowProposals)) reasons.push('shipment_summary_not_goods_row');
  }
  if (field === 'freightAmount' && conflictingRole(proposal.quote, proposal.value,
    /\b(?:transport(?:ation)?|freight|shipping|carriage)\s*(?:and|&|\+|\/)\s*pack(?:ag)?ing\b/g,
    /\b(?:transport(?:ation)?|freight|shipping|carriage)(?:\s*(?:charges?|costs?|fees?))?\b/g)) reasons.push('combined_charge_not_freight_only');
  return reasons;
}
