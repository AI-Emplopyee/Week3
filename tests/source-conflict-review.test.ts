import assert from "node:assert/strict";
import test from "node:test";
import { getDeclarationEntry, saveDeclarationField } from "../lib/declaration.ts";
import { createEmptyWorkspace, getIssues } from "../lib/engine.ts";
import { actionableReviewIssues, declarationReviewIssue, reviewQuestion } from "../lib/review-questions.ts";
import { syncShipmentDeclaration } from "../lib/shipment-autofill.ts";
import { automaticQuestionIssues, syncAutomaticQuestionDrafts } from "../lib/shipment-correspondence.ts";
import type { Actor, ShipmentCase, ShipmentDocument, WorkspaceState } from "../lib/types.ts";

const actor: Actor = { id: "source-reviewer", name: "Synthetic reviewer", email: "reviewer@example.invalid" };
const at = "2026-10-20T00:00:00.000Z";
const goodsLineId = "invoice-row";

function fixture() {
  const state = createEmptyWorkspace("source-conflict-tests");
  const shipment: ShipmentCase = {
    id: "shipment", reference: "SYNTHETIC-1", title: "Synthetic source review", status: "review", caseType: "import",
    assignedTo: actor.name, createdAt: at, updatedAt: at, documentIds: [], fields: {},
    goods: [{ id: goodsLineId, description: "Synthetic control card", quantity: "1", unit: "PCS", unitPrice: "10", amount: "10",
      hsCode: "12345678", origin: "CN", dutyRate: "", vatRate: "", sourceDocumentId: "invoice", sourcePage: 1,
      reviewed: false, manual: false }],
    groupingConfidence: "high", groupingReason: "Synthetic references agree.", groupingConfirmed: true, synthetic: true, resolutions: [],
    declarationDraft: { schemaVersion: 1, fields: [] },
  };
  state.cases.push(shipment);
  addSource(state, shipment, "invoice", "invoice", {
    goodsCode: "SYNTHETIC-SKU", description: "Synthetic control card", quantity: "1", unit: "PCS", unitPrice: "10", amount: "10",
    hsCode: "12345678", origin: "CN",
  });
  return { state, shipment };
}

function addSource(state: WorkspaceState, shipment: ShipmentCase, id: string, type: ShipmentDocument["type"], values: Record<string, string>) {
  const text = Object.entries(values).map(([field, value]) => `${field}: ${value}`).join("\n");
  const document: ShipmentDocument = {
    id, caseId: shipment.id, name: `${id}.txt`, type, mime: "text/plain", size: text.length, sha256: `synthetic-${id}`,
    version: 1, active: true, uploadedAt: at, extractionStatus: "extracted", synthetic: true,
    extractionPipeline: "kimi", aiProcessedPages: [1], aiStatus: "completed",
    pages: [{ page: 1, text, textSource: "pdf_text", documentType: type, aiReadability: "clear" }],
  };
  state.documents.push(document);
  shipment.documentIds.push(id);
  state.candidates.push(...Object.entries(values).map(([field, value]) => ({
    id: `${id}-${field}`, caseId: shipment.id, documentId: id, documentVersion: 1, lineId: `${id}-row`,
    field, value, originalText: `${field}: ${value}`, page: 1, location: "Synthetic goods row", method: "kimi:test_fixture",
    confidence: "high" as const, readability: "clear" as const, normalizations: [],
  })));
  return document;
}

function addConflictingCertificate(state: WorkspaceState, shipment: ShipmentCase) {
  return addSource(state, shipment, "certificate", "certificate_of_origin", {
    goodsCode: "SYNTHETIC-SKU", description: "Synthetic control card", hsCode: "87654321", origin: "BE",
  });
}

function saved(shipment: ShipmentCase, fieldId: string) {
  const entry = getDeclarationEntry(shipment.declarationDraft, fieldId, goodsLineId);
  assert.ok(entry, `Expected saved field ${fieldId}`);
  return entry;
}

