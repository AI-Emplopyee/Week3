import { comparableWeightTotals, normalizeGrossWeightCandidates } from './weight-normalization.ts';
import {
  declarationEntryKey,
  DECLARATION_LIMITS,
  emptyDeclarationValue,
  getDeclarationEntry,
  isDeclarationSourceCurrent,
} from "./declaration.ts";
import { isIsoDate, parseExactDecimal } from "./integrity.ts";
import { getDeclarationField } from "./declaration-catalog.ts";
import { ECUS_FORM_FIELDS } from "./ecus-form.ts";
import { canonicalExtractionField } from "./extraction.ts";
import { normalizeDeclarationCodeCandidate } from "./country-codes.ts";
import { explicitFormCode } from "./explicit-form-code.ts";
import { SHIPMENT_TEXT_LIMITS } from "./source-text-limits.ts";
import { deriveGuideCandidates, selectGuideCandidates, type GuideRuleDecision } from "./vnaccs-guide-rules.ts";
import type {
  DeclarationFieldEntry,
  DeclarationComponentIssue,
  DeclarationProvenance,
  DeclarationValue,
} from "./declaration-types.ts";
import type {
  Actor,
  Candidate,
  Issue,
  ShipmentCase,
  ShipmentDocument,
  WorkspaceState,
} from "./types.ts";

const numericFields = new Set([
  "invoiceTotal",
  "packageCount",
  "grossWeight",
  "netWeight",
  "containerCount",
  "quantity",
  "unitPrice",
  "amount",
  ...ECUS_FORM_FIELDS.filter((field) => ["decimal", "integer"].includes(field.input))
    .map((field) => field.sourceField ?? field.key),
]);
const dateFields = new Set(["invoiceDate", "packingListDate", "arrivalDate",
  ...ECUS_FORM_FIELDS.filter((field) => field.input === "date")
    .map((field) => field.sourceField ?? field.key),
]);
const integerFields = new Set(["packageCount", "containerCount",
  ...ECUS_FORM_FIELDS.filter((field) => field.input === "integer")
    .map((field) => field.sourceField ?? field.key),
]);
const confidenceOrder = { high: 0, medium: 1, low: 2 };
const partyFields = new Set([
  "importer",
  "exporter",
  "transportShipper",
  "transportConsignee",
  "notifyParty",
  "houseShipper",
  "houseConsignee",
  "houseNotifyParty",
  "masterShipper",
  "masterConsignee",
  "masterNotifyParty",
]);

/** Compare exact decimal strings without ever converting money or weight to a JS float. */
export function normalizedShipmentValue(field: string, value: string): string {
  const trimmed = (partyFields.has(field) ? value.normalize("NFKC") : value)
    .trim()
    .replace(/\s+/g, " ");
  // Layout-only spacing differs between PDF/OCR sources. Keep punctuation and every
  // letter meaningful: this does not expand abbreviations or guess company names.
  if (partyFields.has(field))
    return trimmed.toLocaleLowerCase("en").replace(/\s*([.,])\s*/g, "$1");
  if (["portOfLoading", "portOfDischarge"].includes(field)) return trimmed.toLocaleLowerCase("en").replace(/\s*,\s*/g, ",");
  if (/Address(?:Line\d+)?$/.test(field))
    return trimmed.toLocaleLowerCase("en").replace(/^address\s*:\s*/i, "").replace(/\s*([,])\s*/g, "$1");
  if (numericFields.has(field) && parseExactDecimal(trimmed)) {
    const [whole, fraction = ""] = trimmed.split(".");
    const decimal = fraction.replace(/0+$/, "");
    return `${whole.replace(/^0+(?=\d)/, "")}${decimal ? `.${decimal}` : ""}`;
  }
  const lowered = trimmed.toLocaleLowerCase("en");
  const explicitCode = explicitFormCode(field, trimmed);
  // Preserve historic comparison tokens for equivalent form spellings.
  if (explicitCode?.value === 'KGM') return 'kg';
  if (explicitCode?.value === 'PCE') return 'piece';
  // KGS is also a mass-flow code. Only the separate source-aware gross-weight
  // normalization may resolve a documented physical weight before comparison.
  if (['unit', 'unit2', 'grossWeightUnit'].includes(field) && lowered === 'kgs') return 'kgs';
  if (["unit", "unit2", "grossWeightUnit", "packageUnit"].includes(field)) {
    const equivalentUnits: Record<string, string> = {
      kg: "kg",
      kgs: "kg",
      kilograms: "kg",
      kilogram: "kg",
      package: "package",
      packages: "package",
      pkg: "package",
      pkgs: "package",
      carton: "carton",
      cartons: "carton",
      ctn: "carton",
      ctns: "carton",
      case: "case",
      cases: "case",
      pallet: "pallet",
      pallets: "pallet",
      pc: "piece",
      pcs: "piece",
      piece: "piece",
      pieces: "piece",
    };
    return equivalentUnits[lowered] ?? lowered;
  }
  return lowered;
}

export type ShipmentFact = {
  field: string;
  status: "agreed" | "conflict" | "missing";
  value?: string;
  candidates: Candidate[];
  alternatives: { value: string; candidateIds: string[] }[];
  rule?: GuideRuleDecision;
  excludedCandidates?: Candidate[];
  supportingCandidates?: Candidate[];
};

/** Formatting aliases need independent, explicit party evidence on every page.
 * Preserve the quoted names; only their comparison values share one spelling. */
