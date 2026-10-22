"use client";

import { AuthGate, useAuthStatus } from "@/components/account-access";
import {
  DeclarationDraftEditor,
  type DeclarationUiDraft,
} from "@/components/declaration-draft";
import { fetchWithSession } from "@/lib/auth-client";
import { CASE_TYPE_LABELS, caseScopeMessage } from "@/lib/case-scope";
import { clearSavedGoodsDraft } from "@/lib/client-drafts";
import { prepareIntakeFile } from "@/lib/client-intake";
import { runCaseKimi } from "@/lib/client-case-automation";
import { AiPipelineError, buildAiBatches, canRenderVisionDocument, runDocumentAi, type ClientAiStatus } from "@/lib/client-vision";
import { declarationEntryKey } from "@/lib/declaration";
import {
  clearSavedDeclarationDraft,
  hasDeclarationDrafts,
} from "@/lib/declaration-client";
import { LocaleProvider, useLocale } from "@/lib/i18n";
import { translateIssue, translateSystemText } from "@/lib/i18n-core";
import { downloadReport } from "@/lib/report";
import { actionableReviewIssues } from "@/lib/review-questions";
import { getReviewHistory } from "@/lib/review-history";
import type { Candidate, GoodsLine, Issue, ShipmentCase, ShipmentDocument, WorkspaceResponse } from "@/lib/types";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileText,
  GitBranch,
  History,
  Loader2,
  Mail,
  Settings2,
  ShieldCheck,
  Ship,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AuditList } from "@/components/workspace/audit-list";
import { ModalShell } from "@/components/workspace/modal-shell";
import {
  activeDocs,
  Badge,
  proposed,
  STATUS,
} from "@/components/workspace/shared";
import {
  ShipmentActionDialog,
  type ShipmentDialogRequest,
} from "@/components/workspace/shipment-action-dialog";
import { ShipmentDocuments } from "@/components/workspace/shipment-documents";
import { ShipmentIssues } from "@/components/workspace/shipment-issues";
import { EmailShipmentMatches } from "@/components/workspace/email-shipment-matches";
import { ShipmentList } from "@/components/workspace/shipment-list";
import {
  ShipmentMessages,
  type EmailDraftEdit,
} from "@/components/workspace/shipment-messages";
import { ShipmentReport } from "@/components/workspace/shipment-report";
import { SourceFields } from "@/components/workspace/source-fields";
import { SourceGoods } from "@/components/workspace/source-goods";
import { WorkspaceSettings } from "@/components/workspace/workspace-settings";
import { SampleReview } from "@/components/workspace/sample-review";
import {
  WorkspaceShell,
  type WorkspaceView,
} from "@/components/workspace/workspace-shell";

import {
  errorMessage,
  useWorkspaceSession,
  type ApiResponse,
} from "@/hooks/use-workspace-session";

import { sourcePageNeedsKimi } from '@/lib/source-completeness';

const needsKimi = (workspace: WorkspaceResponse, document: ShipmentDocument) => !document.referenceOnly && !['unsupported', 'failed'].includes(document.extractionStatus) && document.pages.some(page => sourcePageNeedsKimi(workspace.state, document, page));

export default function WorkspaceApp() {
  return (
    <LocaleProvider>
      <Workspace />
    </LocaleProvider>
  );
}

