"use client";

import { useLocale } from "@/lib/i18n";
import { translateSystemText } from "@/lib/i18n-core";
import type { ShipmentCase } from "@/lib/types";
import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "./modal-shell";

export function DeleteCaseDialog({ shipment, documentCount, busy, error, onDelete, onClose }: {
  shipment: ShipmentCase;
  documentCount: number;
  busy: boolean;
  error: string;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const en = locale === "en";
  const [confirmedOnce, setConfirmedOnce] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  useEffect(() => { cancel.current?.focus(); }, [confirmedOnce]);
  const remove = async () => {
    if (!confirmedOnce || busy || submitting.current) return;
    submitting.current = true;
    try {
      if (await onDelete()) onClose();
    } finally {
      submitting.current = false;
    }
  };
  return <ModalShell title={confirmedOnce ? (en ? "Delete this case permanently?" : "Xóa vĩnh viễn hồ sơ này?") : (en ? "Delete case?" : "Xóa hồ sơ?")} onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-body delete-case-body">
      <p className="muted">{en ? `Confirmation ${confirmedOnce ? 2 : 1} of 2` : `Xác nhận ${confirmedOnce ? 2 : 1}/2`}</p>
      <div className="modal-context"><strong>{shipment.reference} · {shipment.title}</strong><br />{en ? `${documentCount} documents` : `${documentCount} chứng từ`}</div>
      <p>{confirmedOnce
        ? (en ? "Please confirm once more. This will permanently delete the case, its documents and saved drafts. You cannot undo this in AICD." : "Vui lòng xác nhận lần nữa. Hồ sơ, chứng từ và bản nháp đã lưu sẽ bị xóa vĩnh viễn. Bạn không thể hoàn tác trong AICD.")
        : (en ? "This removes the case and its documents from AICD. You will be asked once more before anything is deleted." : "Thao tác này xóa hồ sơ và chứng từ khỏi AICD. Bạn sẽ được hỏi thêm một lần trước khi xóa.")}</p>
      <p className="muted">{en ? "Original emails and the audit history are kept. Existing drafts in ECUS are unchanged." : "Email gốc và lịch sử hoạt động được giữ lại. Bản nháp đã có trong ECUS không thay đổi."}</p>
      {error && <p className="upload-dialog-error" role="alert">{translateSystemText(error, locale)}</p>}
    </div>
    <div className="modal-footer">
      {confirmedOnce && <button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}{en ? "Yes, delete permanently" : "Đồng ý, xóa vĩnh viễn"}</button>}
      <button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={onClose}>{en ? "Cancel" : "Hủy"}</button>
      {!confirmedOnce && <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmedOnce(true)}>{en ? "Continue to confirmation" : "Tiếp tục xác nhận"}</button>}
    </div>
  </ModalShell>;
}
