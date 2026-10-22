"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  History,
  List,
  Loader2,
  LockKeyhole,
  Plus,
  Save,
  X,
} from "lucide-react";
import type {
  Action,
  GoodsLine,
  Issue,
  ShipmentCase,
  WorkspaceState,
} from "@/lib/types";
import type {
  DeclarationDraft,
  DeclarationFieldEntry,
  SaveDeclarationFieldAction,
} from "@/lib/declaration-types";
import { getDeclarationField } from "@/lib/declaration-catalog";
import {
  declarationEntryKey,
  emptyDeclarationValue,
  getDeclarationEntry,
  isDeclarationSourceCurrent,
  validateDeclarationEntry,
} from "@/lib/declaration";
import { declarationDraftKey } from "@/lib/declaration-client";
import {
  ECUS_FORM_FIELDS,
  ecusFormValue,
  ecusFormValueUpdate,
  type EcusFormField,
} from "@/lib/ecus-form";
import { caseScopeMessage } from "@/lib/case-scope";
import { useLocale } from "@/lib/i18n";
import { translateIssue } from "@/lib/i18n-core";
import { VisionEvidenceImage } from "@/components/vision-evidence-image";
import { EcusFieldEvidence } from "@/components/ecus-field-evidence";
import { EcusClientMemory } from "@/components/ecus-client-memory";
import { getClientMemorySuggestions } from "@/lib/client-memory";
import { readyForAutomaticQuestions } from "@/lib/shipment-correspondence";

export type DeclarationUiDraft = Pick<
  SaveDeclarationFieldAction,
  "applicability" | "basis" | "value" | "provenance" | "reason"
>;
type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  issues: Issue[];
  busy: boolean;
  drafts: Record<string, DeclarationUiDraft>;
  onChange: (key: string, draft: DeclarationUiDraft) => void;
  onSaved: (key: string, submitted: DeclarationUiDraft) => void;
  mutation: (action: Action, success?: string) => Promise<boolean>;
  onManageGoods: () => void;
  focusFieldId?: string;
  focusGoodsLineId?: string;
};
type EditorTab = EcusFormField["tab"];
type FieldTarget = { field: EcusFormField; goodsLineId?: string };
// Keep the ECUS navigation and control names in Vietnamese in both locales so
// users can match this form directly to the supplied ECUS screen references.
const ECUS_LABELS = {
  menu: "Tờ khai hải quan",
  title: "Đăng ký mới tờ khai nhập khẩu (IDA)",
  goods: "Danh sách hàng",
  addGoods: "Thêm mới",
};
const TABS: { id: EditorTab; label: string }[] = [
  { id: "general_1", label: "Thông tin chung" },
  { id: "general_2", label: "Thông tin chung 2" },
  { id: "goods", label: "Danh sách hàng" },
];
const GOODS_FIELDS = ECUS_FORM_FIELDS.filter((field) => field.tab === "goods");
const ECUS_FIELD_IDS = new Set(ECUS_FORM_FIELDS.map((field) => field.fieldId));
const MANUAL_NOTE =
  "Thông tin do người dùng nhập hoặc điều chỉnh trên biểu mẫu nhập khẩu IDA.";

function fromEntry(
  fieldId: string,
  entry?: DeclarationFieldEntry,
): DeclarationUiDraft {
  return {
    applicability: entry?.applicability || "applicable",
    basis: entry?.basis || MANUAL_NOTE,
    value: entry?.value || emptyDeclarationValue(fieldId),
    provenance: entry?.provenance || [],
    reason: "",
  };
}
function inputId(field: EcusFormField, goodsLineId?: string) {
  return `ecus-${field.key}-${goodsLineId || "header"}`;
}
function pendingForCase(
  drafts: Record<string, DeclarationUiDraft>,
  caseId: string,
) {
  return Object.entries(drafts).flatMap(([key, draft]) => {
    try {
      const [draftCaseId, fieldId, goodsLineId] = JSON.parse(key) as [
        string,
        string,
        string | null,
      ];
      return draftCaseId === caseId
        ? [{ key, draft, fieldId, goodsLineId: goodsLineId || undefined }]
        : [];
    } catch {
      return [];
    }
  });
}

