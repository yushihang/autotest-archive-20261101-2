import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "autotest · AI 驱动的端到端测试",
  description:
    "用自然语言描述要验证的流程，autotest 生成测试计划、执行浏览器步骤，并把失败原因与证据整理成可复现的报告。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