function harmonizePartyTypography(state: WorkspaceState, candidates: Candidate[]): Candidate[] {
  const replacements = new Map<string, Candidate>();
  for (const field of ["importer", "exporter"]) {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates.filter(candidate => candidate.field === field && !candidate.lineId)) {
      const key = candidate.value.normalize("NFKC").toLocaleLowerCase("en").replace(/&/g, "and").replace(/[\s.,]+/g, "");
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    for (const group of groups.values()) {
      if (new Set(group.map(candidate => normalizedShipmentValue(field, candidate.value))).size < 2 ||
        !group.every(candidate => isShipmentFactClear(state, field, [candidate]))) continue;
      const support = (name: Candidate, suffix: string) => candidates.filter(candidate =>
        !candidate.lineId && candidate.field === `${field}${suffix}` && candidate.documentId === name.documentId && candidate.page === name.page);
      // An explicit conflicting identifier wins over a superficially matching address.
      const codes = group.flatMap(name => support(name, "Code"));
      if (new Set(codes.map(candidate => normalizedShipmentValue(candidate.field, candidate.value))).size > 1 ||
        (codes.length && !codes.every(candidate => isShipmentFactClear(state, candidate.field, [candidate])))) continue;
      const keys = group.map(name => new Set(["Address", "Code"].flatMap(suffix => {
        const sources = support(name, suffix);
        if (!sources.length || !isShipmentFactClear(state, `${field}${suffix}`, sources) ||
          !sources.every(candidate => candidate.confidence !== "low" && candidate.readability !== "uncertain")) return [];
        return [`${suffix}:${normalizedShipmentValue(`${field}${suffix}`, sources[0].value)}`];
      })));
      if (!keys.length || ![...keys[0]].some(key => keys.every(other => other.has(key)))) continue;
      const spelling = [...group].sort((left, right) => left.value.localeCompare(right.value) || left.id.localeCompare(right.id))[0].value;
      for (const candidate of group) if (candidate.value !== spelling) replacements.set(candidate.id, {
        ...candidate, value: spelling,
        normalizations: [...candidate.normalizations, { before: candidate.value, after: spelling,
          reason: "party-typography: Exact name letters agree after spacing, periods and AND/& formatting; clear matching address or identifier corroborates every source page. Original quoted name retained." }],
      });
    }
  }
  return candidates.map(candidate => replacements.get(candidate.id) ?? candidate);
}

function isExplicitWeightFactClear(state: WorkspaceState, field: string, candidates: Candidate[]): boolean {
  return candidates.every(candidate => state.documents.some(document => document.id === candidate.documentId && document.caseId === candidate.caseId &&
    document.active && !document.referenceOnly && document.version === candidate.documentVersion && document.extractionPipeline === 'kimi' && document.aiProcessedPages?.includes(candidate.page))) &&
    isShipmentFactClear(state, field, candidates);
}

function activeCandidates(
  state: WorkspaceState,
  shipment: ShipmentCase,
  normalizeWeights = true,
): Candidate[] {
  const documents = new Map(
    state.documents
      .filter((doc) => doc.active && !doc.referenceOnly && doc.caseId === shipment.id)
      .map((doc) => [doc.id, doc]),
  );
  const source = harmonizePartyTypography(state, state.candidates.filter(
    (candidate) =>
      candidate.caseId === shipment.id &&
      candidate.method.startsWith("kimi:") &&
      candidate.documentVersion ===
        documents.get(candidate.documentId)?.version &&
      !!documents.get(candidate.documentId)?.pages.find((page) => page.page === candidate.page)?.aiReadability &&
      candidate.value.trim(),
  ).map((candidate) => canonicalExtractionField(candidate.field) === candidate.field
    ? candidate : { ...candidate, field: canonicalExtractionField(candidate.field) }).map(normalizeDeclarationCodeCandidate));
  const raw = normalizeWeights ? normalizeGrossWeightCandidates(source, (field, evidence) => isExplicitWeightFactClear(state, field, evidence)) : source;
  return [...raw, ...deriveGuideCandidates(raw, [...documents.values()],
    (field, evidence) => isShipmentFactClear(state, field, evidence))];
}

/** Known source units are mandatory for the net-versus-gross arithmetic check. */
export function getComparableShipmentWeights(state: WorkspaceState, shipment: ShipmentCase, proposed: Record<string, string>) {
  return comparableWeightTotals(activeCandidates(state, shipment, false), proposed, (field, evidence) => isExplicitWeightFactClear(state, field, evidence));
}

function reconcile(field: string, candidates: Candidate[]): ShipmentFact {
  const sorted = [...candidates].sort(
    (a, b) =>
      confidenceOrder[a.confidence] - confidenceOrder[b.confidence] ||
      a.value.localeCompare(b.value) ||
      a.id.localeCompare(b.id),
  );
  if (
    field === "container" &&
    sorted.length &&
    sorted.every((candidate) =>
      /^(?:[A-Z]{4}\d{7})(?:\s*[,;/]\s*[A-Z]{4}\d{7})*$/i.test(
        candidate.value.trim(),
      ),
    )
  ) {
    const value = [
      ...new Set(
        sorted.flatMap((candidate) =>
          candidate.value.toUpperCase().split(/\s*[,;/]\s*/),
        ),
      ),
    ]
      .sort()
      .join(", ");
    return {
      field,
      status: "agreed",
      value,
      candidates: sorted,
      alternatives: [
        { value, candidateIds: sorted.map((candidate) => candidate.id) },
      ],
    };
  }
  const groups = new Map<string, Candidate[]>();
  for (const candidate of sorted) {
    const key = normalizedShipmentValue(field, candidate.value);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const alternatives = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({
      value: group[0].value,
      candidateIds: group.map((candidate) => candidate.id),
    }));
  return {
    field,
    status: groups.size > 1 ? "conflict" : groups.size ? "agreed" : "missing",
    ...(groups.size === 1 ? { value: sorted[0].value } : {}),
    candidates: sorted,
    alternatives,
  };
}

/** All active header evidence, including collisions, is available to the question UI. */
export function buildShipmentFacts(
  state: WorkspaceState,
  shipment: ShipmentCase,
): Record<string, ShipmentFact> {
  const candidates = activeCandidates(state, shipment).filter(
    (candidate) => !candidate.lineId,
  );
  const documents = state.documents.filter((document) => document.active && !document.referenceOnly && document.caseId === shipment.id);
  const fields = new Set(candidates.map((candidate) => candidate.field));
  if (candidates.some((candidate) => ["houseBillOfLading", "masterBillOfLading"].includes(candidate.field))) fields.add("billOfLading");
  return Object.fromEntries(
    [...fields]
      .sort()
      .map((field) => {
        const available = candidates.filter((candidate) => field === "billOfLading"
          ? ["billOfLading", "houseBillOfLading", "masterBillOfLading"].includes(candidate.field)
          : candidate.field === field);
        const selected = selectGuideCandidates(field, available, documents, candidates,
          (dependency, evidence) => isShipmentFactClear(state, dependency, evidence));
        return [field, {
          ...reconcile(field, selected.candidates),
          ...(selected.rule ? {
            rule: selected.rule,
            excludedCandidates: available.filter((candidate) => !selected.candidates.some((chosen) => chosen.id === candidate.id)),
            ...(selected.supportingCandidates?.length ? { supportingCandidates: selected.supportingCandidates } : {}),
          } : {}),
        }];
      }),
  );
}

