"use client";

import { useLocale } from "@/lib/i18n";
import { translateSystemText } from "@/lib/i18n-core";
import type { ShipmentCase } from "@/lib/types";
import { FilePlus2, Loader2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { ModalShell } from "./modal-shell";

type Props = {
  target?: Pick<ShipmentCase, "id" | "title" | "reference">;
  busy: boolean;
  error: string;
  progress: string;
  canStop: boolean;
  onStop: () => void;
  onUpload: (files: File[], targetCaseId?: string) => Promise<boolean>;
  onClose: () => void;
};

export function UploadDocumentsDialog({ target, busy, error, progress, canStop, onStop, onUpload, onClose }: Props) {
  const { locale } = useLocale();
  const en = locale === "en";
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  const size = (bytes: number) => bytes < 1024
    ? `${bytes} B`
    : `${(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 2 })} ${bytes < 1024 * 1024 ? "KB" : "MB"}`;
  const limitError = files.length > 20
    ? (en ? "Choose up to 20 files per upload. Remove some files to continue." : "Chọn tối đa 20 tệp mỗi lần. Bỏ bớt tệp để tiếp tục.")
    : files.some(file => file.size > 20 * 1024 * 1024)
      ? (en ? "Each file must be 20 MB or smaller." : "Mỗi tệp phải có dung lượng tối đa 20 MB.")
      : total > 22 * 1024 * 1024
        ? (en ? "The selected files exceed 22 MB. Upload them in smaller batches." : "Các tệp đã chọn vượt quá 22 MB. Chia thành các lần tải lên nhỏ hơn.")
        : "";
  const addFiles = (incoming: FileList | null) => {
    if (busy || !incoming?.length) return;
    // FileList is live: snapshot before clearing the picker for the next selection.
    const selected = Array.from(incoming);
    setFiles(previous => [...previous, ...selected]);
  };
  const submit = async () => {
    if (busy || submitting.current || !files.length || limitError) return;
    submitting.current = true;
    try {
      if (await onUpload(files, target?.id)) onClose();
    } finally {
      submitting.current = false;
    }
  };
  return (
    <ModalShell title={en ? "Upload documents" : "Tải chứng từ"} onClose={() => { if (!busy) onClose(); }}>
      <div className="modal-body upload-dialog-body">
        <div className="modal-context">
          {target ? <><strong>{target.reference} · {target.title}</strong><br />{en ? "All selected documents will be added to this case." : "Tất cả chứng từ đã chọn sẽ được thêm vào hồ sơ này."}</>
            : en ? "Documents will be grouped into shipments after upload." : "Chứng từ sẽ được phân nhóm thành các lô hàng sau khi tải lên."}
        </div>
        <input ref={input} type="file" multiple hidden aria-label={en ? "Choose documents" : "Chọn chứng từ"} onChange={event => {
          addFiles(event.target.files);
          event.target.value = "";
        }} />
        <div className={`upload-drop-zone${dragging ? " dragging" : ""}`}
          onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
          <Upload size={24} aria-hidden="true" />
          <button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}>
            <FilePlus2 size={16} />{files.length ? (en ? "Add more files" : "Thêm tệp") : (en ? "Choose files" : "Chọn tệp")}
          </button>
          <p>{en ? "Drag files here, or select several with Ctrl (Windows) / Command (Mac). You can also add files one at a time before uploading." : "Kéo tệp vào đây hoặc chọn nhiều tệp bằng Ctrl (Windows) / Command (Mac). Bạn cũng có thể thêm từng tệp trước khi tải lên."}</p>
          <small>{en ? "Up to 20 files · 20 MB per file · 22 MB per batch" : "Tối đa 20 tệp · 20 MB mỗi tệp · 22 MB mỗi lần"}</small>
        </div>
        {files.length > 0 && <>
          <p className="upload-selection-summary" aria-live="polite">{en ? `${files.length} ${files.length === 1 ? "file" : "files"} selected` : `Đã chọn ${files.length} tệp`} · {size(total)}</p>
          <ul className="upload-file-list">
            {files.map((file, index) => <li key={index}>
              <span><strong>{file.name}</strong><small>{size(file.size)}</small></span>
              <button type="button" className="icon-button" disabled={busy} aria-label={`${en ? "Remove" : "Bỏ"} ${file.name}`} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}><X size={17} /></button>
            </li>)}
          </ul>
        </>}
        {(limitError || error) && <p className="upload-dialog-error" role="alert">{limitError || translateSystemText(error, locale)}</p>}
        {busy && <p className="upload-dialog-progress" role="status"><Loader2 size={16} className="spin" />{translateSystemText(progress, locale) || (en ? "Uploading documents…" : "Đang tải chứng từ…")}</p>}
      </div>
      <div className="modal-footer">
        {busy && canStop ? <button type="button" className="button secondary" onClick={onStop}>{en ? "Stop processing" : "Dừng xử lý"}</button>
          : <button type="button" className="button secondary" disabled={busy} onClick={onClose}>{en ? "Cancel" : "Hủy"}</button>}
        <button type="button" className="button primary" disabled={busy || !files.length || !!limitError} onClick={() => void submit()}>
          {busy ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
          {en ? `Upload${files.length ? ` ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}` : `Tải lên${files.length ? ` ${files.length} tệp` : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}
