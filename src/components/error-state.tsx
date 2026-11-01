"use client";

import type { ReactNode } from "react";

/** 请求失败时的统一错误态：面向人的消息 + 可选字段级明细 + 重试。 */
export function ErrorState({
  title = "加载失败",
  message,
  details,
  onRetry,
  action,
}: {
  title?: string;
  message: string;
  /** 契约里的 `error.details`，字段级错误。 */
  details?: Record<string, string[]> | null;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  const entries = details ? Object.entries(details) : [];

  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm">
      <p className="font-medium text-rose-900">{title}</p>
      <p className="mt-1 leading-relaxed text-rose-700">{message}</p>
      {entries.length > 0 ? (
        <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-rose-700">
          {entries.map(([field, messages]) => (
            <li key={field}>
              <span className="font-mono">{field}</span>：{messages.join("；")}
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry || action ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-800"
            >
              重试
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
