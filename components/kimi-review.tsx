"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, Sparkles, X } from "lucide-react";
import type { ShipmentDocument, WorkspaceResponse } from "@/lib/types";
import { fetchWithSession } from "@/lib/auth-client";
import { useLocale } from "@/lib/i18n";
import { translateSystemText } from "@/lib/i18n-core";
import {
  AiPipelineError,
  buildAiBatches,
  canRenderVisionDocument,
  runDocumentAi,
  type AiProgress,
  type ClientAiStatus,
} from "@/lib/client-vision";

type Props = {
  document: ShipmentDocument;
  caseId: string;
  revision: number;
  initialPage: number;
  disabled: boolean;
  label?: string;
  onBusyChange: (busy: boolean) => void;
  onApplied: (response: WorkspaceResponse, message: string) => void;
  onConflict: (response: WorkspaceResponse) => void;
};

export function KimiReviewButton(props: Props) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (
    !props.document.pages.length ||
    props.document.extractionStatus === "unsupported" ||
    props.document.extractionStatus === "failed"
  )
    return null;
  return (
    <>
      <button
        className="button secondary small ai-source-button"
        disabled={props.disabled || !props.document.pages.length}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={13} />
        {props.label ||
          t(
            props.document.pages.some(
              (page) => page.aiReadability === "uncertain",
            )
              ? "Đọc lại các trang chưa rõ"
              : "Đọc chứng từ bằng AI",
          )}
      </button>
      {open && <KimiRequestDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function KimiRequestDialog({
  document,
  revision,
  onClose,
  onBusyChange,
  onApplied,
  onConflict,
}: Props & { onClose: () => void }) {
  const { t, locale } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<ClientAiStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [pages, setPages] = useState<number[]>(() => {
    const remaining = document.pages.filter(
      (page) =>
        !(document.aiProcessedPages || []).includes(page.page) ||
        document.aiRejectedPages?.includes(page.page) ||
        page.aiReadability === "uncertain",
    );
    return (remaining.length ? remaining : document.pages).map(
      (page) => page.page,
    );
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    fetchWithSession("/api/ai/status", { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as ClientAiStatus & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || "Không thể kiểm tra kết nối AI.");
        setStatus(body);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Không thể kiểm tra kết nối AI.",
          );
      });
    return () => {
      element?.close();
      controller.abort();
      abort.current?.abort();
    };
  }, []);
  const visual = canRenderVisionDocument(document);
  let selectionError = "";
  try {
    buildAiBatches(
      document.pages,
      pages,
      status?.limits || {
        maxPages: 5,
        maxTextCharacters: 24000,
        maxCandidates: 100,
      },
      visual,
    );
  } catch (error) {
    selectionError =
      error instanceof Error ? error.message : "Invalid page selection.";
  }
  const submit = async () => {
    if (pending || !status?.configured || selectionError) return;
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setStopping(false);
    setError("");
    onBusyChange(true);
    try {
      const response = await fetchWithSession("/api/workspace");
      const workspace = (await response.json()) as WorkspaceResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          workspace.error || "Không thể tải không gian làm việc.",
        );
      if (workspace.state.revision !== revision) {
        onConflict(workspace);
        onClose();
        return;
      }
      const result = await runDocumentAi({
        workspace,
        documentId: document.id,
        pages,
        status,
        signal: controller.signal,
        onProgress: setProgress,
        onWorkspace: (response) => {
          const processed =
            (response as WorkspaceResponse & { ai?: { pages: number[] } }).ai
              ?.pages || [];
          setPages((current) =>
            current.filter((page) => !processed.includes(page)),
          );
          onApplied(
            response,
            t("Đã lưu kết quả AI của một nhóm trang. Đang tiếp tục…"),
          );
        },
      });
      const uncertain =
        result.workspace.state.documents
          .find((source) => source.id === document.id)
          ?.pages.filter(
            (page) =>
              pages.includes(page.page) && page.aiReadability === "uncertain",
          )
          .map((page) => page.page) || [];
      onApplied(
        result.workspace,
        !result.rejected && uncertain.length
          ? t(
              "Đã lưu kết quả AI. Trang {p0} vẫn chưa rõ; có thể đọc lại hoặc thay bản rõ hơn.",
              { p0: uncertain.join(", ") },
            )
          : t(
              result.rejected
                ? "AI đã đọc {p0} trang và thêm {p1} giá trị có dẫn nguồn. {p2} giá trị chưa đủ căn cứ không được lưu."
                : "AI đã đọc {p0} trang và thêm {p1} giá trị có dẫn nguồn. Bản nháp đã được cập nhật.",
              { p0: result.processed, p1: result.added, p2: result.rejected },
            ),
      );
      onClose();
    } catch (error) {
      if (
        error instanceof AiPipelineError &&
        error.status === 409 &&
        error.workspace
      ) {
        onConflict(error.workspace);
        onClose();
      } else if (controller.signal.aborted)
        setError(
          t(
            "Đã dừng. Kết quả các trang đã xử lý vẫn được lưu; có thể tiếp tục các trang còn lại.",
          ),
        );
      else
        setError(
          error instanceof Error
            ? error.message
            : "Không thể hoàn thành thao tác. Vui lòng thử lại.",
        );
    } finally {
      setPending(false);
      onBusyChange(false);
      abort.current = null;
    }
  };
  const completed = document.aiProcessedPages?.length || 0;
  const uncertainPages = document.pages
    .filter((page) => page.aiReadability === "uncertain")
    .map((page) => page.page);
  return (
    <dialog
      ref={dialog}
      className="modal ai-consent-modal"
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">{status?.model || "AI"}</span>
          <h2>{t("Đọc chứng từ bằng AI")}</h2>
        </div>
        <button
          className="icon-button"
          aria-label={t("Đóng")}
          disabled={pending}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <div className="modal-body">
        <div className="ai-document-summary">
          <FileText size={21} />
          <div>
            <strong>{document.name}</strong>
            <small>
              {t("Đã xử lý {p0}/{p1} trang", {
                p0: completed,
                p1: document.pages.length,
              })}
            </small>
          </div>
        </div>
        <p>
          {visual
            ? t("AI đọc trực tiếp ảnh trang chứng từ và điền bản nháp.")
            : t(
                "AI đọc văn bản đã lưu để trích xuất thông tin có dẫn nguồn và cập nhật bản nháp.",
              )}
        </p>
        {status?.configured && (
          <p className="muted">
            {locale === "vi" ? "Nơi xử lý: " : "Processing provider: "}
            <strong>{status.provider}</strong>
            {status.endpoint && <> · {status.endpoint}</>}
          </p>
        )}
        <p className="muted">
          {t(
            "Thông tin rõ ràng, có dẫn nguồn và không mâu thuẫn được tự điền. Chỉ thông tin thiếu, chưa rõ hoặc mâu thuẫn mới cần kiểm tra. Tờ khai vẫn chờ người duyệt.",
          )}
        </p>
        {!!uncertainPages.length && (
          <p className="muted">
            {t(
              "Trang {p0} chưa đọc đủ rõ. Các trang này đã được chọn để thử lại; chỉ gửi yêu cầu khi bạn bấm đọc.",
              { p0: uncertainPages.join(", ") },
            )}
          </p>
        )}
        {!!document.aiRejectedPages?.length && (
          <p className="muted">
            {t(
              "Một số đề xuất AI chưa đủ căn cứ trên trang {p0}. Kiểm tra hoặc đọc lại các trang này; giá trị bị loại chưa được lưu.",
              { p0: document.aiRejectedPages.join(", ") },
            )}
          </p>
        )}
        <details className="ai-page-selection">
          <summary>
            {t("Chọn trang · {p0} trang", { p0: pages.length })}
          </summary>
          <fieldset disabled={pending}>
            <legend>{t("Chọn trang cần phân tích")}</legend>
            {document.pages.map((page) => (
              <label className="checkbox-label" key={page.page}>
                <input
                  type="checkbox"
                  checked={pages.includes(page.page)}
                  onChange={(event) =>
                    setPages((current) =>
                      event.target.checked
                        ? [...current, page.page]
                        : current.filter((number) => number !== page.page),
                    )
                  }
                />
                {t("Trang {p0}", { p0: page.page })}
                {page.aiReadability === "uncertain" ? (
                  <small>{t("Chưa đọc rõ")}</small>
                ) : (
                  document.aiProcessedPages?.includes(page.page) && (
                    <small>{t("Đã xử lý")}</small>
                  )
                )}
              </label>
            ))}
          </fieldset>
        </details>
        {pending && (
          <p role="status" className="auth-loading">
            <Loader2 className="spin" size={15} />
            {stopping
              ? t("Đang dừng sau yêu cầu hiện tại…")
              : progress
                ? t(
                    progress.stage === "rendering"
                      ? "Đang chuẩn bị ảnh trang {p0} · đã lưu {p1}/{p2} trang"
                      : "Đang đọc bằng AI · đã lưu {p1}/{p2} trang",
                    {
                      p0: progress.page,
                      p1: progress.completed,
                      p2: progress.total,
                    },
                  )
                : t("Đang kiểm tra cấu hình máy chủ…")}
          </p>
        )}
        {!status && !error && (
          <p className="auth-loading">
            <Loader2 className="spin" size={15} />
            {t("Đang kiểm tra cấu hình máy chủ…")}
          </p>
        )}
        {status && !status.configured && (
          <p className="connection-blocker">
            {t(
              "Quản trị viên cần cấu hình AI trên máy chủ để bật chức năng này. Hiện chưa thể gửi yêu cầu trích xuất.",
            )}
          </p>
        )}
        {status?.configured && visual && status.visionSupported === false && (
          <p className="connection-blocker">
            {t("Quản trị viên cần chọn mô hình AI hỗ trợ đọc ảnh.")}
          </p>
        )}
        {(error || selectionError) && (
          <div className="inline-form-error" role="alert">
            <AlertCircle size={16} />
            <span>{translateSystemText(error || selectionError, locale)}</span>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button
          className="button secondary"
          disabled={stopping}
          onClick={() => {
            if (pending) {
              setStopping(true);
              abort.current?.abort();
            } else onClose();
          }}
        >
          {t(pending ? "Dừng sau yêu cầu hiện tại" : "Đóng")}
        </button>
        <button
          className="button primary"
          disabled={
            pending ||
            !status?.configured ||
            (visual && status.visionSupported === false) ||
            !!selectionError
          }
          onClick={() => void submit()}
        >
          {pending ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <Sparkles size={16} />
          )}
          {t(
            completed && completed < document.pages.length
              ? "Tiếp tục đọc các trang còn lại"
              : "Đọc các trang đã chọn",
          )}
        </button>
      </div>
    </dialog>
  );
}
