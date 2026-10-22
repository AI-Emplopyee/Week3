import { DEFAULT_DOCUMENT_MODEL, ZAI_ENDPOINT } from './ai-provider.ts';
import { documentSourceReady } from './source-completeness.ts';
import { clientMemorySaveAction, dismissOrRevokeClientMemory, getClientIdentity, rememberClientCorrection } from './client-memory.ts';
import { applyEmailGroupingAction } from './email-grouping.ts';
import type {
  Action,
  Actor,
  AuditEntry,
  Candidate,
  DocumentType,
  FieldDefinition,
  GoodsLine,
  Issue,
  ReviewedValue,
  ShipmentCase,
  ShipmentDocument,
  SourceCollection,
  UploadedDocument,
  WorkspaceState,
} from "./types.ts";
import {
  documentHasType,
  pageDocumentType,
} from "./extraction.ts";
import { simulateTestDraft, successfulRunForSnapshot } from "./ecus.ts";
import { caseScopeMessage } from "./case-scope.ts";
import { syntheticShipments } from "./demo.ts";
import { assessExtraction } from "./extraction-quality.ts";
import { groundKimiProposals, selectKimiPages, validateKimiPageReadings, KIMI_ENDPOINT } from "./kimi.ts";
import {
  getDeclarationIssues,
  invalidateDeclarationDraft,
  removeDeclarationField,
  saveDeclarationField,
} from "./declaration.ts";
import {
  addDecimal,
  compareDecimal,
  formatDecimal,
  isIsoDate,
  multiplyDecimal,
  parseExactDecimal,
} from "./integrity.ts";
import { groupShipmentDocuments } from "./shipment-grouping.ts";
import {
  normalizedShipmentValue,
  isShipmentFactClear,
  getEcusEvidenceIssues,
  buildShipmentFacts,
  getComparableShipmentWeights,
  syncShipmentDeclaration,
} from "./shipment-autofill.ts";
import { applyCorrespondenceAction, syncAutomaticQuestionDrafts } from "./shipment-correspondence.ts";
import { recordReviewHistory, recordsReviewHistory } from "./review-history.ts";
import { withinGuideLineTolerance } from "./vnaccs-guide-rules.ts";

export const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: "importer",
    label: "Người nhập khẩu",
    group: "Các bên",
    required: true,
  },
  {
    key: "exporter",
    label: "Người xuất khẩu",
    group: "Các bên",
    required: true,
  },
  { key: "importerAddress", label: "Địa chỉ người nhập khẩu", group: "Các bên" },
  { key: "importerTelephone", label: "Điện thoại người nhập khẩu", group: "Các bên" },
  { key: "exporterAddress", label: "Địa chỉ người xuất khẩu", group: "Các bên" },
  { key: "exporterAddressLine2", label: "Địa chỉ người xuất khẩu (dòng 2)", group: "Các bên" },
  { key: "exporterCity", label: "Thành phố người xuất khẩu", group: "Các bên" },
  { key: "exporterCountry", label: "Quốc gia người xuất khẩu", group: "Các bên" },
  {
    key: "invoiceNumber",
    label: "Số hóa đơn",
    group: "Hóa đơn",
    required: true,
  },
  {
    key: "invoiceDate",
    label: "Ngày hóa đơn",
    group: "Hóa đơn",
    required: true,
  },
  { key: "currency", label: "Đồng tiền", group: "Hóa đơn", required: true },
  {
    key: "invoiceTotal",
    label: "Trị giá hóa đơn",
    group: "Hóa đơn",
    required: true,
  },
  { key: "incoterm", label: "Điều kiện giao hàng", group: "Hóa đơn" },
  {
    key: "billOfLading",
    label: "Số vận đơn (chưa xác định cấp)",
    group: "Vận chuyển",
  },
  {
    key: "houseBillOfLading",
    label: "Số vận đơn House (HBL)",
    group: "Vận chuyển",
  },
  {
    key: "masterBillOfLading",
    label: "Số vận đơn Master (MBL)",
    group: "Vận chuyển",
  },
  {
    key: "transportReference",
    label: "Số tham chiếu vận chuyển / booking",
    group: "Vận chuyển",
  },
  {
    key: "transportShipper",
    label: "Shipper ghi trên vận đơn",
    group: "Các bên trên vận đơn",
  },
  {
    key: "transportConsignee",
    label: "Consignee ghi trên vận đơn",
    group: "Các bên trên vận đơn",
  },
  {
    key: "notifyParty",
    label: "Notify party ghi trên vận đơn",
    group: "Các bên trên vận đơn",
  },
  {
    key: "houseShipper",
    label: "Shipper trên HBL",
    group: "Các bên trên vận đơn",
  },
  {
    key: "houseConsignee",
    label: "Consignee trên HBL",
    group: "Các bên trên vận đơn",
  },
  {
    key: "houseNotifyParty",
    label: "Notify party trên HBL",
    group: "Các bên trên vận đơn",
  },
  {
    key: "masterShipper",
    label: "Shipper trên MBL",
    group: "Các bên trên vận đơn",
  },
  {
    key: "masterConsignee",
    label: "Consignee trên MBL",
    group: "Các bên trên vận đơn",
  },
  {
    key: "masterNotifyParty",
    label: "Notify party trên MBL",
    group: "Các bên trên vận đơn",
  },
  { key: "contractNumber", label: "Số hợp đồng", group: "Hóa đơn" },
  { key: "packingListDate", label: "Ngày phiếu đóng gói", group: "Đóng gói" },
  { key: "vessel", label: "Tên tàu / chuyến bay", group: "Vận chuyển" },
  { key: "voyage", label: "Số chuyến", group: "Vận chuyển" },
  { key: "arrivalDate", label: "Ngày hàng đến", group: "Vận chuyển" },
  { key: "portOfLoading", label: "Cảng xếp hàng", group: "Vận chuyển" },
  { key: "portOfDischarge", label: "Cảng dỡ hàng", group: "Vận chuyển" },
  { key: "container", label: "Container", group: "Vận chuyển" },
  { key: "containerCount", label: "Số lượng container", group: "Vận chuyển" },
  { key: "packageCount", label: "Số kiện", group: "Đóng gói" },
  { key: "packageUnit", label: "Đơn vị kiện", group: "Đóng gói" },
  { key: "grossWeight", label: "Trọng lượng cả bì (kg)", group: "Đóng gói" },
  { key: "grossWeightUnit", label: "Đơn vị trọng lượng cả bì", group: "Đóng gói" },
  { key: "netWeight", label: "Trọng lượng tịnh (kg)", group: "Đóng gói" },
  {
    key: "customsProcedure",
    label: "Loại hình — nhập tay, chưa xác minh",
    group: "Quyết định hải quan",
    manualOnly: true,
  },
  {
    key: "countryOfOrigin",
    label: "Xuất xứ — nhập tay, chưa xác minh",
    group: "Quyết định hải quan",
    manualOnly: true,
  },
];
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  invoice: "Hóa đơn",
  packing_list: "Phiếu đóng gói",
  bill_of_lading: "Vận đơn đường biển",
  air_waybill: "Vận đơn hàng không",
  contract: "Hợp đồng",
  certificate_of_origin: "Chứng nhận xuất xứ",
  other: "Khác / chưa phân loại",
};
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const same = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const sameField = normalizedShipmentValue;
const present = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
function reasonRequired(reason: string) {
  if (!present(reason))
    throw new Error("Cần ghi rõ lý do / căn cứ cho quyết định này.");
}
function assertReviewable(c: ShipmentCase) {
  if (c.mergedInto)
    throw new Error("Hồ sơ đã được ghép; mở hồ sơ đích để tiếp tục.");
  if (c.status === "completed")
    throw new Error("Mở lại hồ sơ đã hoàn tất trước khi sửa đổi.");
}
function findCase(state: WorkspaceState, id: string) {
  const c = state.cases.find((c) => c.id === id);
  if (!c) throw new Error("Không tìm thấy hồ sơ.");
  return c;
}
function findDocument(state: WorkspaceState, id: string) {
  const d = state.documents.find((d) => d.id === id && d.active);
  if (!d) throw new Error("Không tìm thấy chứng từ đang hoạt động.");
  return d;
}
function documentsFor(state: WorkspaceState, c: ShipmentCase) {
  return state.documents.filter((d) => d.caseId === c.id && d.active);
}
function candidatesFor(state: WorkspaceState, caseId: string) {
  const ids = new Set(
    state.documents
      .filter((d) => d.caseId === caseId && d.active)
      .map((d) => `${d.id}:${d.version}`),
  );
  return state.candidates.filter(
    (c) =>
      c.caseId === caseId && ids.has(`${c.documentId}:${c.documentVersion}`) && c.method.startsWith("kimi:") &&
      state.documents.some(d => d.id === c.documentId && d.pages.some(p => p.page === c.page && !!p.aiReadability)),
  );
}
function audit(
  state: WorkspaceState,
  actor: Actor,
  action: string,
  reason: string,
  extra: Partial<AuditEntry> = {},
) {
  state.audit.push({
    id: uid("audit"),
    at: now(),
    actor: actor.name,
    action,
    reason,
    ...structuredClone(extra),
  });
}
function invalidate(
  state: WorkspaceState,
  c: ShipmentCase,
  actor: Actor,
  reason: string,
) {
  const priorApproval = c.approval;
  Object.values(c.fields).forEach((field) => {
    field.stale = true;
  });
  c.goods.forEach((line) => {
    line.reviewed = false;
  });
  c.declarationDraft = invalidateDeclarationDraft(c.declarationDraft, reason);
  c.resolutions = [];
  c.approval = undefined;
  c.status = "review";
  c.updatedAt = now();
  if (priorApproval)
    audit(state, actor, "approval_invalidated", reason, {
      caseId: c.id,
      before: priorApproval,
      after: null,
    });
}
function newCase(
  state: WorkspaceState,
  title: string,
  actor: Actor,
  type: ShipmentCase["caseType"] = "import",
) {
  const at = now();
  const c: ShipmentCase = {
    id: uid("case"),
    reference: `AICD-${String(state.cases.length + 1).padStart(4, "0")}`,
    title: title.trim() || "Lô hàng mới",
    status: "review",
    caseType: type,
    assignedTo: state.settings.defaultReviewer || actor.name,
    createdAt: at,
    updatedAt: at,
    documentIds: [],
    fields: {},
    goods: [],
    groupingConfidence: "low",
    groupingReason: "Chưa có đủ định danh vận đơn / hóa đơn.",
    groupingConfirmed: false,
    synthetic: false,
    resolutions: [],
    declarationDraft: { schemaVersion: 1, fields: [] },
  };
  state.cases.push(c);
  audit(state, actor, "case_created", "Tạo hồ sơ để rà soát.", {
    caseId: c.id,
    after: { title: c.title, caseType: type },
  });
  return c;
}
export function createEmptyWorkspace(id: string): WorkspaceState {
  return {
    id,
    name: "AICD Workspace",
    revision: 0,
    cases: [],
    documents: [],
    candidates: [],
    audit: [],
    emails: [],
    snapshots: [],
    handoffs: [],
    settings: {
      inboxProvider: "gmail",
      inboxAddress: "",
      inboxStatus: "not_connected",
      defaultReviewer: "",
    },
  };
}

/** Add only an empty editable draft to live cases. Historical snapshots retain their original shape. */
export function initializeDeclarationDrafts(
  state: WorkspaceState,
): WorkspaceState {
  for (const shipment of state.cases)
    if (shipment.declarationDraft == null)
      shipment.declarationDraft = { schemaVersion: 1, fields: [] };
  return state;
}

