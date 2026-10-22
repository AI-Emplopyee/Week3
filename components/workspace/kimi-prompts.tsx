"use client";

import { useState } from "react";
import { ArrowUpRight, FileCode2 } from "lucide-react";
import type { AiPrompt, AiPromptsResponse } from "@/lib/ai-prompts";
import { useLocale } from "@/lib/i18n";
import { fetchWithSession } from "@/lib/auth-client";

const promptLabels: Record<AiPrompt['id'], [string, string]> = {
  extraction: ["Đọc chứng từ và điền bản nháp", "Document extraction and draft fields"],
  'page-image': ["Nhãn ảnh trang", "Page image label"],
  repair: ["Sửa kết quả không đạt kiểm tra", "Repair a failed validation"],
  'email-matching': ["Đối chiếu email với lô hàng", "Match emails to shipments"],
};

export function KimiPrompts() {
  const { locale } = useLocale();
  const [data, setData] = useState<AiPromptsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const say = (vi: string, en: string) => locale === "vi" ? vi : en;

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetchWithSession('/api/ai/prompts', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load prompts');
      setData(await response.json() as AiPromptsResponse);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card settings-card kimi-prompts-card">
      <div className="section-heading">
        <h2><FileCode2 size={19} />{say("Prompt AI", "AI prompts")}</h2>
        {data?.model && <span className="muted">{data.model}</span>}
      </div>
      <p>{say(
        "Xem nguyên văn các chỉ dẫn mà ứng dụng gửi đến mô hình AI đã cấu hình để đọc chứng từ, sửa kết quả và đối chiếu email.",
        "Read the exact instructions the app sends to the configured AI model to read documents, repair results and match emails.",
      )}</p>
      <button className="button secondary" disabled={loading} onClick={() => void load()}>
        {loading ? say("Đang tải…", "Loading…") : data ? say("Làm mới prompt", "Refresh prompts") : say("Xem prompt AI", "View AI prompts")}
      </button>
      {failed && <p role="alert">{say("Không tải được prompt. Vui lòng thử lại.", "Could not load prompts. Please try again.")}</p>}
      {data && (
        <div className="kimi-prompts-list">
          <p className="muted">{say(
            "Chứng từ PDF và hình ảnh được gửi dưới dạng ảnh trang từ tệp gốc, không kèm văn bản trích xuất hoặc OCR. Tệp văn bản dùng nội dung văn bản gốc. Đối chiếu email sử dụng tiêu đề, nội dung email và các dữ kiện nhận diện lô hàng từ chứng từ. Trang này chỉ hiển thị chỉ dẫn, không hiển thị nội dung chứng từ, email hay khóa API.",
            "PDFs and images are sent as page images from the originals, without extracted text or OCR. Text files use their original text. Email matching uses email subjects, bodies and shipment identifiers from documents. This page shows instructions only, without document contents, emails or API keys.",
          )}</p>
          <p className="muted">{say(
            "{{pageNumber}} và {{validationFeedback}} được thay bằng số trang và kết quả kiểm tra của lần chạy. Nội dung prompt gốc được giữ bằng tiếng Anh. Đáp án ToKhai của nhân viên chỉ dùng để chấm điểm cục bộ, không gửi đến mô hình.",
            "{{pageNumber}} and {{validationFeedback}} are replaced with the page number and validation feedback for that run. The original prompt wording is in English. Employee ToKhai answer keys are used only for local scoring and are not sent to the model.",
          )}</p>
          {data.prompts.map(prompt => (
            <details className="kimi-prompt" key={prompt.id}>
              <summary>{promptLabels[prompt.id][locale === 'vi' ? 0 : 1]} <small>· {prompt.role}</small></summary>
              <pre tabIndex={0}>{prompt.text}</pre>
            </details>
          ))}
          <a className="text-button" href="/api/ai/prompts" target="_blank" rel="noreferrer">
            {say("Mở JSON prompt", "Open prompts as JSON")} <ArrowUpRight size={14} />
          </a>
        </div>
      )}
    </section>
  );
}
