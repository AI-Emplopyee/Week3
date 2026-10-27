"use client";

import { useLocale } from "@/lib/i18n";
import type { Action, WorkspaceResponse } from "@/lib/types";
import { Mail } from "lucide-react";
import { useState } from "react";
import { Badge } from "./shared";
import { KimiPrompts } from "./kimi-prompts";
import { AiProcessingStatus } from "./ai-processing-status";
import { EcusConnection } from "./ecus-connection";

type Props = {
  data: WorkspaceResponse;
  busy: boolean;
  mutation: (action: Action, success?: string) => Promise<boolean>;
};

export function WorkspaceSettings({ data, busy, mutation }: Props) {
  const { t } = useLocale();
  const [inboxAddress, setInboxAddress] = useState(
    data.state.settings.inboxAddress,
  );
  const canEdit = data.role === "owner" && !busy;

  return (
    <div className="content settings-content">
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("KHÔNG GIAN LÀM VIỆC")}</span>
          <h1>{t("Cài đặt")}</h1>
          <p>{t("Quản lý kết nối Gmail và ECUS.")}</p>
        </div>
      </div>
      <div className="settings-grid">
        <KimiPrompts />
        <AiProcessingStatus documents={data.state.documents} />
        <section className="card settings-card">
          <div className="section-heading">
            <h2>
              <Mail size={19} />
              {t("Kết nối Gmail")}
            </h2>
            <Badge tone="amber">{t("Chưa kết nối")}</Badge>
          </div>
          <p>
            {t(
              "Lưu địa chỉ Gmail sẽ dùng để nhận chứng từ. Đồng bộ Gmail chưa được triển khai; lưu địa chỉ chưa cấp quyền truy cập hộp thư.",
            )}
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await mutation(
                { type: "settings", inboxAddress },
                t("Đã lưu địa chỉ Gmail"),
              );
            }}
          >
            <label>
              {t("Địa chỉ hộp thư")}
              <input
                type="email"
                value={inboxAddress}
                disabled={!canEdit}
                onChange={(event) => setInboxAddress(event.target.value)}
                placeholder="chungtu@congty.vn"
              />
            </label>
            <button className="button primary" disabled={!canEdit}>
              {t("Lưu địa chỉ Gmail")}
            </button>
          </form>
        </section>
        <EcusConnection data={data} />
      </div>
    </div>
  );
}
