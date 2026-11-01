import Link from "next/link";
import type { ReactNode } from "react";

import { ConsoleNav } from "@/components/console-nav";

/** 控制台外壳：顶部导航 + 统一内容宽度。 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight text-slate-900">autotest</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              控制台
            </span>
          </Link>
          <ConsoleNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
