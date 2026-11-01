"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Project, RunStatus, RunSummary } from "@/lib/domain";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Pagination } from "@/components/pagination";
import { TableSkeleton } from "@/components/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { errorMessage, listProjects, listRuns } from "@/lib/api-client";
import { formatDateTime, formatDuration, formatPassRate, formatTime } from "@/lib/format";
import { failureKindLabel, runTriggerLabel } from "@/lib/labels";

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 3000;

interface StatusFilterOption {
  value: string;
  label: string;
  statuses: RunStatus[] | null;
}

const STATUS_FILTERS: StatusFilterOption[] = [
  { value: "all", label: "全部状态", statuses: null },
  { value: "active", label: "进行中", statuses: ["queued", "running"] },
  { value: "passed", label: "通过", statuses: ["passed"] },
  { value: "failed", label: "失败", statuses: ["failed"] },
  { value: "timed_out", label: "超时", statuses: ["timed_out"] },
  { value: "cancelled", label: "已取消", statuses: ["cancelled"] },
  { value: "error", label: "错误", statuses: ["error"] },
];

const SELECT_CLASS =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200";
const TH_CLASS = "whitespace-nowrap px-4 py-2.5 font-medium";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadedRef = useRef(false);

  const selectedStatuses = useMemo(
    () => STATUS_FILTERS.find((option) => option.value === statusFilter)?.statuses ?? null,
    [statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    listProjects({ page: 1, pageSize: 100, signal: controller.signal })
      .then((data) => {
        if (active) setProjects(data.items);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setProjectLoadError(errorMessage(err));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setRefreshing(true);
    setError(null);

    listRuns({
      projectId: projectFilter || null,
      status: selectedStatuses,
      page,
      pageSize: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((data) => {
        if (!active) return;
        setRuns(data.items);
        setTotal(data.total);
        setLastUpdatedAt(formatTime(new Date()));
        loadedRef.current = true;
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(errorMessage(err));
        if (!loadedRef.current) {
          setRuns([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [page, projectFilter, selectedStatuses, reloadKey]);

  const hasActiveRuns = runs.some((run) => run.status === "queued" || run.status === "running");

  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = setInterval(() => setReloadKey((key) => key + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveRuns]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleProjectChange = useCallback((value: string) => {
    setProjectFilter(value);
    setPage(1);
  }, []);

  const handleStatusChange = useCallback((value: string) => {
    setStatusFilter(value);
    setPage(1);
  }, []);

  const filtersActive = projectFilter !== "" || statusFilter !== "all";
  const showEmpty = !loading && !error && runs.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">运行</h1>
          <p className="mt-1 text-sm text-slate-600">
            按创建时间倒序。进行中的运行每 3 秒自动刷新，终态后停止。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span>共 {total} 次运行</span>
          <span>
            最后更新 {lastUpdatedAt ?? "—"}
            {refreshing ? "（刷新中…）" : ""}
          </span>
          {hasActiveRuns ? (
            <span className="inline-flex items-center gap-1.5 text-sky-700">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              自动刷新中
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="run-project-filter" className="sr-only">
          按项目筛选
        </label>
        <select
          id="run-project-filter"
          value={projectFilter}
          onChange={(event) => handleProjectChange(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">全部项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>

        <label htmlFor="run-status-filter" className="sr-only">
          按状态筛选
        </label>
        <select
          id="run-status-filter"
          value={statusFilter}
          onChange={(event) => handleStatusChange(event.target.value)}
          className={SELECT_CLASS}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          刷新
        </button>

        {projectLoadError ? (
          <span className="text-xs text-amber-700">项目筛选加载失败：{projectLoadError}</span>
        ) : null}
      </div>

      {loading ? (
        <TableSkeleton rows={5} columns={7} />
      ) : error && runs.length === 0 ? (
        <ErrorState title="运行列表加载失败" message={error} onRetry={refresh} />
      ) : showEmpty ? (
        <EmptyState
          title={filtersActive ? "没有符合条件的运行" : "还没有运行记录"}
          description={
            filtersActive
              ? "换个项目或状态条件试试。"
              : "从项目页或 API 发起一次运行后，这里会显示状态、通过率与失败数。"
          }
          action={
            filtersActive ? (
              <button
                type="button"
                onClick={() => {
                  handleProjectChange("");
                  handleStatusChange("all");
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                清空筛选
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              刷新失败：{error}（当前显示的是上次结果）
            </p>
          ) : null}

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className={TH_CLASS}>
                      运行
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      计划
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      状态
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      通过率
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      失败
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      耗时
                    </th>
                    <th scope="col" className={TH_CLASS}>
                      时间
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.map((run) => (
                    <tr key={run.id} className="align-top transition-colors hover:bg-slate-50/80">
                      <td className="px-4 py-3">
                        <Link
                          href={`/runs/${run.id}`}
                          className="font-mono text-xs font-medium text-slate-900 hover:text-sky-700 hover:underline"
                        >
                          {run.id}
                        </Link>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {runTriggerLabel(run.trigger)}触发
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="block max-w-[260px] truncate text-slate-800"
                          title={run.planTitle ?? undefined}
                        >
                          {run.planTitle ?? "（无计划标题）"}
                        </span>
                        {run.failureKind ? (
                          <span className="mt-0.5 block text-[11px] text-rose-600">
                            {failureKindLabel(run.failureKind)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900">
                          {formatPassRate(run.totals.passed, run.totals.cases)}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {run.totals.passed}/{run.totals.cases} 用例
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={run.totals.failed > 0 ? "font-medium text-rose-600" : "text-slate-500"}
                        >
                          {run.totals.failed}
                        </span>
                        {run.totals.skipped > 0 ? (
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            跳过 {run.totals.skipped}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatDuration(run.durationMs)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                        <span className="block">{formatDateTime(run.createdAt)}</span>
                        {run.finishedAt ? (
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            结束 {formatDateTime(run.finishedAt)}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
