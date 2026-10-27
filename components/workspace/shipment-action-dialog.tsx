"use client";
import { CASE_TYPE_LABELS } from "@/lib/case-scope";
import { reviewerForMode } from "@/lib/client-reviewer";
import { useLocale } from "@/lib/i18n";
import { translateIssue } from "@/lib/i18n-core";
import type {
  Action,
  Actor,
  Issue,
  ShipmentCase,
  WorkspaceState,
} from "@/lib/types";
import { Loader2 } from "lucide-react";
import React, { useState } from "react";
import { ModalShell } from "./modal-shell";
import { activeDocs } from "./shared";
export type ShipmentDialogRequest = {
  kind: "create" | "edit_case" | "group" | "complete" | "reopen" | "resolve";
  issue?: Issue;
};
type Props = {
  request: ShipmentDialogRequest;
  state: WorkspaceState | undefined;
  issues: Issue[];
  actor: Actor;
  shipment?: ShipmentCase;
  localMode: boolean;
  busy: boolean;
  selectedDocuments: string[];
  onSelectionChange: React.Dispatch<React.SetStateAction<string[]>>;
  mutation: (action: Action, success?: string) => Promise<boolean>;
  onClose: () => void;
  onCreated: () => void;
  onCaseOpen: (id: string) => void;
};
export function ShipmentActionDialog({
  request: modal,
  state,
  issues,
  actor,
  shipment: current,
  localMode,
  busy,
  selectedDocuments: selectedDocs,
  onSelectionChange: setSelectedDocs,
  mutation,
  onClose,
  onCreated,
  onCaseOpen: openCase,
}: Props) {
  const { t, locale } = useLocale();
  const [modalText, setModalText] = useState(
    modal.kind === "edit_case" ? current?.title || "" : "",
  );
  const [modalTarget, setModalTarget] = useState(
    modal.kind === "edit_case" ? current?.assignedTo || "" : "",
  );
  const [groupMode, setGroupMode] = useState(
    modal.kind === "edit_case" ? current?.caseType || "import" : "move",
  );
  const [createType, setCreateType] = useState<"import" | "export">("import");
  const documents = state && current ? activeDocs(state, current.id) : [];
  const submitModal = async (event: React.FormEvent) => {
    event.preventDefault();

    let ok = false;
    if (modal.kind === "create") {
      ok = await mutation(
        { type: "create_case", title: modalText, caseType: createType },
        t("Đã tạo hồ sơ mới"),
      );
      if (ok) {
        onCreated();
      }
    }
    if (current) {
      if (modal.kind === "edit_case")
        ok = await mutation(
          {
            type: "update_case",
            caseId: current.id,
            title: modalText,
            assignedTo: reviewerForMode(localMode, actor, modalTarget),
            caseType: groupMode as ShipmentCase["caseType"],
          },
          t("Đã cập nhật thông tin hồ sơ"),
        );
      if (modal.kind === "complete" || modal.kind === "reopen")
        ok = await mutation(
          { type: modal.kind, caseId: current.id, reason: modalText },
          modal.kind === "complete"
            ? t("Đã hoàn tất và lưu trữ hồ sơ")
            : t("Đã mở lại hồ sơ để điều chỉnh"),
        );
      if (modal.kind === "resolve" && modal.issue)
        ok = await mutation(
          {
            type: "resolve_issue",
            caseId: current.id,
            issueId: modal.issue.id,
            reason: modalText,
          },
          t("Đã lưu quyết định xử lý"),
        );
      if (modal.kind === "group") {
        if (groupMode === "merge")
          ok = await mutation(
            {
              type: "merge_cases",
              sourceCaseId: current.id,
              targetCaseId: modalTarget,
            },
            t("Đã gộp hồ sơ"),
          );
        else
          ok = await mutation(
            {
              type: "move_documents",
              documentIds: selectedDocs,
              ...(modalTarget
                ? { targetCaseId: modalTarget }
                : {
                    title:
                      modalText || t("Tách từ {p0}", { p0: current.reference }),
                  }),
            },
            t("Đã cập nhật phân nhóm chứng từ"),
          );
        if (ok) {
          setSelectedDocs([]);
          if (groupMode === "merge") openCase(modalTarget);
        }
      }
    }
    if (ok) onClose();
  };

  return (
    <ModalShell
      title={
        modal.kind === "create"
          ? t("Tạo hồ sơ lô hàng")
          : modal.kind === "edit_case"
            ? t("Thông tin hồ sơ")
            : modal.kind === "group"
              ? t("Sắp xếp chứng từ")
              : modal.kind === "complete"
                ? t("Hoàn tất và lưu trữ hồ sơ")
                : modal.kind === "reopen"
                  ? t("Mở lại hồ sơ để điều chỉnh")
                  : t("Ghi nhận quyết định rà soát")
      }
      onClose={() => onClose()}
    >
      <form onSubmit={submitModal}>
        <div className="modal-body">
          {modal.kind === "create" ? (
            <>
              <p className="muted">
                {locale === "en" ? "Choose the shipment direction, then add documents and data." : "Chọn chiều vận chuyển, sau đó bổ sung chứng từ và dữ liệu."}
              </p>
              <label>
                {locale === "en" ? "Shipment direction" : "Chiều vận chuyển"}
                <select value={createType} disabled={busy} onChange={event => setCreateType(event.target.value as "import" | "export")}>
                  <option value="import">{locale === "en" ? "Import (IDA)" : "Nhập khẩu (IDA)"}</option>
                  <option value="export">{locale === "en" ? "Export (EDA)" : "Xuất khẩu (EDA)"}</option>
                </select>
              </label>
              <label>
                {t("Tên lô hàng")}
                <input
                  autoFocus
                  required
                  value={modalText}
                  onChange={(e) => setModalText(e.target.value)}
                  placeholder={t("Ví dụ: Nhập khẩu linh kiện · tháng 10")}
                />
              </label>
            </>
          ) : modal.kind === "edit_case" ? (
            <>
              <label>
                {t("Tên lô hàng")}
                <input
                  autoFocus
                  required
                  value={modalText}
                  onChange={(e) => setModalText(e.target.value)}
                />
              </label>
              {localMode ? (
                <div className="local-reviewer-info">
                  <span>{t("Người phụ trách")}</span>
                  <strong>{t("Người dùng trên Mac này")}</strong>
                  <small>
                    {t(
                      "Lưu thông tin sẽ phân công hồ sơ cho người đang sử dụng Mac này.",
                    )}
                  </small>
                </div>
              ) : (
                <label>
                  {t("Người phụ trách")}
                  <input
                    required
                    value={modalTarget}
                    onChange={(e) => setModalTarget(e.target.value)}
                  />
                </label>
              )}
              <label>
                {t("Loại hồ sơ")}
                <select
                  value={groupMode}
                  onChange={(e) => setGroupMode(e.target.value)}
                >
                  {Object.entries(CASE_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                {t(
                  "Chọn theo nội dung chứng từ và chiều vận chuyển thực tế. Tên thư mục hoặc người gửi không đủ để xác định loại hồ sơ.",
                )}
              </p>
            </>
          ) : modal.kind === "group" ? (
            <>
              <div className="segmented">
                <button
                  type="button"
                  className={groupMode === "move" ? "active" : ""}
                  onClick={() => setGroupMode("move")}
                >
                  {t("Tách / di chuyển")}
                </button>
                <button
                  type="button"
                  className={groupMode === "merge" ? "active" : ""}
                  onClick={() => setGroupMode("merge")}
                >
                  {t("Gộp cả hồ sơ")}
                </button>
              </div>
              {groupMode === "move" && (
                <>
                  <p className="muted">
                    {t(
                      "Chọn chứng từ cần chuyển. Các quyết định liên quan phải được rà soát lại.",
                    )}
                  </p>
                  <div className="group-document-list">
                    {documents.map((d) => (
                      <label className="checkbox-label" key={d.id}>
                        <input
                          type="checkbox"
                          checked={selectedDocs.includes(d.id)}
                          onChange={(e) =>
                            setSelectedDocs((v) =>
                              e.target.checked
                                ? [...v, d.id]
                                : v.filter((id) => id !== d.id),
                            )
                          }
                        />
                        {d.name}
                      </label>
                    ))}
                  </div>
                </>
              )}
              <label>
                {t("Hồ sơ đích")}
                <select
                  required={groupMode === "merge"}
                  value={modalTarget}
                  onChange={(e) => setModalTarget(e.target.value)}
                >
                  <option value="">
                    {groupMode === "merge"
                      ? t("Chọn hồ sơ để gộp vào")
                      : t("Tạo hồ sơ mới từ chứng từ đã chọn")}
                  </option>
                  {state?.cases
                    .filter(
                      (c) =>
                        !c.mergedInto &&
                        c.id !== current?.id &&
                        c.status === "review",
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.reference} · {c.title}
                      </option>
                    ))}
                </select>
              </label>
              {!modalTarget && groupMode === "move" && (
                <label>
                  {t("Tên hồ sơ mới")}
                  <input
                    required
                    value={modalText}
                    onChange={(e) => setModalText(e.target.value)}
                    placeholder={t("Tên lô hàng được tách")}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              <div className="modal-context">
                {modal.kind === "complete"
                  ? t(
                      "Hồ sơ sẽ rời hàng đợi và xuất hiện trong lưu trữ. Đây là quyết định của người phụ trách, không phải xác nhận thông quan.",
                    )
                  : modal.kind === "reopen"
                    ? t(
                        "Hồ sơ trở lại hàng đợi. Các thay đổi tiếp theo cần được duyệt lại trước khi chuyển.",
                      )
                    : modal.issue
                      ? translateIssue(
                          issues.find(
                            (issue) => issue.id === modal.issue?.id,
                          ) || modal.issue,
                          locale,
                        ).description
                      : ""}
              </div>
              <label>
                {t("Lý do ")}
                {modal.kind === "complete"
                  ? t("hoàn tất")
                  : modal.kind === "reopen"
                    ? t("mở lại")
                    : t("xử lý")}
                <textarea
                  rows={4}
                  autoFocus
                  required
                  minLength={3}
                  value={modalText}
                  onChange={(e) => setModalText(e.target.value)}
                  placeholder={t(
                    "Ghi rõ quyết định và căn cứ để người khác có thể rà soát…",
                  )}
                />
              </label>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={() => onClose()}
          >
            {t("Hủy")}
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              (modal.kind === "group" &&
                groupMode === "move" &&
                !selectedDocs.length)
            }
          >
            {busy && <Loader2 className="spin" size={15} />}
            {modal.kind === "create"
              ? t("Tạo hồ sơ")
              : modal.kind === "group"
                ? t("Cập nhật phân nhóm")
                : modal.kind === "complete"
                  ? t("Hoàn tất & lưu trữ")
                  : t("Lưu quyết định")}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
