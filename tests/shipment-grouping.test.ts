import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyWorkspace,
  getIssues,
  getProposedFields,
} from "../lib/engine.ts";
import { applyFixtureAction as applyAction } from './helpers/kimi-fixtures.ts';
import { classifyDocument, extractDocument } from "./helpers/legacy-extraction.ts";
import { groupShipmentDocuments } from "../lib/shipment-grouping.ts";
import type {
  Actor,
  Candidate,
  CaseType,
  ShipmentCase,
  ShipmentDocument,
  UploadedDocument,
} from "../lib/types.ts";
const actor: Actor = {
  id: "grouping-test",
  name: "Synthetic reviewer",
  email: "reviewer@example.invalid",
};
function upload(
  id: string,
  text: string,
  name = `${id}.txt`,
): UploadedDocument {
  return {
    id,
    sha256: `synthetic-hash-${id}`,
    name,
    mime: "text/plain",
    size: text.length,
    extractionStatus: "extracted",
    pages: [{ page: 1, text }],
    synthetic: true,
  };
}
function doc(file: UploadedDocument): ShipmentDocument {
  return {
    ...file,
    caseId: "",
    version: 1,
    active: true,
    type: classifyDocument(file.name, file.pages[0].text),
    uploadedAt: "2026-01-01",
    synthetic: true,
  };
}
const parties = "Importer: Fictional Buyer Co\nExporter: Fictional Seller Co";
function packet() {
  return [
    upload(
      "invoice",
      `COMMERCIAL INVOICE\nInvoice Number: TEST-INV-101\nInvoice Date: 2026-01-01\n${parties}\nCurrency: USD\nInvoice Total: 100\nPackages: 10\nGross Weight (kg): 25\nDescription | Quantity | Unit | Unit Price | Amount\nWidget | 10 | PCS | 10 | 100`,
    ),
    upload(
      "contract",
      `SALES CONTRACT\nInvoice Number: TEST-INV-101\n${parties}\nContract Number: TEST-CT-999`,
    ),
    upload(
      "origin",
      `CERTIFICATE OF ORIGIN\nInvoice Number: TEST-INV-101\n${parties}\nVessel: TEST VESSEL`,
    ),
    upload(
      "house",
      `HOUSE BILL OF LADING\nHBL Number: TEST-HBL-101\nBooking No: TEST-BOOK-101\n${parties}\nPackages: 10\nGross Weight (kg): 25\nVessel: TEST VESSEL\nVoyage: TEST-V1\nTEST1234567 / SEAL123456\nTEST1234568 / SEAL123457`,
    ),
    upload(
      "master",
      "MASTER BILL OF LADING\nMBL Number: TEST-MBL-101\nBooking No: TEST-BOOK-101\nPackages: 10\nGross Weight (kg): 25\nVessel: TEST VESSEL\nVoyage: TEST-V1\nTEST1234567 / SEAL123456\nTEST1234568 / SEAL123457",
    ),
    upload(
      "detail",
      `PACKING LIST\nInvoice Number: TEST-INV-101\n${parties}\nContainer: TEST1234567\nSeal No: SEAL123456`,
    ),
  ];
}
function permutations<T>(values: T[]): T[][] {
  return values.length <= 1
    ? [values]
    : values.flatMap((value, i) =>
        permutations([...values.slice(0, i), ...values.slice(i + 1)]).map(
          (rest) => [value, ...rest],
        ),
      );
}
function grouped(files: UploadedDocument[]) {
  const documents = files.map(doc);
  return groupShipmentDocuments(
    documents,
    documents.flatMap((d) => extractDocument(d).candidates),
    [],
  );
}
function activeCount(state: ReturnType<typeof createEmptyWorkspace>) {
  return state.cases.filter((c) => !c.mergedInto).length;
}

test("grouping never extracts container or seal matches from unprocessed document text", () => {
  const source = "BILL OF LADING\nContainer: TEST1234567\nSeal No: SEAL123456";
  const documents = [doc(upload("first-unread", source)), doc(upload("second-unread", source))];
  assert.equal(groupShipmentDocuments(documents, [], []).length, 2);
});

