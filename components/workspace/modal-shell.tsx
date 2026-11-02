"use client";
import { useLocale } from "@/lib/i18n";
import { X } from "lucide-react";
import React, { useEffect, useRef } from "react";
export function ModalShell({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const current = dialog.current;
    return () => current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={event => { event.preventDefault(); onClose(); }}
      className={`modal ${wide ? "wide-modal" : ""}`}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={t("Đóng")}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