function subscribeLocationChange(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
const sampleViewRequested = () => new URLSearchParams(window.location.search).get('view') === 'samples';

function Workspace() {
  const { locale, t, date } = useLocale();
  const { status: authStatus } = useAuthStatus();
  const localMode = authStatus?.mode === "local";
  const {
    data,
    stateRef,
    error,
    setError,
    toast,
    setToast,
    busy,
    setBusy,
    loading,
    conflict,
    setConflict,
    conflictRef,
    install,
    load,
    mutation,
    refreshConflict,
  } = useWorkspaceSession();
  const pendingFieldSaves = useRef(new Map<string, string>());
  const [chosenView, setView] = useState<WorkspaceView | null>(null);
  const requestedSamples = useSyncExternalStore(subscribeLocationChange, sampleViewRequested, () => false);
  const view: WorkspaceView = chosenView ?? (localMode && requestedSamples ? 'samples' : 'shipments');
  const [shipmentQuery, setShipmentQuery] = useState("");
  const [shipmentFilter, setShipmentFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setReviewTab] = useState("declaration");
  const [shipmentTab, setShipmentTab] = useState<
    "review" | "documents" | "messages"
  >("review");
  const [secondary, setSecondary] = useState<"report" | "history" | null>(null);
  const setTab = (next: string) => {
    setReviewTab(next);
    setShipmentTab("review");
  };
  const [declarationDrafts, setDeclarationDrafts] = useState<
    Record<string, DeclarationUiDraft>
  >({});
  const [declarationFocus, setDeclarationFocus] = useState<
    string | undefined
  >();
  const [declarationGoodsFocus, setDeclarationGoodsFocus] = useState<
    string | undefined
  >();
  const [docId, setDocId] = useState("");
  const [page, setPage] = useState(1);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [selectedIssue, setSelectedIssue] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [emailDraftEdits, setEmailDraftEdits] = useState<
    Record<string, EmailDraftEdit>
  >({});
  const [reviewReason, setReviewReason] = useState("");
  const [goodsDrafts, setGoodsDrafts] = useState<Record<string, GoodsLine[]>>(
    {},
  );
  const goodsDraft = selectedId ? (goodsDrafts[selectedId] ?? null) : null;
  const setGoodsDraft = (next: GoodsLine[] | null) => {
    if (selectedId)
      setGoodsDrafts((previous) => {
        const value = { ...previous };
        if (next) value[selectedId] = next;
        else delete value[selectedId];
        return value;
      });
  };
  const [modal, setModal] = useState<ShipmentDialogRequest | null>(null);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [uploadLabel, setUploadLabel] = useState("");
  const [extractionCancelable, setExtractionCancelable] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const automaticCases = useRef(new Set<string>());
  const uploadInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceId = useRef("");

  const upload = async (files: FileList | null, replacement = false) => {
    if (!files?.length || conflictRef.current) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    uploadAbort.current = controller;
    const batch = replacement ? [files[0]] : Array.from(files);
    let currentFile = "";
    let committed = false;
    const existingDocuments = new Set((stateRef.current?.state.documents || []).map(document => `${document.id}:${document.version}`));
    try {
      if (
        batch.reduce((total, file) => total + file.size, 0) >
        22 * 1024 * 1024
      )
        throw new Error(
          t(
            "Lô chứng từ vượt quá giới hạn 22 MB. Chia thành các lần tải lên nhỏ hơn; AICD sẽ đối chiếu với các lô hàng đã có.",
          ),
        );
      const metadata = [];
      setExtractionCancelable(true);
      for (const [index, file] of batch.entries()) {
        currentFile = file.name;
        setUploadLabel(
          t("Đang đọc lô chứng từ · {p0}/{p1} · {p2}", {
            p0: index + 1,
            p1: batch.length,
            p2: file.name,
          }),
        );
        const prepared = await prepareIntakeFile(file, {
          signal: controller.signal,
          onProgress: (progress) =>
            setUploadLabel(
              t("Đang chuẩn bị {p0} · trang {p1}/{p2}", {
                p0: file.name,
                p1: progress.page,
                p2: progress.total,
              }),
            ),
        });
        if (controller.signal.aborted)
          throw new DOMException("Đã hủy tiếp nhận.", "AbortError");
        metadata.push({ name: file.name, ...prepared });
      }
      // Preserve the complete batch before AI reads the saved originals.
      // Shipment grouping is reconsidered as source-backed facts arrive.
      setExtractionCancelable(false);
      currentFile = "";
      setUploadLabel(t("Đang lưu toàn bộ chứng từ…"));
      const form = new FormData();
      for (const file of batch) form.append("file", file);
      form.set("documents", JSON.stringify(metadata));
      form.set("revision", String(stateRef.current?.state.revision ?? 0));
      if (replacement) form.set("documentId", replaceId.current);
      const response = await fetchWithSession("/api/documents", {
        method: "POST",
        body: form,
      });
      const rawResponse = await response.text();
      let body: ApiResponse;
      try {
        body = JSON.parse(rawResponse) as ApiResponse;
      } catch {
        if (response.status === 413)
          throw new Error(
            t(
              "Lô chứng từ vượt quá giới hạn 22 MB. Chia thành các lần tải lên nhỏ hơn; AICD sẽ đối chiếu với các lô hàng đã có.",
            ),
          );
        throw new Error(
          t("Không thể tiếp nhận chứng từ (HTTP {p0}). Vui lòng thử lại.", {
            p0: response.status,
          }),
        );
      }
      if (response.status === 409) {
        conflictRef.current = true;
        setConflict(body);
        throw new Error(
          t(
            "Có thay đổi từ thành viên khác. Nạp bản mới và chọn lại tệp chưa tải lên.",
          ),
        );
      }
      if (!response.ok)
        throw new Error(body.error || t("Không thể tiếp nhận lô chứng từ."));
      install(body);
      committed = true;
      // AI reads the saved originals in small batches. A later failure never
      // loses uploaded files or results from completed pages.
      const visualDocuments = body.state.documents.filter(document => document.active && !document.referenceOnly && canRenderVisionDocument(document) && !existingDocuments.has(`${document.id}:${document.version}`));
      if (visualDocuments.length) {
        const statusResponse = await fetchWithSession("/api/ai/status");
        const status = await statusResponse.json() as ClientAiStatus & { error?: string };
        if (!statusResponse.ok) throw new Error(status.error || t("Không thể kiểm tra kết nối AI."));
        if (status.configured && status.visionSupported === false) throw new Error(t("Quản trị viên cần chọn mô hình AI hỗ trợ đọc ảnh."));
        if (status.configured && !status.backgroundProcessing) {
          setExtractionCancelable(true);
          let workspace = body;
          const queue: { documentId: string; batches: number[][] }[] = [];
          const skipped: string[] = [];
          for (const document of visualDocuments) {
            try {
              const remaining = document.pages.filter(page => sourcePageNeedsKimi(workspace.state, document, page)).map(page => page.page);
              if (!remaining.length && document.pages.length) continue;
              queue.push({ documentId: document.id, batches: buildAiBatches(document.pages, remaining, status.limits, true) });
            } catch (error) { skipped.push(`${document.name}: ${translateSystemText(errorMessage(error), locale)}`); }
          }
          // Visit each document before a second batch of a long packing list.
          // This lets invoices and bills contribute before the request budget is exhausted.
          while (queue.some(item => item.batches.length)) for (const item of queue) {
            const pages = item.batches.shift();
            if (!pages) continue;
            const document = workspace.state.documents.find(document => document.id === item.documentId && document.active);
            if (!document) continue;
            currentFile = document.name;
            const savedPages = document.aiProcessedPages?.length || 0;
            const result = await runDocumentAi({
              workspace, documentId: document.id, pages, status, signal: controller.signal,
              onWorkspace: response => install(response),
              onProgress: progress => setUploadLabel(t(progress.stage === "rendering" ? "Đang chuẩn bị ảnh {p0} · trang {p1} · đã lưu {p2}/{p3}" : "Đang đọc bằng AI {p0} · đã lưu {p2}/{p3} trang", { p0: document.name, p1: progress.page, p2: savedPages + progress.completed, p3: document.pages.length })),
            });
            workspace = result.workspace;
          }
          if (workspace.state.emails.length && !controller.signal.aborted) {
            // New visual facts can identify previously unmatched replies. The server
            // rotates bounded batches, prioritizing pending or stale evidence.
            const matching = await fetchWithSession('/api/ai/group-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: workspace.state.revision }) });
            const matched = await matching.json() as ApiResponse;
            if (!matching.ok) throw new AiPipelineError(matched.error || 'Email matching could not finish. Saved documents remain available.', matching.status, matched.state ? matched : undefined);
            install(matched);
          }
          currentFile = "";
          if (skipped.length) setError(`${t("Một số chứng từ cần kiểm tra trước khi đọc bằng AI. Bản gốc vẫn được lưu.")} ${skipped.join(" · ")}`);
        } else if (!status.configured) {
          setError(t("Chứng từ đã được lưu và đang chờ AI. Quản trị viên cần cấu hình AI trên máy chủ để trích xuất dữ liệu."));
        }
      }
      setToast(
        body.notice ? translateSystemText(body.notice, locale) : t("Đã xử lý {p0} tệp cùng nhau. Kiểm tra nhóm chứng từ và bản nháp.", {
          p0: batch.length,
        }),
      );
    } catch (error) {
      if (error instanceof AiPipelineError && error.status === 409 && error.workspace) {
        conflictRef.current = true;
        setConflict(error.workspace);
      }
      if (controller.signal.aborted)
        setToast(t(committed ? "Đã dừng. Chứng từ và kết quả các trang đã xử lý vẫn được lưu. Mở chứng từ để tiếp tục đọc bằng AI." : "Đã dừng đọc chứng từ. Chưa lưu tệp nào trong lần tiếp nhận này."));
      else
        setError(
          `${committed ? `${t("Chứng từ đã được lưu. Có thể tiếp tục đọc bằng AI trong mục chứng từ.")} ` : ""}${currentFile ? `${currentFile}: ` : ""}${errorMessage(error)}`,
        );
    } finally {
      setBusy(false);
      setUploadLabel("");
      setExtractionCancelable(false);
      uploadAbort.current = null;
      if (uploadInput.current) uploadInput.current.value = "";
      if (replaceInput.current) replaceInput.current.value = "";
    }
  };
  const navigate = (next: WorkspaceView) => {
    setView(next);
    const url=new URL(window.location.href);
    if(next==='samples') url.searchParams.set('view','samples'); else url.searchParams.delete('view');
    window.history.replaceState(null,'',url);
    setSelectedId(null);
    setModal(null);
    setSecondary(null);
  };
  const openCase = (id: string) => {
    const target =
      stateRef.current?.state.cases.find((c) => c.id === id)?.mergedInto || id;
    setSelectedId(target);
    setView("shipments");
    setSecondary(null);
    setTab("declaration");
    setDeclarationFocus(undefined);
    setDeclarationGoodsFocus(undefined);
    setDocId("");
    setPage(1);
    setSelectedDocs([]);
    setSelectedIssue("");
    setReviewReason("");
    setError("");
  };
  const showModal = (kind: ShipmentDialogRequest["kind"], issue?: Issue) =>
    setModal({ kind, issue });

  const evidence = (candidate: Candidate) => {
    setDocId(candidate.documentId);
    setPage(candidate.page);
  };
  const saveField = async (c: ShipmentCase, field: string) => {
    const key = `${c.id}:${field}`;
    if (!(key in drafts)) return;
    const submittedValue = drafts[key];
    if (pendingFieldSaves.current.get(key) === submittedValue) return;
    if (!reviewReason.trim()) {
      setError(
        t(
          "Thêm lý do rà soát trước khi lưu giá trị chỉnh sửa. Nội dung đã nhập được giữ lại.",
        ),
      );
      return;
    }
    pendingFieldSaves.current.set(key, submittedValue);
    if (
      await mutation(
        {
          type: "review_field",
          caseId: c.id,
          field,
          value: submittedValue,
          reason: reviewReason,
        },
        t("Đã lưu giá trị và lý do rà soát"),
      )
    )
      setDrafts((current) => {
        const next = { ...current };
        if (next[key] === submittedValue) delete next[key];
        return next;
      });
    if (pendingFieldSaves.current.get(key) === submittedValue)
      pendingFieldSaves.current.delete(key);
  };
  const acceptCandidate = async (c: ShipmentCase, candidate: Candidate) => {
    const previousDraft = drafts[`${c.id}:${candidate.field}`];
    if (candidate.lineId) {
      setTab("goods");
      evidence(candidate);
      setToast(t("Đối chiếu và xác nhận dòng hàng trong bảng hàng hóa."));
      return;
    }
    if (
      !reviewReason.trim() &&
      (candidate.confidence !== "high" ||
        stateRef.current?.issues.some(
          (i) =>
            i.caseId === c.id &&
            i.field === candidate.field &&
            i.kind === "conflict" &&
            !i.resolved,
        ))
    ) {
      setError(
        t(
          "Ghi rõ lý do chọn nguồn này trong ô Lý do rà soát trước khi xác nhận dữ kiện mâu thuẫn hoặc chưa chắc chắn.",
        ),
      );
      document.getElementById("review-reason")?.focus();
      evidence(candidate);
      return;
    }
    if (
      await mutation(
        {
          type: "review_field",
          caseId: c.id,
          field: candidate.field,
          value: candidate.value,
          candidateId: candidate.id,
          reason:
            reviewReason.trim() ||
            t("Đã đối chiếu {p0}, trang {p1}: {p2}", {
              p0: stateRef.current?.state.documents.find(
                (d) => d.id === candidate.documentId,
              )?.name,
              p1: candidate.page,
              p2: candidate.originalText,
            }),
        },
        t("Đã ghi nhận lựa chọn của người rà soát"),
      )
    )
      setDrafts((current) => {
        const next = { ...current };
        if (next[`${c.id}:${candidate.field}`] === previousDraft)
          delete next[`${c.id}:${candidate.field}`];
        return next;
      });
  };
  const exportPdf = async (caseId: string) => {
    if (!stateRef.current) return;
    setBusy(true);
    try {
      await downloadReport(stateRef.current.state, caseId, locale);
      setToast(t("Đã tạo báo cáo PDF"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const state = data?.state;
  const current = state?.cases.find((c) => c.id === selectedId);
  const currentScope = current ? caseScopeMessage(current.caseType) : null;
  const unresolved = data?.issues.filter((i) => !i.resolved) || [];
  const issuePriority: Record<string, number> = {
    conflict: 0,
    stale: 1,
    document: 2,
    grouping: 3,
    unsupported: 4,
    missing: 5,
    goods: 6,
    uncertain: 7,
    transfer: 8,
    declaration: 5,
  };
  const caseIssues = unresolved
    .filter((i) => i.caseId === selectedId)
    .map((issue) => translateIssue(issue, locale))
    .sort(
      (a, b) => (issuePriority[a.kind] ?? 9) - (issuePriority[b.kind] ?? 9),
    );
  const pendingQuestions = state
    ? actionableReviewIssues(state, caseIssues)
    : [];
  const completedQuestions =
    state && current
      ? getReviewHistory(state, current.id, data?.issues || [])
      : [];
  const documents = state && current ? activeDocs(state, current.id) : [];
  const currentCandidates =
    state?.candidates.filter(
      (c) =>
        c.caseId === selectedId &&
        documents.some(
          (d) => d.id === c.documentId && d.version === c.documentVersion,
        ),
    ) || [];
  const run = state?.handoffs
    .filter(
      (h) =>
        h.caseId === selectedId &&
        h.snapshotId === current?.approval?.snapshotId,
    )
    .at(-1);
  const editable = current?.status === "review";
  const hasPendingDrafts =
    !!current &&
    (Object.keys(drafts).some((key) => key.startsWith(`${current.id}:`)) ||
      !!goodsDraft ||
      hasDeclarationDrafts(declarationDrafts, current.id));
  const hasPendingEmailDraft =
    !!current &&
    (state?.emailDrafts || []).some(
      (draft) =>
        draft.caseId === current.id &&
        !!emailDraftEdits[draft.id] &&
        (emailDraftEdits[draft.id].recipient !== draft.recipient ||
          emailDraftEdits[draft.id].subject !== draft.subject ||
          emailDraftEdits[draft.id].body !== draft.body),
    );
  const hasAnyPendingDrafts =
    Object.keys(drafts).length > 0 ||
    Object.keys(goodsDrafts).length > 0 ||
    Object.keys(declarationDrafts).length > 0 ||
    Object.keys(emailDraftEdits).length > 0;
  useEffect(() => {
    if (!hasAnyPendingDrafts && !busy) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasAnyPendingDrafts, busy]);
  // Background writes install only when no local edit is pending, and only if the
  // exact state seen at request start is still current when the response arrives.
  useEffect(() => {
    if (!localMode || busy || hasAnyPendingDrafts || conflictRef.current) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      const initial = stateRef.current;
      if (!initial) return;
      void fetchWithSession('/api/workspace', { signal: controller.signal, headers: { 'If-None-Match': `"${initial.state.id}:${initial.state.revision}"` } }).then(async response => {
        if (!response.ok) return;
        const body = await response.json() as WorkspaceResponse;
        if (!controller.signal.aborted && !conflictRef.current && stateRef.current === initial && body.state.revision > initial.state.revision) install(body);
      }).catch(() => undefined);
    }, 4000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [localMode, busy, hasAnyPendingDrafts, conflictRef, install, stateRef]);
  const liveCases =
    state?.cases.filter((c) => !c.mergedInto && c.status !== "completed") || [];
  const automaticDraft = state?.emailDrafts?.find(draft => draft.caseId === current?.id && draft.automation && draft.automation.state !== 'resolved');
  const unreadOriginals = !!data && documents.some(document => needsKimi(data, document));
  const automationKey = current?.status === 'review' && current.caseType === 'import'
    ? `${current.id}:${documents.map(document => `${document.id}:${document.version}`).sort().join('|')}` : '';
  useEffect(() => {
    if (!automationKey || busy || hasAnyPendingDrafts || conflictRef.current || automaticCases.current.has(automationKey)) return;
    const initial = stateRef.current;
    if (!initial || !selectedId) return;
    automaticCases.current.add(automationKey);
    const caseId = selectedId;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setBusy(true);
    void (async () => {
      try {
        const saved = await mutation({ type: 'refresh_case_automation', caseId, locale });
        const refreshed = stateRef.current;
        if (!saved || !refreshed) return;
        setBusy(true);
        const pending = refreshed.state.documents.some(document => document.caseId === caseId && document.active && needsKimi(refreshed, document));
        if (!pending) return;
        const response = await fetchWithSession('/api/ai/status');
        const status = await response.json() as ClientAiStatus & { error?: string };
        if (!response.ok) throw new Error(status.error || 'AI status could not be loaded.');
        if (!status.configured) {
          setError(locale === 'vi' ? 'Bản gốc đang chờ AI. Cần cấu hình khóa AI trên máy chủ để ứng dụng tự đọc và điền biểu mẫu.' : 'Originals are waiting for AI. Configure the server AI key to read and fill the forms automatically.');
          return;
        }
        if (status.backgroundProcessing) return;
        setExtractionCancelable(true);
        await runCaseKimi({ workspace: refreshed, caseId, status, signal: controller.signal,
          onWorkspace: response => { install(response); setError(""); },
          onProgress: progress => setUploadLabel(`${progress.stage === 'rendering' ? (locale === 'vi' ? 'Chuẩn bị ảnh trang' : 'Preparing page image') : (locale === 'vi' ? 'AI đang đọc' : 'AI is reading')} · ${progress.documentName} · ${progress.page}`),
        });
      } catch (error) {
        if (error instanceof AiPipelineError && error.workspace) install(error.workspace);
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        uploadAbort.current = null;
        setExtractionCancelable(false);
        setUploadLabel('');
        setBusy(false);
      }
    })();
  }, [automationKey, busy, hasAnyPendingDrafts, selectedId, locale, conflictRef, install, mutation, setBusy, setError, stateRef]);

  const documentPanel =
    state && current ? (
      <ShipmentDocuments
        state={state}
        shipment={current}
        documentId={docId}
        page={page}
        selectedDocuments={selectedDocs}
        onDocumentChange={setDocId}
        onPageChange={setPage}
        onSelectionChange={setSelectedDocs}
        busy={busy || !!conflict}
        hasPendingDrafts={hasPendingDrafts}
        reviewReason={reviewReason}
        mutation={mutation}
        onUpload={() => uploadInput.current?.click()}
        onGroup={() => showModal("group")}
        onReplace={(id) => {
          replaceId.current = id;
          replaceInput.current?.click();
        }}
        onBusyChange={setBusy}
        onApplied={(response, message) => {
          install(response);
          setError("");
          setToast(message);
        }}
        onConflict={(response) => {
          setConflict(response);
          conflictRef.current = true;
          setError(
            t(
              "Một thành viên khác đã cập nhật hồ sơ. Bản nhập của bạn được giữ lại.",
            ),
          );
        }}
      />
    ) : null;

  const questionsPanel =
    state && current?.caseType === "import" ? (
      <ShipmentIssues
        key={current.id}
        state={state}
        shipment={current}
        issues={pendingQuestions}
        completedQuestions={completedQuestions}
        selectedIssue={selectedIssue}
        onIssueChange={setSelectedIssue}
        busy={busy || !!conflict}
        reviewReason={reviewReason}
        mutation={mutation}
        onAccept={acceptCandidate}
        onEvidence={evidence}
        onDocument={(id, page) => {
          setDocId(id);
          setPage(page);
          if (tab === "declaration") setShipmentTab("documents");
        }}
        onDeclaration={(issue) => {
          setDeclarationFocus(issue.ecusFieldKey || issue.field);
          setDeclarationGoodsFocus(
            issue.goodsLineId || current.declarationDraft?.fields.find(
              (entry) =>
                entry.fieldId === issue.field &&
                issue.id.includes(
                  `:declaration:${declarationEntryKey(entry.fieldId, entry.goodsLineId)}:`,
                ),
            )?.goodsLineId,
          );
          setTab("declaration");
        }}
        onGoods={() => setTab("goods")}
        onResolve={(issue) => showModal("resolve", issue)}
        onEditCase={() => showModal("edit_case")}
        onUpload={() => uploadInput.current?.click()}
        showReviewReason={tab === "declaration"}
        hasPendingEmailDraft={hasPendingEmailDraft}
        onReasonChange={setReviewReason}
        onMessages={() => setShipmentTab("messages")}
        onField={(field) => {
          setTab("fields");
          setTimeout(
            () => document.getElementById(`input-${field}`)?.focus(),
            0,
          );
        }}
      />
    ) : null;

  return (
    <WorkspaceShell
      view={view}
      shipmentReference={current?.reference}
      actor={data?.actor}
      role={data?.role}
      localMode={localMode}
      shipmentCount={liveCases.length}
      sessionDisabled={busy || hasAnyPendingDrafts}
      onNavigate={navigate}
      onActivity={() => setShowActivity(true)}
    >
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
      <input
        ref={replaceInput}
        type="file"
        hidden
        onChange={(e) => void upload(e.target.files, true)}
      />
      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={17} />
          <span>{translateSystemText(error, locale)}</span>
          <button aria-label={t("Ẩn lỗi")} onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {conflict && (
        <div className="conflict-banner">
          <GitBranch size={19} />
          <div>
            <strong>{t("Hồ sơ đã được cập nhật ở nơi khác")}</strong>
            <p>
              {t(
                "Bản nhập của bạn vẫn được giữ. Nạp dữ liệu mới rồi kiểm tra trước khi lưu lại.",
              )}
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => void refreshConflict()}
          >
            {t("Nạp bản mới, giữ bản nhập")}
          </button>
        </div>
      )}
      {uploadLabel && (
        <div className="upload-progress" role="status">
          <Loader2 size={16} className="spin" />
          <div>
            <strong>{translateSystemText(uploadLabel, locale)}</strong>
            {extractionCancelable && (
              <p>
                {t(
                  "Giữ trang này mở để AI đọc chứng từ. Kết quả từng nhóm trang được lưu tự động.",
                )}
              </p>
            )}
          </div>
          {extractionCancelable && (
            <button
              className="button secondary small"
              onClick={() => uploadAbort.current?.abort()}
            >
              {t("Dừng xử lý")}
            </button>
          )}
        </div>
      )}
      {loading ? (
        <div className="loading-screen">
          <Loader2 className="spin" size={28} />
          <h3>{t("Đang tải không gian làm việc")}</h3>
          <p>{t("Chuẩn bị hồ sơ và lịch sử rà soát…")}</p>
        </div>
      ) : !state ? (
        <AuthGate
          onAuthenticated={() => void load()}
          onRetry={() => void load()}
        />
      ) : current ? (
        <>
          <section className="case-heading">
            <button className="back-button" onClick={() => setSelectedId(null)}>
              <ArrowLeft size={16} />
              {t("Danh sách hồ sơ")}
            </button>
            <div className="case-title-row">
              <div>
                <div className="eyebrow">
                  {current.reference} <span>•</span> {t(CASE_TYPE_LABELS[current.caseType])}
                  {current.synthetic && (
                    <Badge tone="purple">{t("Dữ liệu giả lập")}</Badge>
                  )}
                </div>
                <h1>{current.title}</h1>
                <div className="case-subtitle">
                  <span>
                    <Ship size={14} />
                    {proposed(state, current, "houseBillOfLading") ||
                      proposed(state, current, "billOfLading") ||
                      proposed(state, current, "masterBillOfLading") ||
                      t("Chưa có số vận đơn")}
                  </span>
                  <span>·</span>
                  <span>
                    {documents.length} {t("chứng từ")}
                  </span>
                  <span>·</span>
                  <span>
                    {t("Cập nhật ")}
                    {date(current.updatedAt)}
                  </span>
                  <Badge tone={current.caseType === "reference" ? "neutral" : current.status === "review" ? "amber" : "green"}>
                    {t(current.caseType === "reference" ? "Chỉ tham khảo" : STATUS[current.status])}
                  </Badge>
                </div>
              </div>
              <div className="case-actions">
                {editable && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => showModal("edit_case")}
                    title={t("Tên hồ sơ, người phụ trách và loại hình")}
                  >
                    <Settings2 size={15} />
                    {t("Thông tin")}
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={busy || hasPendingDrafts}
                  title={
                    hasPendingDrafts
                      ? t("Lưu nội dung đang chỉnh sửa trước khi xuất")
                      : t("Tải báo cáo PDF")
                  }
                  onClick={() => setSecondary("report")}
                >
                  <FileCheck2 size={16} />
                  {t("Báo cáo rà soát")}
                </button>
                {current.caseType === "import" && editable ? (
                  <button
                    className="button primary"
                    disabled={busy || hasPendingDrafts || caseIssues.length > 0}
                    title={
                      caseIssues.length
                        ? t("Xử lý các vấn đề trước khi duyệt")
                        : t("Đóng băng phiên bản được rà soát")
                    }
                    onClick={() =>
                      void mutation(
                        { type: "approve", caseId: current.id },
                        t("Đã duyệt nội bộ và đóng băng phiên bản"),
                      )
                    }
                  >
                    <CheckCheck size={17} />
                    {t("Duyệt bản khai")}
                  </button>
                ) : !editable ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => showModal("reopen")}
                  >
                    <History size={16} />
                    {t("Mở lại để chỉnh sửa")}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="next-action">
              <span
                className={`next-icon ${currentScope ? (current.caseType === "unknown" || current.caseType === "unsupported" ? "amber" : "") : caseIssues.length ? "amber" : "green"}`}
              >
                {currentScope ? (
                  current.caseType === "unknown" || current.caseType === "unsupported"
                    ? <AlertTriangle size={18} />
                    : <FileText size={18} />
                ) : caseIssues.length ? (
                  <AlertTriangle size={18} />
                ) : (
                  <Check size={18} />
                )}
              </span>
              <div>
                <strong>
                  {currentScope
                    ? t(currentScope.title)
                    : current.status === "completed"
                    ? t("Hồ sơ đã được lưu trữ")
                    : unreadOriginals
                      ? (locale === 'vi' ? 'AI đang chuẩn bị dữ liệu từ bản gốc' : 'AI original-document processing')
                    : automaticDraft && !automaticDraft.approval
                      ? (locale === 'vi' ? 'Email bổ sung thông tin đang chờ bạn duyệt' : 'Information-request email awaiting your approval')
                    : caseIssues.length
                      ? t("{p0} vấn đề cần bạn rà soát", {
                          p0: caseIssues.length,
                        })
                      : editable
                        ? t(
                            "Đã xử lý các vấn đề dữ liệu. Sẵn sàng duyệt nội bộ.",
                          )
                        : t("Phiên bản rà soát đã được đóng băng")}
                </strong>
                <span>
                  {currentScope
                    ? t(currentScope.description)
                    : current.status === "completed"
                    ? t("Mở lại hồ sơ khi cần sửa đổi hoặc bổ sung.")
                    : unreadOriginals
                      ? (locale === 'vi' ? 'Ứng dụng đọc các trang bằng AI, áp dụng hướng dẫn và điền biểu mẫu trước khi hỏi thông tin còn thiếu.' : 'The app reads pages with AI, applies the guide and fills the forms before requesting missing information.')
                    : automaticDraft && !automaticDraft.approval
                      ? (locale === 'vi' ? `Đã tổng hợp ${automaticDraft.automation?.questionCount || 0} thông tin cần bổ sung trong mục Tin nhắn. Email chưa được gửi.` : `${automaticDraft.automation?.questionCount || 0} outstanding details are grouped in Messages. The email has not been sent.`)
                    : caseIssues.length
                      ? t(
                          "Đối chiếu dữ kiện chứng từ và hàng hóa trong Rà soát & bản khai trước khi duyệt.",
                        )
                      : editable
                        ? t(
                            "Phê duyệt để cố định dữ liệu trước khi thử chuyển sang ECUS.",
                          )
                        : t(
                            "Có thể thử tạo bản nháp ECUS hoặc đánh dấu hoàn tất để lưu trữ.",
                          )}
                </span>
              </div>
              {current.caseType === "import" && <span className="legal-state">
                {t("Kiểm tra quy định ")}
                <strong>{t("Chưa đánh giá")}</strong>
              </span>}
            </div>
          </section>
          <div className="review-tabs">
            <div>
              {[
                {
                  id: "review",
                  label: t(current.caseType === "import" ? "Rà soát & bản khai" : "Thông tin"),
                  icon: ClipboardCheck,
                },
                { id: "documents", label: t("Chứng từ"), icon: FileText },
                { id: "messages", label: t("Trao đổi"), icon: Mail },
              ].map((item) => (
                <button
                  key={item.id}
                  className={shipmentTab === item.id ? "active" : ""}
                  onClick={() => setShipmentTab(item.id as typeof shipmentTab)}
                >
                  <item.icon size={16} />
                  {item.label}
                </button>
              ))}
            </div>
            <span className="save-indicator">
              {busy ? (
                <Loader2 className="spin" size={13} />
              ) : hasPendingDrafts || hasPendingEmailDraft ? (
                <Clock3 size={13} />
              ) : (
                <Check size={13} />
              )}{" "}
              {busy
                ? t("Đang lưu…")
                : hasPendingDrafts || hasPendingEmailDraft
                  ? t("Có nội dung chưa lưu")
                  : t("Mọi thay đổi đã lưu")}
            </span>
          </div>
          {shipmentTab === "review" && (
            <div
              className="review-subnavigation"
              aria-label={t("Các bước rà soát")}
            >
              {[
                { id: "declaration", label: t(current.caseType === "import" ? "Bản khai" : "Thông tin") },
                { id: "fields", label: t("Dữ kiện chứng từ") },
                { id: "goods", label: t("Đối chiếu hàng hóa") },
              ].map((item) => (
                <button
                  key={item.id}
                  className={tab === item.id ? "active" : ""}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
              <button
                className="secondary-history"
                onClick={() => setSecondary("history")}
              >
                <History size={14} />
                {t("Lịch sử thay đổi")}
              </button>
            </div>
          )}
          {shipmentTab === "messages" ? (
            <ShipmentMessages
              onReviewClientMemory={(fieldKey) => {
                setShipmentTab("review");
                setReviewTab("declaration");
                setDeclarationFocus(fieldKey);
                setDeclarationGoodsFocus(undefined);
              }}
              key={current.id}
              state={state}
              shipment={current}
              disabled={busy || !editable}
              mutation={mutation}
              edits={emailDraftEdits}
              onEdit={(id, edit) =>
                setEmailDraftEdits((previous) => ({ ...previous, [id]: edit }))
              }
              onSaved={(id, submitted) =>
                setEmailDraftEdits((previous) => {
                  const current = previous[id];
                  if (
                    !current ||
                    current.recipient !== submitted.recipient ||
                    current.subject !== submitted.subject ||
                    current.body !== submitted.body
                  )
                    return previous;
                  const next = { ...previous };
                  delete next[id];
                  return next;
                })
              }
              onUpload={() => uploadInput.current?.click()}
              onDocument={(id) => {
                setDocId(id);
                setPage(1);
                setShipmentTab("documents");
              }}
            />
          ) : shipmentTab === "documents" ? (
            <div className="standalone-documents">{documentPanel}</div>
          ) : (
            <>
              {tab === "declaration" ? (
                <>
                  {current.caseType === "import" && (pendingQuestions.length > 0 ||
                    completedQuestions.length > 0) && (
                    <details className="shipment-question-section ecus-review-questions">
                      <summary>{t("Cần rà soát ")}<span className="issue-count">{pendingQuestions.length}</span></summary>
                      {questionsPanel}
                    </details>
                  )}
                  <DeclarationDraftEditor
                    key={`${current.id}:${declarationFocus || ""}:${declarationGoodsFocus || ""}`}
                    state={state}
                    shipment={current}
                    issues={unresolved.filter(
                      (issue) => issue.caseId === current.id,
                    )}
                    busy={busy || !!conflict}
                    drafts={declarationDrafts}
                    focusFieldId={declarationFocus}
                    focusGoodsLineId={declarationGoodsFocus}
                    onChange={(key, draft) =>
                      setDeclarationDrafts((previous) => ({
                        ...previous,
                        [key]: draft,
                      }))
                    }
                    onSaved={(key, submitted) =>
                      setDeclarationDrafts((previous) =>
                        clearSavedDeclarationDraft(previous, key, submitted),
                      )
                    }
                    mutation={mutation}
                    onManageGoods={() => setTab("goods")}
                  />
                </>
              ) : tab === "fields" || tab === "goods" ? (
                <div
                  className={`review-grid ${tab === "goods" ? "goods-mode" : ""} ${current.caseType !== "import" ? "reference-review" : ""}`}
                >
                  {documentPanel}
                  <section className="data-panel">
                    <div className="panel-heading">
                      <h2>
                        {tab === "goods"
                          ? t("Danh sách hàng hóa")
                          : t(current.caseType === "import" ? "Bản khai đề xuất" : "Dữ kiện chứng từ")}
                      </h2>
                      <Badge tone="green">
                        {
                          tab === "goods"
                            ? current.goods.filter((line) => line.reviewed).length
                            : Object.values(current.fields).filter((f) => !f.stale)
                                .length
                        }{" "}
                        {t("đã rà soát")}
                      </Badge>
                    </div>
                    <div className="review-note">
                      <ShieldCheck size={15} />
                      <p>
                        {t(
                          "Đề xuất từ chứng từ. Mỗi xác nhận của bạn đều được lưu cùng nguồn và lý do.",
                        )}
                      </p>
                    </div>
                    {editable && (
                      <div className="review-reason">
                        <label htmlFor="review-reason">
                          {t("Lý do rà soát / chỉnh sửa ")}
                          <span>{t("Bắt buộc khi nhập tay")}</span>
                        </label>
                        <input
                          id="review-reason"
                          placeholder={t("Ví dụ: Đã xác nhận với chủ hàng…")}
                          value={reviewReason}
                          onChange={(e) => setReviewReason(e.target.value)}
                        />
                      </div>
                    )}
                    {tab === "fields" ? (
                      <SourceFields
                        state={state}
                        shipment={current}
                        issues={caseIssues}
                        candidates={currentCandidates}
                        drafts={drafts}
                        selectedIssue={selectedIssue}
                        busy={busy || !!conflict}
                        onDraftChange={setDrafts}
                        onSave={saveField}
                        onAccept={acceptCandidate}
                        onEvidence={evidence}
                      />
                    ) : (
                      <SourceGoods
                        state={state}
                        shipment={current}
                        draft={goodsDraft}
                        busy={busy || !!conflict}
                        reviewReason={reviewReason}
                        onChange={setGoodsDraft}
                        onSaved={(submittedGoods) =>
                          setGoodsDrafts((previous) =>
                            clearSavedGoodsDraft(
                              previous,
                              current.id,
                              submittedGoods,
                            ),
                          )
                        }
                        onError={setError}
                        onEvidence={(id, page) => {
                          setDocId(id);
                          setPage(page);
                        }}
                        mutation={mutation}
                      />
                    )}
                  </section>
                  {current.caseType === "import" && questionsPanel}
                </div>
              ) : null}

              {current.caseType === "import" && <details className="shipment-completion">
                <summary>{t("Hoàn tất hồ sơ & thử kết nối ECUS")}</summary>
                <section className="handoff-bar">
                  <div className="handoff-heading">
                    <span className="handoff-symbol">
                      <ArrowUpRight size={20} />
                    </span>
                    <div>
                      <h3>
                        {t("Chuyển bản nháp sang ECUS ")}
                        <Badge tone="purple">TEST CONNECTOR</Badge>
                      </h3>
                      <p>
                        {run
                          ? translateSystemText(run.message, locale)
                          : t(
                              "Mô phỏng có kiểm soát. Chưa kết nối ECUS thực tế.",
                            )}
                      </p>
                    </div>
                  </div>
                  <div className="handoff-status">
                    <span>
                      {t("Bản nháp ECUS ")}
                      <strong
                        className={
                          run?.status === "succeeded"
                            ? "text-green"
                            : run?.status === "failed"
                              ? "text-amber"
                              : ""
                        }
                      >
                        {run?.status === "succeeded"
                          ? `${run.draftReference} (TEST)`
                          : run?.status === "failed"
                            ? t("Thất bại (TEST)")
                            : t("Chưa tạo")}
                      </strong>
                    </span>
                    <span>
                      IDA <strong>{t("Chưa truyền")}</strong>
                    </span>
                    <span>
                      IDC <strong>{t("Chưa đăng ký")}</strong>
                    </span>
                    <span>
                      {t("Hải quan ")}
                      <strong>{t("Chưa đánh giá")}</strong>
                    </span>
                  </div>
                  <div className="handoff-actions">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={simulateFailure}
                        onChange={(e) => setSimulateFailure(e.target.checked)}
                      />
                      {t("Mô phỏng lỗi")}
                    </label>
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        hasPendingDrafts ||
                        current.status !== "approved"
                      }
                      onClick={() =>
                        void mutation(
                          {
                            type: "handoff",
                            caseId: current.id,
                            simulateFailure,
                          },
                          t(
                            "Đã chạy test connector. Không có truyền dữ liệu chính thức.",
                          ),
                        )
                      }
                    >
                      {t("Tạo bản nháp ECUS thử nghiệm")}{" "}
                      <ArrowUpRight size={15} />
                    </button>
                    {current.status !== "completed" && (
                      <button
                        className="button secondary"
                        disabled={
                          busy ||
                          hasPendingDrafts ||
                          current.status !== "approved" ||
                          caseIssues.length > 0 ||
                          ![
                            data.actor.id,
                            data.actor.name,
                            data.actor.email,
                          ].includes(current.assignedTo)
                        }
                        title={
                          current.status !== "approved"
                            ? t("Duyệt bản khai trước khi hoàn tất")
                            : ![
                                  data.actor.id,
                                  data.actor.name,
                                  data.actor.email,
                                ].includes(current.assignedTo)
                              ? t("Chỉ người phụ trách được đánh dấu hoàn tất")
                              : t("Hoàn tất và lưu trữ hồ sơ")
                        }
                        onClick={() => showModal("complete")}
                      >
                        <Archive size={15} />
                        {t("Hoàn tất & lưu trữ")}
                      </button>
                    )}
                  </div>
                  <p className="handoff-footnote">
                    {t(
                      "Chỉ bản được duyệt mới có thể chuyển. Không ký số, không truyền IDA, không đăng ký IDC. Mỗi lần chạy gắn với phiên bản được duyệt.",
                    )}
                  </p>
                </section>
              </details>}
            </>
          )}
        </>
      ) : view === "samples" && localMode ? (
        <SampleReview />
      ) : view === "settings" ? (
        <WorkspaceSettings data={data!} busy={busy} mutation={mutation} />
      ) : (
        <>
        <EmailShipmentMatches state={state} disabled={busy || !!conflict} onBusyChange={setBusy} onApplied={(response, message) => { install(response); setError(""); setToast(message); }} onConflict={response => { conflictRef.current = true; setConflict(response); }} mutation={mutation} onOpen={openCase} onUpload={() => uploadInput.current?.click()} />
        <ShipmentList
          query={shipmentQuery}
          filter={shipmentFilter}
          onQueryChange={setShipmentQuery}
          onFilterChange={setShipmentFilter}
          state={state}
          issues={unresolved}
          busy={busy}
          onOpen={openCase}
          onCreate={() => showModal("create")}
          onUpload={() => uploadInput.current?.click()}
          onDemo={() =>
            void mutation(
              { type: "seed_demo" },
              t("Đã nạp bộ chứng từ giả lập để thử toàn bộ quy trình"),
            )
          }
        />
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          <span>{translateSystemText(toast, locale)}</span>
          <button
            className="icon-button"
            aria-label={t("Ẩn thông báo")}
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {secondary && current && state && (
        <ModalShell
          title={
            secondary === "history"
              ? t("Lịch sử có thể truy vết")
              : t("Báo cáo rà soát")
          }
          onClose={() => setSecondary(null)}
          wide
        >
          <div className="modal-body">
            {secondary === "history" ? (
              <AuditList
                entries={state.audit
                  .filter((entry) => entry.caseId === current.id)
                  .slice()
                  .reverse()}
              />
            ) : (
              <>
                <button
                  className="button secondary"
                  disabled={busy || hasPendingDrafts}
                  onClick={() => void exportPdf(current.id)}
                >
                  <ArrowDownToLine size={16} />
                  {t("Báo cáo PDF")}
                </button>
                <ShipmentReport
                  state={state}
                  shipment={current}
                  issues={caseIssues}
                />
              </>
            )}
          </div>
        </ModalShell>
      )}
      {showActivity && (
        <ModalShell
          title={t("Hoạt động của không gian làm việc")}
          onClose={() => setShowActivity(false)}
        >
          <div className="modal-body">
            <AuditList
              entries={(state?.audit || []).slice().reverse().slice(0, 40)}
            />
          </div>
        </ModalShell>
      )}
      {modal && data && (
        <ShipmentActionDialog
          request={modal}
          state={state}
          issues={data.issues}
          actor={data.actor}
          shipment={current}
          localMode={localMode}
          busy={busy || !!conflict}
          selectedDocuments={selectedDocs}
          onSelectionChange={setSelectedDocs}
          mutation={mutation}
          onClose={() => setModal(null)}
          onCreated={() => {
            const newest = stateRef.current?.state.cases.at(-1);
            if (newest) openCase(newest.id);
          }}
          onCaseOpen={openCase}
        />
      )}
    </WorkspaceShell>
  );
}
