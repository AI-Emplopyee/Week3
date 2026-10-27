import type { Candidate, ShipmentDocument } from './types.ts';

type Clear = (field: string, candidates: Candidate[]) => boolean;
const partyKey = (value: string) => value.normalize('NFKC').toUpperCase().replace(/[\s.,]+/g, '');
const samePage = (a: Candidate, b: Candidate) => a.caseId === b.caseId && a.documentId === b.documentId && a.documentVersion === b.documentVersion && a.page === b.page;
const sameDocument = (a: Candidate, b: Candidate) => a.caseId === b.caseId && a.documentId === b.documentId && a.documentVersion === b.documentVersion;

function internationalLiteral(value: string): string | undefined {
  const literal = value.trim();
  if (!/^\(?\+84\)?[\d\s().-]+$/.test(literal)) return undefined;
  const compact = literal.replace(/[\s().-]/g, '');
  // Merely bound a phone-shaped literal; this is not numbering-plan validation.
  return /^\+84\d{6,12}$/.test(compact) ? compact : undefined;
}

/** Source corroboration only, never a general +840 numbering-plan repair. Require
 * an independently quoted +84 spelling for the same party on another document.
 * Return projections; source IDs, quotations and saved candidates stay intact. */
export function projectVietnamTelephoneCandidates(candidates: Candidate[], documents: ShipmentDocument[], clear: Clear): Candidate[] {
  const currentDocument = (candidate: Candidate) => documents.find(document =>
    document.id === candidate.documentId && document.caseId === candidate.caseId &&
    document.version === candidate.documentVersion && document.active && !document.referenceOnly &&
    document.extractionPipeline === 'kimi' && document.aiProcessedPages?.includes(candidate.page) &&
    document.pages.some(page => page.page === candidate.page && page.aiReadability === 'clear'));
  // A processed page may contain an unrelated rejected proposal. The caller's
  // per-candidate evidence check decides whether this accepted fact is grounded.
  const eligible = (candidate: Candidate) => !candidate.lineId && candidate.method.startsWith('kimi:') &&
    candidate.confidence === 'high' && candidate.readability === 'clear' && !!currentDocument(candidate) &&
    clear(candidate.field, [candidate]);
  const replacements = new Map<string, Candidate>();
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!['importerTelephone', 'exporterTelephone'].includes(candidate.field) || candidate.lineId || !currentDocument(candidate)) continue;
    const key = JSON.stringify([candidate.caseId, candidate.field]);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || !group.every(eligible)) continue;
    const phones = group.map(candidate => internationalLiteral(candidate.value));
    if (phones.some(phone => !phone) || !phones.some(phone => phone!.startsWith('+840'))) continue;
    // The exact supplied spelling must still occur in the retained source quote.
    if (!group.every(candidate => candidate.originalText.includes(candidate.value.trim()))) continue;
    const partyField = group[0].field === 'importerTelephone' ? 'importer' : 'exporter';
    // A transport recipient can identify the phone's owner without becoming the
    // commercial importer. Retain that role and require independent commercial
    // corroboration below; rejected source proposals never enter this function.
    const identityFields = partyField === 'importer' ? ['importer', 'transportConsignee', 'houseConsignee'] : ['exporter', 'transportShipper', 'houseShipper'];
    const directNames = group.map(phone => candidates.filter(candidate => samePage(phone, candidate) && identityFields.includes(candidate.field)));
    const names = group.map((phone, index) => {
      if (directNames[index].length) return directNames[index]; // Local conflict or unreadability must block, never be bypassed.
      // Repeated pages may omit the party name. An identical literal AND quote
      // on this same original version can refer back to a directly named phone.
      // No cross-document borrowing, normalization guess, or transitive chain.
      return group.flatMap((anchor, anchorIndex) => anchor.page !== phone.page && sameDocument(anchor, phone)
        && anchor.value === phone.value && anchor.originalText === phone.originalText ? directNames[anchorIndex] : []);
    });
    if (names.some(page => !page.length || !page.every(eligible))) continue;
    const nameKeys = new Set(names.flat().map(candidate => partyKey(candidate.value)));
    if (nameKeys.size !== 1 || ![...nameKeys][0]) continue;
    // Same wording never overrides an explicit conflicting party identifier.
    const identifiers = candidates.filter(candidate => candidate.field === `${partyField}Code` && group.some(phone => samePage(phone, candidate)));
    if (!identifiers.every(eligible) || new Set(identifiers.map(candidate => candidate.value.trim().toUpperCase())).size > 1) continue;
    const explicit = group.filter((_, index) => !phones[index]!.startsWith('+840'));
    if (!explicit.some(phone => directNames[group.indexOf(phone)].some(name => name.field === partyField && eligible(name)))) continue;
    const explicitValues = new Set(explicit.map(candidate => internationalLiteral(candidate.value)!));
    if (explicitValues.size !== 1) continue;
    const value = [...explicitValues][0];
    if (!phones.every(phone => phone === value || phone === `+840${value.slice(3)}`)) continue;
    const malformed = group.filter((_, index) => phones[index]!.startsWith('+840'));
    if (!malformed.every(candidate => explicit.some(support => {
      const original = currentDocument(candidate)!, corroborating = currentDocument(support)!;
      return original.id !== corroborating.id && !!original.sha256 && !!corroborating.sha256 && original.sha256 !== corroborating.sha256;
    }))) continue;
    const evidence = explicit.map(candidate => `${candidate.id} (${candidate.documentId}, page ${candidate.page})`).join('; ');
    for (const candidate of group) if (candidate.value !== value) replacements.set(candidate.id, {
      ...candidate, value,
      normalizations: [...candidate.normalizations, {
        before: candidate.value, after: value,
        reason: `telephone-corroboration: Retain the explicit international +84 number corroborated for the same named party by independent current source documents: ${evidence}. Accepted transport party names establish phone ownership only, never a commercial declaration role; duplicate unnamed pages require an identical phone literal and quote in the same original version. Only the extra zero after +84 and display punctuation differ; no domestic prefix, area code or subscriber digits are inferred. Original source quote retained. Rule: docs/verified-form-normalization-sources.json#phoneRule.`,
      }],
    });
  }
  return candidates.map(candidate => replacements.get(candidate.id) ?? candidate);
}