/** Text citations remain literal; vision citations retain their separate saved image evidence. */
function candidateEvidence(
  candidate: Candidate,
  documents: Map<string, ShipmentDocument>,
): DeclarationProvenance[] {
  const document = documents.get(candidate.documentId);
  const page = document?.pages.find((page) => page.page === candidate.page);
  if (!document || !page || document.version !== candidate.documentVersion)
    return [];
  const modelScore = candidate.confidenceScore !== undefined
    ? { candidateId: candidate.id, confidenceScore: candidate.confidenceScore }
    : {};
  if (candidate.visualEvidence) {
    return [{
      kind: "document",
      documentId: document.id,
      documentVersion: document.version,
      page: page.page,
      quote: candidate.originalText,
      ...modelScore,
      visualEvidence: { candidateId: candidate.id, ...candidate.visualEvidence },
    }];
  }
  const variants = [
    candidate.value,
    ...candidate.normalizations.map((change) => change.before),
  ].filter((value) => value.trim());
  const containsValue = (text: string) =>
    variants.some((value) =>
      text
        .replace(/\s+/g, " ")
        .toLowerCase()
        .includes(value.replace(/\s+/g, " ").toLowerCase()),
    );
  const snippets = page.text.includes(candidate.originalText)
    ? [candidate.originalText]
    : candidate.originalText
        .split(/\r?\n/)
        .filter((line) => line.trim() && page.text.includes(line));
  return snippets
    .filter(containsValue)
    .slice(0, 3)
    .flatMap((snippet) => {
      const quote = snippet;
      if (quote.length > SHIPMENT_TEXT_LIMITS.maxQuoteLength) return [];
      return [
        {
          kind: "document" as const,
          documentId: document.id,
          documentVersion: document.version,
          page: page.page,
          quote,
          ...modelScore,
        },
      ];
    });
}

/** A clear source fact is a draft value, never a fabricated human approval. */
export function isShipmentFactClear(
  state: WorkspaceState,
  field: string,
  candidates: readonly Candidate[],
): boolean {
  if (!candidates.length) return false;
  const fact = reconcile(field, [...candidates]);
  if (fact.status !== "agreed" || !fact.value) return false;
  if (
    (numericFields.has(field) && !parseExactDecimal(fact.value, {
      integer: integerFields.has(field),
    })) ||
    (dateFields.has(field) &&
      !isIsoDate(fact.value))
  ) return false;
  const documents = new Map(state.documents
    .filter((document) => document.active && !document.referenceOnly)
    .map((document) => [document.id, document]));
  const supported = candidates.filter((candidate) => {
    const document = documents.get(candidate.documentId);
    return document?.caseId === candidate.caseId &&
      document.version === candidate.documentVersion &&
      candidate.method.startsWith("kimi:") &&
      candidate.readability !== "uncertain" &&
      document.pages.find(page => page.page === candidate.page)?.aiReadability === "clear" &&
      (candidate.confidence !== "high" || candidate.readability === "clear") &&
      candidateEvidence(candidate, documents).length > 0;
  });
  const clear = (evidence: readonly Candidate[]) => {
    if (evidence.some((candidate) => candidate.confidence === "high")) return true;
    const medium = evidence.filter((candidate) => candidate.confidence === "medium");
    if (new Set(medium.map((candidate) => documents.get(candidate.documentId)!.sha256)).size >= 2) return true;
    // Repeated legible Kimi readings on separate original pages corroborate a
    // header even when both pages belong to one PDF. Copies and repeated reads
    // of the same page image never add another vote. Historical OCR cannot use
    // this path, and explicitly uncertain/invalid values were excluded above.
    const pagesByOriginal = new Map<string, Map<string, number>>();
    for (const candidate of medium) {
      if (!candidate.method.startsWith("kimi:") || !candidate.visualEvidence) continue;
      const document = documents.get(candidate.documentId)!;
      const page = document.pages.find((page) => page.page === candidate.page)!;
      if (candidate.readability !== "clear" && page.aiReadability !== "clear") continue;
      const images = pagesByOriginal.get(document.sha256) ?? new Map<string, number>();
      images.set(candidate.visualEvidence.imageSha256, candidate.page);
      pagesByOriginal.set(document.sha256, images);
    }
    return [...pagesByOriginal.values()].some((images) => images.size >= 2 && new Set(images.values()).size >= 2);
  };
  if (field === "container") {
    // A clear container must not silently validate a different, uncertain one.
    const tokens = fact.value.toUpperCase().match(/[A-Z]{4}\d{7}/g);
    if (tokens?.length) return tokens.every((token) => clear(supported.filter(
      (candidate) => candidate.value.toUpperCase().match(/[A-Z]{4}\d{7}/g)?.includes(token),
    )));
  }
  return clear(supported);
}

type Part = {
  value: string;
  fact: ShipmentFact;
  provenance: DeclarationProvenance[];
  unknown?: boolean;
  reviewed?: boolean;
  ecusFieldKey?: string;
  component?: string;
  rowIndex?: number;
  formCodeReason?: string;
};
type Proposal = {
  fieldId: string;
  goodsLineId?: string;
  value: DeclarationValue;
  parts: Part[];
};
const missingFact = (field: string): ShipmentFact => ({
  field,
  status: "missing",
  candidates: [],
  alternatives: [],
});

function uniqueEvidence(
  evidence: DeclarationProvenance[],
): DeclarationProvenance[] {
  return [
    ...new Map(
      evidence.map((source) => [JSON.stringify(source), source]),
    ).values(),
  ].slice(0, DECLARATION_LIMITS.maxProvenance);
}

function valuePresent(value: DeclarationValue): boolean {
  return "rows" in value
    ? value.rows.some((row) =>
        Object.entries(row).some(
          ([key, content]) => key !== "id" && content.trim(),
        ),
      )
    : Object.entries(value).some(
        ([key, content]) => key !== "kind" && String(content).trim(),
      );
}

function semanticFingerprint(proposal: Proposal): string {
  // This is a comparison token, not a security hash. New copies of the same value
  // do not invalidate a human decision simply because their document IDs differ.
  return JSON.stringify(
    proposal.parts.map((part) => [
      part.fact.field,
      part.fact.alternatives
        .map((item) => normalizedShipmentValue(part.fact.field, item.value))
        .sort(),
      normalizedShipmentValue(part.fact.field, part.value),
      !!part.unknown,
      ...(part.fact.supportingCandidates?.length ? [
        [...new Set(part.fact.supportingCandidates.map((candidate) => JSON.stringify([
          candidate.field, normalizedShipmentValue(candidate.field, candidate.value),
        ])))].sort(),
      ] : []),
    ]),
  );
}

