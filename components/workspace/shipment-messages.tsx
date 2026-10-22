"use client";

import { useLocale } from "@/lib/i18n";
import {
  currentEmailCaseId,
  emailLinkedToCase,
  isEmailMatchCurrent,
} from "@/lib/email-grouping";
import type { Action, ShipmentCase, WorkspaceState } from "@/lib/types";
import {
  ArrowDownToLine,
  Check,
  FileText,
  Mail,
  Save,
  Sparkles,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { Badge, Empty, documentLabel } from "./shared";
import { EmailMatchEvidence } from "./email-shipment-matches";

export type EmailDraftEdit = {
  recipient: string;
  subject: string;
  body: string;
};
type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  disabled: boolean;
  onUpload: () => void;
  onDocument: (documentId: string) => void;
  onReviewClientMemory: (fieldKey?: string) => void;
  mutation: (action: Action, success?: string) => Promise<boolean>;
  edits: Record<string, EmailDraftEdit>;
  onEdit: (id: string, edit: EmailDraftEdit) => void;
  onSaved: (id: string, edit: EmailDraftEdit) => void;
};

export function ShipmentMessages({
  state,
  shipment,
  disabled,
  onUpload,
  onDocument,
  onReviewClientMemory,
  mutation,
  edits,
  onEdit,
  onSaved,
}: Props) {
  const { t, date, locale } = useLocale();
  const say = (vi: string, en: string) => (locale === "vi" ? vi : en);
  const [selectedId, setSelectedId] = useState("");
  const documents = state.documents.filter(
    (document) => document.caseId === shipment.id,
  );
  const messages = state.emails.filter((email) =>
    emailLinkedToCase(state, email, shipment.id),
  );
  const drafts = (state.emailDrafts || [])
    .filter((draft) => draft.caseId === shipment.id)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const selected =
    messages.find((email) => email.id === selectedId) || messages[0];

  return (
    <section className="shipment-messages">
      <section
        className="card email-drafts"
        aria-label={say(
          "Email nháp chờ duyệt",
          "Email drafts awaiting approval",
        )}
      >
        <div className="panel-heading">
          <h2>
            <Sparkles size={16} />
            {say(
              "Yêu cầu thông tin được chuẩn bị tự động",
              "Information requests prepared automatically",
            )}
          </h2>
          {drafts.length > 0 && <Badge>{drafts.length}</Badge>}
        </div>
        <p className="email-draft-notice">
          {say(
            "Sau khi đọc và đối chiếu chứng từ, AICD gom thông tin còn thiếu hoặc mâu thuẫn vào một email nháp. Bạn kiểm tra nội dung, chọn người nhận và phê duyệt; email chưa được gửi.",
            "After reading and comparing the documents, AICD collects missing or conflicting information into one email draft. Check the wording, choose the recipient and approve it; the email is not sent.",
          )}
        </p>
        {!drafts.length && (
          <div className="email-draft-empty">
            <Check size={20} />
            <div>
              <strong>
                {say(
                  "Chưa có yêu cầu thông tin cần duyệt",
                  "No information request awaiting approval",
                )}
              </strong>
              <p>
                {say(
                  "Thông tin rõ ràng được tự điền. Email nháp sẽ xuất hiện khi đã đọc đủ chứng từ và vẫn còn thông tin cần hỏi người gửi.",
                  "Clear information is filled automatically. A draft appears after all source documents have been read if information is still needed from the sender.",
                )}
              </p>
            </div>
          </div>
        )}
        {drafts.map((draft) => {
          const value = edits[draft.id] || draft;
          const changed =
            value.recipient !== draft.recipient ||
            value.subject !== draft.subject ||
            value.body !== draft.body;
          const automation = draft.automation;
          const needsReview = automation?.state === "needs_review";
          const waiting = automation?.state === "waiting_for_sources";
          const resolved = automation?.state === "resolved";
          const hasUpdate = automation?.pendingBody !== undefined;
          const pendingMemory = !!automation?.pendingClientMemoryIds?.length;
          const validRecipient = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(
            value.recipient.trim(),
          );
          const canApprove =
            !disabled &&
            !changed &&
            !waiting &&
            !resolved &&
            !needsReview &&
            !hasUpdate &&
            !pendingMemory &&
            validRecipient &&
            !!value.subject.trim() &&
            !!value.body.trim() &&
            !draft.approval;
          const update = (change: Partial<EmailDraftEdit>) =>
            onEdit(draft.id, {
              recipient: value.recipient,
              subject: value.subject,
              body: value.body,
              ...change,
            });
          const save = async () => {
            const submitted = {
              recipient: value.recipient,
              subject: value.subject,
              body: value.body,
            };
            if (
              await mutation(
                { type: "save_email_draft", draftId: draft.id, ...submitted },
                say(
                  "Đã lưu email nháp để duyệt. Chưa gửi email.",
                  "Email draft saved for approval. No email was sent.",
                ),
              )
            )
              onSaved(draft.id, submitted);
          };
          return (
            <article className="email-draft" key={draft.id}>
              <div className="email-draft-meta">
                <span>
                  {automation ? (
                    <>
                      <Sparkles size={13} />
                      {say(
                        "Tự soạn từ chứng từ",
                        "Prepared from the documents",
                      )}{" "}
                      · {automation.questionCount}{" "}
                      {say("thông tin cần làm rõ", "information requests")}
                    </>
                  ) : (
                    <>
                      <Mail size={13} />
                      {say("Email nháp", "Email draft")}
                    </>
                  )}
                </span>
                <Badge
                  tone={
                    changed || needsReview || pendingMemory
                      ? "amber"
                      : draft.approval
                        ? "green"
                        : "neutral"
                  }
                >
                  {changed
                    ? say("Có thay đổi chưa lưu", "Unsaved changes")
                    : resolved
                      ? say("Đã đủ thông tin", "Questions resolved")
                      : waiting
                        ? say(
                            "Đang chờ đọc chứng từ",
                            "Waiting for source reading",
                          )
                        : pendingMemory
                          ? say(
                              "Cần kiểm tra thông tin đã nhớ",
                              "Review prior client corrections",
                            )
                          : draft.approval
                            ? say("Đã duyệt · chưa gửi", "Approved · not sent")
                            : say("Chờ bạn duyệt", "Awaiting your approval")}
                </Badge>
              </div>
              {waiting && (
                <p className="email-draft-state">
                  {say(
                    "Đang chờ AI đọc đủ chứng từ hiện hành. Nội dung này sẽ được đối chiếu lại trước khi có thể duyệt.",
                    "Waiting for AI to finish the current documents. These questions will be checked again before the draft can be approved.",
                  )}
                </p>
              )}
              {pendingMemory && !resolved && (
                <div className="email-draft-update ecus-memory-email-notice">
                  <strong>
                    {say(
                      "Có thông tin đã sửa trong hồ sơ trước",
                      "An earlier correction may answer this request",
                    )}
                  </strong>
                  <p>
                    {say(
                      "Kiểm tra thông tin đã nhớ của công ty trong biểu mẫu ECUS trước khi hỏi lại. Dùng gợi ý hoặc bỏ qua cho hồ sơ này rồi duyệt email.",
                      "Review this company’s prior correction in the ECUS form before asking again. Apply it or dismiss it for this shipment, then approve the email.",
                    )}
                  </p>
                  <button
                    className="button secondary small"
                    onClick={() =>
                      onReviewClientMemory(
                        state.clientMemories?.find(
                          (memory) =>
                            memory.id ===
                            automation?.pendingClientMemoryIds?.[0],
                        )?.fieldKey,
                      )
                    }
                  >
                    {say(
                      "Kiểm tra trong biểu mẫu ECUS",
                      "Review in the ECUS form",
                    )}
                  </button>
                </div>
              )}
              {resolved && (
                <p className="email-draft-state resolved">
                  <Check size={14} />
                  {say(
                    "Các câu hỏi đã được giải quyết. Bản nháp được giữ để tham khảo và không còn chờ duyệt.",
                    "The questions have been resolved. This draft is retained for reference and no longer awaits approval.",
                  )}
                </p>
              )}
              {hasUpdate && (
                <div className="email-draft-update">
                  <strong>
                    {say(
                      "Có thông tin mới cần đối chiếu",
                      "Updated questions are available",
                    )}
                  </strong>
                  <p>
                    {say(
                      "Chứng từ hoặc câu hỏi đã thay đổi. Nội dung bạn chỉnh sửa được giữ nguyên; đối chiếu đề xuất mới rồi chọn nội dung muốn giữ.",
                      "The documents or questions have changed. Your edits are preserved; compare the updated proposal and choose the wording to keep.",
                    )}
                  </p>
                  <details>
                    <summary>
                      {say("Xem đề xuất mới", "View updated proposal")}
                    </summary>
                    <strong>{automation.pendingSubject}</strong>
                    <pre>{automation.pendingBody}</pre>
                  </details>
                  <button
                    className="button secondary small"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        subject: automation.pendingSubject || value.subject,
                        body: automation.pendingBody || value.body,
                      })
                    }
                  >
                    {say("Dùng đề xuất mới", "Use updated proposal")}
                  </button>
                </div>
              )}
              <label htmlFor={`email-recipient-${draft.id}`}>
                {t("Người nhận")}
              </label>
              <input
                id={`email-recipient-${draft.id}`}
                type="email"
                value={value.recipient}
                disabled={disabled}
                placeholder={say(
                  "Nhập email người nhận",
                  "Recipient email address",
                )}
                onChange={(event) => update({ recipient: event.target.value })}
              />
              {!value.recipient && (
                <p className="muted">
                  {say(
                    "Chưa xác định được một người gửi duy nhất. Chọn email người nhận trước khi duyệt.",
                    "A single sender could not be determined. Choose the recipient before approving.",
                  )}
                </p>
              )}
              <label htmlFor={`email-subject-${draft.id}`}>
                {t("Tiêu đề")}
              </label>
              <input
                id={`email-subject-${draft.id}`}
                value={value.subject}
                disabled={disabled}
                onChange={(event) => update({ subject: event.target.value })}
              />
              <label htmlFor={`email-body-${draft.id}`}>
                {t("Nội dung câu hỏi")}
              </label>
              <textarea
                id={`email-body-${draft.id}`}
                value={value.body}
                rows={10}
                disabled={disabled}
                onChange={(event) => update({ body: event.target.value })}
              />
              {draft.approval && !changed && (
                <p className="email-draft-approval">
                  <Check size={14} />
                  {say("Đã được duyệt bởi", "Approved by")}{" "}
                  {draft.approval.actorName} · {date(draft.approval.at)}
                </p>
              )}
              <div className="email-draft-footer">
                <small>
                  {date(draft.updatedAt)}
                  {changed && (
                    <span>
                      {say(
                        "Lưu chỉnh sửa trước khi duyệt.",
                        "Save edits before approving.",
                      )}
                    </span>
                  )}
                </small>
                <div>
                  <button
                    className="button secondary small"
                    disabled={
                      disabled ||
                      (!changed && !needsReview) ||
                      !value.subject.trim() ||
                      !value.body.trim() ||
                      (!!value.recipient.trim() && !validRecipient)
                    }
                    onClick={() => void save()}
                  >
                    <Save size={14} />
                    {needsReview && !changed
                      ? say("Giữ nội dung này", "Keep this wording")
                      : t("Lưu email nháp")}
                  </button>
                  {!resolved && (
                    <button
                      className="button primary small"
                      disabled={!canApprove}
                      onClick={() =>
                        void mutation(
                          { type: "approve_email_draft", draftId: draft.id },
                          say(
                            "Đã duyệt email nháp. Email chưa được gửi.",
                            "Email draft approved. No email was sent.",
                          ),
                        )
                      }
                    >
                      <Check size={14} />
                      {draft.approval && !changed
                        ? say("Đã duyệt", "Approved")
                        : say("Duyệt email nháp", "Approve email draft")}
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </section>
      <div className="email-notice">
        <Mail size={23} />
        <div>
          <strong>
            Google Workspace / Gmail{" "}
            <Badge tone="amber">{t("Chưa kết nối")}</Badge>
          </strong>
          <p>
            {t(
              "Email đã nhập được đối chiếu với lô hàng bằng chứng từ và nội dung trao đổi. Đồng bộ Gmail và gửi tin nhắn chưa được triển khai.",
            )}
          </p>
        </div>
        <button
          className="button secondary small"
          disabled={disabled}
          onClick={onUpload}
        >
          <Upload size={15} />
          {t("Nhập email .eml")}
        </button>
      </div>
      <div className="card email-layout">
        <div className="email-list">
          <div className="panel-heading">
            <h2>{t("Email đã tiếp nhận")}</h2>
            <Badge>{messages.length}</Badge>
          </div>
          {messages.map((email) => (
            <button
              key={email.id}
              className={`email-row ${selected?.id === email.id ? "selected" : ""}`}
              onClick={() => setSelectedId(email.id)}
            >
              <span className="email-sender">
                <Mail size={15} />
                {email.sender}
              </span>
              <strong>{email.subject || t("(Không có tiêu đề)")}</strong>
              <small>{date(email.receivedAt)}</small>
            </button>
          ))}
          {!messages.length && (
            <Empty icon={Mail} title={t("Chưa có email cho lô hàng này")}>
              <p>
                {t(
                  "Nhập email .eml cùng tệp đính kèm để giữ lại nguồn trao đổi.",
                )}
              </p>
            </Empty>
          )}
        </div>
        <div className="email-detail">
          {selected ? (
            <>
              <Badge>{t("Email gốc được bảo toàn")}</Badge>
              <h2>{selected.subject || t("(Không có tiêu đề)")}</h2>
              <dl>
                <dt>{t("Người gửi")}</dt>
                <dd>{selected.sender}</dd>
                <dt>{t("Thời điểm")}</dt>
                <dd>{date(selected.receivedAt)}</dd>
                <dt>Message-ID</dt>
                <dd>{selected.messageId}</dd>
                <dt>{t("Tệp gốc")}</dt>
                <dd>{selected.originalName}</dd>
              </dl>
              {(selected.shipmentMatches || [])
                .filter(
                  (match) =>
                    currentEmailCaseId(state, match.caseId) === shipment.id &&
                    match.status === "matched" &&
                    isEmailMatchCurrent(state, match),
                )
                .map((match) => (
                  <EmailMatchEvidence
                    key={match.id}
                    state={state}
                    match={match}
                  />
                ))}
              <a
                className="button secondary"
                href={`/api/emails/${selected.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <ArrowDownToLine size={15} />
                {t("Tải email gốc")}
              </a>
              {selected.text ? (
                <>
                  <h3>{t("Nội dung email")}</h3>
                  <div className="email-body-text">{selected.text}</div>
                </>
              ) : (
                <p className="muted">
                  {t(
                    "Chưa có văn bản email để hiển thị. Tải email gốc để xem nội dung.",
                  )}
                </p>
              )}
              <h3>{t("Tệp đính kèm của lô hàng")}</h3>
              {documents
                .filter(
                  (document) =>
                    selected.documentIds.includes(document.id) ||
                    document.sourceEmailId === selected.id,
                )
                .map((document) => (
                  <button
                    key={document.id}
                    className="email-attachment"
                    onClick={() => onDocument(document.id)}
                  >
                    <FileText size={19} />
                    <span>
                      <strong>{document.name}</strong>
                      <small>
                        {t(documentLabel(document.type))} · v{document.version}
                      </small>
                    </span>
                  </button>
                ))}
            </>
          ) : (
            <Empty icon={Mail} title={t("Trao đổi gắn với chứng từ")}>
              <p>
                {t(
                  "Người gửi, thời điểm và chứng từ gốc luôn có thể truy xuất.",
                )}
              </p>
            </Empty>
          )}
        </div>
      </div>
    </section>
  );
}