test("all six documents form one evidence-linked shipment in every attachment order", () => {
  for (const files of permutations(packet())) {
    const groups = grouped(files);
    assert.equal(groups.length, 1, files.map((d) => d.id).join(","));
    assert.equal(groups[0].confirmed, true);
    assert.deepEqual(groups[0].documentIds, [
      "contract",
      "detail",
      "house",
      "invoice",
      "master",
      "origin",
    ]);
  }
});

test("intake builds one combined draft only after grouping and uses container set semantics", () => {
  const state = applyAction(
    createEmptyWorkspace("combined-test"),
    { type: "intake", documents: packet().reverse() },
    actor,
  );
  assert.equal(activeCount(state), 1);
  const shipment = state.cases[0];
  assert.equal(shipment.documentIds.length, 6);
  assert.equal(shipment.groupingConfirmed, true);
  assert.equal(
    getProposedFields(state, shipment.id).container,
    "TEST1234567, TEST1234568",
  );
  assert.ok(
    shipment.declarationDraft!.fields.some((entry) => entry.fieldId === "1.41"),
  );
  assert.equal(
    getIssues(state).some(
      (issue) => issue.kind === "conflict" && issue.field === "container",
    ),
    false,
  );
  assert.equal(
    getIssues(state).some((issue) => issue.kind === "grouping"),
    false,
  );
});

test("late bridge unites provisional shipments and keeps the former case as audited history", () => {
  let state = applyAction(
    createEmptyWorkspace("bridge"),
    { type: "intake", documents: [packet()[0], packet()[4]] },
    actor,
  );
  assert.equal(activeCount(state), 2);
  const oldIds = state.cases.map((c) => c.id);
  state = applyAction(
    state,
    { type: "intake", documents: [packet()[3]] },
    actor,
  );
  assert.equal(activeCount(state), 1);
  assert.equal(state.cases.filter((c) => c.mergedInto).length, 1);
  assert.ok(oldIds.every((id) => state.cases.some((c) => c.id === id)));
  assert.ok(state.audit.some((entry) => entry.action === "case_merged"));
});

test("shared sender, contract, master bill, parties, or vessel alone never groups separate shipments", () => {
  for (const reference of [
    "Contract Number: SHARED-123",
    "MBL Number: SHARED-123",
    "Vessel: SHARED VESSEL",
    parties,
  ]) {
    const files = [
      upload("first", `PACKING LIST\n${reference}`),
      upload("second", `PACKING LIST\n${reference}`),
    ];
    assert.equal(grouped(files).length, 2, reference);
  }
  const state = applyAction(
    createEmptyWorkspace("email-separation"),
    {
      type: "intake",
      documents: [
        upload("first", "PACKING LIST"),
        upload("second", "COMMERCIAL INVOICE"),
      ].map((d) => ({ ...d, sourceEmailId: "same-email" })),
      email: {
        id: "same-email",
        messageId: "same-message",
        sender: "sender@example.invalid",
        subject: "Two shipments",
        receivedAt: "2026-01-01",
        originalName: "synthetic.eml",
        documentIds: [],
        sha256: "email-hash",
      },
    },
    actor,
  );
  assert.equal(activeCount(state), 2);
});

test("distinct HBL shipments sharing master booking, containers, totals and parties remain separate", () => {
  const first = packet()[3];
  const second = upload(
    "second-house",
    first.pages[0].text.replace("TEST-HBL-101", "TEST-HBL-102"),
  );
  assert.equal(grouped([first, second]).length, 2);
  const ambiguous = packet()[4];
  for (const files of permutations([first, second, ambiguous])) {
    const groups = grouped(files);
    assert.equal(groups.length, 3);
    assert.equal(
      groups.find((g) => g.documentIds.includes("master"))!.confirmed,
      false,
    );
  }
});

test("different invoices with identical parties and totals do not merge without a shipment identifier", () => {
  const first = packet()[0];
  const second = upload(
    "other-invoice",
    first.pages[0].text.replace("TEST-INV-101", "TEST-INV-102"),
  );
  assert.equal(grouped([first, second]).length, 2);
});