/** Link only explicit, unambiguous row identities. Page roles separate an invoice
 * from a quality certificate inside the same PDF; repeated rows within a role
 * remain distinct. Nothing here parses descriptions into product identifiers. */
function goodsRowLinks(state: WorkspaceState, shipment: ShipmentCase, candidates: Candidate[], lineId: string): Map<string, Candidate[]> {
  const rows = new Map<string, Candidate[]>();
  for (const candidate of candidates) if (candidate.lineId) rows.set(candidate.lineId, [...(rows.get(candidate.lineId) ?? []), candidate]);
  const own = rows.get(lineId) ?? [];
  const role = (candidate: Candidate) => {
    const document = state.documents.find(document => document.id === candidate.documentId);
    return `${candidate.documentId}:${document?.pages.find(page => page.page === candidate.page)?.documentType ?? document?.type}`;
  };
  const values = (row: Candidate[], field: string) => new Set(row.filter(candidate => candidate.field === field).map(candidate => normalizedShipmentValue(field, candidate.value)));
  const compatible = (row: Candidate[]) => ['goodsCode', 'goodsModel'].every(field => {
    const left = values(own, field), right = values(row, field);
    return left.size <= 1 && right.size <= 1 && (!left.size || !right.size || [...left][0] === [...right][0]);
  });
  const links = new Map<string, Candidate[]>([[lineId, []]]);
  const description = normalizedShipmentValue('description', shipment.goods.find(line => line.id === lineId)?.description ?? '');
  const descriptions = candidates.filter(candidate => candidate.lineId && candidate.field === 'description' && normalizedShipmentValue('description', candidate.value) === description);
  if (description && shipment.goods.filter(line => normalizedShipmentValue('description', line.description) === description).length === 1) {
    for (const candidate of descriptions) if (compatible(rows.get(candidate.lineId!) ?? []) && new Set(descriptions.filter(other => role(other) === role(candidate)).map(other => other.lineId)).size === 1) links.set(candidate.lineId!, []);
  }
  const clearIdentity = (row: Candidate[], field: string) => {
    const facts = row.filter(candidate => candidate.field === field);
    return facts.length > 0 && facts.every(candidate => candidate.confidence !== 'low' && candidate.readability !== 'uncertain' && state.documents.find(document => document.id === candidate.documentId)?.aiProcessedPages?.includes(candidate.page)) && isShipmentFactClear(state, field, facts);
  };
  const uniqueIdentity = (row: Candidate[], field: string, value: string) => {
    const matching = candidates.filter(candidate => candidate.lineId && candidate.field === field && normalizedShipmentValue(field, candidate.value) === value);
    return new Set(matching.filter(candidate => role(candidate) === role(row[0])).map(candidate => candidate.lineId)).size === 1 &&
      new Set(matching.filter(candidate => shipment.goods.some(line => line.id === candidate.lineId)).map(candidate => candidate.lineId)).size <= 1;
  };
  if (own.length) for (const field of ['goodsCode', 'goodsModel']) {
    if (!clearIdentity(own, field)) continue;
    const value = [...values(own, field)][0];
    if (!uniqueIdentity(own, field, value)) continue;
    for (const [otherId, row] of rows) {
      if (otherId === lineId || role(row[0]) === role(own[0]) || !values(row, field).has(value) || !compatible(row) || !clearIdentity(row, field) || !uniqueIdentity(row, field, value)) continue;
      links.set(otherId, [...own, ...row].filter(candidate => candidate.field === field));
    }
  }
  return links;
}

