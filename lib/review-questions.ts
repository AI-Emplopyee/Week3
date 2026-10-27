import type { Candidate, Issue, WorkspaceState } from "./types.ts";
import { buildShipmentFacts, isShipmentFactClear, normalizedShipmentValue } from "./shipment-autofill.ts";
import { ECUS_FORM_FIELDS } from "./ecus-form.ts";

export type ReviewQuestion = {
  kind: "confirm" | "choose" | "missing" | "review";
  candidates: Candidate[];
  values: string[];
};

/** A derived alternative keeps its original evidence identity. Review the target
 * form cell instead of approving that original candidate as a different field. */
export function declarationReviewIssue(issue: Issue, candidate: Candidate): Issue | undefined {
  if (issue.ecusFieldKey) return issue;
  if (!issue.field || candidate.field === issue.field) return undefined;
  const target = ECUS_FORM_FIELDS.find(field => !field.readOnly &&
    (field.sourceField ?? field.key) === issue.field && (field.tab === "goods") === !!issue.goodsLineId);
  return target ? { ...issue, field: target.fieldId, ecusFieldKey: target.key } : undefined;
}

/** A question may offer only evidence from a current document in this shipment. */
export function reviewQuestion(
  state: WorkspaceState,
  issue: Issue,
): ReviewQuestion {
  const active = new Map(
    state.documents
      .filter((document) => document.active && document.caseId === issue.caseId)
      .map((document) => [document.id, document.version]),
  );
  const candidates = state.candidates.filter(
    (candidate) =>
      issue.candidateIds.includes(candidate.id) &&
      candidate.caseId === issue.caseId &&
      active.get(candidate.documentId) === candidate.documentVersion &&
      candidate.value.trim(),
  );
  const distinctValues = new Map<string, string>();
  const shipment = issue.field && !issue.goodsLineId && ["conflict", "uncertain", "stale"].includes(issue.kind)
    ? state.cases.find((item) => item.id === issue.caseId) : undefined;
  const projected = shipment && issue.field
    ? new Map((buildShipmentFacts(state, shipment)[issue.field]?.candidates ?? []).map((candidate) => [candidate.id, candidate]))
    : undefined;
  for (const candidate of candidates) {
    // The choice summary uses the same evidence-backed formatting comparison as
    // autofill. Cards retain the original quote and value for source inspection.
    const comparison = projected?.get(candidate.id) ?? candidate;
    const key = `${comparison.field}:${normalizedShipmentValue(comparison.field, comparison.value)}`;
    if (!distinctValues.has(key))
      distinctValues.set(key, comparison.value.trim());
  }
  // Keep one original display value per semantic value, plus all original evidence.
  const values = [...distinctValues.values()];
  // ECUS source findings retain kind "declaration" so the question opens the
  // right form cell. Their evidence subtype still needs an explicit choice or
  // confirmation, just like the shipment-level source questions.
  const evidenceKind = issue.kind === "declaration" && issue.ecusFieldKey && issue.id.includes(":ecus-evidence:")
    ? issue.id.match(/:(conflict|uncertain|invalid)$/)?.[1]
    : undefined;
  const questionKind = evidenceKind === "invalid" ? "uncertain" : evidenceKind ?? issue.kind;
  const kind =
    (issue.kind === "missing" || (issue.ecusFieldKey && issue.id.endsWith(':required'))) && issue.field && values.length === 0
      ? "missing"
      : issue.field &&
          values.length > 1 &&
          ["conflict", "uncertain", "stale"].includes(questionKind)
        ? "choose"
        : issue.field &&
            values.length === 1 &&
            ["uncertain", "stale"].includes(questionKind)
          ? "confirm"
          : "review";
  return { kind, candidates, values };
}

/** Routine sign-off remains in the declaration editor; questions address uncertainty. */
export function actionableReviewIssues(
  state: WorkspaceState,
  issues: Issue[],
): Issue[] {
  return issues.filter((issue) => {
    if (issue.resolved) return false;
    if (issue.kind === "declaration" && issue.id.endsWith(":review:review"))
      return false;
    if (issue.kind === "goods" && issue.id === `${issue.caseId}:goods-review`)
      return false;
    if (
      issue.kind === "uncertain" &&
      issue.field &&
      issue.id === `${issue.caseId}:review-${issue.field}`
    ) {
      const { candidates } = reviewQuestion(state, issue);
      if (
        isShipmentFactClear(state, issue.field, candidates)
      )
        return false;
    }
    return true;
  });
}

/** Keep a surviving question open after another question is completed. */
export function expandedReviewIssueId(
  issues: readonly Issue[],
  selectedId: string,
): string {
  if (selectedId === "__closed__") return "";
  return issues.some((issue) => issue.id === selectedId)
    ? selectedId
    : issues[0]?.id || "";
}
