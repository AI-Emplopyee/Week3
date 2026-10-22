"use client";
import { FIELD_DEFINITIONS } from "@/lib/engine";
import { useLocale } from "@/lib/i18n";
import { translateSystemText } from "@/lib/i18n-core";
import {
  buildShipmentFacts,
  isShipmentFactClear,
} from "@/lib/shipment-autofill";
import type {
  Candidate,
  Issue,
  ShipmentCase,
  WorkspaceState,
} from "@/lib/types";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCheck,
  FileText,
} from "lucide-react";
import React from "react";
import { Badge, confidenceLabel } from "./shared";
type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  issues: Issue[];
  candidates: Candidate[];
  drafts: Record<string, string>;
  selectedIssue: string;
  busy: boolean;
  onDraftChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSave: (shipment: ShipmentCase, field: string) => Promise<void>;
  onAccept: (shipment: ShipmentCase, candidate: Candidate) => Promise<void>;
  onEvidence: (candidate: Candidate) => void;
};
export function SourceFields({
  state,
  shipment: current,
  issues: caseIssues,
  candidates: currentCandidates,
  drafts,
  selectedIssue,
  busy,
  onDraftChange: setDrafts,
  onSave: saveField,
  onAccept: acceptCandidate,
  onEvidence: evidence,
}: Props) {
  const { t, locale } = useLocale();
  const editable = current.status === "review";
  const facts = buildShipmentFacts(state, current);
  const isCurrentKimiReading = (candidate: Candidate) =>
    candidate.method.startsWith("kimi:") &&
    state.documents.some(
      (document) =>
        document.id === candidate.documentId &&
        document.version === candidate.documentVersion &&
        document.active &&
        !document.referenceOnly &&
        document.pages.some(
          (page) => page.page === candidate.page && !!page.aiReadability,
        ),
    );
  return (
    <div className="field-list">
      {Array.from(new Set(FIELD_DEFINITIONS.map((f) => f.group))).map(
        (group) => (
          <section className="field-group" key={group}>
            <h3>{t(group)}</h3>
            {FIELD_DEFINITIONS.filter((f) => f.group === group).map((field) => {
              const fieldCandidates = currentCandidates.filter(
                (c) => c.field === field.key && !c.lineId,
              );
              const candidates = fieldCandidates.filter(isCurrentKimiReading);
              const historicalCandidates = fieldCandidates.filter(
                (candidate) => !isCurrentKimiReading(candidate),
              );
              const reviewed = current.fields[field.key];
              const related = caseIssues.filter((i) => i.field === field.key);
              const selected = candidates.find(
                (c) => c.id === reviewed?.candidateId,
              );
              const candidate = selected || candidates[0];
              const fact = facts[field.key];
              const clearFact =
                !!fact &&
                isShipmentFactClear(state, field.key, fact.candidates);
              const automaticallyApplied =
                clearFact &&
                !reviewed &&
                fact.candidates.every((value) =>
                  value.method.startsWith("kimi:"),
                ) &&
                current.declarationDraft?.fields.some(
                  (entry) =>
                    entry.generatedBy === "shipment_extraction" &&
                    !entry.stale &&
                    entry.sourceCandidateIds?.some((id) =>
                      fact.candidates.some((value) => value.id === id),
                    ),
                );
              const key = `${current.id}:${field.key}`;
              const value =
                key in drafts
                  ? drafts[key]
                  : ((reviewed && !reviewed.stale
                      ? reviewed.value
                      : undefined) ??
                    (clearFact
                      ? fact.value
                      : new Set(candidates.map((c) => c.value)).size === 1
                        ? candidates[0]?.value
                        : "") ??
                    "");
              return (
                <div
                  className={`field-row ${related.length ? "has-issue" : ""} ${selectedIssue && related.some((i) => i.id === selectedIssue) ? "highlight" : ""}`}
                  id={`field-${field.key}`}
                  key={field.key}
                >
                  <label htmlFor={`input-${field.key}`}>
                    {t(field.label)}
                    {field.required && <span className="required">*</span>}
                    {reviewed && !reviewed.stale ? (
                      <CheckCheck size={14} className="text-green" />
                    ) : related.length ? (
                      <AlertCircle size={14} className="text-amber" />
                    ) : null}
                  </label>
                  <div className="field-input">
                    <input
                      id={`input-${field.key}`}
                      disabled={!editable}
                      placeholder={
                        candidates.length > 1
                          ? t("Chọn giá trị từ chứng từ")
                          : t("Chưa có thông tin")
                      }
                      value={value}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [key]: e.target.value }))
                      }
                      onBlur={() => void saveField(current, field.key)}
                    />
                    {automaticallyApplied && !(key in drafts) ? (
                      <span
                        className="field-autofilled"
                        title={
                          locale === "vi"
                            ? "Thông tin rõ ràng đã tự điền; không cần xác nhận riêng từng giá trị."
                            : "Clear information was autofilled; no separate confirmation is needed."
                        }
                      >
                        <Check size={16} />
                      </span>
                    ) : (
                      <button
                        className="icon-button"
                        disabled={busy || !editable || !value}
                        aria-label={t("Xác nhận {p0}", { p0: t(field.label) })}
                        title={
                          key in drafts
                            ? t("Lưu nội dung chỉnh sửa")
                            : t("Xác nhận giá trị từ chứng từ")
                        }
                        onClick={() => {
                          if (key in drafts) void saveField(current, field.key);
                          else if (candidate)
                            void acceptCandidate(current, candidate);
                        }}
                      >
                        <Check size={16} />
                      </button>
                    )}
                  </div>
                  <div className="field-meta">
                    {automaticallyApplied && (
                      <span className="field-autofilled-label">
                        {locale === "vi"
                          ? "AI · Đã tự điền"
                          : "AI · Autofilled"}
                      </span>
                    )}
                    {reviewed?.stale ? (
                      <span className="text-amber">
                        {t("Nguồn đã thay đổi · cần rà soát lại")}
                      </span>
                    ) : reviewed?.source === "manual" ? (
                      <span className="text-amber">
                        {t("Nhập tay · ")}
                        {reviewed.unverified
                          ? t("chưa xác minh")
                          : t("đã rà soát")}
                      </span>
                    ) : candidate ? (
                      <button onClick={() => evidence(candidate)}>
                        <FileText size={11} />
                        {
                          state.documents.find(
                            (d) => d.id === candidate.documentId,
                          )?.name
                        }{" "}
                        · {t("tr.")} {candidate.page}
                      </button>
                    ) : (
                      <span>{t("Chưa có nguồn chứng từ")}</span>
                    )}
                    {field.manualOnly && (
                      <Badge tone="amber">Manual / unverified</Badge>
                    )}
                  </div>
                  {candidates.length > 0 && (
                    <details className="candidate-details">
                      <summary>
                        {candidates.length} {t("nguồn đề xuất · ")}
                        {candidate
                          ? t(confidenceLabel[candidate.confidence])
                          : ""}
                      </summary>
                      {candidates.map((v) => (
                        <div className="candidate" key={v.id}>
                          <div>
                            <strong>{v.value}</strong>
                            <span className={`confidence ${v.confidence}`}>
                              {t(confidenceLabel[v.confidence])}
                            </span>
                          </div>
                          <button
                            className="evidence-link"
                            onClick={() => evidence(v)}
                          >
                            {
                              state.documents.find((d) => d.id === v.documentId)
                                ?.name
                            }{" "}
                            · {t("trang")} {v.page} <ArrowUpRight size={11} />
                          </button>
                          <blockquote>{v.originalText}</blockquote>
                          <small>
                            {v.method} · {v.location}
                          </small>
                          {v.normalizations.map((n, index) => (
                            <p key={index} className="normalization">
                              {n.before} → {n.after}
                              <span>
                                {translateSystemText(n.reason, locale)}
                              </span>
                            </p>
                          ))}
                          <button
                            className="text-button"
                            disabled={busy || !editable}
                            onClick={() => void acceptCandidate(current, v)}
                          >
                            <Check size={12} />
                            {t("Sử dụng giá trị này")}
                          </button>
                        </div>
                      ))}
                    </details>
                  )}
                  {historicalCandidates.length > 0 && (
                    <details className="candidate-details historical-readings">
                      <summary>
                        {historicalCandidates.length}{" "}
                        {locale === "vi"
                          ? "kết quả cũ · không dùng để tự điền"
                          : "historical readings · excluded from autofill"}
                      </summary>
                      <p className="muted">
                        {locale === "vi"
                          ? "Chỉ giữ để đối chiếu. AI cần đọc bản gốc trước khi các giá trị này có thể được dùng làm đề xuất hiện tại."
                          : "Retained for reference. AI must read the original before these values can become current suggestions."}
                      </p>
                      {historicalCandidates.map((candidate) => (
                        <div className="candidate" key={candidate.id}>
                          <strong>{candidate.value}</strong>
                          <button
                            className="evidence-link"
                            onClick={() => evidence(candidate)}
                          >
                            {
                              state.documents.find(
                                (document) =>
                                  document.id === candidate.documentId,
                              )?.name
                            }{" "}
                            · {t("trang")} {candidate.page}{" "}
                            <ArrowUpRight size={11} />
                          </button>
                          <blockquote>{candidate.originalText}</blockquote>
                          <small>
                            {candidate.method} · {candidate.location}
                          </small>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              );
            })}
          </section>
        ),
      )}
    </div>
  );
}