function proposalsFor(
  state: WorkspaceState,
  shipment: ShipmentCase,
): Proposal[] {
  const documents = new Map(
    state.documents
      .filter((doc) => doc.active && doc.caseId === shipment.id)
      .map((doc) => [doc.id, doc]),
  );
  const candidates = activeCandidates(state, shipment);
  const header = buildShipmentFacts(state, shipment);
  const proposals: Proposal[] = [];
  const part = (
    field: string,
    available?: Candidate[],
    allowReviewed = true,
  ): Part => {
    const fact = available
      ? reconcile(
          field,
          available.filter((candidate) => candidate.field === field),
        )
      : (header[field] ?? missingFact(field));
    const reviewed = allowReviewed
      ? shipment.fields[field] ?? (field === "declarationType" ? shipment.fields.customsProcedure : undefined)
      : undefined;
    if (reviewed && !reviewed.stale && reviewed.value.trim()) {
      const chosen = fact.candidates.find(
        (candidate) =>
          candidate.id === reviewed.candidateId &&
          normalizedShipmentValue(field, candidate.value) ===
            normalizedShipmentValue(field, reviewed.value),
      );
      const provenance = chosen ? candidateEvidence(chosen, documents) : [];
      if (reviewed.source === "manual" || provenance.length)
        return {
          value: reviewed.value,
          reviewed: true,
          fact: { ...fact, status: "agreed" },
          provenance: provenance.length
            ? provenance
            : [
                {
                  kind: "manual",
                  note: `${field}: ${reviewed.reason || "Value entered by the responsible reviewer."}`.slice(
                    0,
                    4000,
                  ),
                },
              ],
        };
    }
    const provenance = uniqueEvidence(
      [...fact.candidates, ...(fact.supportingCandidates ?? [])].flatMap((candidate) =>
        candidateEvidence(candidate, documents),
      ),
    );
    return {
      value: fact.status === "agreed" && provenance.length ? fact.value! : "",
      fact,
      provenance,
      unknown: fact.status === "agreed" && !provenance.length,
    };
  };
  const checked = (source: Part, valid: (value: string) => boolean): Part =>
    source.value && !valid(source.value)
      ? { ...source, value: "", unknown: true }
      : source;
  const decimal = (source: Part, integer = false) =>
    checked(source, (value) => !!parseExactDecimal(value, { integer }));
  const formCode = (source: Part): Part => {
    if (!source.value || source.reviewed || source.unknown || source.fact.status !== 'agreed' ||
      !isShipmentFactClear(state, source.fact.field, source.fact.candidates)) return source;
    const code = explicitFormCode(source.fact.field, source.value);
    return code && code.value !== source.value
      ? { ...source, value: code.value, formCodeReason: code.reason }
      : source;
  };
  const add = (
    fieldId: string,
    components: Record<string, Part>,
    goodsLineId?: string,
  ) => {
    const bounded = Object.fromEntries(
      Object.entries(components).map(([key, source]) => [
        key,
        checked(
          formCode(source),
          (value) =>
            value.length <=
            (key === "text"
              ? DECLARATION_LIMITS.maxTextLength
              : DECLARATION_LIMITS.maxComponentLength),
        ),
      ]),
    );
    const value = emptyDeclarationValue(fieldId);
    Object.assign(
      value,
      Object.fromEntries(
        Object.entries(bounded).map(([key, source]) => [key, source.value]),
      ),
    );
    proposals.push({
      fieldId,
      ...(goodsLineId ? { goodsLineId } : {}),
      value,
      parts: Object.entries(bounded).map(([component, source]) => ({ ...source, component })),
    });
  };

  const transportField = [
    "billOfLading",
    "houseBillOfLading",
    "masterBillOfLading",
  ].find(
    (field) =>
      header[field]?.candidates.length || shipment.fields[field]?.value,
  );
  if (transportField) {
    const source = part(transportField);
    proposals.push({
      fieldId: "1.26",
      value: {
        kind: "reference_rows",
        rows: source.value
          ? [{ id: `source-${transportField}`, reference: source.value }]
          : [],
      },
      parts: [{ ...source, component: 'reference', rowIndex: 0 }],
    });
  }

  const sourceUnit = (
    source: Part,
    explicitKey: string,
    expression: RegExp,
  ): Part => {
    const explicit = part(explicitKey);
    if (explicit.fact.status !== "missing") return explicit;
    const units = source.fact.candidates.flatMap((candidate) => {
      const found = [...candidate.originalText.matchAll(expression)].map(
        (match) => match[1].toUpperCase(),
      );
      return [...new Set(found)].map((value) => ({
        ...candidate,
        field: explicitKey,
        value,
      }));
    });
    return part(explicitKey, units, false);
  };
  const packages = decimal(part("packageCount"), true);
  add("1.27", {
    amount: packages,
    unitCode: sourceUnit(
      packages,
      "packageUnit",
      /\b(PACKAGES?|PKGS?|CARTONS?|CTNS?|CASES?|PALLETS?)\b/gi,
    ),
  });
  const weight = decimal(part("grossWeight"));
  add("1.28", {
    amount: weight,
    unitCode: sourceUnit(
      weight,
      "grossWeightUnit",
      /\b(KGS?|KGM|TONNES?|TONS?|LBS?)\b/gi,
    ),
  });

  // The screenshot-backed form is the source of truth for additional controls.
  // Merge components into legacy entries so existing saved values and citations
  // remain usable, including the individually indexed optional header tables.
  const addEcusFields = (
    scope: "header" | "goods",
    sourcePart: (field: string) => Part,
    goodsLineId?: string,
  ) => {
    for (const field of ECUS_FORM_FIELDS) {
      if (field.readOnly || (field.tab === "goods") !== (scope === "goods")) continue;
      const sourceKey = field.sourceField ?? field.key;
      let source = formCode(sourcePart(sourceKey));
      if (field.input === "date") source = checked(source, isIsoDate);
      if (field.input === "year") source = checked(source, (value) => /^\d{4}$/.test(value));
      if (["decimal", "integer"].includes(field.input))
        source = decimal(source, field.input === "integer");
      if (sourceKey === "hsCode") source = checked(source, (value) => /^\d{4,10}$/.test(value));
      if (sourceKey === "origin") source = checked(source, (value) => /^[A-Z]{2}$/i.test(value));
      if (["currency", "incoterm"].includes(sourceKey))
        source = checked(source, (value) => /^[A-Z]{3}$/i.test(value));
      source = checked(source, (value) => value.length <=
        (field.component === "text" ? DECLARATION_LIMITS.maxTextLength : DECLARATION_LIMITS.maxComponentLength));
      source = { ...source, ecusFieldKey: field.key, component: field.component, ...(field.rowIndex === undefined ? {} : { rowIndex: field.rowIndex }) };
      let proposal = proposals.find((item) => item.fieldId === field.fieldId && item.goodsLineId === goodsLineId);
      if (!proposal) {
        proposal = {
          fieldId: field.fieldId,
          ...(goodsLineId ? { goodsLineId } : {}),
          value: emptyDeclarationValue(field.fieldId),
          parts: [],
        };
        proposals.push(proposal);
      }
      proposal.parts.push(source);
      // An absent canonical field must not erase the literal house-B/L fallback,
      // a unit attached to a source value, or another populated legacy component.
      if (source.fact.status === "missing" && !source.value) continue;
      if ("rows" in proposal.value) {
        const rowIndex = field.rowIndex ?? 0;
        const catalog = getDeclarationField(field.fieldId)!;
        const rows = proposal.value.rows as Record<string, string>[];
        // Keep literal row positions, including holes before a supplied row.
        // Reuse legacy row IDs so an existing reference remains stable.
        while (rows.length <= rowIndex) rows.push({
          id: `ecus-${field.fieldId}-${rows.length + 1}`,
          ...Object.fromEntries(catalog.components.map((component) => [component.key, ""])),
        });
        rows[rowIndex][field.component] = source.value;
      } else {
        (proposal.value as unknown as Record<string, string>)[field.component] = source.value;
      }
    }
  };
  addEcusFields("header", part);

  for (const line of shipment.goods) {
    const own = candidates.filter((candidate) => candidate.lineId === line.id);
    const links = goodsRowLinks(state, shipment, candidates, line.id);
    const joined = candidates.filter(candidate => candidate.lineId && links.has(candidate.lineId));
    const itemPart = (field: string) => {
      // Manual goods decisions remain authoritative. Propagate their exact value
      // as a draft with an explicit manual basis, never as invented PDF evidence.
      if (
        line.manual &&
        [
          "description",
          "quantity",
          "unit",
          "unitPrice",
          "amount",
          "hsCode",
          "origin",
          "dutyRate",
          "vatRate",
        ].includes(field)
      ) {
        const value = String(line[field as keyof typeof line] ?? "");
        return {
          value,
          reviewed: true,
          fact: reconcile(
            field,
            joined.filter((candidate) => candidate.field === field),
          ),
          provenance: [
            {
              kind: "manual" as const,
              note: `${field}: ${line.reason || "Goods value entered by the responsible reviewer."}`.slice(
                0,
                4000,
              ),
            },
          ],
        };
      }
      const baselineUnit = own.find(
        (candidate) => candidate.field === "unit",
      )?.value;
      const comparable =
        ["quantity", "unit", "unitPrice", "amount"].includes(field) &&
        baselineUnit
          ? joined.filter((candidate) => {
              const unit = joined.find(
                (item) =>
                  item.lineId === candidate.lineId && item.field === "unit",
              )?.value;
              return (
                !unit ||
                normalizedShipmentValue("unit", unit) ===
                  normalizedShipmentValue("unit", baselineUnit)
              );
            })
          : joined;
      // Invoice amounts and their quantity/unit belong to the commercial invoice,
      // not a certificate's FOB/packing measurements. Keep same-authority conflicts.
      const invoice = comparable.filter(candidate => candidate.field === field &&
        documents.get(candidate.documentId)?.pages.find(page => page.page === candidate.page)?.documentType === 'invoice');
      const invoicePreferred = ['description', 'quantity', 'unit', 'unitPrice', 'amount'].includes(field) && invoice.length &&
        invoice.every(candidate => candidate.confidence !== 'low' && candidate.readability !== 'uncertain' &&
          documents.get(candidate.documentId)?.pages.find(page => page.page === candidate.page)?.aiReadability === 'clear') &&
        [...new Set(invoice.map(candidate => normalizedShipmentValue(field, candidate.value)))].every(value =>
          isShipmentFactClear(state, field, invoice.filter(candidate => normalizedShipmentValue(field, candidate.value) === value)));
      const source = part(field, invoicePreferred ? invoice : comparable, false);
      if (invoicePreferred && field !== 'description') source.fact = { ...source.fact,
        rule: { id: 'vnaccs-guide:1.86', section: '1.86', reasonVi: 'Dùng số liệu dòng hàng trên hóa đơn thương mại.', reasonEn: 'Use the commercial invoice for its quantity, unit and invoice prices.' },
        excludedCandidates: comparable.filter(candidate => candidate.field === field && !invoice.includes(candidate)),
      };
      const identity = source.fact.candidates.flatMap(candidate => links.get(candidate.lineId ?? '') ?? []);
      if (identity.length) source.provenance = uniqueEvidence([...source.provenance, ...identity.flatMap(candidate =>
        candidateEvidence(candidate, documents).map(proof => proof.kind === 'document' ? { ...proof, candidateId: candidate.id } : proof))]);
      return source;
    };
    add(
      "1.86",
      {
        amount: decimal(itemPart("unitPrice")),
        currencyCode: checked(part("currency"), (value) =>
          /^[A-Z]{3}$/i.test(value),
        ),
        unitCode: itemPart("unit"),
      },
      line.id,
    );
    addEcusFields("goods", itemPart, line.id);
  }
  return proposals;
}