test("a supplier's sole HS and origin readings stay literal and do not invent a classification conflict", () => {
  const { state, shipment } = fixture();
  const source = structuredClone(state.candidates);
  syncShipmentDeclaration(state, shipment, actor);
  assert.deepEqual(saved(shipment, "1.74").value, { kind: "code", code: "12345678" });
  assert.deepEqual(saved(shipment, "1.79").value, { kind: "code", code: "CN" });
  for (const field of ["1.74", "1.79"]) {
    assert.equal(saved(shipment, field).codeVerification, "unverified");
    assert.equal(saved(shipment, field).review, null);
  }
  assert.deepEqual(getIssues(state, shipment.id).filter(issue => ["hsCode", "origin"].includes(issue.ecusFieldKey ?? "")), []);
  assert.deepEqual(state.candidates, source);
});

test("actual linked HS and origin conflicts offer both source values and citations in review and correspondence", () => {
  const { state, shipment } = fixture();
  addConflictingCertificate(state, shipment);
  const source = structuredClone(state.candidates);
  syncShipmentDeclaration(state, shipment, actor);
  const issues = actionableReviewIssues(state, getIssues(state, shipment.id))
    .filter(issue => ["hsCode", "origin"].includes(issue.ecusFieldKey ?? ""));
  assert.equal(issues.length, 2);
  for (const [key, values] of [["hsCode", ["12345678", "87654321"]], ["origin", ["CN", "BE"]]] as const) {
    const issue = issues.find(issue => issue.ecusFieldKey === key)!;
    assert.equal(issue.kind, "declaration", "The question still targets the correct ECUS form cell.");
    assert.equal(issue.goodsLineId, goodsLineId);
    assert.ok(issue.id.endsWith(":conflict"));
    const question = reviewQuestion(state, issue);
    assert.equal(question.kind, "choose");
    assert.deepEqual(question.values, values);
    assert.deepEqual(question.candidates.map(candidate => [candidate.documentId, candidate.page, candidate.originalText]), [
      ["invoice", 1, `${key}: ${values[0]}`], ["certificate", 1, `${key}: ${values[1]}`],
    ]);
  }
  assert.equal(getDeclarationEntry(shipment.declarationDraft, "1.74", goodsLineId), undefined);
  assert.equal(getDeclarationEntry(shipment.declarationDraft, "1.79", goodsLineId), undefined);
  assert.deepEqual(automaticQuestionIssues(state, shipment, issues).map(issue => issue.ecusFieldKey), ["hsCode", "origin"]);
  syncAutomaticQuestionDrafts(state, actor, issues, "en", shipment.id);
  const draft = state.emailDrafts?.find(draft => draft.caseId === shipment.id);
  assert.ok(draft);
  assert.match(draft.body, /12345678 \/ 87654321/);
  assert.match(draft.body, /CN \/ BE/);
  assert.match(draft.body, /invoice\.txt, page 1: CN/);
  assert.match(draft.body, /certificate\.txt, page 1: BE/);
  assert.equal(draft.status, "draft");
  assert.deepEqual(state.candidates, source, "Review questions never rewrite source readings to match a chosen answer.");
});

