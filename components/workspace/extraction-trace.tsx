"use client";

import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { VisionEvidenceImage } from "@/components/vision-evidence-image";
import { ECUS_FORM_FIELDS, ecusFormValue } from "@/lib/ecus-form";
import { canonicalExtractionField } from "@/lib/extraction";
import { useLocale } from "@/lib/i18n";
import { fieldLabel } from "@/lib/i18n-core";
import { normalizedShipmentValue } from "@/lib/shipment-autofill";
import type {
  Candidate,
  ShipmentCase,
  ShipmentDocument,
  SourcePage,
  WorkspaceState,
} from "@/lib/types";
import { confidenceLabel, documentLabel } from "./shared";

type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  document: ShipmentDocument;
  page?: SourcePage;
};

const kimiModel = (method: string) =>
  method.slice(5).replace(/:source_(?:vision|text)_proposal(?::.*)?$/, "");

/** Shows saved extraction outputs and source links, never a reconstructed AI rationale. */
export function ExtractionTrace({ state, shipment, document, page }: Props) {
  const { locale, t } = useLocale();
  const say = (vi: string, en: string) => (locale === "vi" ? vi : en);
  const [expandedCandidate, setExpandedCandidate] = useState("");
  const candidates = state.candidates.filter(
    (candidate) =>
      candidate.caseId === shipment.id &&
      candidate.documentId === document.id &&
      candidate.documentVersion === document.version &&
      candidate.page === page?.page,
  );
  const processed =
    document.extractionPipeline === "kimi" && !!page?.aiReadability;
  const kimiCandidates = candidates.filter(
    (candidate) => processed && candidate.method.startsWith("kimi:"),
  );
  const legacyCount = candidates.length - kimiCandidates.length;
  const models = [
    ...new Set(kimiCandidates.map((candidate) => kimiModel(candidate.method))),
  ];
  const visual =
    document.mime === "application/pdf" || document.mime.startsWith("image/");
  const hasRejected =
    processed && document.aiRejectedPages?.includes(page?.page || 0);
  const formEntries = shipment.declarationDraft?.fields || [];
  const targetsFor = (candidate: Candidate) => {
    const key = canonicalExtractionField(candidate.field);
    const fields = ECUS_FORM_FIELDS.filter(
      (field) =>
        canonicalExtractionField(field.sourceField || field.key) === key,
    );
    return formEntries.flatMap((entry) => {
      const citesCandidate =
        entry.sourceCandidateIds?.includes(candidate.id) ||
        entry.provenance.some(
          (source) =>
            source.kind === "document" &&
            source.documentId === candidate.documentId &&
            source.documentVersion === candidate.documentVersion &&
            source.page === candidate.page &&
            (source.visualEvidence?.candidateId === candidate.id ||
              source.quote === candidate.originalText),
        );
      if (
        !citesCandidate ||
        entry.stale ||
        entry.applicability !== "applicable"
      )
        return [];
      return fields
        .filter(
          (field) =>
            field.fieldId === entry.fieldId &&
            normalizedShipmentValue(
              key,
              ecusFormValue(
                field,
                shipment.declarationDraft,
                entry.goodsLineId,
              ),
            ) === normalizedShipmentValue(key, candidate.value),
        )
        .map((field) => ({
          label: field.labelVi,
          manual: entry.generatedBy !== "shipment_extraction" || !!entry.review,
        }));
    });
  };
  const appliedCount = kimiCandidates.filter(
    (candidate) => targetsFor(candidate).length > 0,
  ).length;

  return (
    <details className="extraction-trace">
      <summary>
        <ScanLine size={15} />
        <span>{say("Xem cách trích xuất", "How this was extracted")}</span>
        <small>
          {kimiCandidates.length} {say("giá trị từ AI", "AI readings")}
        </small>
        <ChevronDown size={14} />
      </summary>
      <div className="extraction-trace-body">
        <ol className="extraction-stages">
          <li>
            <FileText size={16} />
            <div>
              <strong>
                {say("1. Chuẩn bị bản gốc", "1. Prepare the original")}
              </strong>
              <p>
                {visual
                  ? document.mime === "application/pdf"
                    ? say(
                        "PDFium dựng ảnh từng trang PDF. Ảnh trang được gửi đến AI; không lấy văn bản PDF hoặc chạy OCR.",
                        "PDFium renders each PDF page as an image. Page images go to AI; no PDF text extraction or OCR runs.",
                      )
                    : say(
                        "Ảnh chứng từ gốc được gửi đến AI để đọc nội dung.",
                        "The original document image goes to AI for reading.",
                      )
                  : say(
                      "Nội dung của tệp được gửi đến AI để xác định thông tin chứng từ.",
                      "The file content goes to AI to identify document information.",
                    )}
              </p>
            </div>
          </li>
          <li>
            <Sparkles size={16} />
            <div>
              <strong>
                {say("2. AI đọc trang", "2. AI reads the page")}
              </strong>
              <p>
                {models.length
                  ? models.join(" · ")
                  : processed
                    ? say(
                        "Trang đã được AI xử lý; trang này chưa có giá trị trích xuất ghi tên mô hình.",
                        "AI processed this page; no extracted value on this page records the model name.",
                      )
                    : say(
                        "Chưa có kết quả AI đã lưu cho trang này.",
                        "No saved AI result for this page yet.",
                      )}
              </p>
              <span>
                {say("Trang", "Page")} {page?.page || 1} ·{" "}
                {page?.documentType
                  ? t(documentLabel(page.documentType))
                  : t(documentLabel(document.type))}{" "}
                ·{" "}
                {processed && page?.aiReadability === "clear"
                  ? say("Đọc rõ", "Clear reading")
                  : processed && page?.aiReadability === "uncertain"
                    ? say("Chưa đọc rõ", "Uncertain reading")
                    : say("Chưa đọc", "Not yet read")}
              </span>
            </div>
          </li>
          <li>
            <Check size={16} />
            <div>
              <strong>
                {say(
                  "3. Đối chiếu và điền biểu mẫu",
                  "3. Compare and fill the form",
                )}
              </strong>
              <p>
                {say(
                  "Website kiểm tra dẫn nguồn, so sánh giá trị giữa các trang và chứng từ, rồi tự điền thông tin rõ ràng, nhất quán. Chỉ dữ liệu thực sự thiếu, chưa rõ hoặc mâu thuẫn mới cần xử lý thêm.",
                  "The website checks source evidence, compares values across pages and documents, and fills clear, consistent information. Only genuinely missing, unclear or conflicting data needs further attention.",
                )}
              </p>
              <span>
                {appliedCount}{" "}
                {say(
                  "giá trị đang được dùng trong biểu mẫu",
                  "readings currently used in the form",
                )}
              </span>
            </div>
          </li>
        </ol>
        {legacyCount > 0 && (
          <p className="extraction-legacy-note">
            {say(
              `Trang này còn ${legacyCount} kết quả từ lần đọc trước. Chúng được giữ để đối chiếu, không được dùng làm dữ liệu AI hiện tại hoặc tự điền.`,
              `This page also has ${legacyCount} historical readings. They are retained for reference and are not used as current AI readings or for autofill.`,
            )}
          </p>
        )}
        {hasRejected && (
          <p className="extraction-legacy-note">
            {say(
              "Một số giá trị AI trả về không vượt qua kiểm tra dẫn nguồn. Những giá trị đó không được lưu hoặc tự điền.",
              "Some AI outputs failed the source-evidence checks. Those values were neither saved nor autofilled.",
            )}
          </p>
        )}
        {kimiCandidates.length > 0 ? (
          <div className="extraction-readings">
            {kimiCandidates.map((candidate) => {
              const targets = targetsFor(candidate);
              const manual =
                targets.length > 0 && targets.every((target) => target.manual);
              const expanded = expandedCandidate === candidate.id;
              const field = ECUS_FORM_FIELDS.find(
                (item) =>
                  canonicalExtractionField(item.sourceField || item.key) ===
                  canonicalExtractionField(candidate.field),
              );
              const label = field
                ? locale === "vi"
                  ? field.labelVi
                  : field.labelEn
                : fieldLabel(candidate.field, locale);
              return (
                <article className="extraction-reading" key={candidate.id}>
                  <button
                    className="extraction-reading-heading"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedCandidate(expanded ? "" : candidate.id)
                    }
                  >
                    <span>
                      <strong>{label}</strong>
                      <span>{candidate.value}</span>
                    </span>
                    <small className={targets.length ? "applied" : "retained"}>
                      {targets.length
                        ? manual
                          ? say("Đã chọn thủ công", "Reviewer selected")
                          : say("Đã tự điền", "Autofilled")
                        : say("Giữ để đối chiếu", "Saved for comparison")}
                    </small>
                    <ChevronDown size={12} />
                  </button>
                  {expanded && (
                    <div className="extraction-reading-detail">
                      <div className="extraction-reading-meta">
                        <span>{kimiModel(candidate.method)}</span>
                        <span>{t(confidenceLabel[candidate.confidence])}</span>
                        {candidate.confidenceScore !== undefined && (
                          <span>
                            {say("Ước lượng của AI", "AI estimate")}:{" "}
                            {candidate.confidenceScore}/100 ·{" "}
                            {say("chưa hiệu chuẩn", "uncalibrated")}
                          </span>
                        )}
                        <span>
                          {candidate.readability === "clear"
                            ? say(
                                "AI đọc rõ giá trị này",
                                "AI marked this reading clear",
                              )
                            : candidate.readability === "uncertain"
                              ? say(
                                  "AI chưa đọc rõ giá trị này",
                                  "AI marked this reading uncertain",
                                )
                              : say(
                                  "Chưa có đánh giá độ rõ riêng cho giá trị",
                                  "No separate readability rating for this value",
                                )}
                        </span>
                      </div>
                      {targets.length > 0 && (
                        <p className="extraction-applied-target">
                          <ArrowRight size={12} />
                          {[
                            ...new Set(targets.map((target) => target.label)),
                          ].join(" · ")}
                        </p>
                      )}
                      <blockquote>{candidate.originalText}</blockquote>
                      {candidate.visualEvidence ? (
                        <VisionEvidenceImage
                          documentId={document.id}
                          page={candidate.page}
                          evidence={candidate.visualEvidence}
                          cropped
                        />
                      ) : (
                        <p className="muted">
                          {say(
                            "Dẫn nguồn được đối chiếu nguyên văn với nội dung trang đã gửi.",
                            "The quotation is matched against the page text submitted to AI.",
                          )}
                        </p>
                      )}
                      {candidate.normalizations.map((normalization, index) => (
                        <p className="extraction-normalization" key={index}>
                          <span>
                            {normalization.before} → {normalization.after}
                          </span>
                          <small>{normalization.reason}</small>
                        </p>
                      ))}
                      <details className="extraction-record">
                        <summary>
                          {say(
                            "Xem bản ghi trích xuất",
                            "Inspect extraction record",
                          )}
                        </summary>
                        <pre>
                          {JSON.stringify(
                            {
                              field: candidate.field,
                              value: candidate.value,
                              page: candidate.page,
                              documentVersion: candidate.documentVersion,
                              method: candidate.method,
                              confidence: candidate.confidence,
                              confidenceScore: candidate.confidenceScore,
                              readability: candidate.readability,
                              location: candidate.location,
                              ...(candidate.lineId
                                ? { goodsLineId: candidate.lineId }
                                : {}),
                              ...(candidate.visualEvidence
                                ? {
                                    imageSha256:
                                      candidate.visualEvidence.imageSha256,
                                    bounds: candidate.visualEvidence.bounds,
                                  }
                                : {}),
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="extraction-no-readings">
            {processed
              ? say(
                  "AI đã đọc trang này nhưng không có giá trị trích xuất đã lưu.",
                  "AI read this page, but no extracted field values were saved.",
                )
              : say(
                  "Kết quả sẽ xuất hiện ở đây sau khi AI đọc bản gốc.",
                  "The results will appear here after AI reads the original.",
                )}
          </p>
        )}
      </div>
    </details>
  );
}