/** Supplied optional facts still need a question when evidence cannot settle them.
 * Unlike a fabricated empty draft, these questions retain the original choices. */
export function getEcusEvidenceIssues(
  state: WorkspaceState,
  shipment: ShipmentCase,
  handled: { header?: ReadonlySet<string>; goods?: ReadonlySet<string> } = {},
): Issue[] {
  if (shipment.caseType !== "import" || shipment.mergedInto || !shipment.groupingConfirmed) return [];
  const issues: Issue[] = [];
  for (const proposal of proposalsFor(state, shipment)) {
    const saved = getDeclarationEntry(shipment.declarationDraft, proposal.fieldId, proposal.goodsLineId);
    // Human decisions stay local even when stale. An unreviewed generated value
    // must still expose a new source conflict instead of hiding it behind staleness.
    if (saved && (saved.generatedBy !== "shipment_extraction" || saved.review)) continue;
    for (const source of proposal.parts) {
      const field = ECUS_FORM_FIELDS.find((item) => item.key === source.ecusFieldKey);
      if (!field || !source.fact.candidates.length ||
        (proposal.goodsLineId ? handled.goods : handled.header)?.has(source.fact.field) ||
        (source.reviewed && !source.unknown)) continue;
      const problem = source.fact.status === "conflict" ? "conflict"
        : source.unknown ? "invalid"
        : !isShipmentFactClear(state, source.fact.field, source.fact.candidates) ? "uncertain" : undefined;
      if (!problem) continue;
      const row = proposal.goodsLineId ? shipment.goods.findIndex((line) => line.id === proposal.goodsLineId) + 1 : undefined;
      const label = `${field.labelVi}${row ? ` — dòng hàng ${row}` : ""}`;
      issues.push({
        id: `${shipment.id}:ecus-evidence:${JSON.stringify([field.key, proposal.goodsLineId ?? null])}:${problem}`,
        caseId: shipment.id, kind: "declaration", severity: "error",
        title: `Vui lòng làm rõ ${label}`,
        description: problem === "conflict"
          ? `Các nguồn ghi ${label} khác nhau. Vui lòng đối chiếu và nhập giá trị đúng trên biểu mẫu.`
          : problem === "invalid"
            ? `${label} đã được cung cấp nhưng định dạng hoặc bằng chứng chưa rõ. Vui lòng xác nhận giá trị; không tự đoán dữ liệu.`
            : `${label} có nội dung chưa đọc rõ hoặc chưa chắc chắn. Vui lòng kiểm tra nguồn và xác nhận trên biểu mẫu.`,
        field: proposal.fieldId, ecusFieldKey: field.key,
        ...(proposal.goodsLineId ? { goodsLineId: proposal.goodsLineId } : {}),
        candidateIds: source.fact.candidates.map((candidate) => candidate.id),
        documentIds: [...new Set(source.fact.candidates.map((candidate) => candidate.documentId))],
        resolved: false,
        fingerprint: JSON.stringify([field.key, proposal.goodsLineId, problem, source.fact.candidates.map((candidate) => [candidate.id, candidate.documentVersion, candidate.value, candidate.confidence])]),
      });
    }
  }
  return issues;
}

function sourceRevoked(
  entry: DeclarationFieldEntry,
  state: WorkspaceState,
  shipment: ShipmentCase,
): boolean {
  return (
    (!!entry.goodsLineId &&
      !shipment.goods.some((line) => line.id === entry.goodsLineId)) ||
    (!!entry.goodsLineId && entry.provenance.some(source => {
      if (source.kind !== 'document') return false;
      const identity = state.candidates.find(candidate => candidate.id === (source.candidateId ?? source.visualEvidence?.candidateId));
      if (!identity?.lineId || !['goodsCode', 'goodsModel'].includes(identity.field) || identity.lineId === entry.goodsLineId) return false;
      return !goodsRowLinks(state, shipment, activeCandidates(state, shipment), entry.goodsLineId!).has(identity.lineId);
    })) ||
    entry.provenance.some((source) => {
      if (source.kind !== "document") return false;
      return !isDeclarationSourceCurrent(source, {
        caseId: shipment.id,
        documents: state.documents,
        goods: shipment.goods,
        candidates: state.candidates,
      });
    })
  );
}