test("a lone low-confidence AI identifier cannot group documents", () => {
  const documents = [
    doc(upload("a", "COMMERCIAL INVOICE")),
    doc(upload("b", "PACKING LIST")),
  ];
  const candidates = documents.map((d): Candidate => ({
    id: `${d.id}-ai`,
    documentId: d.id,
    documentVersion: 1,
    caseId: "",
    field: "houseBillOfLading",
    value: "MAYBE-HBL",
    page: 1,
    originalText: "MAYBE-HBL",
    location: "Test",
    method: "kimi:test",
    confidence: "low",
    normalizations: [],
  }));
  assert.equal(groupShipmentDocuments(documents, candidates, []).length, 2);
});

test("later agreeing sources preserve manual values and reviews; contradictory values flag only the affected field", () => {
  let state = applyAction(
    createEmptyWorkspace("late-values"),
    { type: "intake", documents: packet() },
    actor,
  );
  const id = state.cases[0].id;
  state = applyAction(
    state,
    {
      type: "review_field",
      caseId: id,
      field: "invoiceTotal",
      value: "100",
      reason: "Checked source.",
    },
    actor,
  );
  state = applyAction(
    state,
    {
      type: "review_field",
      caseId: id,
      field: "importer",
      value: "Manually confirmed legal buyer",
      reason: "Checked broker instruction.",
    },
    actor,
  );
  state = applyAction(
    state,
    {
      type: "review_goods",
      caseId: id,
      goods: state.cases[0].goods,
      reviewedLineIds: state.cases[0].goods.map(line => line.id),
      reason: "Checked lines.",
    },
    actor,
  );
  const sourceAudit = structuredClone(state.audit);
  state = applyAction(
    state,
    {
      type: "intake",
      documents: [
        upload(
          "agreeing",
          `COMMERCIAL INVOICE\nInvoice Number: TEST-INV-101\n${parties}\nInvoice Total: 100`,
        ),
      ],
    },
    actor,
  );
  assert.equal(state.cases[0].fields.invoiceTotal.stale, false);
  assert.equal(
    state.cases[0].fields.importer.value,
    "Manually confirmed legal buyer",
  );
  assert.equal(state.cases[0].fields.importer.stale, false);
  assert.equal(state.cases[0].goods[0].reviewed, true);
  state = applyAction(
    state,
    {
      type: "intake",
      documents: [
        upload(
          "contradiction",
          `COMMERCIAL INVOICE\nInvoice Number: TEST-INV-101\n${parties}\nInvoice Total: 120`,
        ),
      ],
    },
    actor,
  );
  assert.equal(state.cases[0].fields.invoiceTotal.value, "100");
  assert.equal(state.cases[0].fields.invoiceTotal.stale, true);
  assert.equal(state.cases[0].fields.importer.stale, false);
  assert.deepEqual(state.audit.slice(0, sourceAudit.length), sourceAudit);
});

test("regrouping preserves decisions from both source cases without silently replacing either", () => {
  let state = applyAction(
    createEmptyWorkspace("existing"),
    { type: "intake", documents: [packet()[0], packet()[4]] },
    actor,
  );
  const [first, second] = state.cases;
  state = applyAction(
    state,
    {
      type: "review_field",
      caseId: first.id,
      field: "customsProcedure",
      value: "TEST-A",
      reason: "Synthetic manual choice.",
    },
    actor,
  );
  state = applyAction(
    state,
    {
      type: "review_field",
      caseId: second.id,
      field: "customsProcedure",
      value: "TEST-B",
      reason: "Different synthetic manual choice.",
    },
    actor,
  );
  state = applyAction(
    state,
    { type: "intake", targetCaseId: second.id, documents: [packet()[3]] },
    actor,
  );
  state = applyAction(state, { type: "regroup_existing" }, actor);
  const target = state.cases.find((c) => !c.mergedInto)!;
  assert.equal(activeCount(state), 1);
  assert.equal(target.fields.customsProcedure.value, "TEST-A");
  assert.equal(target.fields.customsProcedure.stale, true);
  assert.ok(
    state.audit.some((entry) => entry.action === "merged_review_conflict"),
  );
  assert.equal(
    state.cases.find((c) => c.mergedInto)!.fields.customsProcedure.value,
    "TEST-B",
  );
});