export function getProposedFields(
  state: WorkspaceState,
  caseId: string,
): Record<string, string> {
  const c = findCase(state, caseId);
  const facts = buildShipmentFacts(state, c);
  const result: Record<string, string> = {};
  for (const def of FIELD_DEFINITIONS) {
    const reviewed = c.fields[def.key];
    if (reviewed && !reviewed.stale) {
      result[def.key] = reviewed.value;
      continue;
    }
    if (def.manualOnly) continue;
    const fact = facts[def.key];
    if (fact?.status === "agreed" && fact.value && isShipmentFactClear(state, def.key, fact.candidates)) result[def.key] = fact.value;
  }
  return result;
}
function rebuildCandidatesAndGoods(
  state: WorkspaceState,
  c: ShipmentCase,
  preserveReviewed = false,
) {
  const activeVersions = new Set(
    documentsFor(state, c).map((d) => `${d.id}:${d.version}`),
  );
  // Historical readers' saved evidence stays available in history. Only current
  // Kimi readings can create new facts or goods; there is no local extraction fallback.
  // An unrelated intake must not erase reviewed AI evidence. A move changes its current case only.
  for (const candidate of state.candidates)
    if (
      activeVersions.has(
        `${candidate.documentId}:${candidate.documentVersion}`,
      ) &&
      candidate.method.startsWith("kimi:")
    )
      candidate.caseId = c.id;
  const extracted = documentsFor(state, c).map((d) => {
    // New intake is interpreted by Kimi. Historical text remains available as
    // evidence, but must not be fed through the retired local extraction path.
    const result = { candidates: [] as Candidate[], goods: [] as GoodsLine[] };
    if (!result.goods.length && documentHasType(d, "invoice")) {
      const ai = state.candidates.filter(
        (x) =>
          x.documentId === d.id &&
          x.documentVersion === d.version &&
          x.lineId &&
          x.method.startsWith("kimi:") &&
          d.pages.some(
            (page) =>
              page.page === x.page && pageDocumentType(d, page) === "invoice",
          ),
      );
      for (const lineId of [...new Set(ai.map((x) => x.lineId!))]) {
        const values = ai.filter((x) => x.lineId === lineId);
        const value = (field: string) => {
          const matches = values.filter((x) => x.field === field);
          return new Set(matches.map((x) => sameField(field, x.value))).size ===
            1
            ? matches[0].value
            : "";
        };
        // Keep partial source rows so the ECUS form can ask for their missing cells.
        if (!value("description")) continue;
        result.goods.push({
          id: lineId,
          description: value("description"),
          quantity: value("quantity"),
          unit: value("unit"),
          unitPrice: value("unitPrice"),
          amount: value("amount"),
          hsCode: value("hsCode"),
          origin: value("origin"),
          dutyRate: value("dutyRate"),
          vatRate: value("vatRate"),
          sourceDocumentId: d.id,
          sourcePage: values[0].page,
          originalText: [...new Set(values.map((x) => x.originalText))].join(
            "\n",
          ),
          reviewed: false,
          manual: false,
        });
      }
    }
    return { document: d, ...result };
  });
  state.candidates.push(...extracted.flatMap((x) => x.candidates));
  // Pick a stable invoice source, independent of attachment order. Other tables stay evidence.
  const tables = extracted
    .filter((x) => x.goods.length)
    .sort(
      (a, b) =>
        Number(documentHasType(b.document, "invoice")) -
          Number(documentHasType(a.document, "invoice")) ||
        a.document.id.localeCompare(b.document.id),
    );
  const chosenSource = c.goods.find(
    (line) => line.sourceDocumentId,
  )?.sourceDocumentId;
  const proposedGoods =
    (tables.find((table) => table.document.id === chosenSource) ?? tables[0])
      ?.goods ?? [];
  if (!preserveReviewed) c.goods = proposedGoods;
  else if (c.goods.some((g) => g.reviewed || g.manual) || c.declarationDraft?.fields.some(entry => entry.goodsLineId && entry.generatedBy !== "shipment_extraction")) {
    // A reviewed table is a human choice of rows, including deliberately omitted rows.
    // Keep that choice instead of concatenating another invoice or reviving removed lines.
    // New contradictory evidence is surfaced by refreshAfterGrouping/getIssues.
    c.goods = [...c.goods];
  } else c.goods = proposedGoods;
}
function preparedDocument(
  upload: UploadedDocument,
  caseId = "",
  version = 1,
): ShipmentDocument {
  // AI candidates belong in the evidence collection, not duplicated inside each stored document.
  const source = structuredClone(upload);
  delete source.aiCandidates;
  delete source.aiPageReadings;
  if (source.extractionPipeline === "kimi") for (const page of source.pages) {
    delete page.aiReadability;
    delete page.documentType;
  }
  if (upload.aiPageReadings) {
    // Intake can accumulate several provider batches, including a saved partial
    // result. Validate each source page once without imposing the per-call limit.
    const readings = upload.aiPageReadings;
    if (readings.length > source.pages.length || new Set(readings.map(reading => reading.page)).size !== readings.length)
      throw new Error("AI intake page readings must identify distinct source pages.");
    for (const reading of readings) {
      const page = source.pages.find(page => page.page === reading.page);
      if (!page) throw new Error("AI intake page reading refers to an absent source page.");
      validateKimiPageReadings([page], [reading], true);
      page.documentType = reading.documentType;
      page.aiReadability = reading.readability;
    }
  }
  if (source.extractionPipeline === "kimi") {
    // Only server-produced page readings can finish extraction. A caller's old
    // extracted/OCR status or page list does not prove that Kimi read the source.
    source.aiProcessedPages = upload.aiPageReadings?.map(reading => reading.page).sort((a, b) => a - b) ?? [];
    const terminalSourceFailure = ["unsupported", "failed"].includes(source.extractionStatus);
    const allRead = source.pages.length > 0 && source.pages.every(page => source.aiProcessedPages!.includes(page.page));
    if (terminalSourceFailure) {
      // Opening/conversion failures need a replacement source, not a pending AI
      // request that can never run. Preserve the original actionable message.
      source.aiProcessedPages = [];
      delete source.aiStatus;
    } else {
      source.aiStatus = allRead ? "completed" : ["unavailable", "failed"].includes(source.aiStatus ?? "") ? source.aiStatus : "partial";
      source.extractionStatus = !allRead ? "pending_ai"
        : source.pages.every(page => page.aiReadability === "clear") ? "extracted" : "needs_transcription";
      if (source.extractionStatus === "extracted") delete source.extractionError;
      else source.extractionError = source.extractionStatus === "pending_ai"
        ? "AI has not finished reading every page."
        : "AI could not clearly read every page. Retry the source or supply a clearer copy.";
    }
  }
  return {
    ...source,
    caseId,
    type: source.extractionPipeline === "kimi"
      ? source.pages.find(page => page.documentType && page.documentType !== "other")?.documentType ?? "other"
      : "other",
    version,
    active: true,
    uploadedAt: now(),
    synthetic: !!upload.synthetic,
  };
}
function preserveMergedDecisions(
  state: WorkspaceState,
  source: ShipmentCase,
  target: ShipmentCase,
  actor: Actor,
) {
  for (const [field, value] of Object.entries(source.fields)) {
    const current = target.fields[field];
    if (!current) target.fields[field] = structuredClone(value);
    else if (
      sameField(field, current.value) !== sameField(field, value.value)
    ) {
      current.stale = true;
      audit(
        state,
        actor,
        "merged_review_conflict",
        "Hai hồ sơ có quyết định khác nhau; giữ nguyên các quyết định trong lịch sử và yêu cầu rà soát.",
        {
          caseId: target.id,
          field,
          before: { target: current, source: value, sourceCaseId: source.id },
          after: current,
        },
      );
    }
  }
  for (const line of source.goods.filter((g) => g.manual || g.reviewed))
    if (!target.goods.some((g) => g.id === line.id))
      target.goods.push(structuredClone(line));
  target.declarationDraft ??= { schemaVersion: 1, fields: [] };
  for (const entry of source.declarationDraft?.fields ?? []) {
    const current = target.declarationDraft.fields.find(
      (item) =>
        item.fieldId === entry.fieldId &&
        item.goodsLineId === entry.goodsLineId,
    );
    if (!current) target.declarationDraft.fields.push(structuredClone(entry));
    else if (JSON.stringify(current.value) !== JSON.stringify(entry.value)) {
      current.stale = true;
      current.staleReason =
        "Hai hồ sơ có giá trị khai báo khác nhau trước khi nhóm.";
      audit(state, actor, "merged_declaration_conflict", current.staleReason, {
        caseId: target.id,
        field: entry.fieldId,
        before: { target: current, source: entry, sourceCaseId: source.id },
        after: current,
      });
    }
  }
}
function sourceValues(candidates: Candidate[], field: string) {
  return new Set(
    candidates
      .filter((x) => !x.lineId && x.field === field)
      .map((x) => sameField(field, x.value)),
  );
}
function refreshAfterGrouping(
  state: WorkspaceState,
  c: ShipmentCase,
  actor: Actor,
  previous: Candidate[],
  changed: boolean,
) {
  const priorGoods = structuredClone(c.goods);
  rebuildCandidatesAndGoods(state, c, true);
  const current = candidatesFor(state, c.id);
  for (const [field, decision] of Object.entries(c.fields)) {
    const before = sourceValues(previous, field);
    const after = sourceValues(current, field);
    const reviewedContainers = new Set(
      decision.value.toUpperCase().match(/[A-Z]{4}\d{7}/g) ?? [],
    );
    const addedContradiction =
      field === "container"
        ? [...after].some((value) =>
            (value.toUpperCase().match(/[A-Z]{4}\d{7}/g) ?? []).some(
              (token) => !reviewedContainers.has(token),
            ),
          )
        : [...after].some(
            (value) =>
              !before.has(value) && value !== sameField(field, decision.value),
          );
    const removedSource =
      decision.source === "candidate" &&
      !current.some((x) => x.id === decision.candidateId);
    if (addedContradiction || removedSource) decision.stale = true;
  }
  for (const line of c.goods.filter((g) => g.reviewed)) {
    const prior = priorGoods.find((g) => g.id === line.id);
    if (!prior) continue;
    const relatedIds = new Set(
      current
        .filter(
          (x) =>
            x.lineId &&
            x.field === "description" &&
            same(x.value) === same(line.description),
        )
        .map((x) => x.lineId),
    );
    const changedValues = ["quantity", "unit", "unitPrice", "amount"].some(
      (field) => {
        const oldValues = new Set(
          previous
            .filter(
              (x) => x.lineId && relatedIds.has(x.lineId) && x.field === field,
            )
            .map((x) => sameField(field, x.value)),
        );
        const newValues = current.filter(
          (x) => x.lineId && relatedIds.has(x.lineId) && x.field === field,
        );
        const units = current.filter(
          (x) => x.lineId && relatedIds.has(x.lineId) && x.field === "unit",
        );
        if (
          field !== "unit" &&
          new Set(units.map((x) => same(x.value))).size > 1
        )
          return false;
        return newValues.some(
          (x) =>
            !oldValues.has(sameField(field, x.value)) &&
            sameField(field, x.value) !==
              sameField(field, String(line[field as keyof GoodsLine] ?? "")),
        );
      },
    );
    if (
      changedValues ||
      (line.sourceDocumentId &&
        !documentsFor(state, c).some((d) => d.id === line.sourceDocumentId))
    )
      line.reviewed = false;
  }
  if (changed)
    clearApproval(
      state,
      c,
      actor,
      "Bộ chứng từ đã được bổ sung / nhóm lại; cần duyệt bản hiện hành. Các giá trị đã rà soát được giữ nguyên.",
    );
  c.synthetic =
    documentsFor(state, c).length > 0 &&
    documentsFor(state, c).every((d) => d.synthetic);
  if (c.groupingConfirmed) syncShipmentDeclaration(state, c, actor);
}
/** Receive every file first, then group the batch and only then build the combined draft. */
function regroupDocuments(
  state: WorkspaceState,
  actor: Actor,
  options: {
    newIds?: string[];
    caseIds?: string[];
    targetCaseId?: string;
    focusCaseId?: string;
  } = {},
) {
  const allowedCases = state.cases.filter(
    (c) =>
      !c.mergedInto &&
      c.status !== "completed" &&
      (!c.sourceCollection || options.caseIds?.includes(c.id)) &&
      (!options.caseIds || options.caseIds.includes(c.id)),
  );
  const allowedIds = new Set(allowedCases.map((c) => c.id));
  const newIds = new Set(options.newIds ?? []);
  const documents = state.documents.filter(
    (d) => d.active && (allowedIds.has(d.caseId) || newIds.has(d.id)),
  );
  const previous = new Map(
    allowedCases.map((c) => [
      c.id,
      structuredClone(candidatesFor(state, c.id)),
    ]),
  );
  const evidence = documents.flatMap((d) => [
    ...state.candidates.filter(
      (x) =>
        x.documentId === d.id &&
        x.documentVersion === d.version &&
        x.method.startsWith("kimi:") && d.pages.some(page => page.page === x.page && !!page.aiReadability),
    ),
  ]);
  const groups = groupShipmentDocuments(documents, evidence, allowedCases);
  const incomingGroups = groups.filter((group) =>
    group.documentIds.some((id) => newIds.has(id)),
  );
  const emptyTarget = options.targetCaseId
    ? allowedCases.find(
        (c) => c.id === options.targetCaseId && !documentsFor(state, c).length,
      )
    : undefined;
  if (
    emptyTarget &&
    incomingGroups.length === 1 &&
    !incomingGroups[0].caseIds.length
  )
    incomingGroups[0].caseIds.push(emptyTarget.id);
  for (const group of groups) {
    // A page reread may discover a genuinely related shipment, but must not
    // refresh unrelated histories merely because grouping considers all evidence.
    if (options.focusCaseId && !group.caseIds.includes(options.focusCaseId)) continue;
    const sourceCases = group.caseIds
      .map((id) => findCase(state, id))
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.reference.localeCompare(b.reference) ||
          a.id.localeCompare(b.id),
      );
    const firstDocument = group.documentIds
      .map((id) => state.documents.find((d) => d.id === id)!)
      .sort(
        (a, b) =>
          Number(documentHasType(b, "invoice")) -
            Number(documentHasType(a, "invoice")) ||
          a.name.localeCompare(b.name),
      )[0];
    const target =
      sourceCases[0] ??
      newCase(state, firstDocument.name.replace(/\.[^.]+$/, ""), actor);
    const changed =
      group.documentIds.some((id) => newIds.has(id)) || sourceCases.length > 1;
    if (!changed && options.newIds) continue;
    const beforeCandidates = sourceCases.flatMap(
      (c) => previous.get(c.id) ?? [],
    );
    for (const source of sourceCases.slice(1))
      preserveMergedDecisions(state, source, target, actor);
    for (const id of group.documentIds) {
      const document = state.documents.find((d) => d.id === id)!;
      const oldCaseId = document.caseId;
      if (oldCaseId && oldCaseId !== target.id) {
        const source = findCase(state, oldCaseId);
        source.documentIds = source.documentIds.filter(
          (existing) => existing !== id,
        );
        audit(state, actor, "document_grouped", group.reason, {
          caseId: target.id,
          before: { documentId: id, caseId: oldCaseId },
          after: { documentId: id, caseId: target.id },
        });
      }
      document.caseId = target.id;
      if (!target.documentIds.includes(id)) target.documentIds.push(id);
      // Historical candidates and snapshots remain unchanged; only active source evidence changes owner.
      state.candidates
        .filter(
          (x) => x.documentId === id && x.documentVersion === document.version,
        )
        .forEach((x) => {
          x.caseId = target.id;
        });
    }
    for (const source of sourceCases.slice(1)) {
      clearApproval(
        state,
        source,
        actor,
        "Chứng từ được nhóm vào hồ sơ đích; bản đóng băng cũ vẫn giữ nguyên.",
      );
      source.mergedInto = target.id;
      audit(state, actor, "case_merged", group.reason, {
        caseId: source.id,
        after: {
          mergedInto: target.id,
          preservedReview: source.fields,
          preservedDeclaration: source.declarationDraft,
        },
      });
    }
    target.groupingConfidence = group.confirmed ? "high" : "low";
    target.groupingConfirmed = group.confirmed;
    target.groupingReason = group.reason;
    refreshAfterGrouping(state, target, actor, beforeCandidates, changed);
    if (changed || !options.newIds)
      audit(state, actor, "shipment_grouping_evaluated", group.reason, {
        caseId: target.id,
        after: {
          documentIds: group.documentIds,
          confirmed: group.confirmed,
          evidence: group.evidence,
        },
      });
  }
}
function addUploads(
  state: WorkspaceState,
  uploads: UploadedDocument[],
  actor: Actor,
  targetCaseId?: string,
  sourceCollection?: SourceCollection,
) {
  const added: string[] = [];
  if (targetCaseId) assertReviewable(findCase(state, targetCaseId));
  // A historical folder is a provisional packet, not proof of one customs movement.
  let packet = sourceCollection ? state.cases.find(c => !c.mergedInto && c.sourceCollection?.name === sourceCollection.name && c.sourceCollection.folder === sourceCollection.folder) : undefined;
  if (sourceCollection && targetCaseId) throw new Error('A collection packet cannot target a live shipment.');
  if (packet) assertReviewable(packet);
  const previousPacketCandidates = packet ? structuredClone(candidatesFor(state, packet.id)) : [];
  for (const upload of uploads) {
    if (!present(upload.id) || !present(upload.sha256) || !present(upload.name))
      throw new Error("Chứng từ thiếu ID, tên hoặc SHA-256.");
    const duplicate = state.documents.find((d) => d.sha256 === upload.sha256);
    if (duplicate) {
      const paths = [...new Set([...(duplicate.sourcePaths ?? []), ...(upload.sourcePaths ?? [])])].slice(0, 100);
      if (paths.length !== (duplicate.sourcePaths?.length ?? 0)) {
        duplicate.sourcePaths = paths;
        audit(state, actor, 'document_source_linked', 'Giữ thêm đường dẫn nguồn của bản trùng; không thay đổi chứng từ hoặc quyết định đã rà soát.', { caseId: duplicate.caseId, after: { documentId: duplicate.id, sourcePaths: paths } });
      }
      audit(
        state,
        actor,
        "duplicate_document_skipped",
        "Bỏ qua bản có cùng SHA-256; giữ nguyên bản gốc.",
        {
          caseId: duplicate.caseId,
          after: {
            existingDocumentId: duplicate.id,
            uploadedName: upload.name,
          },
        },
      );
      continue;
    }
    if (state.documents.some((d) => d.id === upload.id))
      throw new Error("ID chứng từ đã tồn tại.");
    const document = preparedDocument(upload);
    state.documents.push(document);
    added.push(document.id);
    // Trusted server ingestion supplies only already grounded candidates. The public schema excludes them.
    state.candidates.push(
      ...(upload.aiCandidates ?? []).map((candidate) => ({
        ...structuredClone(candidate),
        caseId: "",
        documentId: document.id,
        documentVersion: document.version,
      })),
    );
  }
  if (added.length && sourceCollection) {
    packet ??= newCase(state, sourceCollection.folder.slice(0, 200), actor, sourceCollection.caseType ?? "unknown");
    if (!packet.sourceCollection && sourceCollection.caseType) packet.caseType = sourceCollection.caseType;
    packet.sourceCollection = { ...structuredClone(sourceCollection), caseType: packet.caseType };
    packet.groupingConfirmed = false;
    packet.groupingConfidence = 'low';
    packet.groupingReason = 'Chứng từ được giữ theo thư mục nguồn. Chưa xác nhận cùng một lô hàng; đối chiếu số vận đơn, hóa đơn, ngày và chiều vận chuyển trước khi lập tờ khai.';
    for (const id of added) {
      const document = state.documents.find(d => d.id === id)!;
      document.caseId = packet.id;
      packet.documentIds.push(id);
    }
    refreshAfterGrouping(state, packet, actor, previousPacketCandidates, true);
    packet.updatedAt = now();
    audit(state, actor, 'source_collection_received', packet.groupingReason, {caseId: packet.id, after: {sourceCollection, documentIds: added}});
  } else if (added.length) regroupDocuments(state, actor, { newIds: added, targetCaseId });
  for (const id of added) {
    const document = state.documents.find((d) => d.id === id)!;
    const c = findCase(state, document.caseId);
    audit(state, actor, "document_received", c.groupingReason, {
      caseId: c.id,
      after: {
        documentId: document.id,
        name: document.name,
        type: document.type,
        sha256: document.sha256,
        extractionStatus: document.extractionStatus,
      },
    });
    for (const candidate of state.candidates.filter(
      (x) => x.documentId === id && x.normalizations.length,
    ))
      audit(
        state,
        actor,
        "safe_normalization",
        candidate.normalizations.map((x) => x.reason).join(" "),
        {
          caseId: c.id,
          field: candidate.field,
          before: candidate.normalizations[0].before,
          after: candidate.value,
        },
      );
  }
  return added;
}