function contradictsSaved(
  proposal: Proposal,
  entry: DeclarationFieldEntry,
): boolean {
  if (
    proposal.parts.some(
      (part) => part.fact.status === "conflict" || part.unknown,
    )
  )
    return true;
  if (proposal.value.kind !== entry.value.kind) return true;
  if ("rows" in proposal.value) {
    if (!("rows" in entry.value)) return true;
    const savedRows = entry.value.rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "id"),
          ),
        ),
      )
      .sort();
    const proposedRows = proposal.value.rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "id"),
          ),
        ),
      )
      .sort();
    return (
      proposedRows.length > 0 &&
      JSON.stringify(savedRows) !== JSON.stringify(proposedRows)
    );
  }
  return Object.entries(proposal.value).some(([key, value]) => {
    if (key === 'kind' || !value) return false;
    // Representation-only unit changes must not revoke a human's literal PCS
    // or KG decision. Compare using the source field, never generic unitCode
    // (which would also conflate package codes).
    const sourceField = proposal.parts.find(part => part.component === key)?.fact.field;
    const comparisonField = sourceField ?? (["amount", "count"].includes(key) ? "amount" : key);
    return normalizedShipmentValue(comparisonField, value) !== normalizedShipmentValue(comparisonField,
      String((entry.value as unknown as Record<string, string>)[key] ?? ''));
  });
}

/** Retire obsolete source selections without creating a new human approval.
 * Manual corrections and materially different current-reader choices remain
 * decisions for their reviewer; original selections stay in the audit trail. */
const legacyMachineSourceMethods = new Set([
  "browser_local_ocr", "pdf_text", "deterministic_bilingual_label", "contextual_bilingual_label",
  "adjacent_label_value", "adjacent_transport_identifiers", "contextual_packing_date",
  "certificate_party_block", "transport_package_statement", "transport_container_identifiers",
  "commercial_letterhead_proposal", "packing_numeric_totals_proposal", "invoice_currency_header",
  "invoice_total_statement", "invoice_numeric_tail_proposal", "office_explicit_cell_label",
  "layout_table_header", "layout_packing_totals", "layout_invoice_total", "deterministic_delimited_table",
  "delimited_table_wrapped_description",
]);
function retireSupersededHeaderSelections(
  state: WorkspaceState,
  shipment: ShipmentCase,
  actor: Actor,
): void {
  const pending = Object.entries(shipment.fields).filter(([, reviewed]) => reviewed.stale && reviewed.source === "candidate");
  if (!pending.length) return;
  const facts = buildShipmentFacts(state, shipment);
  const historical = state.audit.filter(entry => entry.caseId === shipment.id).flatMap(entry =>
    [entry.before, entry.after].flatMap(value => Array.isArray(value) ? value : []),
  );
  for (const [field, reviewed] of pending) {
    const fact = facts[field];
    if (reviewed.unverified || !fact?.value || fact.status !== "agreed" ||
      !isShipmentFactClear(state, field, fact.candidates) ||
      fact.candidates.some(candidate => !state.documents.find(document => document.id === candidate.documentId)?.aiProcessedPages?.includes(candidate.page))) continue;
    const oldSource = [...state.candidates, ...historical].find((value: unknown): value is Candidate => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Partial<Candidate>;
      return !!reviewed.candidateId && candidate.id === reviewed.candidateId && candidate.caseId === shipment.id &&
        candidate.field === field && !candidate.lineId && typeof candidate.method === "string" && typeof candidate.value === "string" &&
        normalizedShipmentValue(field, candidate.value) === normalizedShipmentValue(field, reviewed.value);
    });
    if (oldSource && /^manual(?:[\s_:]|$)/i.test(oldSource.method)) continue;
    const legacy = !!oldSource && oldSource.method.split(/\s*\+\s*/).every(method => legacyMachineSourceMethods.has(method));
    const previousValue = normalizedShipmentValue(field, reviewed.value);
    const equivalent = previousValue === normalizedShipmentValue(field, fact.value) || fact.candidates.some(candidate =>
      candidate.normalizations.some(change =>
        (change.reason.startsWith("party-typography:") ||
          change.reason.startsWith("user-policy:corroborated-exporter: Equivalent explicit party typography")) &&
        normalizedShipmentValue(field, change.before) === previousValue &&
        normalizedShipmentValue(field, change.after) === normalizedShipmentValue(field, fact.value!)),
    );
    if (!legacy && !equivalent) continue;
    delete shipment.fields[field];
    state.audit.push({
      id: `audit-${crypto.randomUUID()}`,
      caseId: shipment.id,
      field,
      at: new Date().toISOString(),
      actor: actor.name,
      action: "source_selection_superseded",
      reason: legacy
        ? "A stale legacy machine-source selection was superseded by clear, agreed current AI evidence. The original decision is retained here; no new human review was created."
        : "A stale source selection is semantically equivalent to clear, agreed current evidence. The original decision is retained here; no new human review was created.",
      before: structuredClone(reviewed),
      after: {
        value: fact.value,
        sourceCandidateIds: [...new Set([...fact.candidates, ...(fact.supportingCandidates ?? [])].map(candidate => candidate.id))],
        selection: "automatic_evidence",
        ...(fact.rule ? { policyId: fact.rule.id } : {}),
      },
    });
  }
}