test("missing-field questions wait until all available document pages are readable", () => {
  const scan = {
    ...upload("scan", ""),
    extractionStatus: "needs_transcription" as const,
  };
  const state = applyAction(
    createEmptyWorkspace("unreadable"),
    { type: "intake", documents: [scan] },
    actor,
  );
  assert.ok(getIssues(state).some((issue) => issue.kind === "document"));
  assert.equal(
    getIssues(state).some((issue) => issue.kind === "missing"),
    false,
  );
});

test("multi-email intake retains each original and links only its own attachments", () => {
  const docs = packet()
    .slice(0, 2)
    .map((d, n) => ({ ...d, sourceEmailId: `email-${n}` }));
  const emails = docs.map((_, n) => ({
    id: `email-${n}`,
    messageId: `message-${n}`,
    sender: `sender${n}@example.invalid`,
    subject: "Same synthetic shipment",
    receivedAt: "2026-01-01",
    originalName: `email${n}.eml`,
    documentIds: [],
    sha256: `email-hash-${n}`,
  }));
  const state = applyAction(
    createEmptyWorkspace("emails"),
    { type: "intake", documents: docs, emails },
    actor,
  );
  assert.equal(activeCount(state), 1);
  assert.equal(state.emails.length, 2);
  assert.deepEqual(state.emails[0].documentIds, ["invoice"]);
  assert.deepEqual(state.emails[1].documentIds, ["contract"]);
});

test("conflicting generic bills and commercial identities override shared invoice or container evidence", () => {
  const first = upload(
    "generic-a",
    `COMMERCIAL INVOICE\nInvoice Number: SAME-INVOICE\nB/L Number: SHIPMENT-A\n${parties}`,
  );
  const second = upload(
    "generic-b",
    `COMMERCIAL INVOICE\nInvoice Number: SAME-INVOICE\nB/L Number: SHIPMENT-B\n${parties}`,
  );
  assert.equal(grouped([first, second]).length, 2);
  const containerA = upload(
    "consolidated-a",
    `PACKING LIST\nInvoice Number: INV-A\n${parties}\nTEST1234567 / SEAL123456`,
  );
  const containerB = upload(
    "consolidated-b",
    "PACKING LIST\nInvoice Number: INV-B\nImporter: Another Buyer\nExporter: Another Seller\nTEST1234567 / SEAL123456",
  );
  assert.equal(grouped([containerA, containerB]).length, 2);
});

test("navigation target cannot force unrelated or contradictory attachments into an existing shipment", () => {
  let state = applyAction(
    createEmptyWorkspace("navigation-target"),
    { type: "intake", documents: packet() },
    actor,
  );
  const caseId = state.cases[0].id;
  const other = upload(
    "other-house",
    packet()[3].pages[0].text.replace("TEST-HBL-101", "TEST-HBL-OTHER"),
  );
  state = applyAction(
    state,
    { type: "intake", targetCaseId: caseId, documents: [other] },
    actor,
  );
  assert.equal(activeCount(state), 2);
  assert.notEqual(
    state.documents.find((d) => d.id === other.id)!.caseId,
    caseId,
  );
});

test("adding an alternate invoice table cannot duplicate or replace reviewed goods", () => {
  let state = applyAction(
    createEmptyWorkspace("goods-choice"),
    { type: "intake", documents: packet() },
    actor,
  );
  const id = state.cases[0].id;
  state = applyAction(
    state,
    {
      type: "review_goods",
      caseId: id,
      goods: state.cases[0].goods,
      reviewedLineIds: state.cases[0].goods.map(line => line.id),
      reason: "Checked invoice table.",
    },
    actor,
  );
  const reviewed = structuredClone(state.cases[0].goods);
  state = applyAction(
    state,
    {
      type: "intake",
      documents: [upload("aaa-copy-invoice", packet()[0].pages[0].text)],
    },
    actor,
  );
  assert.deepEqual(state.cases[0].goods, reviewed);
});

