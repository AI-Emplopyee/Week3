"use client";

import { useMemo } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { VisionEvidenceImage } from "@/components/vision-evidence-image";
import { isDeclarationSourceCurrent } from "@/lib/declaration";
import type {
  DeclarationFieldEntry,
  DeclarationProvenance,
} from "@/lib/declaration-types";
import { ecusEvidenceReadings } from "@/lib/ecus-evidence";
import { ecusFormValue, type EcusFormField } from "@/lib/ecus-form";
import { canonicalExtractionField } from "@/lib/extraction";
import { useLocale } from "@/lib/i18n";
import { buildShipmentFacts } from "@/lib/shipment-autofill";
import type { ShipmentCase, WorkspaceState } from "@/lib/types";

type Props = {
  state: WorkspaceState;
  shipment: ShipmentCase;
  field: EcusFormField;
  goodsLineId?: string;
  currentValue: string;
  entry?: DeclarationFieldEntry;
  provenance: DeclarationProvenance[];
  basis: string;
  unsaved: boolean;
};

/** Scores describe saved source readings. They never grade a reviewer edit or a derived customs code. */
export function EcusFieldEvidence({
  state,
  shipment,
  field,
  goodsLineId,
  currentValue,
  entry,
  provenance,
  basis,
  unsaved,
}: Props) {
  const { locale } = useLocale();
  const say = (vi: string, en: string) => (locale === "vi" ? vi : en);
  const facts = useMemo(
    () => buildShipmentFacts(state, shipment),
    [state, shipment],
  );
  const fact = goodsLineId
    ? undefined
    : facts[canonicalExtractionField(field.sourceField ?? field.key)];
  const readings = ecusEvidenceReadings(
    field,
    provenance,
    state.candidates,
    fact?.candidates,
    ecusFormValue(field, shipment.declarationDraft, goodsLineId),
  );
  const documents = readings.filter((item) => item.source.kind === "document");
  const hasManualBasis = provenance.some((source) => source.kind === "manual");
  const hasReconciliationPolicy = fact?.rule?.origin === "user_policy" || readings.some(
    (item) => item.candidate?.normalizations.some((change) => change.reason.startsWith("user-policy:")),
  );
  const guideReasons = [
    ...new Set([
      ...(fact?.rule &&
      !entry?.stale &&
      documents.some(
        (item) =>
          item.candidate &&
          fact.candidates.some(
            (candidate) => candidate.id === item.candidate?.id,
          ),
      )
        ? [
            `${fact.rule.origin === "user_policy" ? say("Đối chiếu nguồn", "Source reconciliation") : `§ ${fact.rule.section}`} · ${locale === "vi" ? fact.rule.reasonVi : fact.rule.reasonEn}`,
          ]
        : []),
      ...readings.flatMap(
        (item) =>
          item.candidate?.normalizations
            .filter((change) => change.reason.startsWith("vnaccs-guide:") || change.reason.startsWith("user-policy:"))
            .map((change) => change.reason) ?? [],
      ),
    ]),
  ];
  const qualitative = (confidence: string) =>
    confidence === "high"
      ? say("Cao", "High")
      : confidence === "medium"
        ? say("Trung bình", "Medium")
        : say("Thấp", "Low");
  return (
    <div className="ecus-field-evidence">
      <div className="ecus-selected-value">
        <span>
          {say("Giá trị trên biểu mẫu", "Current form value")}
          {unsaved ? ` · ${say("chưa lưu", "unsaved")}` : ""}
        </span>
        <strong>{currentValue || "—"}</strong>
        <small>
          {hasManualBasis
            ? say(
                "Có dữ liệu hoặc căn cứ do người dùng nhập. Điểm bên dưới chỉ thuộc lần đọc chứng từ của AI.",
                "Includes user input or a manual basis. Scores below belong only to AI’s source reading.",
              )
            : entry?.review
              ? say("Đã được người phụ trách rà soát", "Reviewed by a person")
              : entry?.generatedBy === "shipment_extraction"
                ? say("Tự điền từ chứng từ", "Autofilled from source documents")
                : currentValue
                  ? say("Giá trị do người dùng lưu", "Value saved by a person")
                  : say("Chưa có giá trị", "No value yet")}
        </small>
      </div>
      {documents.length > 0 && (
        <p className="ecus-confidence-note">
          {say(
            "Điểm là ước lượng của AI về lần đọc nguồn, chưa được hiệu chuẩn; không phải xác nhận tính đúng của mã khai báo.",
            "Scores are AI’s uncalibrated estimates of source readings, not validation of declaration codes.",
          )}
        </p>
      )}
      {documents.map(({ source, index, candidate, scoreEligible }) => {
        if (source.kind !== "document") return null;
        const document = state.documents.find(
          (item) =>
            item.id === source.documentId &&
            item.version === source.documentVersion,
        );
        const current = isDeclarationSourceCurrent(source, {
          caseId: shipment.id,
          documents: state.documents,
          candidates: state.candidates,
          goods: shipment.goods,
        });
        const kimi =
          scoreEligible &&
          (candidate?.method.startsWith("kimi:") ||
            source.confidenceScore !== undefined);
        const score = scoreEligible
          ? (source.confidenceScore ??
            (candidate?.method.startsWith("kimi:")
              ? candidate.confidenceScore
              : undefined))
          : undefined;
        return (
          <article className="ecus-reading-card" key={index}>
            <div className="ecus-reading-score">
              <span>
                {kimi
                  ? say("Ước lượng của AI", "AI estimate")
                  : candidate
                    ? say("Kết quả từ bộ đọc cũ", "Legacy extractor reading")
                    : say("Dẫn nguồn đã lưu", "Saved source evidence")}
              </span>
              <strong>
                {score !== undefined
                  ? `${score}/100`
                  : candidate
                    ? qualitative(candidate.confidence)
                    : say("Chưa lưu điểm", "No recorded score")}
              </strong>
            </div>
            <a
              href={`/api/documents/${source.documentId}#page=${source.page}`}
              target="_blank"
              rel="noreferrer"
            >
              <FileText size={13} />
              {document?.name ??
                say("Chứng từ nguồn", "Source document")} ·{" "}
              {say("trang", "page")} {source.page}
              <ArrowUpRight size={12} />
            </a>
            {!current && (
              <p className="ecus-warning-text">
                {say(
                  "Dẫn nguồn cũ; cần đối chiếu với phiên bản hiện tại.",
                  "Earlier source evidence; compare with the current version.",
                )}
              </p>
            )}
            <blockquote>{source.quote}</blockquote>
            {source.visualEvidence ? (
              <VisionEvidenceImage
                documentId={source.documentId}
                page={source.page}
                evidence={source.visualEvidence}
                cropped
              />
            ) : (
              <p className="ecus-no-crop">
                {document &&
                (document.mime === "application/pdf" ||
                  document.mime.startsWith("image/"))
                  ? say(
                      "Lần đọc này chỉ lưu trích dẫn văn bản, chưa có vùng ảnh. Có thể yêu cầu AI đọc lại bản gốc.",
                      "This reading saved a text quotation without image bounds. Reread the original with AI to capture a crop.",
                    )
                  : say(
                      "Nguồn văn bản — trích dẫn nguyên văn được hiển thị ở trên.",
                      "Text source — the exact quotation is shown above.",
                    )}
              </p>
            )}
          </article>
        );
      })}
      {!documents.length && (
        <p className="ecus-no-crop">
          {hasManualBasis
            ? say(
                "Thông tin được nhập thủ công; không có điểm AI hoặc vùng ảnh gắn với ô này.",
                "Manually supplied information has no AI score or image crop for this field.",
              )
            : say(
                "Chưa có dẫn nguồn riêng cho ô này. Chọn ô đã được tự điền để xem vùng chứng từ và độ tin cậy.",
                "No field-specific evidence is saved yet. Select an autofilled field to inspect its source region and confidence.",
              )}
        </p>
      )}
      {readings
        .filter((item) => item.source.kind === "manual")
        .map(
          ({ source, index }) =>
            source.kind === "manual" && (
              <div className="ecus-human-basis" key={index}>
                <strong>
                  {say("Căn cứ do người dùng nhập", "Human-provided basis")}
                </strong>
                <p>{source.note || "—"}</p>
              </div>
            ),
        )}
      {(guideReasons.length > 0 || basis) && (
        <details className="ecus-guide-basis" open={guideReasons.length > 0}>
          <summary>
            {guideReasons.length && !hasReconciliationPolicy
              ? say("Căn cứ từ hướng dẫn VNACCS", "VNACCS guide basis")
              : say("Căn cứ sử dụng thông tin", "Basis for this value")}
          </summary>
          {guideReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {!guideReasons.length && <p>{basis}</p>}
        </details>
      )}
    </div>
  );
}