test("reviewed HS and origin corrections survive refresh and later contradictory evidence requires local review", () => {
  const { state, shipment } = fixture();
  syncShipmentDeclaration(state, shipment, actor);
  for (const [fieldId, code] of [["1.74", "11223344"], ["1.79", "DE"]]) {
    shipment.declarationDraft = saveDeclarationField(shipment.declarationDraft, {
      type: "save_declaration_field", caseId: shipment.id, fieldId, goodsLineId, applicability: "applicable",
      basis: "Reviewer supplied a classification decision after checking the shipment.", value: { kind: "code", code },
      provenance: [{ kind: "manual", note: "Synthetic reviewed decision; retain the supplier reading as evidence." }],
      reason: "Reviewer confirmed this specific goods row.", review: true,
    }, { caseId: shipment.id, documents: state.documents, goods: shipment.goods, actor, at });
  }
  syncShipmentDeclaration(state, shipment, actor);
  syncShipmentDeclaration(state, shipment, actor);
  assert.equal(saved(shipment, "1.74").stale, false);
  assert.equal(saved(shipment, "1.79").stale, false);
  addConflictingCertificate(state, shipment);
  const source = structuredClone(state.candidates);
  syncShipmentDeclaration(state, shipment, actor);
  syncShipmentDeclaration(state, shipment, actor);
  for (const [fieldId, code] of [["1.74", "11223344"], ["1.79", "DE"]]) {
    const entry = saved(shipment, fieldId);
    assert.deepEqual(entry.value, { kind: "code", code });
    assert.equal(entry.review?.actorId, actor.id);
    assert.equal(entry.stale, true);
    assert.equal(entry.codeVerification, "unverified");
  }
  const stale = actionableReviewIssues(state, getIssues(state, shipment.id))
    .filter(issue => ["hsCode", "origin"].includes(issue.ecusFieldKey ?? "") && issue.id.endsWith(":stale:review"));
  assert.equal(stale.length, 2, "Source changes keep the reviewed decision visible for local re-review.");
  assert.deepEqual(automaticQuestionIssues(state, shipment, stale), [], "Staleness alone does not ask the sender to approve an employee decision.");
  assert.deepEqual(state.candidates, source);
});

test("ECUS choices exclude replaced sources and unrelated declaration validation stays a review", () => {
  const { state, shipment } = fixture();
  const certificate = addConflictingCertificate(state, shipment);
  const issue = getIssues(state, shipment.id).find(issue => issue.ecusFieldKey === "origin" && issue.id.endsWith(":conflict"))!;
  assert.ok(issue);
  certificate.version = 2;
  assert.deepEqual(reviewQuestion(state, issue).values, ["CN"]);
  assert.deepEqual(reviewQuestion(state, issue).candidates.map(candidate => candidate.documentId), ["invoice"]);
  certificate.version = 1;
  assert.equal(reviewQuestion(state, { ...issue, id: "shipment:declaration:origin:format:conflict" }).kind, "review");
  for (const problem of ["uncertain", "invalid"]) {
    const uncertain = { ...issue, id: issue.id.replace(/:conflict$/, `:${problem}`), candidateIds: ["invoice-origin"] };
    assert.equal(reviewQuestion(state, uncertain).kind, "confirm");
    assert.deepEqual(reviewQuestion(state, uncertain).values, ["CN"]);
  }
});

test("a transport name derived from a code opens the name form cell without approving the raw code as a name", () => {
  const { state, shipment } = fixture();
  addSource(state, shipment, "awb", "air_waybill", { portOfDischargeCode: "SGN", portOfDischarge: "Bruxelles" });
  for (const candidate of state.candidates.filter(candidate => candidate.documentId === "awb")) delete candidate.lineId;
  syncShipmentDeclaration(state, shipment, actor);
  const issue = getIssues(state, shipment.id).find(issue => issue.field === "portOfDischarge" && issue.kind === "conflict");
  assert.ok(issue);
  const question = reviewQuestion(state, issue);
  assert.equal(question.kind, "choose");
  assert.deepEqual(question.values, ["Ho Chi Minh City", "Brussel (Bruxelles)"]);
  const code = question.candidates.find(candidate => candidate.field === "portOfDischargeCode")!;
  const name = question.candidates.find(candidate => candidate.field === "portOfDischarge")!;
  const original = structuredClone(code);
  const target = declarationReviewIssue(issue, code);
  assert.ok(target);
  assert.equal(target.field, "1.33");
  assert.equal(target.ecusFieldKey, "portOfDischarge");
  assert.deepEqual(code, original, "The action never forges a transformed source candidate.");
  assert.equal(declarationReviewIssue(issue, name), undefined, "A genuine same-field candidate keeps the existing confirmation action.");
  const existingEcusIssue = { ...issue, field: "1.33", ecusFieldKey: "portOfDischarge" };
  assert.equal(declarationReviewIssue(existingEcusIssue, name), existingEcusIssue);
});