function fingerprint(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
export function getIssues(state: WorkspaceState, caseId?: string): Issue[] {
  const issues: Issue[] = [];
  for (const c of state.cases.filter(
    (x) => !x.mergedInto && (!caseId || x.id === caseId),
  )) {
    const docs = documentsFor(state, c);
    const candidates = candidatesFor(state, c.id);
    const facts = buildShipmentFacts(state, c);
    const proposed = getProposedFields(state, c.id);
    const sourceRead = (document: ShipmentDocument) => documentSourceReady(state, document);
    const extractionComplete =
      c.groupingConfirmed &&
      docs.filter(d => !d.referenceOnly).every(sourceRead);
    const add = (
      key: string,
      kind: Issue["kind"],
      title: string,
      description: string,
      field?: string,
      evidence: Candidate[] = [],
      documentIds: string[] = [],
      inherentlyResolved = false,
      severity: Issue["severity"] = "error",
    ) => {
      const implicatedRow = kind === "goods" ? c.goods.find(line =>
        ["goods-uncertain", "goods-incomplete", "goods-price-format", "goods-math"].some(prefix => key === `${prefix}-${line.id}`),
      ) : undefined;
      const goodsEvidence = implicatedRow ? [implicatedRow] : key === "goods-total" ? c.goods : [];
      const fp = fingerprint({
        key,
        description,
        values: evidence.map((x) => [x.id, x.value]),
        docs: documentIds.map((id) => {
          const d = state.documents.find((x) => x.id === id);
          return [id, d?.version];
        }),
        fieldValue: field ? c.fields[field] : undefined,
        // Review flags on another row are not evidence for this question.
        goods: kind === "goods" ? goodsEvidence.map(line => ({ id: line.id, description: line.description, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice, amount: line.amount, sourceDocumentId: line.sourceDocumentId, sourcePage: line.sourcePage })) : undefined,
      });
      const id = `${c.id}:${key}`;
      const resolution = c.resolutions.find(
        (r) => r.issueId === id && r.fingerprint === fp,
      );
      issues.push({
        id,
        caseId: c.id,
        kind,
        title,
        description,
        field,
        candidateIds: evidence.map((x) => x.id),
        documentIds: [
          ...new Set([...documentIds, ...evidence.map((x) => x.documentId)]),
        ],
        severity,
        fingerprint: fp,
        resolved: inherentlyResolved || !!resolution,
        resolution,
      });
    };
    const scope = caseScopeMessage(c.caseType);
    if (scope) {
      add("unsupported", "unsupported", scope.title, scope.description,
        undefined, [], [], false, c.caseType === "reference" ? "warning" : "error");
      // Import-only checks would create irrelevant missing-field questions for
      // exports and reference collections. Their originals and facts remain saved.
      continue;
    }
    if (!c.groupingConfirmed)
      add(
        "grouping",
        "grouping",
        "Xác nhận nhóm chứng từ",
        c.groupingReason,
        undefined,
        [],
        docs.map((d) => d.id),
      );
    for (const d of docs) {
      if (d.referenceOnly) continue;
      if (d.extractionPipeline !== "kimi") {
        add(`kimi-original-${d.id}`, "document", "Cần AI đọc bản gốc", "Dữ liệu cũ chưa được AI đọc. Ứng dụng sẽ đọc lại bản gốc khi AI được cấu hình; chưa yêu cầu bổ sung thông tin từ nội dung chưa đọc.", undefined, [], [d.id]);
        continue;
      }
      const clearlySupplemental = sourceRead(d) && d.pages.every(page => page.documentType === "other");
      if (d.extractionStatus === "pending_ai") {
        add(`document-${d.id}`, "document", "Đang chờ AI đọc chứng từ",
          d.aiError || "AI chưa đọc xong chứng từ này. Chỉ kiểm tra thông tin còn thiếu sau khi đã xử lý đầy đủ bộ chứng từ.",
          undefined, [], [d.id]);
        continue;
      }
      if (!sourceRead(d))
        add(
          `document-${d.id}`,
          "document",
          d.extractionStatus === "needs_transcription" ||
            d.pages.some(page => page.aiReadability === "uncertain") || d.aiRejectedPages?.length
            ? "AI chưa đọc rõ chứng từ"
            : "Chưa đọc được chứng từ",
          d.extractionError || d.aiError || "AI chưa đọc rõ tất cả các trang. Thử đọc lại hoặc cung cấp bản rõ hơn.",
          undefined,
          [],
          [d.id],
        );
      else if (!clearlySupplemental && !candidates.some((x) => x.documentId === d.id))
        add(
          `layout-${d.id}`,
          "uncertain",
          "Bố cục chưa trích xuất được",
          "Trình đọc nhãn / bảng chưa nhận diện được dữ liệu. Đối chiếu nguồn và nhập các giá trị thủ công, sau đó ghi lý do xác nhận.",
          undefined,
          [],
          [d.id],
        );
      if (d.type === "other" && !d.classificationConfirmed && !clearlySupplemental)
        add(
          `classification-${d.id}`,
          "document",
          "Chứng từ chưa phân loại",
          "Chọn loại chứng từ sau khi kiểm tra nội dung.",
          undefined,
          [],
          [d.id],
        );
      const pageNumbers = d.pages.map((p) => p.page);
      if (
        pageNumbers.length &&
        (Math.min(...pageNumbers) !== 1 ||
          new Set(pageNumbers).size !== pageNumbers.length ||
          Math.max(...pageNumbers) !== pageNumbers.length)
      )
        add(
          `pages-${d.id}`,
          "document",
          "Thứ tự trang cần kiểm tra",
          "Các số trang không liên tục hoặc trùng lặp; cần thay thế bằng bộ trang đầy đủ.",
          undefined,
          [],
          [d.id],
        );
    }
    for (const def of FIELD_DEFINITIONS) {
      const values = facts[def.key]?.candidates ?? [];
      const reviewed = c.fields[def.key];
      const validReview =
        !!reviewed && !reviewed.stale && present(reviewed.value);
      const distinct = new Set(
        values.map((x) =>
          def.key === "container" &&
          /^(?:[A-Z]{4}\d{7})(?:\s*[,;/]\s*[A-Z]{4}\d{7})*$/i.test(x.value)
            ? "container-set"
            : sameField(x.field, x.value),
        ),
      );
      // Required fields are checked against the ECUS form below. The source
      // panel must not add a second, different set of mandatory header fields.
      if (distinct.size > 1)
        add(
          `conflict-${def.key}`,
          "conflict",
          `Mâu thuẫn ${def.label.toLowerCase()}`,
          "Nguồn ghi các giá trị khác nhau. Chọn giá trị hoặc nhập hiệu chỉnh và ghi căn cứ.",
          def.key,
          values,
          [],
          validReview && present(reviewed.reason),
        );
      if (reviewed?.stale)
        add(
          `stale-${def.key}`,
          "stale",
          `Rà soát lại ${def.label.toLowerCase()}`,
          "Bộ chứng từ đã thay đổi kể từ quyết định trước. Cần lưu lại quyết định trên nguồn hiện tại.",
          def.key,
          values,
        );
      else if (
        !validReview &&
        values.length &&
        !def.manualOnly &&
        distinct.size <= 1 &&
        !isShipmentFactClear(state, def.key, values)
      )
        add(
          `review-${def.key}`,
          "uncertain",
          `Rà soát ${def.label.toLowerCase()}`,
          values.some((x) => x.confidence !== "high")
            ? "Nguồn có giá trị chưa chắc chắn hoặc định dạng mơ hồ; cần kiểm tra và xác nhận."
            : "Giá trị mới chỉ là đề xuất từ nguồn; cần người rà soát xác nhận.",
          def.key,
          values,
        );
    }
    if (!c.goods.length && extractionComplete)
      add(
        "goods-missing",
        "goods",
        "Thiếu dòng hàng",
        "Chưa có bảng hàng có thể rà soát; cần nhập ít nhất một dòng hàng.",
      );
    else if (c.goods.length) {
      const uncertainGoods = c.goods.filter(
        (g) =>
          !g.reviewed &&
          (g.manual || !g.sourceDocumentId ||
            ["description", "quantity", "unit", "unitPrice", "amount"].some((field) => {
              const value = String(g[field as keyof GoodsLine] ?? "");
              if (!value) return false; // Missing cells have their own specific question.
              const evidence = candidates.filter((candidate) => candidate.lineId === g.id && candidate.field === field);
              return !isShipmentFactClear(state, field, evidence) ||
                !evidence.some((candidate) => sameField(field, candidate.value) === sameField(field, value));
            })),
      );
      for (const line of uncertainGoods)
        add(
          `goods-uncertain-${line.id}`,
          "goods",
          `Rà soát dòng hàng: ${line.description}`,
          "Dòng hàng này có dữ liệu chưa được xác nhận. Kiểm tra mô tả, số lượng, đơn vị và trị giá rồi xác nhận riêng dòng này.",
          undefined,
          candidates.filter((candidate) => line.id === candidate.lineId),
        );
      for (const g of c.goods) {
        const qty = parseExactDecimal(g.quantity),
          price = parseExactDecimal(g.unitPrice),
          amount = parseExactDecimal(g.amount);
        if (
          !present(g.description) ||
          !present(g.unit) ||
          !qty ||
          qty.coefficient <= BigInt(0) ||
          !amount
        )
          add(
            `goods-incomplete-${g.id}`,
            "goods",
            "Dòng hàng thiếu dữ liệu",
            "Mỗi dòng cần mô tả, đơn vị, số lượng dương và thành tiền ở định dạng số rõ ràng.",
          );
        if (g.unitPrice !== "" && !price)
          add(
            `goods-price-format-${g.id}`,
            "goods",
            "Đơn giá cần làm rõ",
            "Đơn giá đã nhập phải là số thập phân rõ ràng, không có dấu phân nhóm hoặc số mũ. Giá trị gốc được giữ nguyên.",
          );
        if (
          qty &&
          price &&
          amount &&
          !withinGuideLineTolerance(multiplyDecimal(qty, price), amount)
        )
          add(
            `goods-math-${g.id}`,
            "goods",
            "Thành tiền dòng chưa khớp",
            `${g.description}: số lượng × đơn giá = ${formatDecimal(multiplyDecimal(qty, price))}, thành tiền = ${g.amount}. Chênh lệch vượt ±1 theo mục 1.86 của hướng dẫn được cung cấp.`,
            undefined,
            candidates.filter((x) => x.lineId === g.id),
          );
      }
      const total = parseExactDecimal(proposed.invoiceTotal || "");
      const amounts = c.goods.map((g) => parseExactDecimal(g.amount));
      if (total && amounts.every((x) => x !== undefined)) {
        const sum = amounts.reduce((n, x) => addDecimal(n, x!), {
          coefficient: BigInt(0),
          scale: 0,
        });
        if (compareDecimal(total, sum) !== 0)
          add(
            "goods-total",
            "goods",
            "Tổng dòng hàng chưa khớp hóa đơn",
            `Tổng thành tiền ${formatDecimal(sum)}; trị giá hóa đơn ${formatDecimal(total)}. So sánh chính xác, chưa áp dụng làm tròn. Giải thích chênh lệch, phí hoặc chiết khấu.`,
            "invoiceTotal",
            candidates.filter((x) => x.field === "invoiceTotal"),
          );
      }
    }
    const weights = getComparableShipmentWeights(state, c, proposed);
    if (weights && compareDecimal(weights.net, weights.gross) > 0)
      add(
        "weight",
        "goods",
        "Trọng lượng tịnh lớn hơn cả bì",
        `Trọng lượng tịnh ${formatDecimal(weights.net)} kg; cả bì ${formatDecimal(weights.gross)} kg. Kiểm tra đơn vị và nguồn.`,
        "netWeight",
        candidates.filter((x) =>
          ["netWeight", "grossWeight"].includes(x.field),
        ),
      );
    // Reconcile repeated descriptions, quantities, units and prices across all document tables.
    const groups = new Map<string, Candidate[]>();
    for (const desc of candidates.filter(
      (x) => x.lineId && x.field === "description",
    )) {
      const key = same(desc.value);
      groups.set(key, [...(groups.get(key) ?? []), desc]);
    }
    for (const [description, descriptions] of groups) {
      if (
        new Set(descriptions.map((x) => `${x.documentId}:${x.page}`)).size < 2
      )
        continue;
      for (const field of ["quantity", "unit", "unitPrice", "amount"]) {
        const lineIds = new Set(descriptions.map((x) => x.lineId));
        const evidence = candidates.filter(
          (x) => x.field === field && lineIds.has(x.lineId),
        );
        const unitValues = candidates.filter(
          (x) => x.field === "unit" && lineIds.has(x.lineId),
        );
        if (
          field !== "unit" &&
          new Set(unitValues.map((x) => same(x.value))).size > 1
        )
          continue;
        if (new Set(evidence.map((x) => sameField(x.field, x.value))).size > 1)
          add(
            `line-conflict-${fingerprint(description)}-${field}`,
            "conflict",
            `Mâu thuẫn dòng hàng: ${field}`,
            `${description}: các bảng chứng từ ghi khác nhau. Rà soát dòng hàng và ghi rõ quyết định xử lý.`,
            undefined,
            evidence,
            [],
            c.goods.some((g) => same(g.description) === description) &&
              c.goods.filter((g) => same(g.description) === description).every(
                (g) => g.reviewed && present(g.reason),
              ),
          );
      }
    }
    // A document's invoice pages are one list, not competing full-shipment
    // lists. Packing components without explicit row units cannot establish
    // that their descriptions/counts describe the same commercial goods.
    const sourceDescriptions = docs.filter(document => !document.referenceOnly).flatMap(document =>
      (["invoice", "packing_list"] as const).flatMap(role => {
        const pages = new Set(document.pages.filter(page => pageDocumentType(document, page) === role).map(page => page.page));
        const evidence = candidates.filter(candidate => candidate.documentId === document.id && pages.has(candidate.page) && candidate.lineId);
        const descriptions = evidence.filter(candidate => candidate.field === "description");
        const rows = [...new Set(descriptions.map(candidate => candidate.lineId))].map(lineId => {
          const fields = (field: string) => evidence.filter(candidate => candidate.lineId === lineId && candidate.field === field);
          const description = fields("description"), quantity = fields("quantity"), unit = fields("unit");
          if (![description, quantity, unit].every(values => values.length && isShipmentFactClear(state, values[0].field, values))) return undefined;
          return { description: same(description[0].value), unit: same(unit[0].value) };
        });
        if (!rows.length || rows.some(row => !row)) return [];
        const complete = rows.filter(row => row !== undefined);
        return [{ role, values: complete.map(row => row.description).sort(), units: [...new Set(complete.map(row => row.unit))].sort(), descriptions }];
      }),
    );
    const conflictingDescriptions = sourceDescriptions.flatMap((left, index) => sourceDescriptions.slice(index + 1).flatMap(right =>
      (left.role === "invoice" || right.role === "invoice") &&
      JSON.stringify(left.units) === JSON.stringify(right.units) &&
      JSON.stringify(left.values) !== JSON.stringify(right.values)
        ? [...left.descriptions, ...right.descriptions] : [],
    ));
    if (conflictingDescriptions.length)
      add(
        "goods-description-conflict",
        "conflict",
        "Danh sách hàng giữa chứng từ khác nhau",
        "Mô tả / số dòng trên hóa đơn và phiếu đóng gói không trùng. Cần đối chiếu bảng hàng và ghi lý do xử lý.",
        undefined,
        [...new Map(conflictingDescriptions.map(candidate => [candidate.id, candidate])).values()],
        [],
        c.goods.every((g) => g.reviewed) &&
          c.goods.every((g) => present(g.reason)),
      );
    for (const field of [
      "invoiceTotal",
      "packageCount",
      "containerCount",
      "grossWeight",
      "netWeight",
    ]) {
      const reviewed = c.fields[field];
      if (
        reviewed &&
        !reviewed.stale &&
        reviewed.value &&
        !parseExactDecimal(reviewed.value, {
          integer: ["packageCount", "containerCount"].includes(field),
        })
      )
        add(
          `number-${field}`,
          "uncertain",
          "Giá trị số cần làm rõ",
          ["packageCount", "containerCount"].includes(field)
            ? "Số kiện phải là số nguyên rõ ràng, không có dấu phân nhóm."
            : "Nhập số không có dấu phân nhóm, dùng dấu chấm cho phần thập phân.",
          field,
        );
    }
    for (const field of ["invoiceDate", "packingListDate", "arrivalDate"]) {
      const date = c.fields[field];
      if (date && !date.stale && !isIsoDate(date.value))
        add(
          field === "invoiceDate"
            ? "date-format"
            : `date-format-${field}`,
          "uncertain",
          field === "invoiceDate"
            ? "Ngày hóa đơn cần làm rõ"
            : field === "packingListDate" ? "Ngày phiếu đóng gói cần làm rõ" : "Ngày hàng đến cần làm rõ",
          "Xác nhận ngày thực tế và nhập YYYY-MM-DD để loại bỏ định dạng mơ hồ.",
          field,
        );
    }
    const ecusEvidenceIssues = getEcusEvidenceIssues(state, c, {
      header: new Set(FIELD_DEFINITIONS.map(field => field.key)),
      goods: new Set(["description", "quantity", "unit", "unitPrice", "amount"]),
    });
    issues.push(
      ...ecusEvidenceIssues,
      ...getDeclarationIssues(c.declarationDraft, {
        caseId: c.id,
        documents: state.documents,
        candidates: state.candidates,
        goods: c.goods,
      }).filter(issue => !issue.id.endsWith(':required') ||
        (extractionComplete && !ecusEvidenceIssues.some(evidence => evidence.ecusFieldKey === issue.ecusFieldKey && evidence.goodsLineId === issue.goodsLineId))),
    );
    const recentRun = state.handoffs.filter((h) => h.caseId === c.id).at(-1);
    if (
      recentRun?.status === "failed" &&
      recentRun.snapshotId === c.approval?.snapshotId
    )
      add(
        "transfer",
        "transfer",
        "Tạo nháp ECUS thử nghiệm thất bại",
        recentRun.message,
      );
  }
  return issues;
}

function clearApproval(
  state: WorkspaceState,
  c: ShipmentCase,
  actor: Actor,
  reason: string,
) {
  if (c.approval)
    audit(state, actor, "approval_invalidated", reason, {
      caseId: c.id,
      before: c.approval,
      after: null,
    });
  c.approval = undefined;
  c.status = "review";
  c.updatedAt = now();
}
/** Clones before mutation. The API must additionally enforce authenticated membership and a revision CAS. */
export function applyAction(
  original: WorkspaceState,
  action: Action,
  actor: Actor,
): WorkspaceState {
  if (!present(actor.id) || !present(actor.name))
    throw new Error("Cần người dùng đã đăng nhập có tên để ghi nhật ký.");
  const state = initializeDeclarationDrafts(structuredClone(original));
  const previousQuestions = recordsReviewHistory(action) && "caseId" in action
    ? getIssues(original, action.caseId)
    : [];
  if (action.type === "apply_email_matches" || action.type === "review_email_match" || action.type === "email_matching_status") {
    applyEmailGroupingAction(state, action, actor);
  } else if (action.type === "seed_demo") {
    if (state.documents.some((d) => d.synthetic))
      throw new Error("Dữ liệu demo đã có trong workspace.");
    for (const sample of syntheticShipments()) {
      addUploads(state, sample.documents, actor, undefined, { name: 'Synthetic demonstration', folder: sample.title, caseType: 'import' });
      const c = state.cases.find(item => item.sourceCollection?.name === 'Synthetic demonstration' && item.sourceCollection.folder === sample.title)!;
      if (sample.documents.length > 1) {
        c.groupingConfirmed = true;
        c.groupingConfidence = "high";
        c.groupingReason =
          "Bộ chứng từ tổng hợp đã được tạo cùng một lô hàng; không phải kết quả đánh giá trên khách hàng thật.";
      }
    }
    audit(
      state,
      actor,
      "demo_seeded",
      "Người dùng chủ động nạp 3 bộ dữ liệu tổng hợp; không có chứng từ khách hàng thật.",
    );
  } else if (action.type === "create_case") {
    if (!present(action.title)) throw new Error("Cần tên hồ sơ.");
    newCase(state, action.title, actor, action.caseType);
  } else if (action.type === "add_ai_candidates") {
    // Internal server-only action. The public mutation schema deliberately does not expose it.
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    const document = findDocument(state, action.documentId);
    if (document.referenceOnly)
      throw new Error('Reference-only documents cannot supply shipment AI proposals.');
    if (document.caseId !== c.id || document.version !== action.documentVersion)
      throw new Error(
        "Chứng từ đã thay đổi; cần gửi lại yêu cầu trên bản hiện tại.",
      );
    const readingState = () => JSON.stringify({
      type: document.type, pipeline: document.extractionPipeline,
      status: document.extractionStatus, error: document.extractionError,
      aiStatus: document.aiStatus, aiError: document.aiError,
      processed: document.aiProcessedPages, rejected: document.aiRejectedPages,
      pages: document.pages.map(page => [page.page, page.documentType, page.aiReadability]),
    });
    const previousReadingState = readingState();
    const visionEvidence = action.visionEvidence ?? [];
    const pages = selectKimiPages(document, action.pages, visionEvidence.map(page => page.page));
    const kimiOnly = document.extractionPipeline === "kimi" || action.pageReadings !== undefined;
    const pageReadings = validateKimiPageReadings(pages, action.pageReadings, kimiOnly);
    const uncertainPages = new Set(pageReadings?.filter(reading => reading.readability === "uncertain").map(reading => reading.page));
    const grounded = groundKimiProposals(
      document,
      pages,
      action.proposals.map(proposal => uncertainPages.has(proposal.page)
        ? { ...proposal, confidence: "low", readability: "uncertain" }
        : proposal),
      action.model,
      visionEvidence,
    );
    const selectedPages = pages.map(page => page.page);
    if (kimiOnly) {
      document.extractionPipeline = "kimi";
      for (const reading of pageReadings!) {
        const page = document.pages.find(page => page.page === reading.page)!;
        page.documentType = reading.documentType;
        page.aiReadability = reading.readability;
      }
      if (!document.classificationConfirmed) {
        document.type = document.pages.find(page => page.documentType && page.documentType !== "other")?.documentType ?? "other";
      }
    }
    // A PDF/image is complete only after its visual pages were actually sent. A text-only
    // pass must not hide unread scans or imply that all page layouts were checked.
    const needsVision = document.mime === "application/pdf" || document.mime.startsWith("image/");
    const processedPages = needsVision ? visionEvidence.filter(image => pages.some(page => page.page === image.page)).map(image => image.page) : pages.map(page => page.page);
    document.aiProcessedPages = [...new Set([...(document.aiProcessedPages ?? []), ...processedPages])].sort((a, b) => a - b);
    document.aiStatus = document.pages.every(page => document.aiProcessedPages!.includes(page.page)) ? "completed" : "partial";
    if (kimiOnly) {
      document.extractionStatus = document.aiStatus !== "completed" ? "pending_ai" :
        document.pages.every(page => page.aiReadability === "clear") ? "extracted" : "needs_transcription";
      if (document.extractionStatus === "extracted") delete document.extractionError;
      else document.extractionError = document.extractionStatus === "pending_ai"
        ? "AI has not finished reading every page."
        : "AI could not clearly read every page. Retry the source or supply a clearer copy.";
    }
    // Progress means the page was processed, not that every model interpretation
    // passed grounding. Keep rejected-page warnings until those pages are rerun cleanly.
    const rejectedPages = grounded.rejectionDiagnostics?.filter(diagnostic => selectedPages.includes(diagnostic.page)).map(diagnostic => diagnostic.page) ?? [];
    // Attribute a rejected reading to its actual source page, preserving clean
    // neighbours. An entirely un-attributable rejection cannot certify the batch.
    const pagesToRetry = rejectedPages.length ? rejectedPages : grounded.rejected ? selectedPages : [];
    document.aiRejectedPages = [...new Set([
      ...(document.aiRejectedPages ?? []).filter(page => !selectedPages.includes(page)),
      ...pagesToRetry,
    ])].sort((a, b) => a - b);
    const warnings = [
      ...(document.aiStatus === "partial" ? ["AI has not checked every page. Continue the remaining pages."] : []),
      ...(document.aiRejectedPages.length ? [`Some AI proposals failed source evidence checks on pages: ${document.aiRejectedPages.join(", ")}. Check these pages or rerun them; rejected values were not saved.`] : []),
    ];
    if (warnings.length) document.aiError = warnings.join(" ");
    else delete document.aiError;
    const existing = candidatesFor(state, c.id);
    const sameProof = (prior: Candidate, candidate: Candidate) =>
      prior.documentId === candidate.documentId && prior.documentVersion === candidate.documentVersion &&
      prior.field === candidate.field && prior.page === candidate.page && prior.lineId === candidate.lineId &&
      prior.value === candidate.value && prior.originalText === candidate.originalText && prior.method === candidate.method &&
      JSON.stringify(prior.visualEvidence) === JSON.stringify(candidate.visualEvidence);
    if (kimiOnly) for (const candidate of grounded.candidates) {
      const prior = existing.find(prior => sameProof(prior, candidate));
      if (prior) candidate.id = prior.id;
    }
    const retired = kimiOnly ? existing.filter(candidate =>
      candidate.documentId === document.id && candidate.documentVersion === document.version &&
      selectedPages.includes(candidate.page) && !candidate.method.startsWith("manual_transcription")) : [];
    const retiredIds = new Set(retired.map(candidate => candidate.id));
    const fresh = grounded.candidates.filter(
      (candidate) =>
        kimiOnly || !existing.some(
          (prior) =>
            prior.documentId === candidate.documentId &&
            prior.documentVersion === candidate.documentVersion &&
            prior.field === candidate.field &&
            prior.page === candidate.page &&
            prior.value === candidate.value &&
            prior.originalText === candidate.originalText &&
            prior.method === candidate.method &&
            JSON.stringify(prior.visualEvidence) === JSON.stringify(candidate.visualEvidence) &&
            prior.confidence === candidate.confidence && prior.confidenceScore === candidate.confidenceScore && prior.readability === candidate.readability,
        ),
    );
    if (fresh.length || retired.length || kimiOnly) {
      const materialChange = previousReadingState !== readingState() ||
        (kimiOnly
          ? retired.length !== fresh.length || retired.some(prior => !fresh.some(candidate =>
            sameProof(prior, candidate) && prior.confidence === candidate.confidence && prior.readability === candidate.readability))
          : fresh.length > 0);
      const affected = new Set([...fresh, ...retired].map((candidate) => candidate.field));
      for (const field of affected)
        if (
          c.fields[field] &&
          (fresh.some(
            (candidate) =>
              candidate.field === field &&
              sameField(field, candidate.value) !==
                sameField(field, c.fields[field].value),
          ) || (c.fields[field].candidateId && retiredIds.has(c.fields[field].candidateId!) &&
            !fresh.some(candidate => candidate.id === c.fields[field].candidateId)))
        )
          c.fields[field].stale = true;
      // Each resolution is bound to its own issue fingerprint. A changed value
      // reopens that issue naturally; rereading another field or only changing
      // a model estimate must not erase a reviewer's unchanged explanation.
      if (materialChange) clearApproval(
        state,
        c,
        actor,
        "Có đề xuất AI mới; cần rà soát lại các trường bị ảnh hưởng.",
      );
      const previousCandidates = structuredClone(existing);
      if (retired.length) {
        state.candidates = state.candidates.filter(candidate => !retiredIds.has(candidate.id));
        audit(state, actor, "ai_source_evidence_replaced", "AI reread these pages; prior machine evidence is retained in this audit record.", {
          caseId: c.id, before: retired, after: fresh.map(candidate => candidate.id),
        });
      }
      state.candidates.push(...fresh);
      if (c.sourceCollection) {
        // Samples are provisional packets. Add evidence inside the packet without
        // silently grouping it with a live shipment or confirming its membership.
        rebuildCandidatesAndGoods(state, c, true);
        refreshAfterGrouping(state, c, actor, previousCandidates, materialChange);
      } else regroupDocuments(state, actor, { focusCaseId: c.id });
      for (const candidate of fresh.filter(
        (candidate) => candidate.normalizations.length,
      ))
        audit(
          state,
          actor,
          "safe_normalization",
          candidate.normalizations.map((change) => change.reason).join(" "),
          {
            caseId: c.id,
            field: candidate.field,
            before: candidate.normalizations[0].before,
            after: candidate.value,
          },
        );
    }
    audit(
      state,
      actor,
      "ai_header_proposals_received",
      "AI đã đọc các trang nguồn được chọn và lưu đề xuất kèm bằng chứng. Dữ liệu không tự được duyệt và không phải quyết định hải quan.",
      {
        caseId: c.id,
        after: {
          provider: action.model === DEFAULT_DOCUMENT_MODEL ? "Z.ai" : "Moonshot International",
          endpoint: action.model === DEFAULT_DOCUMENT_MODEL ? ZAI_ENDPOINT : KIMI_ENDPOINT,
          model: action.model,
          scope: visionEvidence.length ? "shipment_facts_and_goods_vision" : "shipment_facts_and_goods_text",
          visionPages: visionEvidence.map(page => page.page),
          documentId: document.id,
          documentVersion: document.version,
          pages: pages.map((page) => page.page),
          pageReadings: action.pageReadings,
          added: fresh.length,
          rejected: grounded.rejected,
          rejectionDiagnostics: grounded.rejectionDiagnostics,
          duplicate: grounded.candidates.length - fresh.length,
          candidateIds: fresh.map((candidate) => candidate.id),
        },
      },
    );
  } else if (action.type === "intake") {
    const emails = [
      ...(action.emails ?? []),
      ...(action.email ? [action.email] : []),
    ];
    if (!action.documents.length && !emails.length)
      throw new Error("Chưa chọn chứng từ để tải lên.");
    const receivedEmails: typeof emails = [];
    const duplicateEmailIds = new Set<string>();
    for (const email of emails) {
      const existing = [...state.emails, ...receivedEmails].find(
        (e) => e.messageId === email.messageId || e.sha256 === email.sha256,
      );
      if (existing) {
        duplicateEmailIds.add(email.id);
        audit(
          state,
          actor,
          "duplicate_email_skipped",
          "Email đã nhận trước đó (Message-ID hoặc SHA-256 trùng).",
          { after: { emailId: existing.id } },
        );
      } else receivedEmails.push(email);
    }
    // Every nonduplicate email in this batch is grouped together, not one email at a time.
    const uploads = action.documents.filter((d) =>
      d.sourceEmailId
        ? !duplicateEmailIds.has(d.sourceEmailId)
        : !(emails.length === 1 && duplicateEmailIds.has(emails[0].id)),
    );
    const ids = addUploads(state, uploads, actor, action.targetCaseId, action.sourceCollection);
    for (const received of receivedEmails) {
      const email = structuredClone(received);
      const attachments = uploads.filter(
        (d) =>
          d.sourceEmailId === email.id ||
          (emails.length === 1 && !d.sourceEmailId),
      );
      email.documentIds = [
        ...new Set([
          ...email.documentIds.filter((id) =>
            state.documents.some((d) => d.id === id),
          ),
          ...attachments.flatMap((d) =>
            state.documents
              .filter(
                (existing) =>
                  existing.sha256 === d.sha256 ||
                  (ids.includes(existing.id) && existing.id === d.id),
              )
              .map((x) => x.id),
          ),
        ]),
      ];
      state.emails.push(email);
      audit(
        state,
        actor,
        "email_received",
        "Lưu nguyên bản email và thông tin nguồn. Không gửi email tự động.",
        {
          after: {
            emailId: email.id,
            sender: email.sender,
            receivedAt: email.receivedAt,
            documentIds: email.documentIds,
          },
        },
      );
    }
  } else if (action.type === 'refresh_case_automation') {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    syncShipmentDeclaration(state, c, actor);
    syncAutomaticQuestionDrafts(state, actor, getIssues(state, c.id), action.locale, c.id);
  } else if (action.type === 'refresh_extraction') {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    reasonRequired(action.reason);
    const previous = structuredClone(candidatesFor(state, c.id));
    refreshAfterGrouping(state, c, actor, previous, true);
    const current = candidatesFor(state, c.id);
    for (const [field, value] of Object.entries(c.fields)) {
      if (value.source === 'candidate' && !current.some(candidate => candidate.id === value.candidateId && candidate.field === field && sameField(field, candidate.value) === sameField(field, value.value))) value.stale = true;
    }
    c.updatedAt = now();
    audit(state, actor, 'extraction_refreshed', action.reason, {caseId:c.id, after:{candidates:current.length}});
  } else if (action.type === "regroup_existing") {
    if (action.caseIds)
      for (const id of action.caseIds) assertReviewable(findCase(state, id));
    regroupDocuments(state, actor, { caseIds: action.caseIds });
  } else if (
    action.type === "draft_questions" ||
    action.type === "save_email_draft" ||
    action.type === "approve_email_draft"
  ) {
    const caseId =
      action.type === "draft_questions"
        ? action.caseId
        : state.emailDrafts?.find((draft) => draft.id === action.draftId)
            ?.caseId;
    if (!caseId) throw new Error("Không tìm thấy bản nháp email.");
    const c = findCase(state, caseId);
    assertReviewable(c);
    applyCorrespondenceAction(state, action, actor, getIssues(state, caseId));
  } else if (action.type === 'apply_client_memory' || action.type === 'dismiss_client_memory' || action.type === 'revoke_client_memory') {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    if (c.caseType !== 'import') throw new Error('Client suggestions apply to import declarations only.');
    if (action.type === 'apply_client_memory') {
      const savedAction = clientMemorySaveAction(state, c, action);
      const before = c.declarationDraft?.fields.find(entry => entry.fieldId === savedAction.fieldId && !entry.goodsLineId) ?? null;
      c.declarationDraft = saveDeclarationField(c.declarationDraft, savedAction, { caseId: c.id, documents: state.documents, candidates: state.candidates, goods: c.goods, actor, at: now() });
      clearApproval(state, c, actor, 'Client information was explicitly applied; review the current declaration again.');
      syncShipmentDeclaration(state, c, actor);
      audit(state, actor, 'client_memory_applied', savedAction.reason, { caseId: c.id, field: savedAction.fieldId, before, after: { memoryId: action.memoryId, entry: c.declarationDraft.fields.find(entry => entry.fieldId === savedAction.fieldId && !entry.goodsLineId) } });
    } else {
      const memory = dismissOrRevokeClientMemory(state, c, action, actor, now());
      audit(state, actor, action.type === 'revoke_client_memory' ? 'client_memory_revoked' : 'client_memory_dismissed', action.type === 'revoke_client_memory' ? 'Stop suggesting this remembered client correction.' : 'Dismiss this suggestion for the current shipment.', { caseId: c.id, field: memory.fieldKey, after: { memoryId: memory.id } });
    }
  } else if (action.type === "remove_declaration_field") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    const before =
      c.declarationDraft?.fields.find(
        (entry) =>
          entry.fieldId === action.fieldId &&
          entry.goodsLineId === action.goodsLineId,
      ) ?? null;
    c.declarationDraft = removeDeclarationField(c.declarationDraft, action, {
      caseId: c.id,
      documents: state.documents,
      candidates: state.candidates,
      goods: c.goods,
    });
    clearApproval(
      state,
      c,
      actor,
      "Bản nháp chỉ tiêu khai báo thay đổi; cần duyệt lại phiên bản hiện hành.",
    );
    audit(state, actor, "declaration_field_removed", action.reason.trim(), {
      caseId: c.id,
      field: action.fieldId,
      before,
      after: null,
    });
  } else if (action.type === "save_declaration_field") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    if (c.caseType !== "import") throw new Error("Chỉ hồ sơ nhập khẩu mới sử dụng biểu mẫu nhập khẩu.");
    const matches = (entry: { fieldId: string; goodsLineId?: string }) =>
      entry.fieldId === action.fieldId &&
      entry.goodsLineId === action.goodsLineId;
    const before = c.declarationDraft?.fields.find(matches) ?? null;
    const identityBefore = getClientIdentity(c);
    c.declarationDraft = saveDeclarationField(c.declarationDraft, action, {
      caseId: c.id,
      documents: state.documents,
      candidates: state.candidates,
      goods: c.goods,
      actor,
      at: now(),
    });
    // Keep the commercial table used by arithmetic checks and reports aligned
    // with edits in the IDA form. A cell edit never approves the entire row.
    const line = action.goodsLineId ? c.goods.find(line => line.id === action.goodsLineId) : undefined;
    if (line && action.applicability === "applicable") {
      const mappings: Record<string, Record<string, keyof Pick<GoodsLine, "description" | "quantity" | "unit" | "unitPrice" | "amount" | "hsCode" | "origin" | "dutyRate" | "vatRate">>> = {
        "1.78": { text: "description" }, "1.74": { code: "hsCode" }, "1.79": { code: "origin" },
        "1.83": { amount: "quantity", unitCode: "unit" }, "1.86": { amount: "unitPrice" },
        "1.85": { amount: "amount" }, "1.76": { amount: "dutyRate" }, "ecus.vatTaxRate": { amount: "vatRate" },
      };
      let changed = false;
      for (const [component, key] of Object.entries(mappings[action.fieldId] || {})) {
        const value = (action.value as unknown as Record<string, string>)[component];
        if (typeof value === "string" && line[key] !== value) { line[key] = value; changed = true; }
      }
      if (changed) { line.manual = true; line.reviewed = false; line.reason = action.reason; }
    }
    clearApproval(
      state,
      c,
      actor,
      "Bản nháp chỉ tiêu khai báo thay đổi; cần duyệt lại phiên bản hiện hành.",
    );
    syncShipmentDeclaration(state, c, actor);
    const memory = rememberClientCorrection(state, c, action, before, actor, now(), identityBefore);
    if (memory) audit(state, actor, 'client_memory_recorded', 'Saved an explicit human correction for suggestions in later declarations for this client.', { caseId: c.id, field: memory.fieldKey, after: { memoryId: memory.id, previousValue: memory.previousValue, value: memory.value } });
    audit(
      state,
      actor,
      action.review ? "declaration_field_reviewed" : "declaration_field_saved",
      action.reason.trim(),
      {
        caseId: c.id,
        field: action.fieldId,
        before,
        after: c.declarationDraft.fields.find(matches),
      },
    );
  } else if (action.type === "review_field") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    const definition = FIELD_DEFINITIONS.find((f) => f.key === action.field);
    if (!definition) throw new Error("Trường dữ liệu chưa được hỗ trợ.");
    const values = candidatesFor(state, c.id).filter(
      (x) => !x.lineId && x.field === action.field,
    );
    const candidate = action.candidateId
      ? values.find((x) => x.id === action.candidateId)
      : undefined;
    if (action.candidateId && !candidate)
      throw new Error(
        "Ứng viên không thuộc trường / hồ sơ / phiên bản chứng từ đang dùng.",
      );
    const value = action.value.trim();
    const manual =
      definition.manualOnly || !candidate || value !== candidate.value;
    const conflict =
      new Set(values.map((x) => sameField(x.field, x.value))).size > 1;
    if (manual || conflict || candidate?.confidence !== "high")
      reasonRequired(action.reason);
    if (definition.required && !value)
      throw new Error("Trường bắt buộc không được để trống.");
    const before = c.fields[action.field];
    const reviewed: ReviewedValue = {
      value,
      source: manual ? "manual" : "candidate",
      candidateId: candidate?.id,
      reason: action.reason.trim() || "Đã đối chiếu với chứng từ nguồn.",
      reviewedBy: actor.name,
      reviewedAt: now(),
      stale: false,
      unverified: !!definition.manualOnly,
    };
    clearApproval(state, c, actor, "Giá trị đã rà soát thay đổi.");
    c.fields[action.field] = reviewed;
    syncShipmentDeclaration(state, c, actor);
    audit(state, actor, "field_reviewed", reviewed.reason, {
      caseId: c.id,
      field: action.field,
      before: before ?? null,
      after: reviewed,
    });
  } else if (action.type === "review_goods") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    reasonRequired(action.reason);
    if (!action.goods.length) throw new Error("Cần ít nhất một dòng hàng.");
    if (new Set(action.goods.map((g) => g.id)).size !== action.goods.length)
      throw new Error("ID dòng hàng bị trùng.");
    // Saving a table is not approval. Only explicitly named rows receive a new
    // review decision; clients cannot approve rows by setting their flags.
    const reviewedLineIds = new Set(action.reviewedLineIds ?? []);
    if (reviewedLineIds.size !== (action.reviewedLineIds ?? []).length)
      throw new Error("ID dòng hàng xác nhận bị trùng.");
    if ([...reviewedLineIds].some((id) => !action.goods.some((g) => g.id === id)))
      throw new Error("Chỉ xác nhận dòng hàng có trong bảng đã gửi.");
    const before = structuredClone(c.goods);
    const activeDocs = documentsFor(state, c);
    const existingCandidates = candidatesFor(state, c.id);
    c.goods = action.goods.map((g) => {
      const old = before.find((x) => x.id === g.id);
      if (!present(g.id)) throw new Error("Dòng hàng cần ID.");
      if (g.sourceDocumentId) {
        const source = activeDocs.find((d) => d.id === g.sourceDocumentId);
        if (
          !source ||
          (g.sourcePage && !source.pages.some((p) => p.page === g.sourcePage))
        )
          throw new Error(
            "Nguồn dòng hàng phải thuộc chứng từ đang hoạt động trong hồ sơ.",
          );
        const originalLine = existingCandidates.find(
          (x) => x.lineId === g.id && x.documentId === g.sourceDocumentId,
        );
        const unchangedSource = old?.sourceDocumentId === g.sourceDocumentId && old?.sourcePage === g.sourcePage && old?.originalText === g.originalText;
        if (!unchangedSource && ((old?.sourceDocumentId === g.sourceDocumentId && g.originalText !== old.originalText) || (originalLine && g.originalText !== originalLine.originalText)))
          throw new Error("Không được thay đổi văn bản nguồn của dòng hàng.");
      }
      const changed =
        !old ||
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
          "sourceDocumentId",
          "sourcePage",
          "originalText",
        ].some(
          (key) => g[key as keyof GoodsLine] !== old[key as keyof GoodsLine],
        );
      if (old && !changed && !reviewedLineIds.has(g.id))
        return structuredClone(old);
      return {
        ...structuredClone(g),
        reviewed: reviewedLineIds.has(g.id) || (!!old?.reviewed && !changed),
        manual:
          !!old?.manual ||
          changed ||
          !g.sourceDocumentId ||
          !!g.hsCode ||
          !!g.origin ||
          !!g.dutyRate ||
          !!g.vatRate,
        reason: action.reason.trim(),
      };
    });
    clearApproval(state, c, actor, "Bảng hàng đã thay đổi.");
    syncShipmentDeclaration(state, c, actor);
    audit(state, actor, reviewedLineIds.size ? "goods_reviewed" : "goods_saved", action.reason.trim(), {
      caseId: c.id,
      before,
      after: c.goods,
    });
  } else if (action.type === "resolve_issue") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    reasonRequired(action.reason);
    const issue = getIssues(state, c.id).find((i) => i.id === action.issueId);
    if (!issue || issue.resolved)
      throw new Error("Vấn đề không còn cần xử lý.");
    const explainable =
      ["goods-total", "weight"].some(
        (suffix) => issue.id === `${c.id}:${suffix}`,
      ) ||
      issue.id.startsWith(`${c.id}:goods-math-`) ||
      (issue.kind === "uncertain" && !issue.field);
    if (!explainable)
      throw new Error(
        "Cần sửa dữ liệu / rà soát giá trị / xác nhận nhóm để xử lý vấn đề này; không thể chỉ bỏ qua.",
      );
    clearApproval(state, c, actor, "Quyết định xử lý vấn đề thay đổi.");
    c.resolutions = c.resolutions.filter((r) => r.issueId !== issue.id);
    c.resolutions.push({
      issueId: issue.id,
      fingerprint: issue.fingerprint,
      reason: action.reason.trim(),
      actor: actor.name,
      at: now(),
    });
    audit(state, actor, "issue_resolved", action.reason.trim(), {
      caseId: c.id,
      before: issue,
      after: c.resolutions.at(-1),
    });
  } else if (action.type === "confirm_grouping") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    reasonRequired(action.reason);
    if (!documentsFor(state, c).length)
      throw new Error("Chưa có chứng từ để xác nhận nhóm.");
    clearApproval(state, c, actor, "Xác nhận nhóm chứng từ.");
    c.groupingConfirmed = true;
    c.groupingReason = action.reason.trim();
    syncShipmentDeclaration(state, c, actor);
    audit(state, actor, "grouping_confirmed", action.reason.trim(), {
      caseId: c.id,
      after: c.documentIds,
    });
  } else if (
    action.type === "move_documents" ||
    action.type === "merge_cases"
  ) {
    let ids: string[];
    let target: ShipmentCase;
    if (action.type === "merge_cases") {
      if (action.sourceCaseId === action.targetCaseId)
        throw new Error("Không thể ghép hồ sơ vào chính nó.");
      const source = findCase(state, action.sourceCaseId);
      assertReviewable(source);
      target = findCase(state, action.targetCaseId);
      preserveMergedDecisions(state, source, target, actor);
      ids = documentsFor(state, source).map((d) => d.id);
    } else {
      ids = [...new Set(action.documentIds)];
      target = action.targetCaseId
        ? findCase(state, action.targetCaseId)
        : newCase(state, action.title || "Lô hàng tách mới", actor);
    }
    assertReviewable(target);
    if (!ids.length) throw new Error("Chọn ít nhất một chứng từ để chuyển.");
    const affected = new Set<string>([target.id]);
    for (const id of ids) {
      const document = findDocument(state, id);
      const source = findCase(state, document.caseId);
      assertReviewable(source);
      if (source.id === target.id) continue;
      affected.add(source.id);
      source.documentIds = source.documentIds.filter((x) => x !== id);
      target.documentIds.push(id);
      document.caseId = target.id;
      audit(
        state,
        actor,
        action.type === "merge_cases"
          ? "case_documents_merged"
          : "document_moved",
        "Người dùng sửa nhóm chứng từ; cần xác nhận và rà soát lại.",
        {
          caseId: target.id,
          before: { documentId: id, caseId: source.id },
          after: { documentId: id, caseId: target.id },
        },
      );
    }
    for (const id of affected) {
      const c = findCase(state, id);
      invalidate(state, c, actor, "Chứng từ được chuyển / ghép hồ sơ.");
      c.groupingConfirmed = false;
      c.groupingConfidence = "medium";
      c.groupingReason = "Nhóm đã thay đổi thủ công; cần xác nhận lại.";
      c.synthetic =
        documentsFor(state, c).length > 0 &&
        documentsFor(state, c).every((d) => d.synthetic);
      rebuildCandidatesAndGoods(state, c, true);
      syncShipmentDeclaration(state, c, actor);
    }
    if (action.type === "merge_cases") {
      const source = findCase(state, action.sourceCaseId);
      if (!documentsFor(state, source).length) {
        source.mergedInto = target.id;
        audit(
          state,
          actor,
          "case_merged",
          "Hồ sơ nguồn được giữ làm lịch sử và liên kết đến hồ sơ đích; không đánh dấu hoàn tất.",
          { caseId: source.id, after: { mergedInto: target.id } },
        );
      }
    }
  } else if (action.type === "replace_document") {
    const previous = findDocument(state, action.documentId);
    const c = findCase(state, previous.caseId);
    assertReviewable(c);
    const upload = action.document;
    if (state.documents.some((d) => d.sha256 === upload.sha256))
      throw new Error(
        "Bản thay thế trùng nội dung đã lưu; không tạo phiên bản mới.",
      );
    if (state.documents.some((d) => d.id === upload.id))
      throw new Error("ID bản thay thế phải là ID mới.");
    previous.active = false;
    const replacement: ShipmentDocument = {
      ...preparedDocument(upload, c.id, previous.version + 1),
      replacesId: previous.id,
    };
    state.documents.push(replacement);
    c.documentIds.push(replacement.id);
    state.candidates.push(
      ...(upload.aiCandidates ?? []).map((candidate) => ({
        ...structuredClone(candidate),
        caseId: c.id,
        documentId: replacement.id,
        documentVersion: replacement.version,
      })),
    );
    invalidate(
      state,
      c,
      actor,
      "Chứng từ được thay thế; các quyết định trước không còn được coi là hiện hành.",
    );
    c.groupingConfirmed = false;
    c.groupingReason =
      "Có phiên bản chứng từ mới; cần xác nhận vẫn thuộc cùng hồ sơ.";
    rebuildCandidatesAndGoods(state, c, true);
    syncShipmentDeclaration(state, c, actor);
    audit(
      state,
      actor,
      "document_replaced",
      "Giữ nguyên bản cũ và lưu phiên bản thay thế.",
      {
        caseId: c.id,
        before: {
          documentId: previous.id,
          version: previous.version,
          sha256: previous.sha256,
        },
        after: {
          documentId: replacement.id,
          version: replacement.version,
          sha256: replacement.sha256,
        },
      },
    );
  } else if (action.type === "classify_document") {
    const document = findDocument(state, action.documentId);
    const c = findCase(state, document.caseId);
    assertReviewable(c);
    if (!(action.documentType in DOCUMENT_LABELS))
      throw new Error("Loại chứng từ không hợp lệ.");
    const before = document.type;
    document.type = action.documentType;
    document.classificationConfirmed = true;
    document.version++;
    delete document.aiProcessedPages;
    delete document.aiRejectedPages;
    delete document.aiStatus;
    delete document.aiError;
    if (document.extractionPipeline === "kimi") {
      if (!["unsupported", "failed"].includes(document.extractionStatus)) {
        document.extractionStatus = "pending_ai";
        document.extractionError = "AI must read the current document version.";
      }
      for (const page of document.pages) delete page.aiReadability;
    }
    invalidate(state, c, actor, "Phân loại chứng từ thay đổi.");
    c.groupingConfirmed = false;
    rebuildCandidatesAndGoods(state, c, true);
    syncShipmentDeclaration(state, c, actor);
    audit(
      state,
      actor,
      "document_classified",
      "Người rà soát chọn loại chứng từ.",
      { caseId: c.id, before, after: action.documentType },
    );
  } else if (action.type === "transcribe_document") {
    const document = findDocument(state, action.documentId);
    const c = findCase(state, document.caseId);
    assertReviewable(c);
    reasonRequired(action.reason);
    if (
      !action.pages.length ||
      !action.pages.some((p) => p.text.trim()) ||
      action.pages.some((p) => !Number.isInteger(p.page) || p.page < 1)
    )
      throw new Error("Cần nội dung trang và số trang dương hợp lệ.");
    const before = {
      version: document.version,
      pages: structuredClone(document.pages),
      extractionStatus: document.extractionStatus,
    };
    const merged = new Map(document.pages.map((p) => [p.page, p]));
    for (const page of action.pages)
      merged.set(page.page, {
        page: page.page,
        text: page.text,
        textSource: "manual",
        documentType: page.documentType,
      });
    document.pages = [...merged.values()].sort((a, b) => a.page - b.page);
    document.transcribedPages = [
      ...new Set([
        ...(document.transcribedPages ?? []),
        ...action.pages.map((p) => p.page),
      ]),
    ];
    document.version++;
    delete document.aiProcessedPages;
    delete document.aiRejectedPages;
    delete document.aiStatus;
    delete document.aiError;
    const assessment = assessExtraction(document.pages);
    document.extractionStatus = document.extractionPipeline === "kimi" ? "pending_ai" : assessment.extractionStatus;
    document.extractionError = document.extractionPipeline === "kimi"
      ? "AI must read the current document version." : assessment.extractionError;
    if (document.extractionPipeline === "kimi") for (const page of document.pages) delete page.aiReadability;
    invalidate(state, c, actor, "Nội dung chép từ chứng từ thay đổi.");
    c.groupingConfirmed = false;
    rebuildCandidatesAndGoods(state, c, true);
    syncShipmentDeclaration(state, c, actor);
    audit(state, actor, "document_transcribed", action.reason.trim(), {
      caseId: c.id,
      before,
      after: {
        documentId: document.id,
        version: document.version,
        pages: document.pages,
      },
    });
  } else if (action.type === "update_case") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    const before = {
      title: c.title,
      assignedTo: c.assignedTo,
      caseType: c.caseType,
    };
    if (action.title !== undefined) {
      if (!present(action.title))
        throw new Error("Tên hồ sơ không được trống.");
      c.title = action.title.trim();
    }
    if (action.assignedTo !== undefined) {
      if (!present(action.assignedTo)) throw new Error("Cần người phụ trách.");
      c.assignedTo = action.assignedTo.trim();
    }
    if (action.caseType && c.caseType !== action.caseType) {
      c.caseType = action.caseType;
      if (c.sourceCollection) c.sourceCollection.caseType = action.caseType;
      invalidate(state, c, actor, "Loại hồ sơ thay đổi.");
    }
    c.updatedAt = now();
    audit(state, actor, "case_updated", action.reason?.trim() || "Cập nhật thông tin hồ sơ.", {
      caseId: c.id,
      before,
      after: { title: c.title, assignedTo: c.assignedTo, caseType: c.caseType },
    });
  } else if (action.type === "approve") {
    const c = findCase(state, action.caseId);
    assertReviewable(c);
    if (c.caseType !== "import") throw new Error("Chỉ hồ sơ nhập khẩu mới sử dụng biểu mẫu nhập khẩu.");
    const unresolved = getIssues(state, c.id).filter((i) => !i.resolved);
    if (unresolved.length)
      throw new Error(
        `Còn ${unresolved.length} vấn đề chưa xử lý; chưa thể đóng băng bản rà soát.`,
      );
    if (c.approval) throw new Error("Bản hiện tại đã được phê duyệt.");
    const id = uid("snapshot");
    const at = now();
    c.status = "approved";
    c.approval = { actor: actor.name, at, snapshotId: id };
    c.updatedAt = at;
    state.snapshots.push({
      id,
      caseId: c.id,
      createdAt: at,
      actor: actor.name,
      version: state.snapshots.filter((s) => s.caseId === c.id).length + 1,
      declaration: structuredClone(c),
      documents: structuredClone(documentsFor(state, c)),
      candidates: structuredClone(candidatesFor(state, c.id)),
      issues: structuredClone(getIssues(state, c.id)),
      customsValidation: "Not yet assessed",
    });
    audit(
      state,
      actor,
      "snapshot_approved",
      "Đóng băng bản rà soát nghiệp vụ AICD. Không phải phê duyệt hải quan hay xác nhận tuân thủ.",
      { caseId: c.id, after: { snapshotId: id } },
    );
  } else if (action.type === "handoff") {
    const c = findCase(state, action.caseId);
    if (c.caseType !== "import") throw new Error("Chỉ hồ sơ nhập khẩu mới sử dụng biểu mẫu nhập khẩu.");
    if (c.status !== "approved" || !c.approval)
      throw new Error(
        "Phê duyệt và đóng băng bản rà soát trước khi tạo nháp ECUS thử nghiệm.",
      );
    if (
      getIssues(state, c.id).some((i) => !i.resolved && i.kind !== "transfer")
    )
      throw new Error("Còn vấn đề phải xử lý trước khi tạo nháp.");
    const snapshot = state.snapshots.find(
      (s) => s.id === c.approval!.snapshotId,
    );
    if (!snapshot) throw new Error("Không tìm thấy bản đóng băng.");
    const existing = successfulRunForSnapshot(state.handoffs, snapshot.id);
    if (existing)
      audit(
        state,
        actor,
        "handoff_idempotent_reuse",
        "Bản đóng băng này đã có nháp TEST; trả về cùng kết quả, không tạo trùng.",
        {
          caseId: c.id,
          after: {
            runId: existing.id,
            draftReference: existing.draftReference,
          },
        },
      );
    else {
      const idempotencyKey = `aicd:${state.id}:${snapshot.id}`;
      const result = simulateTestDraft(
        snapshot,
        idempotencyKey,
        action.simulateFailure,
      );
      const run = {
        id: uid("handoff"),
        caseId: c.id,
        snapshotId: snapshot.id,
        idempotencyKey,
        at: now(),
        actor: actor.name,
        connector: "test" as const,
        ...result,
        idaStatus: "not_transmitted" as const,
        idcStatus: "not_registered" as const,
        customsOutcome: "not_assessed" as const,
      };
      state.handoffs.push(run);
      audit(state, actor, "ecus_test_handoff", result.message, {
        caseId: c.id,
        after: run,
      });
    }
  } else if (action.type === "complete") {
    const c = findCase(state, action.caseId);
    reasonRequired(action.reason);
    assertReviewable(c);
    if (![actor.id, actor.name, actor.email].includes(c.assignedTo))
      throw new Error("Chỉ người phụ trách hồ sơ được đánh dấu hoàn tất.");
    if (!c.approval || c.status !== "approved")
      throw new Error("Cần phê duyệt bản rà soát hiện tại trước khi hoàn tất.");
    if (getIssues(state, c.id).some((i) => !i.resolved))
      throw new Error("Vẫn còn việc cần xử lý; hồ sơ phải ở hàng đợi.");
    c.status = "completed";
    c.completedBy = actor.name;
    c.completedAt = now();
    c.updatedAt = c.completedAt;
    audit(state, actor, "case_completed", action.reason.trim(), {
      caseId: c.id,
      after: { snapshotId: c.approval.snapshotId, completedBy: actor.name },
    });
  } else if (action.type === "reopen") {
    const c = findCase(state, action.caseId);
    reasonRequired(action.reason);
    if (c.mergedInto)
      throw new Error("Hồ sơ đã được ghép; mở hồ sơ đích để tiếp tục.");
    const before = c.status;
    c.status = "review";
    c.completedBy = undefined;
    c.completedAt = undefined;
    c.approval = undefined;
    c.updatedAt = now();
    audit(state, actor, "case_reopened", action.reason.trim(), {
      caseId: c.id,
      before,
      after: "review",
    });
  } else if (action.type === "settings") {
    const before = structuredClone(state.settings);
    if (action.inboxAddress !== undefined)
      state.settings.inboxAddress = action.inboxAddress.trim();
    if (action.defaultReviewer !== undefined)
      state.settings.defaultReviewer = action.defaultReviewer.trim();
    state.settings.inboxStatus = "not_connected";
    audit(
      state,
      actor,
      "settings_updated",
      "Cấu hình Gmail chưa kết nối OAuth; địa chỉ không cấp quyền truy cập.",
      { before, after: state.settings },
    );
  } else throw new Error("Hành động không được hỗ trợ.");
  if (action.type !== 'refresh_case_automation') {
    const clientMemoryChanged = (state.clientMemories?.length ?? 0) !== (original.clientMemories?.length ?? 0) || action.type === 'revoke_client_memory';
    const actionCaseId = 'caseId' in action ? action.caseId : 'draftId' in action ? state.emailDrafts?.find(draft => draft.id === action.draftId)?.caseId : undefined;
    // Grouping may move this action's evidence into an older related shipment.
    // Refresh that destination's questions while leaving unrelated cases alone.
    const changedCaseId = clientMemoryChanged ? undefined : state.cases.find(shipment => shipment.id === actionCaseId)?.mergedInto ?? actionCaseId;
    syncAutomaticQuestionDrafts(state, actor, getIssues(state, changedCaseId), undefined, changedCaseId);
  }
  if (previousQuestions.length && "caseId" in action)
    recordReviewHistory(original, state, action, actor, previousQuestions, getIssues(state, action.caseId));
  state.revision = original.revision + 1;
  return state;
}
