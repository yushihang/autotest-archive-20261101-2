import type { ReactNode } from "react";

/** 列表/详情为空时的统一占位。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed text-slate-500">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