export function DeclarationDraftEditor({
  state,
  shipment,
  issues,
  busy,
  drafts,
  onChange,
  onSaved,
  mutation,
  onManageGoods,
  focusFieldId,
  focusGoodsLineId,
}: Props) {
  const { t, locale, date } = useLocale();
  const say = (vi: string, en: string) => (locale === "en" ? en : vi);
  const initialField = ECUS_FORM_FIELDS.find(
    (field) => field.fieldId === focusFieldId || field.key === focusFieldId,
  );
  const [tab, setTab] = useState<EditorTab>(initialField?.tab || "general_1");
  const [sourceTarget, setSourceTarget] = useState<FieldTarget | null>(
    initialField
      ? { field: initialField, goodsLineId: focusGoodsLineId }
      : null,
  );
  const [focusTarget, setFocusTarget] = useState<FieldTarget | null>(
    initialField
      ? { field: initialField, goodsLineId: focusGoodsLineId }
      : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveReason, setSaveReason] = useState("");
  const [removal, setRemoval] = useState<{
    key: string;
    reason: string;
  } | null>(null);
  const editable = shipment.status === "review";
  const disabled = !editable || busy || saving;
  const memorySuggestions = useMemo(
    () => getClientMemorySuggestions(state, shipment),
    [state, shipment],
  );
  const documents = state.documents.filter(
    (document) => document.caseId === shipment.id && document.active,
  );
  const sourcesReadyForQuestions = readyForAutomaticQuestions(state, shipment);
  const sourceDocuments = documents.filter(
    (document) => !document.referenceOnly,
  );
  const sourceReadingBlocked = sourceDocuments.some((document) =>
    ["unsupported", "failed"].includes(document.extractionStatus),
  );
  const context = {
    caseId: shipment.id,
    documents,
    goods: shipment.goods,
    candidates: state.candidates,
  };
  const entries = shipment.declarationDraft?.fields || [];
  const pending = pendingForCase(drafts, shipment.id);
  const effectiveEntries = new Map(
    entries.map((entry) => [
      declarationEntryKey(entry.fieldId, entry.goodsLineId),
      entry,
    ]),
  );
  for (const item of pending) {
    effectiveEntries.set(declarationEntryKey(item.fieldId, item.goodsLineId), {
      fieldId: item.fieldId,
      goodsLineId: item.goodsLineId,
      ...item.draft,
      review: null,
      stale: false,
      updatedBy: "",
      updatedAt: "",
      codeVerification: "unverified",
    });
  }
  const effectiveDraft: DeclarationDraft = {
    schemaVersion: 1,
    fields: [...effectiveEntries.values()],
  };
  const valueOf = (field: EcusFormField, goodsLineId?: string) =>
    field.key === "goodsSequence"
      ? String(shipment.goods.findIndex((line) => line.id === goodsLineId) + 1)
      : ecusFormValue(field, effectiveDraft, goodsLineId);
  const targets: FieldTarget[] = ECUS_FORM_FIELDS.flatMap((field) =>
    field.tab === "goods"
      ? shipment.goods.map((line) => ({ field, goodsLineId: line.id }))
      : [{ field }],
  );
  const missing = targets.filter(
    ({ field, goodsLineId }) =>
      field.required &&
      !field.readOnly &&
      (!valueOf(field, goodsLineId).trim() ||
        getDeclarationEntry(effectiveDraft, field.fieldId, goodsLineId)
          ?.applicability !== "applicable"),
  );
  const sourceCount = targets.filter(({ field, goodsLineId }) => {
    const entry = getDeclarationEntry(
      shipment.declarationDraft,
      field.fieldId,
      goodsLineId,
    );
    return (
      entry?.generatedBy === "shipment_extraction" &&
      !entry.stale &&
      valueOf(field, goodsLineId).trim()
    );
  }).length;
  const staleEntries = entries.filter((entry) => entry.stale);
  const declarationIssues = issues.filter(
    (issue) => issue.kind === "declaration" && !issue.resolved,
  );
  const orphaned = entries.filter(
    (entry) =>
      entry.goodsLineId &&
      !shipment.goods.some((line) => line.id === entry.goodsLineId),
  );
  const retainedEntries = entries.filter(
    (entry) => !ECUS_FIELD_IDS.has(entry.fieldId),
  );
  const groups = [
    ...new Set(
      ECUS_FORM_FIELDS.filter((field) => field.tab === tab).map(
        (field) => field.section,
      ),
    ),
  ];

  useEffect(() => {
    if (focusTarget && focusTarget.field.tab === tab) {
      const control = document.getElementById(
        inputId(focusTarget.field, focusTarget.goodsLineId),
      );
      control?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
      control?.focus({ preventScroll: true });
    }
  }, [focusTarget, tab]);

  const getUiDraft = (field: EcusFormField, goodsLineId?: string) =>
    drafts[declarationDraftKey(shipment.id, field.fieldId, goodsLineId)] ||
    fromEntry(
      field.fieldId,
      getDeclarationEntry(
        shipment.declarationDraft,
        field.fieldId,
        goodsLineId,
      ),
    );
  const updateDraft = (
    field: EcusFormField,
    goodsLineId: string | undefined,
    change: Partial<DeclarationUiDraft>,
  ) => {
    onChange(declarationDraftKey(shipment.id, field.fieldId, goodsLineId), {
      ...getUiDraft(field, goodsLineId),
      ...change,
    });
    setError("");
  };
  const updateValue = (
    field: EcusFormField,
    goodsLineId: string | undefined,
    input: string,
  ) => {
    const draft = getUiDraft(field, goodsLineId);
    const hasManualSource = draft.provenance.some(
      (source) => source.kind === "manual",
    );
    updateDraft(field, goodsLineId, {
      value: ecusFormValueUpdate(field, draft.value, input),
      applicability: "applicable",
      basis: draft.basis || MANUAL_NOTE,
      provenance: hasManualSource
        ? draft.provenance
        : [...draft.provenance, { kind: "manual", note: MANUAL_NOTE }],
    });
  };
  const jumpTo = (target: FieldTarget) => {
    setTab(target.field.tab);
    setFocusTarget(target);
    setSourceTarget(target);
  };
  const saveDraft = async (
    fieldId: string,
    goodsLineId: string | undefined,
    submitted: DeclarationUiDraft,
    review: boolean,
  ) => {
    const ok = await mutation({
      type: "save_declaration_field",
      caseId: shipment.id,
      fieldId,
      ...(goodsLineId ? { goodsLineId } : {}),
      ...submitted,
      reason:
        submitted.reason.trim() ||
        saveReason.trim() ||
        "Cập nhật biểu mẫu đăng ký mới tờ khai nhập khẩu (IDA).",
      review,
    });
    if (ok)
      onSaved(
        declarationDraftKey(shipment.id, fieldId, goodsLineId),
        submitted,
      );
    return ok;
  };
  const saveAll = async () => {
    if (disabled || !pending.length) return;
    setSaving(true);
    setError("");
    try {
      for (const item of pending) {
        if (
          !(await saveDraft(item.fieldId, item.goodsLineId, item.draft, false))
        ) {
          setError(
            say(
              "Một mục chưa lưu được. Các thay đổi còn lại vẫn được giữ để bạn kiểm tra và lưu lại.",
              "One field could not be saved. Your remaining changes are kept so you can check and save them again.",
            ),
          );
          return;
        }
      }
    } finally {
      setSaving(false);
    }
  };
  const addGoods = async () => {
    if (disabled) return;
    const line: GoodsLine = {
      id: crypto.randomUUID(),
      description: "",
      quantity: "",
      unit: "",
      unitPrice: "",
      amount: "",
      hsCode: "",
      origin: "",
      dutyRate: "",
      vatRate: "",
      reviewed: false,
      manual: true,
      reason: "Thêm mới dòng hàng trong biểu mẫu IDA.",
    };
    setSaving(true);
    try {
      if (
        await mutation(
          {
            type: "review_goods",
            caseId: shipment.id,
            goods: [...shipment.goods, line],
            reviewedLineIds: [],
            reason: line.reason!,
          },
          say(
            "Đã thêm dòng hàng. Điền thông tin rồi lưu biểu mẫu.",
            "Goods row added. Complete the details and save the form.",
          ),
        )
      ) {
        const first = GOODS_FIELDS.find((field) => !field.readOnly);
        if (first) setFocusTarget({ field: first, goodsLineId: line.id });
      }
    } finally {
      setSaving(false);
    }
  };
  const fieldStatus = (field: EcusFormField, goodsLineId?: string) => {
    const entry = getDeclarationEntry(
      shipment.declarationDraft,
      field.fieldId,
      goodsLineId,
    );
    if (drafts[declarationDraftKey(shipment.id, field.fieldId, goodsLineId)])
      return { label: say("Chưa lưu", "Unsaved"), tone: "dirty" };
    if (entry?.stale)
      return { label: say("Nguồn thay đổi", "Source changed"), tone: "stale" };
    if (!valueOf(field, goodsLineId).trim())
      return {
        label: say("Nguồn / ghi chú", "Source / notes"),
        tone: "neutral",
      };
    if (entry?.applicability !== "applicable")
      return {
        label: say("Chưa xác nhận áp dụng", "Confirm applicability"),
        tone: "stale",
      };
    if (entry?.review)
      return { label: say("Đã rà soát", "Reviewed"), tone: "reviewed" };
    if (entry?.generatedBy === "shipment_extraction")
      return { label: say("Tự điền", "Autofilled"), tone: "autofilled" };
    return {
      label: entry
        ? say("Đã lưu", "Saved")
        : say("Nguồn / ghi chú", "Source / notes"),
      tone: "neutral",
    };
  };
  const renderControl = (
    field: EcusFormField,
    goodsLineId?: string,
    compact = false,
  ) => {
    const value = valueOf(field, goodsLineId);
    const isMissing = missing.some(
      (target) =>
        target.field.key === field.key && target.goodsLineId === goodsLineId,
    );
    const common = {
      id: inputId(field, goodsLineId),
      value,
      disabled: disabled || field.readOnly,
      "aria-label": `${field.labelVi}${goodsLineId ? ` · ${say("Dòng", "Row")} ${shipment.goods.findIndex((line) => line.id === goodsLineId) + 1}` : ""}`,
      "aria-required": field.required || undefined,
      "aria-invalid": isMissing || undefined,
      autoComplete: "off",
      onFocus: () => setSourceTarget({ field, goodsLineId }),
      placeholder: field.readOnly
        ? "—"
        : isMissing
          ? say("Cần bổ sung", "Required")
          : "—",
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => updateValue(field, goodsLineId, event.target.value),
    };
    return field.input === "long_text" && !compact ? (
      <textarea {...common} rows={3} />
    ) : (
      <input
        {...common}
        type={field.input === "date" ? "date" : "text"}
        inputMode={
          field.input === "decimal"
            ? "decimal"
            : field.input === "integer" || field.input === "year"
              ? "numeric"
              : undefined
        }
        spellCheck={field.input === "code" ? false : undefined}
      />
    );
  };
  const tabTargets = targets.filter((target) => target.field.tab === tab);
  const defaultTarget =
    tabTargets.find(
      (target) =>
        valueOf(target.field, target.goodsLineId).trim() &&
        getDeclarationEntry(
          effectiveDraft,
          target.field.fieldId,
          target.goodsLineId,
        )?.provenance.some((source) => source.kind === "document"),
    ) ?? tabTargets.find((target) => !target.field.readOnly);
  const evidenceTarget =
    sourceTarget?.field.tab === tab &&
    (!sourceTarget.goodsLineId ||
      shipment.goods.some((line) => line.id === sourceTarget.goodsLineId))
      ? sourceTarget
      : defaultTarget;
  const selected = evidenceTarget?.field;
  const selectedLineId = evidenceTarget?.goodsLineId;
  const selectedDraft = selected
    ? getUiDraft(selected, selectedLineId)
    : undefined;
  const selectedEntry = selected
    ? getDeclarationEntry(
        shipment.declarationDraft,
        selected.fieldId,
        selectedLineId,
      )
    : undefined;
  const selectedEffective = selected
    ? getDeclarationEntry(effectiveDraft, selected.fieldId, selectedLineId)
    : undefined;
  const selectedFindings = selectedEffective
    ? validateDeclarationEntry(selectedEffective, context, effectiveDraft)
    : [];
  const selectedMissing = selected
    ? missing.filter(
        (target) =>
          target.field.fieldId === selected.fieldId &&
          target.goodsLineId === selectedLineId,
      )
    : [];
  const removalControl = (entry: DeclarationFieldEntry) => {
    const entryKey = declarationEntryKey(entry.fieldId, entry.goodsLineId);
    const draftKey = declarationDraftKey(
      shipment.id,
      entry.fieldId,
      entry.goodsLineId,
    );
    if (removal?.key !== entryKey)
      return (
        <button
          className="text-button ecus-remove-saved"
          disabled={disabled}
          onClick={() => setRemoval({ key: entryKey, reason: "" })}
        >
          {say("Xóa bản nhập đã lưu", "Remove saved field")}
        </button>
      );
    return (
      <div className="ecus-removal">
        <p>
          {say(
            "Thao tác này xóa bản nhập của chỉ tiêu này khỏi biểu mẫu hiện tại. Lịch sử vẫn được giữ; các mục liên kết có thể cần rà soát lại.",
            "This removes this saved field from the current form. Its history remains available; related fields may need review.",
          )}
        </p>
        {drafts[draftKey] && (
          <p>
            {say(
              "Các thay đổi chưa lưu của chỉ tiêu này cũng sẽ bị bỏ.",
              "Unsaved changes to this field will also be discarded.",
            )}
          </p>
        )}
        <label className="ecus-control">
          <span>
            {say("Lý do xóa", "Reason for removal")}
            <b className="ecus-required"> *</b>
          </span>
          <textarea
            rows={2}
            value={removal.reason}
            disabled={disabled}
            onChange={(event) =>
              setRemoval({ key: entryKey, reason: event.target.value })
            }
          />
        </label>
        <div>
          <button
            className="button secondary small"
            disabled={busy || saving}
            onClick={() => setRemoval(null)}
          >
            {say("Hủy", "Cancel")}
          </button>
          <button
            className="button secondary small"
            disabled={disabled || !removal.reason.trim()}
            onClick={async () => {
              const submittedDraft = drafts[draftKey];
              setSaving(true);
              try {
                if (
                  await mutation(
                    {
                      type: "remove_declaration_field",
                      caseId: shipment.id,
                      fieldId: entry.fieldId,
                      ...(entry.goodsLineId
                        ? { goodsLineId: entry.goodsLineId }
                        : {}),
                      reason: removal.reason.trim(),
                    },
                    say(
                      "Đã xóa bản nhập; lịch sử vẫn được giữ.",
                      "Saved field removed; its history is retained.",
                    ),
                  )
                ) {
                  if (submittedDraft) onSaved(draftKey, submittedDraft);
                  setRemoval(null);
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            {say("Xóa bản nhập này", "Remove this saved field")}
          </button>
        </div>
      </div>
    );
  };
  const scope = caseScopeMessage(shipment.caseType);
  if (scope)
    return (
      <section className="declaration-view">
        <div className="page-title">
          <div>
            <h1>{t(scope.title)}</h1>
            <p>{t(scope.description)}</p>
          </div>
        </div>
      </section>
    );

  return (
    <section className="declaration-view ecus-form">
      <div className="ecus-breadcrumb">
        <FileText size={14} />
        <span>{ECUS_LABELS.menu}</span>
        <ChevronRight size={13} />
        <span>{ECUS_LABELS.title}</span>
      </div>
      <div className="ecus-heading">
        <div>
          <h1>{ECUS_LABELS.title}</h1>
          <p>
            {say(
              "Thông tin từ chứng từ được tự điền vào ba biểu mẫu. Kiểm tra, bổ sung và lưu ngay tại đây.",
              "Document information is autofilled into the three forms. Check, complete and save it here.",
            )}
          </p>
        </div>
        <span className="ecus-draft-badge">
          {say("Bản nháp trên website", "Website draft")}
        </span>
      </div>
      <div className="ecus-summary" aria-live="polite">
        <span>
          <Check size={14} />
          <strong>{sourceCount}</strong>{" "}
          {say("mục tự điền từ chứng từ", "fields autofilled from documents")}
        </span>
        {sourcesReadyForQuestions && (
          <span
            className={
              missing.length || !shipment.goods.length
                ? "ecus-warning-text"
                : ""
            }
          >
            <AlertCircle size={14} />
            <strong>{missing.length}</strong>{" "}
            {say("ô bắt buộc cần bổ sung", "required fields to complete")}
          </span>
        )}
        {memorySuggestions.length > 0 && (
          <button
            className="ecus-memory-summary"
            onClick={() => {
              const field = ECUS_FORM_FIELDS.find(
                (field) => field.key === memorySuggestions[0].memory.fieldKey,
              );
              if (field) jumpTo({ field });
            }}
          >
            <History size={13} />
            {say(
              `${memorySuggestions.length} gợi ý từ lần sửa trước của công ty`,
              `${memorySuggestions.length} previous company corrections to review`,
            )}
          </button>
        )}
        {staleEntries.length > 0 && (
          <span className="ecus-warning-text">
            <AlertTriangle size={14} />
            <strong>{staleEntries.length}</strong>{" "}
            {say("mục có nguồn thay đổi", "fields with changed sources")}
          </span>
        )}
        {pending.length > 0 && (
          <span className="ecus-unsaved">
            <strong>{pending.length}</strong>{" "}
            {say("mục chưa lưu", "unsaved fields")}
          </span>
        )}
      </div>
      {!sourcesReadyForQuestions && (
        <div className="ecus-source-reading" role="status">
          <FileText size={17} />
          <div>
            <strong>
              {sourceReadingBlocked
                ? say(
                    "Cần kiểm tra bản gốc chưa đọc được",
                    "Check originals that could not be read",
                  )
                : !sourceDocuments.length
                  ? say("Chờ chứng từ nguồn", "Waiting for source documents")
                  : say(
                      "Chưa hoàn tất đọc và kiểm tra nguồn",
                      "Source reading and checks are not complete",
                    )}
            </strong>
            <p>
              {say(
                "Danh sách thông tin cần hỏi sẽ được xác định sau khi AI đọc rõ toàn bộ trang và phân nhóm được xác nhận. Các ô bắt buộc vẫn được đánh dấu; bạn có thể chỉnh sửa thông tin đã có.",
                "Information requests will be identified after AI has read every page clearly and document grouping is confirmed. Required fields remain marked, and you can edit information already available.",
              )}
            </p>
          </div>
        </div>
      )}
      {sourcesReadyForQuestions &&
        (missing.length > 0 || !shipment.goods.length) && (
          <details className="ecus-missing-summary">
            <summary>
              <AlertCircle size={15} />
              {say("Thông tin cần hỏi bổ sung", "Information to request")}
              <span>{missing.length + (!shipment.goods.length ? 1 : 0)}</span>
            </summary>
            <p>
              {say(
                "Vui lòng cung cấp các thông tin dưới đây nếu chứng từ chưa có. Chọn một ô để bổ sung.",
                "Please provide the information below when it is absent from the documents. Select a field to complete it.",
              )}
            </p>
            <div className="ecus-missing-list">
              {!shipment.goods.length && (
                <button onClick={() => setTab("goods")}>
                  {ECUS_LABELS.goods} ·{" "}
                  {say(
                    "Cần ít nhất một dòng hàng",
                    "At least one goods row is needed",
                  )}
                </button>
              )}
              {missing.map((target) => (
                <button
                  key={inputId(target.field, target.goodsLineId)}
                  onClick={() => jumpTo(target)}
                >
                  {target.goodsLineId
                    ? `${say("Dòng", "Row")} ${shipment.goods.findIndex((line) => line.id === target.goodsLineId) + 1} · `
                    : `${TABS.find((item) => item.id === target.field.tab)?.label} · `}
                  {target.field.labelVi}
                </button>
              ))}
            </div>
          </details>
        )}
      {!editable && (
        <div className="ecus-readonly">
          <LockKeyhole size={15} />
          {say(
            "Hồ sơ đang ở chế độ chỉ đọc. Mở lại hồ sơ để chỉnh sửa.",
            "This shipment is read-only. Reopen it to edit.",
          )}
        </div>
      )}
      {error && (
        <div className="ecus-error" role="alert">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
      <div
        className="ecus-tabs"
        role="tablist"
        aria-label={say("Biểu mẫu nhập khẩu IDA", "IDA import forms")}
      >
        {TABS.map((item, index) => (
          <button
            key={item.id}
            id={`ecus-tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`ecus-panel-${item.id}`}
            className={tab === item.id ? "active" : ""}
            onClick={() => {
              setTab(item.id);
              setSourceTarget(null);
            }}
          >
            <span>{index + 1}</span>
            {item.label}
            {missing.some((target) => target.field.tab === item.id) && (
              <i
                aria-label={say("Còn ô bắt buộc", "Required fields incomplete")}
              />
            )}
          </button>
        ))}
      </div>
      <div className="ecus-tab-intro">
        <span>
          <b className="ecus-required">*</b>{" "}
          {tab === "goods"
            ? say(
                "Tất cả các cột hàng hóa cần được điền. STT được đánh số tự động.",
                "Complete every goods column. STT is numbered automatically.",
              )
            : say(
                "Ô bắt buộc theo dấu * trong ảnh ECUS. Điền cả thông tin khác khi có trong chứng từ.",
                "Required fields follow the red * in the ECUS reference. Also complete optional information available in the documents.",
              )}
        </span>
        <span className="ecus-autofill-key">
          <span />
          {say("Tự điền từ chứng từ", "Autofilled from documents")}
        </span>
      </div>

      <div className="ecus-editor-layout">
        <div
          id={`ecus-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`ecus-tab-${tab}`}
        >
          {tab !== "goods" ? (
            <div className="ecus-groups">
              {groups.map((section) => {
                const fields = ECUS_FORM_FIELDS.filter(
                  (field) => field.tab === tab && field.section === section,
                );
                return (
                  <section className="ecus-section" key={section}>
                    <div className="ecus-section-heading">
                      <h2>{fields[0].sectionVi}</h2>
                      <span>
                        {fields.filter((field) => valueOf(field).trim()).length}
                        /{fields.length}
                      </span>
                    </div>
                    <div className="ecus-field-grid">
                      {fields.map((field) => {
                        const status = fieldStatus(field);
                        return (
                          <div
                            className={`ecus-field ${field.input === "long_text" ? "ecus-field-wide" : ""} ${status.tone === "autofilled" ? "ecus-field-autofilled" : ""} ${selected?.key === field.key && !selectedLineId ? "ecus-field-selected" : ""}`}
                            key={field.key}
                            onClick={() => setSourceTarget({ field })}
                          >
                            <label htmlFor={inputId(field)}>
                              {field.labelVi}
                              {field.required && (
                                <b className="ecus-required" aria-hidden="true">
                                  {" "}
                                  *
                                </b>
                              )}
                            </label>
                            {renderControl(field)}
                            {!field.readOnly && (
                              <button
                                className={`ecus-field-status ${status.tone}`}
                                onClick={() => setSourceTarget({ field })}
                              >
                                <span />
                                {status.label}
                                <ChevronRight size={11} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <section className="ecus-goods-section">
              <div className="ecus-goods-toolbar">
                <div>
                  <List size={17} />
                  <h2>{ECUS_LABELS.goods}</h2>
                  <span>
                    {shipment.goods.length} {say("dòng", "rows")}
                  </span>
                </div>
                <button
                  className="button primary small"
                  disabled={disabled}
                  onClick={() => void addGoods()}
                >
                  <Plus size={15} />
                  {ECUS_LABELS.addGoods}
                </button>
              </div>
              <div
                className="ecus-goods-scroll"
                role="region"
                aria-label={say(
                  "Bảng hàng hóa, cuộn ngang để xem tất cả các cột",
                  "Goods table, scroll horizontally to view all columns",
                )}
                tabIndex={0}
              >
                <table className="ecus-goods-table">
                  <thead>
                    <tr>
                      {GOODS_FIELDS.map((field) => (
                        <th
                          key={field.key}
                          className={
                            field.key === "goodsSequence"
                              ? "ecus-row-number"
                              : field.input === "long_text"
                                ? "ecus-description-cell"
                                : ""
                          }
                        >
                          {field.labelVi}
                          {field.required && !field.readOnly && (
                            <b className="ecus-required"> *</b>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shipment.goods.map((line, index) => (
                      <tr key={line.id}>
                        {GOODS_FIELDS.map((field) => {
                          const status = fieldStatus(field, line.id);
                          return (
                            <td
                              key={field.key}
                              className={`${field.key === "goodsSequence" ? "ecus-row-number" : ""} ${status.tone === "autofilled" ? "ecus-cell-autofilled" : ""} ${selected?.key === field.key && selectedLineId === line.id ? "ecus-field-selected" : ""}`}
                              onClick={() =>
                                setSourceTarget({ field, goodsLineId: line.id })
                              }
                            >
                              {field.key === "goodsSequence" ? (
                                <span>{index + 1}</span>
                              ) : (
                                <>
                                  {renderControl(field, line.id, true)}
                                  <button
                                    className={`ecus-field-status ${status.tone}`}
                                    onClick={() =>
                                      setSourceTarget({
                                        field,
                                        goodsLineId: line.id,
                                      })
                                    }
                                  >
                                    <span />
                                    {status.label}
                                    <ChevronRight size={10} />
                                  </button>
                                </>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!shipment.goods.length && (
                <div className="ecus-goods-empty">
                  <List size={25} />
                  <h3>{say("Chưa có dòng hàng", "No goods yet")}</h3>
                  <p>
                    {say(
                      "Dòng hàng sẽ được tự điền từ chứng từ. Chọn Thêm mới để nhập một dòng hàng.",
                      "Goods will be filled from the documents. Choose Thêm mới to enter a goods row.",
                    )}
                  </p>
                  <button
                    className="button secondary small"
                    disabled={disabled}
                    onClick={() => void addGoods()}
                  >
                    <Plus size={14} />
                    {ECUS_LABELS.addGoods}
                  </button>
                </div>
              )}
              <div className="ecus-goods-footer">
                <span>
                  {say(
                    "Cuộn ngang để điền các cột trị giá và thuế.",
                    "Scroll horizontally for valuation and tax columns.",
                  )}
                </span>
                <button className="text-button" onClick={onManageGoods}>
                  {say(
                    "Đối chiếu hàng hóa từ chứng từ",
                    "Compare source goods",
                  )}
                  <ArrowUpRight size={12} />
                </button>
              </div>
              {shipment.goods.length > 0 && (
                <div className="ecus-goods-reviews">
                  {shipment.goods.map((line, index) => {
                    const missingCount = missing.filter(
                      (target) => target.goodsLineId === line.id,
                    ).length;
                    const hasPending = pending.some(
                      (item) => item.goodsLineId === line.id,
                    );
                    return (
                      <div className="ecus-goods-review" key={line.id}>
                        <div>
                          <strong>
                            {say("Dòng", "Row")} {index + 1} ·{" "}
                            {valueOf(
                              GOODS_FIELDS.find(
                                (field) => field.key === "description",
                              )!,
                              line.id,
                            ) ||
                              say(
                                "Chưa nhập tên hàng",
                                "Goods description pending",
                              )}
                          </strong>
                          <small>
                            {hasPending
                              ? say(
                                  "Lưu thay đổi trước khi xác nhận dòng hàng.",
                                  "Save your changes before confirming this row.",
                                )
                              : missingCount
                                ? say(
                                    `Còn ${missingCount} ô cần bổ sung.`,
                                    `${missingCount} required fields remain.`,
                                  )
                                : line.reviewed
                                  ? say(
                                      "Đã xác nhận dòng hàng.",
                                      "Goods row reviewed.",
                                    )
                                  : say(
                                      "Các cột đã được điền. Đối chiếu chứng từ trước khi xác nhận.",
                                      "All columns are complete. Compare the documents before confirming.",
                                    )}
                          </small>
                        </div>
                        <button
                          className="button secondary small"
                          disabled={
                            disabled ||
                            hasPending ||
                            missingCount > 0 ||
                            line.reviewed
                          }
                          onClick={async () => {
                            setSaving(true);
                            try {
                              await mutation(
                                {
                                  type: "review_goods",
                                  caseId: shipment.id,
                                  goods: shipment.goods,
                                  reviewedLineIds: [line.id],
                                  reason:
                                    saveReason.trim() ||
                                    "Đã đối chiếu thông tin dòng hàng trong biểu mẫu nhập khẩu IDA.",
                                },
                                say(
                                  "Đã xác nhận dòng hàng.",
                                  "Goods row reviewed.",
                                ),
                              );
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          <Check size={13} />
                          {line.reviewed
                            ? say("Đã xác nhận", "Reviewed")
                            : say("Xác nhận dòng hàng", "Confirm goods row")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
        {selected && selectedDraft && (
          <aside
            className="ecus-source-panel"
            aria-label={say(
              "Độ tin cậy và dẫn nguồn",
              "Confidence and evidence",
            )}
          >
            <div className="ecus-panel-heading">
              <div>
                <span>
                  {say("Độ tin cậy và dẫn nguồn", "Confidence and evidence")}
                </span>
                <h2>
                  {selected.labelVi}
                  {selectedLineId &&
                    ` · ${say("Dòng", "Row")} ${shipment.goods.findIndex((line) => line.id === selectedLineId) + 1}`}
                </h2>
              </div>
            </div>
            {selectedEntry?.stale && (
              <p className="ecus-warning-text">
                <AlertTriangle size={14} />
                {selectedEntry.staleReason ||
                  say(
                    "Chứng từ nguồn đã thay đổi. Đối chiếu lại trước khi xác nhận.",
                    "The source document changed. Compare it again before reviewing.",
                  )}
              </p>
            )}
            <EcusClientMemory
              key={selected.key}
              suggestions={
                selectedLineId
                  ? []
                  : memorySuggestions.filter(
                      (suggestion) =>
                        suggestion.memory.fieldKey === selected.key,
                    )
              }
              disabled={disabled}
              hasPendingEdit={
                !!drafts[
                  declarationDraftKey(
                    shipment.id,
                    selected.fieldId,
                    selectedLineId,
                  )
                ]
              }
              onApply={(memoryId, expectedValue) =>
                mutation(
                  {
                    type: "apply_client_memory",
                    caseId: shipment.id,
                    memoryId,
                    expectedValue,
                  },
                  say(
                    "Đã dùng thông tin từ lần sửa trước; kiểm tra biểu mẫu trước khi xác nhận.",
                    "Previous correction applied. Review the form before confirming.",
                  ),
                )
              }
              onDismiss={(memoryId) =>
                mutation(
                  {
                    type: "dismiss_client_memory",
                    caseId: shipment.id,
                    memoryId,
                  },
                  say(
                    "Đã bỏ qua gợi ý cho hồ sơ này.",
                    "Suggestion dismissed for this shipment.",
                  ),
                )
              }
              onForget={(memoryId) =>
                mutation(
                  {
                    type: "revoke_client_memory",
                    caseId: shipment.id,
                    memoryId,
                  },
                  say(
                    "Đã ngừng gợi ý thông tin này.",
                    "This correction will no longer be suggested.",
                  ),
                )
              }
            />
            <EcusFieldEvidence
              state={state}
              shipment={shipment}
              field={selected}
              goodsLineId={selectedLineId}
              currentValue={valueOf(selected, selectedLineId)}
              entry={selectedEntry}
              provenance={selectedDraft.provenance}
              basis={selectedDraft.basis}
              unsaved={
                !!drafts[
                  declarationDraftKey(
                    shipment.id,
                    selected.fieldId,
                    selectedLineId,
                  )
                ]
              }
            />
            <details className="ecus-evidence-edit">
              <summary>
                {say(
                  "Chỉnh sửa dẫn nguồn và rà soát",
                  "Edit evidence and review",
                )}
              </summary>
              <div className="ecus-evidence-list">
                {selectedDraft.provenance.map((source, index) => {
                  const sourceDocument =
                    source.kind === "document"
                      ? documents.find(
                          (document) =>
                            document.id === source.documentId &&
                            document.version === source.documentVersion,
                        )
                      : undefined;
                  const current = isDeclarationSourceCurrent(source, context);
                  return (
                    <div className="ecus-evidence" key={index}>
                      <div>
                        {source.kind === "manual" ? (
                          <label className="ecus-control">
                            <span>
                              {say("Căn cứ nhập tay", "Manual source or basis")}
                            </span>
                            <textarea
                              rows={2}
                              value={source.note}
                              disabled={disabled}
                              onChange={(event) =>
                                updateDraft(selected, selectedLineId, {
                                  provenance: selectedDraft.provenance.map(
                                    (item, at) =>
                                      at === index
                                        ? {
                                            kind: "manual",
                                            note: event.target.value,
                                          }
                                        : item,
                                  ),
                                })
                              }
                            />
                          </label>
                        ) : (
                          <>
                            <a
                              href={`/api/documents/${source.documentId}#page=${source.page}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {sourceDocument?.name ||
                                say("Chứng từ nguồn", "Source document")}{" "}
                              · v{source.documentVersion} ·{" "}
                              {say("trang", "page")} {source.page}
                              <ArrowUpRight size={12} />
                            </a>
                            <blockquote>{source.quote}</blockquote>
                            {!current && (
                              <p className="ecus-warning-text">
                                {say(
                                  "Bằng chứng này không còn khớp phiên bản nguồn hiện hành.",
                                  "This evidence no longer matches the current source version.",
                                )}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      <button
                        className="icon-button"
                        disabled={disabled}
                        aria-label={say("Bỏ nguồn", "Remove source")}
                        onClick={() =>
                          updateDraft(selected, selectedLineId, {
                            provenance: selectedDraft.provenance.filter(
                              (_, at) => at !== index,
                            ),
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
              {!selectedDraft.provenance.length && (
                <p>
                  {say(
                    "Chưa có chứng từ cung cấp thông tin này. Nhập dữ liệu và ghi căn cứ khi bạn nhận được thông tin.",
                    "No document supplies this information yet. Enter the value and record its source when it is provided.",
                  )}
                </p>
              )}
              {selectedDraft.applicability !== "applicable" && (
                <div className="ecus-applicability">
                  <p>
                    {say(
                      "Thông tin đã lưu chưa được xác nhận sử dụng cho tờ khai này.",
                      "The stored information has not been confirmed for use in this declaration.",
                    )}
                  </p>
                  <button
                    className="button secondary small"
                    disabled={disabled}
                    onClick={() =>
                      updateDraft(selected, selectedLineId, {
                        applicability: "applicable",
                        basis: selectedDraft.basis || MANUAL_NOTE,
                      })
                    }
                  >
                    {say("Sử dụng thông tin này", "Use this information")}
                  </button>
                </div>
              )}
              <button
                className="text-button"
                disabled={disabled}
                onClick={() =>
                  updateDraft(selected, selectedLineId, {
                    provenance: [
                      ...selectedDraft.provenance,
                      { kind: "manual", note: "" },
                    ],
                  })
                }
              >
                <Plus size={13} />
                {say("Thêm căn cứ nhập tay", "Add a manual source")}
              </button>
              <div className="ecus-source-notes">
                <label className="ecus-control">
                  <span>
                    {say(
                      "Căn cứ sử dụng thông tin",
                      "Basis for using this information",
                    )}
                  </span>
                  <textarea
                    rows={2}
                    value={selectedDraft.basis}
                    disabled={disabled}
                    onChange={(event) =>
                      updateDraft(selected, selectedLineId, {
                        basis: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="ecus-control">
                  <span>
                    {say("Ghi chú chỉnh sửa / rà soát", "Edit / review note")}
                  </span>
                  <textarea
                    rows={2}
                    value={selectedDraft.reason}
                    disabled={disabled}
                    placeholder={
                      saveReason ||
                      say("Cập nhật biểu mẫu IDA", "Update IDA form")
                    }
                    onChange={(event) =>
                      updateDraft(selected, selectedLineId, {
                        reason: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              {(selectedFindings.length > 0 || selectedMissing.length > 0) && (
                <ul className="ecus-review-findings">
                  {selectedMissing.map((target) => (
                    <li key={target.field.key}>
                      {say("Cần bổ sung", "Required")}: {target.field.labelVi}
                    </li>
                  ))}
                  {selectedFindings.map((finding, index) => (
                    <li key={index}>
                      {locale === "en" ? finding.messageEn : finding.messageVi}
                    </li>
                  ))}
                </ul>
              )}
              {selectedEntry?.review && (
                <p className="ecus-review-record">
                  <Check size={14} />
                  {selectedEntry.review.actorName} ·{" "}
                  {date(selectedEntry.review.at)} ·{" "}
                  {selectedEntry.review.reason}
                </p>
              )}
              <div className="ecus-source-actions">
                <button
                  className="button secondary small"
                  disabled={disabled || !selectedEffective}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await saveDraft(
                        selected.fieldId,
                        selectedLineId,
                        selectedDraft,
                        false,
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <Save size={13} />
                  {say("Lưu mục này", "Save this field")}
                </button>
                <button
                  className="button primary small"
                  disabled={
                    disabled ||
                    !selectedEffective ||
                    selectedFindings.length > 0 ||
                    selectedMissing.length > 0
                  }
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await saveDraft(
                        selected.fieldId,
                        selectedLineId,
                        selectedDraft,
                        true,
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <Check size={13} />
                  {say("Xác nhận đã rà soát", "Confirm reviewed")}
                </button>
              </div>
            </details>
          </aside>
        )}
      </div>
      <div className="ecus-save-bar">
        <div>
          <strong>
            {pending.length
              ? say(
                  `${pending.length} mục chưa lưu`,
                  `${pending.length} unsaved fields`,
                )
              : say("Mọi thay đổi đã được lưu", "All changes saved")}
          </strong>
          <span>
            {say(
              "Dữ liệu chưa lưu được giữ khi chuyển giữa ba biểu mẫu.",
              "Unsaved values stay in place as you switch between the three forms.",
            )}
          </span>
        </div>
        <label className="ecus-save-note">
          <span className="sr-only">
            {say("Ghi chú lưu biểu mẫu", "Save note")}
          </span>
          <input
            value={saveReason}
            onChange={(event) => setSaveReason(event.target.value)}
            disabled={disabled}
            placeholder={say(
              "Ghi chú chỉnh sửa (nếu có)",
              "Edit note (optional)",
            )}
          />
        </label>
        <button
          className="button primary"
          disabled={disabled || !pending.length}
          onClick={() => void saveAll()}
        >
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          {say("Lưu biểu mẫu", "Save forms")}
        </button>
      </div>
      {retainedEntries.length > 0 && (
        <details className="ecus-retained-fields">
          <summary>
            <FileText size={14} />
            {say(
              "Các chỉ tiêu được giữ từ trình soạn trước",
              "Retained fields from previous editor",
            )}
            <span>{retainedEntries.length}</span>
          </summary>
          <p>
            {say(
              "Các chỉ tiêu này vẫn được lưu cùng hồ sơ nhưng không có ô tương ứng trong ba biểu mẫu ECUS ở trên. Đối chiếu giá trị và nguồn trước khi quyết định xóa.",
              "These saved fields are still part of the shipment and do not have matching inputs in the three ECUS forms above. Compare their values and evidence before deciding to remove them.",
            )}
          </p>
          {retainedEntries.map((entry) => {
            const field = getDeclarationField(entry.fieldId);
            const records =
              "rows" in entry.value ? entry.value.rows : [entry.value];
            const findings = validateDeclarationEntry(
              entry,
              context,
              shipment.declarationDraft,
            );
            const lineIndex = entry.goodsLineId
              ? shipment.goods.findIndex(
                  (line) => line.id === entry.goodsLineId,
                )
              : -1;
            return (
              <article
                className="ecus-retained-entry"
                key={declarationEntryKey(entry.fieldId, entry.goodsLineId)}
              >
                <h3>
                  <code>{entry.fieldId}</code>
                  {(locale === "en" ? field?.labelEn : field?.labelVi) ||
                    entry.fieldId}
                </h3>
                {entry.goodsLineId && (
                  <p>
                    {lineIndex >= 0
                      ? `${say("Dòng hàng", "Goods row")} ${lineIndex + 1}`
                      : say(
                          "Dòng hàng liên kết không còn tồn tại",
                          "The linked goods row no longer exists",
                        )}
                  </p>
                )}
                {entry.stale && (
                  <p className="ecus-warning-text">
                    <AlertTriangle size={13} />
                    {entry.staleReason ||
                      say(
                        "Nguồn thay đổi; cần rà soát lại.",
                        "Source changed; review is needed.",
                      )}
                  </p>
                )}
                <div className="ecus-retained-values">
                  {records.map((record, index) => (
                    <div key={"id" in record ? String(record.id) : index}>
                      {"rows" in entry.value && (
                        <strong>
                          {say("Dòng", "Row")} {index + 1}
                        </strong>
                      )}
                      <dl>
                        {Object.entries(record)
                          .filter(([key]) => key !== "kind" && key !== "id")
                          .map(([key, value]) => {
                            const component = field?.components.find(
                              (item) => item.key === key,
                            );
                            return (
                              <div key={key}>
                                <dt>
                                  {(locale === "en"
                                    ? component?.labelEn
                                    : component?.labelVi) || key}
                                </dt>
                                <dd>{String(value || "—")}</dd>
                              </div>
                            );
                          })}
                      </dl>
                    </div>
                  ))}
                </div>
                {entry.basis && (
                  <p>
                    <strong>{say("Căn cứ", "Basis")}: </strong>
                    {entry.basis}
                  </p>
                )}
                <div className="ecus-evidence-list">
                  {entry.provenance.map((source, index) => {
                    const document =
                      source.kind === "document"
                        ? state.documents.find(
                            (item) => item.id === source.documentId,
                          )
                        : undefined;
                    return (
                      <div className="ecus-evidence" key={index}>
                        <div>
                          {source.kind === "manual" ? (
                            <>
                              <strong>
                                {say("Căn cứ nhập tay", "Manual source")}
                              </strong>
                              <blockquote>{source.note}</blockquote>
                            </>
                          ) : (
                            <>
                              <a
                                href={`/api/documents/${source.documentId}#page=${source.page}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {document?.name ||
                                  say("Chứng từ nguồn", "Source document")}{" "}
                                · v{source.documentVersion} ·{" "}
                                {say("trang", "page")} {source.page}
                                <ArrowUpRight size={12} />
                              </a>
                              <blockquote>{source.quote}</blockquote>
                              {!isDeclarationSourceCurrent(source, context) && (
                                <p className="ecus-warning-text">
                                  {say(
                                    "Nguồn không còn khớp phiên bản hiện hành.",
                                    "The evidence no longer matches the current source version.",
                                  )}
                                </p>
                              )}
                              {source.visualEvidence &&
                                isDeclarationSourceCurrent(source, context) && (
                                  <VisionEvidenceImage
                                    documentId={source.documentId}
                                    page={source.page}
                                    evidence={source.visualEvidence}
                                  />
                                )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {findings.length > 0 && (
                  <ul className="ecus-review-findings">
                    {findings.map((finding, index) => (
                      <li key={index}>
                        {locale === "en"
                          ? finding.messageEn
                          : finding.messageVi}
                      </li>
                    ))}
                  </ul>
                )}
                {entry.review && (
                  <p className="ecus-review-record">
                    <Check size={13} />
                    {entry.review.actorName} · {date(entry.review.at)} ·{" "}
                    {entry.review.reason}
                  </p>
                )}
                {removalControl(entry)}
              </article>
            );
          })}
        </details>
      )}
      {(declarationIssues.length > 0 ||
        orphaned.length > 0 ||
        staleEntries.length > 0) && (
        <details className="ecus-review-summary">
          <summary>
            <AlertTriangle size={14} />
            {say(
              "Kiểm tra nguồn và dữ liệu đã lưu",
              "Check sources and saved data",
            )}
            <span>{declarationIssues.length}</span>
          </summary>
          <ul>
            {declarationIssues.map((issue) => (
              <li key={issue.id}>
                {translateIssue(issue, locale).description}
              </li>
            ))}
            {orphaned.map((entry) => (
              <li key={declarationEntryKey(entry.fieldId, entry.goodsLineId)}>
                {say(
                  "Mục thuộc dòng hàng không còn tồn tại",
                  "Entry belongs to a removed goods row",
                )}
                : {getDeclarationField(entry.fieldId)?.labelVi || entry.fieldId}
                {ECUS_FIELD_IDS.has(entry.fieldId) && removalControl(entry)}
              </li>
            ))}
          </ul>
          {staleEntries.map((entry) => {
            const field = ECUS_FORM_FIELDS.find(
              (item) => item.fieldId === entry.fieldId,
            );
            return field ? (
              <button
                key={declarationEntryKey(entry.fieldId, entry.goodsLineId)}
                className="text-button"
                onClick={() =>
                  setSourceTarget({ field, goodsLineId: entry.goodsLineId })
                }
              >
                {field.labelVi} · {say("Nguồn thay đổi", "Source changed")}
              </button>
            ) : null;
          })}
        </details>
      )}
    </section>
  );
}
