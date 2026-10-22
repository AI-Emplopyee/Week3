"use client";
import { CASE_TYPE_LABELS, caseScopeMessage } from "@/lib/case-scope";
import { useLocale } from "@/lib/i18n";
import type { Issue, WorkspaceState } from "@/lib/types";
import {
  AlertCircle,
  Archive,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  Ship,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Badge, Empty, STATUS, activeDocs, initials, proposed } from "./shared";
type Props = {
  state: WorkspaceState;
  issues: Issue[];
  busy: boolean;
  query: string;
  filter: string;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: string) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onUpload: () => void;
  onDemo: () => void;
};
export function ShipmentList({
  state,
  issues: unresolved,
  busy,
  query,
  filter,
  onQueryChange: setQuery,
  onFilterChange: setFilter,
  onOpen: openCase,
  onCreate,
  onUpload,
  onDemo,
}: Props) {
  const { t, date, locale } = useLocale();
  const say = (vi: string, en: string) => (locale === "vi" ? vi : en);
  const sampleCases = state.cases.filter(
    (c) => !c.mergedInto && c.sourceCollection,
  );
  const liveCases = state.cases.filter(
    (c) => !c.mergedInto && !c.sourceCollection && c.status !== "completed",
  );
  const archivedCases = state.cases.filter(
    (c) => !c.mergedInto && !c.sourceCollection && c.status === "completed",
  );
  const issueCases = liveCases.filter(
    (c) =>
      c.caseType !== "reference" &&
      unresolved.some((issue) => issue.caseId === c.id),
  );
  const readyCases = liveCases.filter(
    (c) =>
      c.caseType === "import" &&
      !unresolved.some((issue) => issue.caseId === c.id),
  );
  const rows = (
    filter === "samples"
      ? sampleCases
      : filter === "archive"
        ? archivedCases
        : liveCases
  ).filter(
    (c) =>
      (filter !== "issues" ||
        (c.caseType !== "reference" &&
          unresolved.some((i) => i.caseId === c.id))) &&
      (filter !== "ready" ||
        (c.caseType === "import" &&
          !unresolved.some((i) => i.caseId === c.id))) &&
      (!query ||
        [
          c.reference,
          c.title,
          c.assignedTo,
          c.sourceCollection?.name,
          c.sourceCollection?.folder,
          ...state.documents
            .filter((document) => document.caseId === c.id)
            .flatMap((document) => [
              document.name,
              ...(document.sourcePaths || []),
            ]),
          ...Object.values(c.fields).map((f) => f.value),
          ...state.candidates
            .filter((candidate) => candidate.caseId === c.id)
            .map((candidate) => candidate.value),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  return (
    <div className="content">
      <div className="page-title">
        <div>
          <div className="eyebrow">
            {filter === "samples"
              ? t("BỘ HỒ SƠ MẪU ĐÃ NHẬP")
              : filter === "archive"
                ? t("HỒ SƠ ĐÃ HOÀN TẤT")
                : t("KHÔNG GIAN LÀM VIỆC CỦA BẠN")}
          </div>
          <h1>{t("Lô hàng")}</h1>
          <p>
            {filter === "samples"
              ? t(
                  "Hồ sơ lịch sử được lưu cùng chứng từ gốc. Kiểm tra phân nhóm trước khi sử dụng bản khai.",
                )
              : filter === "archive"
                ? t("Tra cứu hồ sơ đã hoàn tất và mở lại khi cần điều chỉnh.")
                : t(
                    "Từ chứng từ đầu vào đến bản khai được rà soát, cùng một nơi.",
                  )}
          </p>
        </div>
        <div className="title-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => onCreate()}
          >
            <Plus size={16} />
            {t("Tạo hồ sơ")}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => onUpload()}
          >
            <Upload size={17} />
            {t("Tải chứng từ")}
          </button>
        </div>
      </div>

      {state.cases.length === 0 && (
        <div className="welcome-card">
          <div className="welcome-copy">
            <span className="mini-eyebrow">
              <Sparkles size={13} />
              {t("BẮT ĐẦU VỚI AICD")}
            </span>
            <h2>
              {t("Bớt đối chiếu thủ công.")}
              <br />
              {t("Thêm thời gian cho quyết định.")}
            </h2>
            <p>
              {t(
                "Tải lên bộ chứng từ đầu tiên, hoặc khám phá quy trình với lô hàng mẫu có dữ liệu hoàn toàn giả lập.",
              )}
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => onDemo()}
            >
              <Sparkles size={16} />
              {t("Khám phá hồ sơ mẫu ")}
              <ArrowRight size={15} />
            </button>
            <span className="demo-disclosure">
              {t("Không sử dụng thông tin khách hàng thật.")}
            </span>
          </div>
          <div className="workflow-illustration" aria-hidden="true">
            <div className="illustration-file back">
              <FileText size={23} />
              <span>PACKING LIST</span>
              <i />
              <i />
              <i />
            </div>
            <div className="illustration-file front">
              <div>
                <span className="file-mini-icon">
                  <FileText size={17} />
                </span>
                <small>COMMERCIAL INVOICE</small>
                <Check size={14} />
              </div>
              <strong>{t("Chứng từ đã được sắp xếp.")}</strong>
              <i />
              <i />
              <i />
              <div className="illustration-value">
                <span>{t("Tổng trị giá")}</span>
                <b>
                  {t("Cần đối chiếu ")}
                  <AlertCircle size={11} />
                </b>
              </div>
            </div>
            <div className="illustration-check">
              <CheckCheck size={15} />
              <span>{t("Mỗi giá trị, một nguồn gốc.")}</span>
            </div>
            <div className="illustration-line" />
          </div>
        </div>
      )}
      <section className="card queue-card">
        <div className="queue-top">
          <div>
            <h2>
              {filter === "samples"
                ? t("Hồ sơ mẫu")
                : filter === "archive"
                  ? t("Hồ sơ lưu trữ")
                  : t("Hàng đợi công việc")}
              <span className="count-pill">{rows.length}</span>
            </h2>
            <p>
              {filter === "samples"
                ? t("Tìm và mở hồ sơ theo thư mục hoặc tên tệp nguồn.")
                : filter === "archive"
                  ? t("Chỉ hồ sơ được người phụ trách đánh dấu hoàn tất.")
                  : t("Ưu tiên các hồ sơ cần quyết định của bạn.")}
            </p>
          </div>
          <div className="queue-legend">
            <span className="status-dot" />
            {t("Cập nhật từ không gian làm việc")}
          </div>
        </div>
        <div className="queue-controls">
          <div className="filter-tabs">
            {[
              { id: "all", label: t("Đang xử lý"), count: liveCases.length },
              {
                id: "issues",
                label: t("Cần rà soát"),
                count: issueCases.length,
              },
              {
                id: "ready",
                label: t("Đã xử lý vấn đề"),
                count: readyCases.length,
              },
              {
                id: "archive",
                label: t("Lưu trữ"),
                count: archivedCases.length,
              },
              {
                id: "samples",
                label: t("Hồ sơ mẫu"),
                count: sampleCases.length,
              },
            ].map((navTab) => (
              <button
                className={filter === navTab.id ? "active" : ""}
                onClick={() => setFilter(navTab.id)}
                key={navTab.id}
              >
                {t(navTab.label)}
                <span>{navTab.count}</span>
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label={t("Tìm hồ sơ")}
              placeholder={t("Tìm hồ sơ, tệp, thư mục, vận đơn…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                aria-label={t("Xóa tìm kiếm")}
                onClick={() => setQuery("")}
              >
                <X size={13} />
              </button>
            )}
          </label>
        </div>
        <div className="table-scroll">
          <table className="queue-table">
            <thead>
              <tr>
                <th>{t("Hồ sơ / khách hàng")}</th>
                <th>{t("Chứng từ")}</th>
                <th>{t("Trạng thái")}</th>
                <th>{t("Cần xử lý")}</th>
                <th>{t("Người phụ trách")}</th>
                <th>
                  {t("Cập nhật ")}
                  <ChevronDown size={11} />
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows
                .slice()
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((c) => {
                  const issues = unresolved.filter((i) => i.caseId === c.id);
                  const docs = activeDocs(state, c.id);
                  const scope = caseScopeMessage(c.caseType);
                  const sourceDocuments = docs.filter(
                    (document) => !document.referenceOnly,
                  );
                  const sourceStatuses = sourceDocuments.map(
                    (document) => document.extractionStatus,
                  );
                  const unreadDocuments = sourceDocuments.filter(
                    (document) =>
                      !["unsupported", "failed"].includes(
                        document.extractionStatus,
                      ) &&
                      (document.extractionPipeline !== "kimi" ||
                        document.extractionStatus === "pending_ai" ||
                        document.pages.some((page) => !page.aiReadability)),
                  );
                  const draft =
                    c.status === "review"
                      ? state.emailDrafts?.find(
                          (item) =>
                            item.caseId === c.id &&
                            item.status === "draft" &&
                            item.automation &&
                            item.automation.state !== "resolved",
                        )
                      : undefined;
                  const sourceAction =
                    c.status !== "review"
                      ? undefined
                      : sourceStatuses.includes("unsupported")
                        ? "Có tệp cần đổi định dạng"
                        : sourceStatuses.includes("failed")
                          ? "Có tệp không mở được"
                          : unreadDocuments.length
                            ? "Đang chờ AI đọc chứng từ"
                            : sourceStatuses.includes("needs_transcription")
                              ? "Có trang chưa đọc rõ"
                              : undefined;
                  const coveredIssues = new Set(draft?.issueIds ?? []);
                  const primarySourceDocuments = sourceDocuments.filter(
                    (document) =>
                      sourceStatuses.includes("unsupported")
                        ? document.extractionStatus === "unsupported"
                        : sourceStatuses.includes("failed")
                          ? document.extractionStatus === "failed"
                          : unreadDocuments.length
                            ? unreadDocuments.includes(document)
                            : document.extractionStatus ===
                              "needs_transcription",
                  );
                  const otherIssues = issues.filter(
                    (issue) =>
                      !coveredIssues.has(issue.id) &&
                      !(
                        sourceAction &&
                        issue.kind === "document" &&
                        primarySourceDocuments.some(
                          (document) =>
                            issue.id === `${c.id}:document-${document.id}` ||
                            issue.id === `${c.id}:kimi-original-${document.id}`,
                        )
                      ),
                  );
                  const extractionLabel = sourceStatuses.includes("unsupported")
                    ? "Có tệp cần đổi định dạng"
                    : sourceStatuses.includes("failed")
                      ? "Có tệp không mở được"
                      : sourceStatuses.includes("pending_ai")
                        ? "Đang chờ AI đọc chứng từ"
                        : sourceStatuses.includes("needs_transcription")
                          ? "Có trang chưa đọc rõ"
                          : "Có nguồn đối chiếu";
                  return (
                    <tr key={c.id} onClick={() => openCase(c.id)}>
                      <td>
                        <div className="case-cell">
                          <span
                            className={`shipment-icon ${c.caseType === "import" && !issues.length ? "ready" : ""}`}
                          >
                            {c.caseType === "reference" ? (
                              <FileText size={19} />
                            ) : (
                              <Ship size={19} />
                            )}
                          </span>
                          <div>
                            <button
                              className="case-link"
                              onClick={() => openCase(c.id)}
                            >
                              {c.title}
                            </button>
                            <span className="case-reference">
                              {c.reference} <span>·</span>{" "}
                              {c.caseType === "import"
                                ? proposed(state, c, "importer") ||
                                  t("Chưa xác định bên nhập khẩu")
                                : t(CASE_TYPE_LABELS[c.caseType])}
                            </span>
                            {c.sourceCollection && (
                              <span
                                className="case-reference"
                                title={`${c.sourceCollection.name} / ${c.sourceCollection.folder}`}
                                style={{ overflowWrap: "anywhere" }}
                              >
                                {c.sourceCollection.name} ·{" "}
                                {c.sourceCollection.folder}
                              </span>
                            )}
                            <div className="case-tags">
                              {c.synthetic && (
                                <span className="synthetic-tag">
                                  {t("Dữ liệu giả lập")}
                                </span>
                              )}
                              {!c.groupingConfirmed &&
                                c.caseType !== "reference" && (
                                  <span className="grouping-tag">
                                    {t("Chưa xác nhận phân nhóm")}
                                  </span>
                                )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="document-count">
                          <FileText size={14} />
                          {docs.length} {t("chứng từ")}
                        </span>
                        <small className="table-subtext">
                          {docs.length === 0
                            ? t("Chưa có chứng từ")
                            : docs.every((d) => d.referenceOnly)
                              ? t("Chỉ có tài liệu tham khảo")
                              : t(extractionLabel)}
                        </small>
                      </td>
                      <td>
                        <Badge
                          tone={
                            scope
                              ? c.caseType === "unknown" ||
                                c.caseType === "unsupported"
                                ? "amber"
                                : "neutral"
                              : c.status === "review"
                                ? "blue"
                                : "green"
                          }
                        >
                          <span className="badge-dot" />
                          {t(
                            c.caseType === "reference"
                              ? "Chỉ tham khảo"
                              : scope
                                ? CASE_TYPE_LABELS[c.caseType]
                                : STATUS[c.status],
                          )}
                        </Badge>
                      </td>
                      <td>
                        {scope ? (
                          <span
                            className="table-subtext"
                            title={t(scope.description)}
                          >
                            {t(
                              c.caseType === "reference"
                                ? "Chỉ tham khảo"
                                : scope.title,
                            )}
                          </span>
                        ) : sourceAction ? (
                          <div className="queue-next-action">
                            <span className="issue-table-count">
                              <Sparkles size={14} />
                              {t(sourceAction)}
                            </span>
                            {draft && (
                              <small className="table-subtext">
                                {say(
                                  "Email sẽ cập nhật sau khi đọc nguồn",
                                  "Email draft updates after source reading",
                                )}
                              </small>
                            )}
                            {otherIssues.length > 0 && (
                              <small className="table-subtext">
                                {say(
                                  `${otherIssues.length} mục cần kiểm tra thêm`,
                                  `${otherIssues.length} other checks remain`,
                                )}
                              </small>
                            )}
                          </div>
                        ) : draft?.automation ? (
                          <div className="queue-next-action">
                            <span
                              className={
                                draft.approval
                                  ? "ready-label"
                                  : "issue-table-count"
                              }
                            >
                              <Mail size={14} />
                              {draft.automation.state === "waiting_for_sources"
                                ? say(
                                    "Hoàn tất kiểm tra nguồn",
                                    "Complete source review",
                                  )
                                : draft.automation.state === "needs_review"
                                  ? say(
                                      "Rà soát email đã cập nhật",
                                      "Review updated email draft",
                                    )
                                  : draft.approval
                                    ? say(
                                        "Email đã duyệt · chưa gửi",
                                        "Email approved · not sent",
                                      )
                                    : say(
                                        "Email nháp đang chờ duyệt",
                                        "Email draft awaiting approval",
                                      )}
                            </span>
                            <small className="table-subtext">
                              {draft.automation.state === "waiting_for_sources"
                                ? say(
                                    "Email sẽ cập nhật sau khi rà soát",
                                    "Email draft updates after review",
                                  )
                                : say(
                                    `${draft.automation.questionCount} thông tin cần hỏi trong một email`,
                                    `${draft.automation.questionCount} questions in one email`,
                                  )}
                            </small>
                            {otherIssues.length > 0 && (
                              <small className="table-subtext">
                                {say(
                                  `${otherIssues.length} mục cần kiểm tra thêm`,
                                  `${otherIssues.length} other checks remain`,
                                )}
                              </small>
                            )}
                          </div>
                        ) : issues.length ? (
                          <span className="issue-table-count">
                            <AlertCircle size={14} />
                            {issues.length} {t("vấn đề")}
                          </span>
                        ) : (
                          <span className="ready-label">
                            <Check size={14} />
                            {t("Đã rà soát")}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="assignee">
                          <span className="mini-avatar">
                            {initials(c.assignedTo || "?")}
                          </span>
                          {c.assignedTo || t("Chưa phân công")}
                        </span>
                      </td>
                      <td>
                        <span className="timestamp">{date(c.updatedAt)}</span>
                      </td>
                      <td>
                        <ChevronRight size={16} className="muted" />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <Empty
            icon={filter === "archive" ? Archive : Search}
            title={
              query
                ? t("Không tìm thấy hồ sơ phù hợp")
                : filter === "archive"
                  ? t("Chưa có hồ sơ lưu trữ")
                  : state.cases.length
                    ? t("Không có hồ sơ trong bộ lọc này")
                    : t("Hàng đợi đã sẵn sàng")
            }
          >
            <p>
              {query
                ? t(
                    "Thử tìm bằng tên khách hàng, số hóa đơn, tên tệp hoặc thư mục nguồn.",
                  )
                : filter === "samples"
                  ? t("Các bộ hồ sơ lịch sử đã nhập sẽ xuất hiện ở đây.")
                  : filter === "archive"
                    ? t(
                        "Hồ sơ sẽ xuất hiện ở đây khi người phụ trách đánh dấu hoàn tất.",
                      )
                    : t("Tải chứng từ lên hoặc mở hồ sơ mẫu để bắt đầu.")}
            </p>
          </Empty>
        )}
        <div className="table-footer">
          <span>
            {t("Hiển thị ")}
            {rows.length} {t("hồ sơ")}
          </span>
          <span>
            <ShieldCheck size={13} />
            {t("Kiểm tra quy định hải quan: ")}
            <strong>{t("Chưa đánh giá")}</strong>
          </span>
        </div>
      </section>

      <footer className="page-footer">
        <span>
          <span className="brand-mini">AICD.</span>{" "}
          {t("Rõ nguồn dữ liệu. Rõ từng quyết định.")}
        </span>
        <span>{t("Không ký số hoặc truyền tờ khai chính thức.")}</span>
      </footer>
    </div>
  );
}
