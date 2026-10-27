import type { Candidate, ShipmentDocument } from './types.ts';
import { verifiedTransportLocation } from './verified-transport-locations.ts';

const locationFields = new Set(['portOfLoading', 'portOfDischarge', 'portOfLoadingCode', 'portOfDischargeCode']);
const nameField = (field: string) => field.replace(/Code$/, '');
const samePage = (left: Candidate, right: Candidate) => left.documentId === right.documentId &&
  left.documentVersion === right.documentVersion && left.page === right.page;

/** A contract allowing any port does not identify an actual shipment location. */
export function isUnspecifiedTransportLocation(value: string): boolean {
  return /^(?:any|all)\s+(?:sea\s*ports?|air\s*ports?|ports?)(?:\s+.*)?$/i.test(value.trim());
}

export function isTransportRouteLabel(value: string): boolean {
  return /^[A-Z]{2}-[A-Z0-9]{3}(?:-[A-Z0-9]+)+$/i.test(value.trim());
}

/** Project grounded transport codes through the small, documented codebook.
 * Raw candidates are never changed. A city is never inferred from a party address. */
export function projectTransportLocations(
  candidates: Candidate[], documents: ShipmentDocument[],
  evidenceClear: (field: string, candidates: Candidate[]) => boolean,
): Candidate[] {
  const eligible = (candidate: Candidate) => {
    const document = documents.find(item => item.id === candidate.documentId && item.caseId === candidate.caseId &&
      item.version === candidate.documentVersion && item.active && !item.referenceOnly);
    const page = document?.pages.find(item => item.page === candidate.page);
    const role = page?.documentType ?? document?.type;
    // A bare three-letter token is only accepted in an air transport role;
    // outside that context it lacks the UN/LOCODE country component.
    if (/^[A-Z]{3}$/i.test(candidate.value.trim()) && role !== 'air_waybill') return false;
    return !candidate.lineId && locationFields.has(candidate.field) && document?.extractionPipeline === 'kimi' &&
      document.aiProcessedPages?.includes(candidate.page) &&
      ['air_waybill', 'bill_of_lading'].includes(role ?? '') &&
      page?.aiReadability === 'clear' && candidate.readability !== 'uncertain' &&
      candidate.confidence !== 'low' && evidenceClear(candidate.field, [candidate]);
  };
  const project = (candidate: Candidate, field: string, value: string, reason: string): Candidate => ({
    ...candidate, field, value,
    normalizations: [...candidate.normalizations, { before: candidate.value, after: value,
      reason: `${reason} Original source quote retained; ECUS code verification remains pending.` }],
  });
  const out = candidates.map(candidate => {
    if (!eligible(candidate)) return candidate;
    const location = verifiedTransportLocation(candidate.value);
    if (!location) return candidate;
    return project(candidate, candidate.field, candidate.field.endsWith('Code') ? location.code : location.name, location.reason);
  });
  for (const candidate of candidates) {
    if (!candidate.field.endsWith('Code') || !eligible(candidate)) continue;
    const location = verifiedTransportLocation(candidate.value);
    if (!location) continue;
    const field = nameField(candidate.field);
    // An independently read name keeps its authority. A known contradictory
    // code/name pair must retain both alternatives so reconciliation asks for
    // review instead of producing an internally inconsistent location.
    const names = candidates.filter(item => !item.lineId && item.field === field && samePage(item, candidate));
    const knownContradiction = names.some(item => {
      const named = verifiedTransportLocation(item.value);
      return named && named.code !== location.code;
    });
    if (!knownContradiction && names.some(item => !isUnspecifiedTransportLocation(item.value))) continue;
    out.push(project(candidate, field, location.name, location.reason));
  }
  return out;
}

/** Drop only generic allowances when a clear actual transport location exists.
 * Specific competing locations stay in reconciliation for employee review. */
export function selectSpecificTransportLocations(
  field: string, candidates: Candidate[], documents: ShipmentDocument[],
  evidenceClear: (field: string, candidates: Candidate[]) => boolean,
): Candidate[] | undefined {
  if (!['portOfLoading', 'portOfDischarge'].includes(field) ||
    !candidates.some(candidate => isUnspecifiedTransportLocation(candidate.value))) return undefined;
  const specific = candidates.filter(candidate => !isUnspecifiedTransportLocation(candidate.value));
  const hasTransportEvidence = specific.some(candidate => {
    const document = documents.find(item => item.id === candidate.documentId && item.caseId === candidate.caseId &&
      item.version === candidate.documentVersion && item.active && !item.referenceOnly);
    const page = document?.pages.find(item => item.page === candidate.page);
    return document?.aiProcessedPages?.includes(candidate.page) &&
      ['air_waybill', 'bill_of_lading'].includes(page?.documentType ?? document.type) &&
      candidate.confidence !== 'low' && candidate.readability !== 'uncertain' &&
      evidenceClear(field, [candidate]);
  });
  return hasTransportEvidence ? specific : undefined;
}