test("completeness questions wait for confirmed grouping, then expose truly absent data", () => {
  let state = applyAction(
    createEmptyWorkspace("group-before-missing"),
    {
      type: "intake",
      documents: [
        upload(
          "unconfirmed-invoice",
          "COMMERCIAL INVOICE\nInvoice Number: SINGLE-TEST",
        ),
      ],
    },
    actor,
  );
  const caseId = state.cases[0].id;
  assert.equal(state.cases[0].groupingConfirmed, false);
  assert.ok(getIssues(state).some((issue) => issue.kind === "grouping"));
  assert.equal(
    getIssues(state).some(
      (issue) =>
        issue.id.endsWith(":required") || issue.id.endsWith(":goods-missing"),
    ),
    false,
  );
  state = applyAction(
    state,
    {
      type: "confirm_grouping",
      caseId,
      reason: "Synthetic reviewer confirms the available shipment packet.",
    },
    actor,
  );
  assert.ok(getIssues(state).some((issue) => issue.ecusFieldKey === 'invoiceTotal' && issue.id.endsWith(':required')));
  assert.ok(
    getIssues(state).some((issue) => issue.id.endsWith(":goods-missing")),
  );
});

test("punctuation spacing in a party name creates neither a false source conflict nor a stale decision", () => {
  const original = upload(
    "party-invoice",
    "COMMERCIAL INVOICE\nInvoice Number: PARTY-101\nExporter: Fictional Supplier Co.,Ltd.",
  );
  let state = applyAction(
    createEmptyWorkspace("party-formatting"),
    { type: "intake", documents: [original] },
    actor,
  );
  const caseId = state.cases[0].id;
  state = applyAction(
    state,
    {
      type: "review_field",
      caseId,
      field: "exporter",
      value: "Fictional Supplier Co.,Ltd.",
      reason: "Synthetic source checked.",
    },
    actor,
  );
  state = applyAction(
    state,
    {
      type: "intake",
      documents: [
        upload(
          "party-packing",
          "PACKING LIST\nInvoice Number: PARTY-101\nExporter: FICTIONAL SUPPLIER CO. , LTD.",
        ),
      ],
    },
    actor,
  );
  assert.equal(activeCount(state), 1);
  assert.equal(state.cases[0].fields.exporter.stale, false);
  assert.equal(
    getIssues(state).some(
      (issue) => issue.kind === "conflict" && issue.field === "exporter",
    ),
    false,
  );
  const changed = structuredClone(state);
  const source = changed.candidates.find(
    (candidate) =>
      candidate.documentId === "party-packing" &&
      candidate.field === "exporter",
  )!;
  source.value = "Different Supplier Co.,Ltd.";
  assert.ok(
    getIssues(changed).some(
      (issue) => issue.kind === "conflict" && issue.field === "exporter",
    ),
  );
});

