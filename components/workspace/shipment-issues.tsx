"use client";
import { useLocale } from "@/lib/i18n";
import { fieldLabel, translateIssue } from "@/lib/i18n-core";
import { getEcusFormField } from "@/lib/ecus-form";
import { getDeclarationField } from "@/lib/declaration-catalog";
import { declarationReviewIssue, expandedReviewIssueId, reviewQuestion } from "@/lib/review-questions";
import { automaticQuestionIssues } from "@/lib/shipment-correspondence";
import { useState } from "react";
import type {
  Action,
  Candidate,
  Issue,
  ReviewHistoryEntry,
  ShipmentCase,
  WorkspaceState,
} from "@/lib/types";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ShieldCheck,
  Mail,
  Upload,
} from "lucide-react";
import { Badge } from "./shared";
import { VisionEvidenceImage } from "@/components/vision-evidence-image";
type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  issues: Issue[];
  completedQuestions?: ReviewHistoryEntry[];
  selectedIssue: string;
  onIssueChange: (id: string) => void;
  busy: boolean;
  reviewReason: string;
  mutation: (action: Action, success?: string) => Promise<boolean>;
  onAccept: (shipment: ShipmentCase, candidate: Candidate) => Promise<void>;
  onEvidence: (candidate: Candidate) => void;
  onDocument: (id: string, page: number) => void;
  onDeclaration: (issue: Issue) => void;
  onGoods: () => void;
  onResolve: (issue: Issue) => void;
  onEditCase: () => void;
  onUpload: () => void;
  onField: (field: string) => void;
  onMessages: () => void;
  onReasonChange: (reason: string) => void;
  showReviewReason?: boolean;
  hasPendingEmailDraft: boolean;
};
export function ShipmentIssues({
  state,
  shipment: current,
  issues: caseIssues,
  completedQuestions = [],
  selectedIssue,
  onIssueChange: setSelectedIssue,
  busy,
  reviewReason,
  mutation,
  onAccept: acceptCandidate,
  onEvidence: evidence,
  onDocument,
  onDeclaration,
  onGoods,
  onResolve,
  onEditCase,
  onUpload,
  onField,
  onMessages,
  onReasonChange,
  showReviewReason = false,
  hasPendingEmailDraft,
}: Props) {
  const { t, locale, date } = useLocale();
  const [previewId, setPreviewId] = useState("");
  const expandedId = expandedReviewIssueId(caseIssues, selectedIssue);
  const editable = current.status === "review";
  const emailDraft = state.emailDrafts?.find(
    (draft) => draft.caseId === current.id && draft.status === "draft",
  );
  const externalQuestionIds = new Set(
    automaticQuestionIssues(state, current, caseIssues).map(
      (issue) => issue.id,
    ),
  );
  return (
    <aside className="issues-panel">
      <div className="panel-heading">
        <h2>
          <AlertCircle size={16} />
          {t("Cần rà soát ")}
          <span className="issue-count">{caseIssues.length}</span>
        </h2>
      </div>
      <p className="issues-intro">
        {locale === "vi"
          ? "Thông tin có dẫn nguồn rõ ràng được tự điền. Các mục còn lại được đối chiếu tiếp; thông tin cần hỏi người gửi sẽ được gom vào một email nháp sau khi đọc đủ chứng từ."
          : "Clear, supported information is autofilled. Remaining items are compared further; information needed from the sender is collected into one email draft after all documents are read."}
      </p>
      {emailDraft && emailDraft.automation?.state !== "resolved" && (
        <div className="questions-draft-ready">
          <Mail size={16} />
          <div>
            <strong>
              {locale === "vi"
                ? emailDraft.approval
                  ? "Email nháp đã được duyệt"
                  : "Email nháp đang chờ bạn duyệt"
                : emailDraft.approval
                  ? "Email draft approved"
                  : "An email draft is waiting for your approval"}
            </strong>
            <p>
              {hasPendingEmailDraft
                ? locale === "vi"
                  ? "Bạn có chỉnh sửa email chưa lưu."
                  : "You have unsaved email edits."
                : emailDraft.automation?.state === "waiting_for_sources"
                  ? locale === "vi"
                    ? "Đang chờ đọc đủ chứng từ để cập nhật câu hỏi."
                    : "Waiting for the source reading to finish before updating the questions."
                  : locale === "vi"
                    ? `${emailDraft.issueIds.length} thông tin được gom trong bản nháp. Chưa gửi email.`
                    : `${emailDraft.issueIds.length} information requests are collected in the draft. No email was sent.`}
            </p>
            <button className="text-button" onClick={onMessages}>
              {locale === "vi" ? "Xem email nháp" : "Review email draft"}
              <ArrowRight size={12} />
            </button>
          </div>
        </div>
      )}
      {caseIssues.map((issue) => {
        const question = reviewQuestion(state, issue);
        const catalogField = issue.field
          ? getDeclarationField(issue.field)
          : undefined;
        const ecusField = issue.ecusFieldKey
          ? getEcusFormField(issue.ecusFieldKey)
          : undefined;
        const baseLabel = ecusField
          ? `${locale === "vi" ? ecusField.sectionVi : ecusField.sectionEn} · ${locale === "vi" ? ecusField.labelVi : ecusField.labelEn}`
          : catalogField
            ? locale === "vi"
              ? catalogField.labelVi
              : catalogField.labelEn
            : fieldLabel(issue.field || "", locale);
        const lineNumber = issue.goodsLineId
          ? current.goods.findIndex((line) => line.id === issue.goodsLineId) + 1
          : 0;
        const label =
          baseLabel +
          (lineNumber
            ? locale === "vi"
              ? ` — dòng hàng ${lineNumber}`
              : ` — goods row ${lineNumber}`
            : "");
        const prompt =
          question.kind === "confirm"
            ? t("Vui lòng xác nhận {p0} là {p1}.", {
                p0: label,
                p1: question.values[0],
              })
            : question.kind === "choose"
              ? t("Các chứng từ ghi {p0} khác nhau: {p1}. Giá trị nào đúng?", {
                  p0: label,
                  p1: question.values.join(" / "),
                })
              : question.kind === "missing"
                ? t("Chưa tìm thấy {p0} trong lô chứng từ. Vui lòng bổ sung.", {
                    p0: label,
                  })
                : translateIssue(issue, locale).title;
        const preview =
          question.candidates.find((candidate) => candidate.id === previewId) ||
          question.candidates[0];
        const source = state.documents.find(
          (document) => document.id === preview?.documentId,
        );
        return (
          <div
            className={`issue-card ${expandedId === issue.id ? "expanded" : ""}`}
            key={issue.id}
          >
            <button
              className="issue-title"
              aria-expanded={expandedId === issue.id}
              onClick={() => {
                setSelectedIssue(
                  expandedId === issue.id ? "__closed__" : issue.id,
                );
                setPreviewId("");
                if (issue.field)
                  document
                    .getElementById(`field-${issue.field}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              <span className={`issue-icon ${issue.severity}`}>
                <AlertTriangle size={15} />
              </span>
              <span>
                <strong>{prompt}</strong>
                <small>
                  {
                    {
                      conflict: t("Mâu thuẫn dữ liệu"),
                      missing: t("Thiếu thông tin"),
                      uncertain: t("Cần xác minh"),
                      grouping: t("Phân nhóm"),
                      unsupported: t("Loại hồ sơ"),
                      document: t("Chứng từ"),
                      stale: t("Nguồn đã thay đổi"),
                      goods: t("Dòng hàng"),
                      transfer: t("Chuyển ECUS"),
                      declaration: t("Bản khai"),
                    }[issue.kind]
                  }
                </small>
              </span>
              <ChevronDown size={14} />
            </button>
            {expandedId === issue.id && (
              <p>{translateIssue(issue, locale).description}</p>
            )}
            {expandedId === issue.id && (
              <div className="issue-detail">
                <div className="question-decision">
                  {question.candidates.map((candidate) => (
                    <div className="issue-candidate" key={candidate.id}>
                      <strong>{candidate.value}</strong>
                      <button
                        className="evidence-link"
                        onClick={() => {
                          setPreviewId(candidate.id);
                          evidence(candidate);
                        }}
                      >
                        {
                          state.documents.find(
                            (document) => document.id === candidate.documentId,
                          )?.name
                        }
                        {" · "}
                        {t("tr.")} {candidate.page}
                        <ArrowUpRight size={11} />
                      </button>
                      <blockquote>{candidate.originalText}</blockquote>
                      <button
                        className="button secondary small"
                        disabled={busy || !editable}
                        onClick={() => {
                          const target = declarationReviewIssue(issue, candidate);
                          if (target) onDeclaration(target);
                          else void acceptCandidate(current, candidate);
                        }}
                      >
                        <Check size={13} />
                        {declarationReviewIssue(issue, candidate)
                          ? locale === "vi"
                            ? "Mở ô cần bổ sung"
                            : "Open field"
                          : t(
                              candidate.lineId
                                ? "Đối chiếu bảng hàng hóa"
                                : "Xác nhận giá trị",
                            )}
                      </button>
                    </div>
                  ))}
                  {showReviewReason &&
                    editable &&
                    question.candidates.length > 0 && (
                      <label
                        className="question-reason"
                        htmlFor="review-reason"
                      >
                        {t("Lý do rà soát / chỉnh sửa")}
                        <input
                          id="review-reason"
                          value={reviewReason}
                          onChange={(event) =>
                            onReasonChange(event.target.value)
                          }
                          placeholder={t("Ví dụ: Đã xác nhận với chủ hàng…")}
                        />
                      </label>
                    )}
                  {!question.candidates.length && !issue.documentIds.length && (
                    <p className="muted">
                      {t("Chưa có chứng từ nguồn cho thông tin này.")}
                    </p>
                  )}
                  {externalQuestionIds.has(issue.id) && (
                    <p className="issue-guidance question-email-state">
                      <Mail size={12} />
                      {emailDraft?.issueIds.includes(issue.id)
                        ? locale === "vi"
                          ? "Thông tin này đã có trong email nháp chờ duyệt."
                          : "This request is already included in the email draft awaiting review."
                        : locale === "vi"
                          ? "Thông tin này sẽ được đưa vào email nháp tự động nếu vẫn chưa rõ sau khi đọc đủ chứng từ."
                          : "This will be included in the automatic email draft if it remains unresolved after all sources are read."}
                    </p>
                  )}
                  {issue.documentIds.length > 0 &&
                    !issue.candidateIds.length &&
                    [...new Set(issue.documentIds)].map((id) => (
                      <button
                        className="evidence-link"
                        key={id}
                        onClick={() => {
                          onDocument(id, 1);
                        }}
                      >
                        {state.documents.find((d) => d.id === id)?.name}
                        <ArrowUpRight size={11} />
                      </button>
                    ))}
                  {issue.kind === "declaration" ? (
                    <button
                      className="text-button"
                      onClick={() => {
                        onDeclaration(issue);
                      }}
                    >
                      {t("Nhập thủ công")}
                      <ArrowRight size={12} />
                    </button>
                  ) : issue.kind === "grouping" ? (
                    <button
                      className="button secondary small"
                      disabled={busy || !editable}
                      onClick={() =>
                        void mutation(
                          {
                            type: "confirm_grouping",
                            caseId: current.id,
                            reason:
                              reviewReason ||
                              t(
                                "Đã đối chiếu toàn bộ chứng từ và xác nhận cùng lô hàng",
                              ),
                          },
                          t("Đã xác nhận nhóm chứng từ"),
                        )
                      }
                    >
                      <Check size={13} />
                      {t("Xác nhận cùng lô hàng")}
                    </button>
                  ) : ["goods-total", "weight"].some(
                      (suffix) => issue.id === `${current.id}:${suffix}`,
                    ) ||
                    issue.id.startsWith(`${current.id}:goods-math-`) ||
                    (issue.kind === "uncertain" && !issue.field) ? (
                    <button
                      className="text-button"
                      disabled={busy || !editable}
                      onClick={() => onResolve(issue)}
                    >
                      {t("Ghi nhận quyết định xử lý ")}
                      <ArrowRight size={12} />
                    </button>
                  ) : issue.kind === "goods" ||
                    issue.candidateIds.some(
                      (id) => state.candidates.find((v) => v.id === id)?.lineId,
                    ) ? (
                    <button className="text-button" onClick={() => onGoods()}>
                      {t("Đối chiếu bảng hàng hóa ")}
                      <ArrowRight size={12} />
                    </button>
                  ) : issue.kind === "missing" && !issue.field ? (
                    <button
                      className="text-button"
                      disabled={busy || !editable}
                      onClick={() => onUpload()}
                    >
                      <Upload size={12} />
                      {t("Bổ sung chứng từ")}
                    </button>
                  ) : issue.kind === "unsupported" ? (
                    <button
                      className="text-button"
                      disabled={busy || !editable}
                      onClick={() => onEditCase()}
                    >
                      {t("Xem loại hồ sơ và hướng xử lý ")}
                      <ArrowRight size={12} />
                    </button>
                  ) : issue.field ? (
                    <button
                      className="text-button"
                      onClick={() => onField(issue.field!)}
                    >
                      {t("Nhập thủ công")}
                      <ArrowRight size={12} />
                    </button>
                  ) : (
                    <p className="issue-guidance">
                      {t(
                        "Kiểm tra bản gốc, phân loại hoặc nhập văn bản trong khung chứng từ.",
                      )}
                    </p>
                  )}
                </div>
                {source && preview && showReviewReason && (
                  <aside className="question-evidence">
                    <strong>
                      {source.name} · {t("tr.")} {preview.page}
                    </strong>
                    <blockquote>{preview.originalText}</blockquote>
                    {preview.visualEvidence ? (
                      <>
                        <VisionEvidenceImage
                          documentId={source.id}
                          page={preview.page}
                          evidence={preview.visualEvidence}
                        />
                        <a
                          className="evidence-link"
                          href={`/api/documents/${source.id}#page=${preview.page}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("Chứng từ nguồn")}
                          <ArrowUpRight size={12} />
                        </a>
                      </>
                    ) : source.blobKey && source.mime === "application/pdf" ? (
                      <iframe
                        title={`${source.name} · ${preview.page}`}
                        src={`/api/documents/${source.id}#page=${preview.page}`}
                      />
                    ) : (
                      <button
                        className="evidence-link"
                        onClick={() => onDocument(source.id, preview.page)}
                      >
                        {t("Chứng từ nguồn")}
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                  </aside>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!caseIssues.length && (
        <div className="issues-clear">
          <span>
            <CheckCheck size={24} />
          </span>
          <h3>{t("Đã xử lý vấn đề dữ liệu")}</h3>
          <p>
            {t(
              "Không còn vấn đề phần mềm phát hiện. Quy định hải quan chưa được đánh giá.",
            )}
          </p>
        </div>
      )}
      <div className="manual-check">
        <ShieldCheck size={19} />
        <strong>{t("Quyết định hải quan")}</strong>
        <p>
          {t("Mã HS, xuất xứ và thuế suất cần người có chuyên môn rà soát.")}
        </p>
        <Badge tone="neutral">{t("Chưa đánh giá")}</Badge>
      </div>
      {completedQuestions.length > 0 && (
        <details className="completed-questions">
          <summary>
            <CheckCheck size={16} />
            <span>
              {t("Câu hỏi đã xử lý ({p0})", { p0: completedQuestions.length })}
            </span>
            <ChevronDown size={14} />
          </summary>
          <p className="completed-questions-note">
            {t(
              "Các xác nhận được giữ lại để đối chiếu. Những câu hỏi chưa xử lý vẫn ở phía trên.",
            )}
          </p>
          {completedQuestions.map((entry) => (
            <article className="completed-question" key={entry.id}>
              <div className="completed-question-heading">
                <strong>{translateIssue(entry.issue, locale).title}</strong>
                <Badge tone="green">
                  {t(
                    entry.status === "confirmed"
                      ? "Đã xác nhận"
                      : entry.status === "corrected"
                        ? "Đã hiệu chỉnh"
                        : "Đã xử lý",
                  )}
                </Badge>
              </div>
              {entry.value && (
                <p className="completed-question-value">{entry.value}</p>
              )}
              <small>
                {entry.actor} · {date(entry.at)}
              </small>
              <p className="completed-question-reason">{entry.reason}</p>
              {[...new Set(entry.issue.documentIds)].map((id) => {
                const document = state.documents.find((item) => item.id === id);
                if (!document?.blobKey) return null;
                return (
                  <a
                    key={id}
                    className="evidence-link"
                    href={`/api/documents/${id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {document.name}
                    <ArrowUpRight size={11} />
                  </a>
                );
              })}
            </article>
          ))}
        </details>
      )}
    </aside>
  );
}
