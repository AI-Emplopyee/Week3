"use client";

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { fetchWithSession } from "@/lib/auth-client";
import { useLocale } from "@/lib/i18n";
import type { ShipmentDocument } from "@/lib/types";
import { Badge } from "./shared";

type Status = {
  configured: boolean;
  model?: string | null;
  backgroundProcessing?: boolean;
  backgroundPaused?: boolean;
  queue?: {
    running: number;
    queued: number;
    failed: number;
    needsReview?: number;
    emailMatchingFailed?: number;
    recentDurationMs: number | null;
    failures: { documentId: string; page: number; error: string | null }[];
  };
};

export function AiProcessingStatus({ documents }: { documents: ShipmentDocument[] }) {
  const { locale } = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const say = (vi: string, en: string) => locale === "vi" ? vi : en;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const response = await fetchWithSession('/api/ai/status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status unavailable');
        const next = await response.json() as Status;
        if (!controller.signal.aborted) { setStatus(next); setUnavailable(false); }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void update(), 4000);
      }
    };
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const queue = status?.queue;
  const label = unavailable ? say('Chưa cập nhật', 'Status unavailable')
    : !status ? say('Đang tải…', 'Loading…')
    : !status.configured ? say('Chưa cấu hình AI', 'AI not configured')
    : status.backgroundPaused ? say('Đã tạm dừng', 'Paused')
    : status.backgroundProcessing ? say('Tự động', 'Automatic')
    : say('Theo phiên trình duyệt', 'Browser session');

  return (
    <section className="card settings-card">
      <div className="section-heading">
        <h2><Activity size={19} />{say('Đọc chứng từ tự động', 'Automatic document reading')}</h2>
        <Badge tone={status?.configured && !status.backgroundPaused && !unavailable ? 'green' : 'amber'}>{label}</Badge>
      </div>
      {status?.model && <p className="muted">{say('Mô hình đọc chứng từ', 'Document reader')}: {status.model}</p>}
      <p>{status?.backgroundProcessing ? say(
        'Chứng từ mới được đọc tự động khi ứng dụng trên máy đang chạy, tối đa hai chứng từ song song. Có thể đóng tab trình duyệt.',
        'New originals are read automatically while the local app is running, with up to two documents in parallel. The browser tab can be closed.',
      ) : say(
        'Phiên này cần mở trình duyệt trong khi đọc chứng từ.',
        'This session requires the browser to remain open while reading documents.',
      )}</p>
      {status?.backgroundPaused && <p>{say('Quá trình tự động đang tạm dừng trên máy chủ.', 'Automatic processing is currently paused on the server.')}</p>}
      {unavailable && <p role="status">{say('Chưa lấy được trạng thái mới. Đang thử lại.', 'The latest status could not be loaded. Retrying.')}</p>}
      {queue && !unavailable && (
        <>
          <p role="status"><strong>{say(
            `${queue.running} trang đang đọc · ${queue.queued} đang chờ · ${queue.failed} gặp lỗi`,
            `${queue.running} pages reading · ${queue.queued} queued · ${queue.failed} failed`,
          )}</strong>{!!queue.needsReview && <><br />{say(`${queue.needsReview} trang cần kiểm tra kết quả.`, `${queue.needsReview} pages need reading review.`)}</>}</p>
          {queue.recentDurationMs !== null && <p>{say(
            `Trang hoàn tất gần nhất: ${Math.max(1, Math.round(queue.recentDurationMs / 1000))} giây. Đây là thời gian cho một trang, không phải cả lô hàng.`,
            `Most recent completed page: ${Math.max(1, Math.round(queue.recentDurationMs / 1000))} seconds. This measures one page, not a whole shipment.`,
          )}</p>}
          {!!queue.failures.length && (
            <details>
              <summary>{say('Các trang cần thử lại', 'Pages needing a retry')}</summary>
              <p className="muted">{say('Mở lô hàng → Chứng từ để kiểm tra bản gốc và yêu cầu đọc lại trang.', 'Open the shipment → Documents to check the original and request a page reread.')}</p>
              <ul>{queue.failures.map(failure => <li key={`${failure.documentId}:${failure.page}`}>
                {documents.find(document => document.id === failure.documentId)?.name ?? failure.documentId} · {say('trang', 'page')} {failure.page}
              </li>)}</ul>
            </details>
          )}
          {!!queue.emailMatchingFailed && <p>{say(
            'Đối chiếu email chưa hoàn tất. Mở mục email và chọn “Đối chiếu email bằng AI” để thử lại.',
            'Email matching did not finish. Open Emails and choose “Match emails with AI” to retry.',
          )}</p>}
        </>
      )}
    </section>
  );
}