test("matching shipment identifiers cannot cross case directions or reference and unresolved collection boundaries", () => {
  const makeCase = (id: string, caseType: CaseType): ShipmentCase => ({
    ...applyAction(createEmptyWorkspace('case-types'), { type: 'create_case', title: id, caseType }, actor).cases[0], id,
  });
  for (const [left, right] of [
    ['import', 'export'], ['import', 'reference'], ['import', 'unknown'],
    ['import', 'unsupported'], ['export', 'unknown'], ['export', 'reference'],
    ['unknown', 'unknown'], ['reference', 'reference'], ['unsupported', 'unsupported'],
  ] as [CaseType, CaseType][]) {
    const documents = [
      { ...doc(packet()[3]), id: 'first-direction', caseId: 'left' },
      { ...doc(packet()[3]), id: 'second-direction', caseId: 'right' },
    ];
    const candidates = documents.flatMap(document => extractDocument(document).candidates);
    for (const order of [documents, [...documents].reverse()]) {
      const groups = groupShipmentDocuments(order, candidates, [makeCase('left', left), makeCase('right', right)]);
      assert.equal(groups.length, 2, `${left} / ${right}`);
    }
  }
  // A same-direction evidence match still works for existing cases.
  for (const caseType of ['import', 'export'] as CaseType[]) {
    const documents = ['left', 'right'].map(caseId => ({ ...doc(packet()[3]), id: caseId, caseId }));
    assert.equal(groupShipmentDocuments(documents, documents.flatMap(document => extractDocument(document).candidates), [makeCase('left', caseType), makeCase('right', caseType)]).length, 1);
  }
  for (const caseType of ['export', 'reference', 'unknown', 'unsupported'] as CaseType[]) {
    const documents = [
      { ...doc(packet()[3]), id: 'existing', caseId: 'left' },
      { ...doc(packet()[3]), id: 'incoming', caseId: '' },
    ];
    assert.equal(groupShipmentDocuments(documents, documents.flatMap(document => extractDocument(document).candidates), [makeCase('left', caseType)]).length, 2, `incoming / ${caseType}`);
  }
});

test("new import attachments stay separate from export cases and AI refresh cannot promote the export", () => {
  let state = applyAction(createEmptyWorkspace('direction-intake'), { type: 'intake', documents: [packet()[3]] }, actor);
  const exportId = state.cases[0].id;
  state = applyAction(state, { type: 'update_case', caseId: exportId, caseType: 'export' }, actor);
  const imported = upload('later-import-house', packet()[3].pages[0].text);
  state = applyAction(state, { type: 'intake', documents: [imported] }, actor);
  assert.equal(activeCount(state), 2);
  const importId = state.documents.find(document => document.id === imported.id)!.caseId;
  assert.notEqual(importId, exportId);
  assert.equal(state.cases.find(shipment => shipment.id === importId)!.caseType, 'import');

  state = applyAction(state, {
    type: 'add_ai_candidates', caseId: exportId, documentId: 'house', documentVersion: 1,
    model: 'synthetic-model', pages: [1], pageReadings: [{ page: 1, documentType: 'bill_of_lading', readability: 'clear' }],
    proposals: [{ field: 'houseBillOfLading', value: 'TEST-HBL-101', quote: 'HBL Number: TEST-HBL-101', page: 1, confidence: 'medium' }],
  }, actor);
  assert.equal(activeCount(state), 2);
  assert.equal(state.documents.find(document => document.id === 'house')!.caseId, exportId);
  assert.equal(state.cases.find(shipment => shipment.id === exportId)!.caseType, 'export');
  assert.ok(state.candidates.some(candidate => candidate.caseId === exportId && candidate.method.startsWith('kimi:')));
  assert.equal(state.cases.find(shipment => shipment.id === exportId)!.declarationDraft?.fields.length, 0);

  // A third matching import attachment may join its import case; it cannot
  // become a transitive bridge back into the export case.
  state = applyAction(state, { type: 'intake', documents: [upload('third-import-house', packet()[3].pages[0].text)] }, actor);
  assert.equal(activeCount(state), 2);
  assert.equal(state.documents.find(document => document.id === 'third-import-house')!.caseId, importId);
});

test("an existing non-import packet retains its own linked documents during regrouping", () => {
  for (const caseType of ['export', 'reference', 'unknown', 'unsupported'] as CaseType[]) {
    let state = applyAction(createEmptyWorkspace('own-packet'), { type: 'intake', documents: packet() }, actor);
    const id = state.cases[0].id;
    state = applyAction(state, { type: 'update_case', caseId: id, caseType }, actor);
    const sourceIds = [...state.cases[0].documentIds].sort();
    state = applyAction(state, { type: 'regroup_existing' }, actor);
    assert.equal(activeCount(state), 1);
    assert.equal(state.cases[0].caseType, caseType);
    assert.deepEqual([...state.cases[0].documentIds].sort(), sourceIds);
    assert.ok(state.candidates.length > 0);
  }
});
