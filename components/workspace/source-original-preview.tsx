"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileText } from "lucide-react";
import { openOriginalPdfPreview } from "@/lib/client-original-preview";
import { useLocale } from "@/lib/i18n";
import type { ShipmentDocument } from "@/lib/types";

type PdfPreview = Awaited<ReturnType<typeof openOriginalPdfPreview>>;

export function SourceOriginalPreview({ source, page, onPageChange }: {
  source: ShipmentDocument;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { locale, t } = useLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [retry, setRetry] = useState(0);
  const identity = `${source.id}:${source.version}:${source.sha256}:${retry}`;
  const [opened, setOpened] = useState<{ identity: string; pdf: PdfPreview }>();
  const [completed, setCompleted] = useState<{ identity: string; page: number }>();
  const [failure, setFailure] = useState<{ identity: string; page?: number }>();
  const [failedImage, setFailedImage] = useState("");
  const hasOriginal = !source.synthetic || !!source.blobKey;
  const pdf = opened?.identity === identity ? opened.pdf : undefined;
  const pageCount = pdf?.pageCount ?? Math.max(1, source.pages.length);
  const selectedPage = Math.min(pageCount, Math.max(1, page));
  const wordSection = source.mime === 'application/msword'
    ? source.pages.find(section => section.page === selectedPage && section.textSource === 'office')
    : undefined;
  const failed = failure?.identity === identity && (failure.page === undefined || failure.page === selectedPage);
  const visible = completed?.identity === identity && completed.page === selectedPage;
  const say = (vi: string, en: string) => locale === "vi" ? vi : en;

  useEffect(() => {
    if (!hasOriginal || source.mime !== 'application/pdf') return;
    const controller = new AbortController();
    let resource: PdfPreview | undefined;
    void openOriginalPdfPreview({ id: source.id, sha256: source.sha256 }, controller.signal).then(result => {
      resource = result;
      if (controller.signal.aborted) result.close();
      else setOpened({ identity, pdf: result });
    }).catch(() => { if (!controller.signal.aborted) setFailure({ identity }); });
    return () => { controller.abort(); resource?.close(); };
  }, [hasOriginal, source.id, source.sha256, source.mime, identity]);

  useEffect(() => {
    if (!pdf) return;
    let current = true;
    void pdf.render(selectedPage).then(raster => {
      if (!current || !canvas.current) return;
      const context = canvas.current.getContext('2d');
      if (!context) throw new Error('The original preview canvas is unavailable.');
      canvas.current.width = raster.width;
      canvas.current.height = raster.height;
      context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
      setFailure(previous => previous?.identity === identity && previous.page === selectedPage ? undefined : previous);
      setCompleted({ identity, page: selectedPage });
    }).catch(() => { if (current) setFailure({ identity, page: selectedPage }); });
    return () => { current = false; };
  }, [identity, pdf, selectedPage]);

  const download = <a href={`/api/documents/${source.id}?download=1`} download={source.name}><Download size={15} />{say('Tải tệp gốc', 'Download original')}</a>;
  if (!hasOriginal) return <div className="original-preview"><p>{say('Dữ liệu minh họa này không có tệp gốc. Tải lên chứng từ để xem bản gốc.', 'This demo record has no original file. Upload a document to view its original.')}</p></div>;

  return (
    <div className="original-preview">
      {source.mime === 'application/pdf' ? (
        <>
          <div className="original-page-controls">
            <button className="icon-button" aria-label={t('Trang trước')} disabled={!pdf || selectedPage <= 1} onClick={() => onPageChange(selectedPage - 1)}><ChevronLeft size={17} /></button>
            <label>{say('Trang', 'Page')} <select aria-label={say('Chọn trang bản gốc', 'Choose original page')} value={selectedPage} disabled={!pdf} onChange={event => onPageChange(Number(event.target.value))}>
              {Array.from({ length: pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
            </select> / {pageCount}</label>
            <button className="icon-button" aria-label={t('Trang sau')} disabled={!pdf || selectedPage >= pageCount} onClick={() => onPageChange(selectedPage + 1)}><ChevronRight size={17} /></button>
          </div>
          {!visible && !failed && <p className="original-preview-message" role="status">{say('Đang hiển thị trang gốc…', 'Displaying the original page…')}</p>}
          {failed && <div className="original-preview-message" role="alert">
            <p>{say('Chưa hiển thị được trang này. Bạn có thể thử lại hoặc tải tệp gốc.', 'This page could not be displayed. Retry the preview or download the original.')}</p>
            <button className="button secondary small" onClick={() => setRetry(value => value + 1)}>{say('Thử lại', 'Retry preview')}</button> {download}
          </div>}
          <canvas ref={canvas} className="original-page-canvas" role="img" aria-label={say(`Bản gốc ${source.name}, trang ${selectedPage}`, `Original ${source.name}, page ${selectedPage}`)} hidden={!visible || failed} />
        </>
      ) : wordSection ? (
        <>
          <div className="original-page-controls">
            <button className="icon-button" aria-label={say('Phần trước', 'Previous section')} disabled={selectedPage <= 1} onClick={() => onPageChange(selectedPage - 1)}><ChevronLeft size={17} /></button>
            <label>{say('Phần văn bản', 'Text section')} <select aria-label={say('Chọn phần văn bản Word', 'Choose Word text section')} value={selectedPage} onChange={event => onPageChange(Number(event.target.value))}>
              {source.pages.map(section => <option key={section.page} value={section.page}>{section.page}</option>)}
            </select> / {pageCount}</label>
            <button className="icon-button" aria-label={say('Phần sau', 'Next section')} disabled={selectedPage >= pageCount} onClick={() => onPageChange(selectedPage + 1)}><ChevronRight size={17} /></button>
          </div>
          <p className="word-preview-note">{say('Văn bản trích xuất từ Word; các phần không tương ứng với trang in. Hình ảnh, đối tượng nhúng, nhận xét và bố cục gốc không được đọc. Hãy xuất thành PDF rồi tải lên nếu cần các nội dung này.', 'Extracted Word text; sections do not correspond to printed pages. Images, embedded objects, comments and original layout are not read. Export to PDF and upload it if these are needed.')}</p>
          <pre className="word-text-preview" aria-label={say(`Văn bản Word, phần ${selectedPage}`, `Word text, section ${selectedPage}`)}>{wordSection.text}</pre>
        </>
      ) : source.mime.startsWith('image/') ? (
        failedImage === identity ? <p role="alert">{say('Không tải được ảnh gốc.', 'The original image could not be loaded.')} {download}</p> :
          // eslint-disable-next-line @next/next/no-img-element -- Display the authenticated original without image proxying or transformations.
          <img alt={t('Bản gốc {p0}', { p0: source.name })} src={`/api/documents/${source.id}`} onError={() => setFailedImage(identity)} />
      ) : (
        <p><FileText size={30} /><strong style={{ display: 'block', margin: '12px 0' }}>{source.name}</strong>
          <span style={{ display: 'block', marginBottom: 16 }}>{say('Mở tệp gốc trong ứng dụng hỗ trợ định dạng này.', 'Open the original file in an application that supports this format.')}</span>{download}
        </p>
      )}
    </div>
  );
}
