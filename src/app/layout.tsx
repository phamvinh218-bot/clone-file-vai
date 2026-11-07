import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Xưởng Vinh — việc applique",
  description: "Công cụ nội bộ nhận mockup và vector, tính khổ cắt, rồi giao việc cho Grok Bot.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
