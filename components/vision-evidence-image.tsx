"use client";

import { useLocale } from "@/lib/i18n";
import { useState } from "react";
import { visionCropGeometry } from "@/lib/ecus-evidence";
import type { Candidate } from "@/lib/types";

/** Show the same authenticated page image used by AI, with its proposed reading region. */
export function VisionEvidenceImage({
  documentId,
  page,
  evidence,
  cropped = false,
}: {
  documentId: string;
  page: number;
  evidence: NonNullable<Candidate["visualEvidence"]>;
  cropped?: boolean;
}) {
  const { locale } = useLocale();
  const [loaded, setLoaded] = useState<{ url: string; ratio: number }>();
  const [failedUrl, setFailedUrl] = useState("");
  const [x, y, width, height] = evidence.bounds;
  const params = new URLSearchParams({
    documentId,
    page: String(page),
    imageSha256: evidence.imageSha256,
  });
  const url = `/api/ai/vision-page?${params}`;
  const crop = visionCropGeometry(evidence.bounds);
  const ratio = loaded?.url === url ? loaded.ratio : undefined;
  if (cropped)
    return (
      <figure className="vision-evidence-crop">
        <figcaption>
          {locale === "vi"
            ? "Vùng chứng từ AI đã đọc"
            : "Source region read by AI"}
        </figcaption>
        {!crop || failedUrl === url ? (
          <p>
            {locale === "vi"
              ? "Không tải được ảnh vùng dẫn nguồn. Xem bản gốc bằng liên kết phía trên."
              : "The saved source crop could not be loaded. Open the original using the link above."}
          </p>
        ) : (
          <div
            className="vision-crop-window"
            style={{
              aspectRatio: ratio
                ? String((ratio * crop.width) / crop.height)
                : undefined,
              minHeight: ratio ? undefined : 80,
            }}
          >
            {!ratio && (
              <span className="vision-crop-loading">
                {locale === "vi"
                  ? "Đang tải vùng dẫn nguồn…"
                  : "Loading source crop…"}
              </span>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated saved raster; the viewport clips to the exact evidence bounds. */}
            <img
              src={url}
              alt={
                locale === "vi"
                  ? `Vùng dẫn nguồn trên trang ${page}`
                  : `Evidence crop from page ${page}`
              }
              onLoad={(event) =>
                setLoaded({
                  url,
                  ratio:
                    event.currentTarget.naturalWidth /
                    event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailedUrl(url)}
              style={{
                position: "absolute",
                width: `${crop.imageWidthPercent}%`,
                maxWidth: "none",
                height: "auto",
                left: `${crop.imageLeftPercent}%`,
                top: `${crop.imageTopPercent}%`,
                opacity: ratio ? 1 : 0,
              }}
            />
          </div>
        )}
      </figure>
    );
  return (
    <figure style={{ margin: "12px 0" }}>
      <figcaption
        className="text-amber"
        style={{ fontSize: 12, marginBottom: 8 }}
      >
        {locale === "vi"
          ? "AI đã đọc vùng chứng từ được đánh dấu."
          : "AI read the highlighted source region."}
      </figcaption>
      <div style={{ position: "relative", width: "100%", lineHeight: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- The private endpoint requires the browser's session cookie. */}
        <img
          src={url}
          alt={locale === "vi" ? `Trang nguồn ${page}` : `Source page ${page}`}
          style={{ width: "100%", height: "auto" }}
        />
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            width: `${width * 100}%`,
            height: `${height * 100}%`,
            border: "2px solid #d97706",
            background: "rgba(245, 158, 11, 0.10)",
            pointerEvents: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
    </figure>
  );
}
