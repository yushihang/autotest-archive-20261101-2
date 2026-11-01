import type { CaseStatus, RunStatus, StepStatus } from "@/lib/domain";

import { statusLabel } from "@/lib/labels";

type AnyStatus = RunStatus | CaseStatus | StepStatus;

const STATUS_TONES: Record<AnyStatus, string> = {
  queued: "bg-slate-100 text-slate-600 ring-slate-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  passed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  cancelled: "bg-amber-50 text-amber-700 ring-amber-200",
  timed_out: "bg-orange-50 text-orange-700 ring-orange-200",
  error: "bg-red-100 text-red-800 ring-red-300",
  skipped: "bg-slate-50 text-slate-400 ring-slate-200",
};

/** run / case / step 通用的状态徽章。 */
export function StatusBadge({
  status,
  className,
}: {
  status: AnyStatus;
  className?: string;
}) {
  const classes = [
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
    STATUS_TONES[status],
    className,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");

  return (
    <span className={classes}>
      <span
        aria-hidden
        className={[
          "h-1.5 w-1.5 rounded-full bg-current",
          status === "running" || status === "queued" ? "animate-pulse" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      {statusLabel(status)}
    </span>
  );
}
