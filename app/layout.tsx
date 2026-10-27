import type { Metadata } from "next";
import "./globals.css";
import "@/components/workspace/ecus-export-submit.css";
export const metadata: Metadata = {
  title: "AICD · Không gian làm việc nhập khẩu",
  description: "Tiếp nhận chứng từ, đối chiếu dữ liệu và rà soát hồ sơ nhập khẩu với nguồn chứng cứ có thể truy vết.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="vi"><body>{children}</body></html>; }