/** Run once after a whole shipment has been grouped and its evidence rebuilt. */
export function syncShipmentDeclaration(
  state: WorkspaceState,
  shipment: ShipmentCase,
  actor: Actor,
): void {
  if (
    shipment.caseType !== "import" ||
    shipment.mergedInto ||
    shipment.status === "completed" ||
    shipment.status === "approved" ||
    !!shipment.approval ||
    !shipment.groupingConfirmed
  )
    return;
  retireSupersededHeaderSelections(state, shipment, actor);
  shipment.declarationDraft ??= { schemaVersion: 1, fields: [] };
  const draft = shipment.declarationDraft;
  const before = structuredClone(draft);
  const proposals = proposalsFor(state, shipment);
  const at = new Date().toISOString();
  const handled = new Set<string>();
  for (const proposal of proposals) {
    const key = declarationEntryKey(proposal.fieldId, proposal.goodsLineId);
    handled.add(key);
    const index = draft.fields.findIndex(
      (entry) => declarationEntryKey(entry.fieldId, entry.goodsLineId) === key,
    );
    const prior = index >= 0 ? draft.fields[index] : undefined;
    const fingerprint = semanticFingerprint(proposal);
    const evidence = uniqueEvidence(
      proposal.parts.flatMap((part) => part.provenance),
    );
    const collision = proposal.parts.some(
      (part) => part.fact.status === "conflict" || part.unknown,
    );
    const componentIssues: DeclarationComponentIssue[] = [...new Map(proposal.parts.flatMap(part => {
      if (!part.component || !(part.fact.status === 'conflict' || part.unknown)) return [];
      const problem: DeclarationComponentIssue = { component: part.component, ...(part.rowIndex === undefined ? {} : { rowIndex: part.rowIndex }), reason: part.fact.status === 'conflict' ? 'conflict' : 'invalid' };
      return [[JSON.stringify([problem.component, problem.rowIndex, problem.reason]), problem] as const];
    })).values()];
    const wholeEntryStale = collision && proposal.parts.some(part => (part.fact.status === 'conflict' || part.unknown) && !part.component);
    const missing = !valuePresent(proposal.value);
    const guideReasons = [...new Set(proposal.parts.flatMap((part) => [
      ...(part.formCodeReason ? [part.formCodeReason] : []),
      ...(part.fact.rule ? [`${part.fact.rule.origin === "user_policy" ? "Source reconciliation policy" : `Supplied VNACCS guide ${part.fact.rule.section}`}: ${part.fact.rule.reasonEn}`] : []),
      ...part.fact.candidates.flatMap((candidate) => candidate.normalizations
        .filter((change) => change.reason.startsWith("vnaccs-guide:") || change.reason.startsWith("user-policy:") || change.reason.startsWith("party-typography:") || change.reason.startsWith("weight-unit:"))
        .map((change) => change.reason)),
    ]))];
    if (
      prior &&
      (prior.generatedBy !== "shipment_extraction" || prior.review)
    ) {
      const changed =
        prior.sourceFingerprint !== undefined &&
        prior.sourceFingerprint !== fingerprint;
      if (
        sourceRevoked(prior, state, shipment) ||
        (changed && contradictsSaved(proposal, prior))
      ) {
        prior.stale = true;
        prior.staleReason =
          "Supporting shipment evidence changed; retain and review the saved decision.";
      }
      prior.sourceFingerprint = fingerprint;
      continue;
    }
    if (missing) {
      if (prior && proposal.parts.every((part) => part.fact.status === "missing")) {
        // A new reading can retract an old automatic extraction. Keep that
        // obsolete value in audit history, not in a required form cell.
        draft.fields.splice(index, 1);
      } else if (prior) {
        prior.stale = true;
        prior.staleReason = collision
          ? "Shipment sources disagree; no value was selected automatically."
          : "Active shipment sources no longer support this extracted value.";
        prior.sourceFingerprint = fingerprint;
      }
      continue;
    }
    const next: DeclarationFieldEntry = {
      fieldId: proposal.fieldId,
      ...(proposal.goodsLineId ? { goodsLineId: proposal.goodsLineId } : {}),
      applicability: "applicable",
      basis:
        ["Captured from the combined shipment evidence. This is a draft, not legal or ECUS code validation.", ...guideReasons].join(" ").slice(0, 4000),
      value: proposal.value,
      provenance: evidence,
      reason:
        ["Shipment documents reconciled before declaration autofill; repeated facts were compared, not added.", ...guideReasons].join(" ").slice(0, 4000),
      review: null,
      // This is a fresh projection of current evidence. An unresolved component
      // blocks approval through validation without invalidating its clear siblings.
      // Keep the old whole-entry guard if an unmapped legacy part cannot be located.
      stale: wholeEntryStale,
      ...(componentIssues.length ? { componentIssues } : {}),
      ...(wholeEntryStale
        ? {
            staleReason:
              "Shipment sources disagree or a value cannot be safely read; affected components remain empty.",
          }
        : {}),
      updatedBy: actor.id,
      updatedAt: at,
      codeVerification: "unverified",
      generatedBy: "shipment_extraction",
      sourceFingerprint: fingerprint,
      sourceCandidateIds: [
        ...new Set(
          proposal.parts.flatMap((part) =>
            [...part.fact.candidates, ...(part.fact.supportingCandidates ?? [])].map((candidate) => candidate.id),
          ),
        ),
      ].sort(),
    };
    // Preserve timestamps and avoid audit churn when rebuilding identical evidence.
    if (
      prior &&
      JSON.stringify({ ...prior, updatedAt: "", updatedBy: "" }) ===
        JSON.stringify({ ...next, updatedAt: "", updatedBy: "" })
    )
      continue;
    if (index >= 0) draft.fields[index] = next;
    else if (draft.fields.length < DECLARATION_LIMITS.maxEntries)
      draft.fields.push(next);
  }
  for (const entry of draft.fields)
    if (
      !handled.has(declarationEntryKey(entry.fieldId, entry.goodsLineId)) &&
      sourceRevoked(entry, state, shipment)
    ) {
      entry.stale = true;
      entry.staleReason =
        "The supporting document or goods row is no longer active in this shipment.";
    }
  if (JSON.stringify(before) !== JSON.stringify(draft)) {
    const affected = draft.fields.filter(
      (entry) =>
        JSON.stringify(
          before.fields.find(
            (previous) =>
              declarationEntryKey(previous.fieldId, previous.goodsLineId) ===
              declarationEntryKey(entry.fieldId, entry.goodsLineId),
          ),
        ) !== JSON.stringify(entry),
    );
    const removed = before.fields.filter((entry) => !draft.fields.some((next) =>
      declarationEntryKey(next.fieldId, next.goodsLineId) === declarationEntryKey(entry.fieldId, entry.goodsLineId),
    ));
    const affectedKeys = new Set([...affected, ...removed].map((entry) => declarationEntryKey(entry.fieldId, entry.goodsLineId)));
    state.audit.push({
      id: `audit-${crypto.randomUUID()}`,
      caseId: shipment.id,
      at,
      actor: actor.name,
      action: "shipment_declaration_synchronized",
      reason:
        "Combined current shipment sources into draft fields; unsupported automatic values retired, human decisions retained and affected evidence changes flagged.",
      before: before.fields.filter((entry) =>
        affectedKeys.has(declarationEntryKey(entry.fieldId, entry.goodsLineId)),
      ),
      after: structuredClone(affected),
    });
  }
}
