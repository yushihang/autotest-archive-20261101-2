/** 加载骨架：所有页面共用同一套灰块，避免加载时布局跳动。 */

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-md bg-slate-200 ${className ?? "h-4 w-full"}`} />;
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="加载中" className="grid gap-4 sm:grid-cols-2">
      <span className="sr-only">加载中…</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-3 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
          <Skeleton className="mt-4 h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 4, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="加载中" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <span className="sr-only">加载中…</span>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid items-center gap-4 px-4 py-4"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }, (_, columnIndex) => (
              <Skeleton key={columnIndex} className={columnIndex === 0 ? "h-4 w-3/4" : "h-4 w-1/2"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div role="status" aria-label="加载中" className="flex flex-col gap-6">
      <span className="sr-only">加载中…</span>
      <Skeleton className="h-4 w-24" />
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-1/2" />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-xl border border-slate-200 bg-white p-4">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="mt-2 h-6 w-1/3" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-5/6" />
      </div>
    </div>
  );
}
