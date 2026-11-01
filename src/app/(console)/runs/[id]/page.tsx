"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isTerminalRunStatus, type Run } from "@/lib/domain";

import { CaseResultCard } from "@/components/case-result-card";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { DetailSkeleton } from "@/components/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { errorMessage, getRun, isApiError } from "@/lib/api-client";
import { formatDateTime, formatDuration, formatPassRate, formatTime } from "@/lib/format";
import { failureKindLabel, runTriggerLabel } from "@/lib/labels";

const POLL_INTERVAL_MS = 3000;

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!id) return;

    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    const controller = new AbortController();

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const load = async (silent: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!silent) {
        setLoading(true);
        setRun(null);
      }

      try {
        const data = await getRun(id, { signal: controller.signal });
        if (!mounted) return;

        setRun(data);
        setError(null);
        setNotFound(false);
        setLastUpdatedAt(formatTime(new Date()));
        loadedIdRef.current = id;

        if (isTerminalRunStatus(data.status)) {
          stopPolling();
        } else if (!timer) {
          timer = setInterval(() => {
            void load(true);
          }, POLL_INTERVAL_MS);
        }
      } catch (err: unknown) {
        if (!mounted || controller.signal.aborted) return;

        setError(errorMessage(err));
        const missing = isApiError(err) && err.status === 404;
        setNotFound(missing);

        if (missing) {
          stopPolling();
        } else if (!timer) {
          timer = setInterval(() => {
            void load(true);
          }, POLL_INTERVAL_MS);
        }
      } finally {
        inFlight = false;
        if (mounted) setLoading(false);
      }
    };

    void load(loadedIdRef.current === id);

    return () => {
      mounted = false;
      stopPolling();
      controller.abort();
    };
  }, [id, reloadKey]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  const summary = useMemo(() => {
    const cases = run?.cases ?? [];
    const passed = cases.filter((item) => item.status === "passed").length;
    const failed = cases.filter((item) => item.status === "failed" || item.status === "error").length;
    const skipped = cases.filter((item) => item.status === "skipped").length;
    return { total: cases.length, passed, failed, skipped };
  }, [run]);

  const active = run !== null && !isTerminalRunStatus(run.status);
  const plan = run?.planSnapshot ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/runs" className="text-sm text-slate-500 hover:text-slate-900">
        ← 返回运行列表
      </Link>

      {notFound ? (
        <ErrorState
          title="运行不存在"
          message={error ?? "没有找到这条运行记录。"}
          action={
            <Link
              href="/runs"
              className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-800 transition-colors hover:bg-rose-100"
            >
              返回运行列表
            </Link>
          }
        />
      ) : loading && !run ? (
        <DetailSkeleton />
      ) : error && !run ? (
        <ErrorState title="运行详情加载失败" message={error} onRetry={retry} />
      ) : !run ? (
        <EmptyState title="没有可展示的运行" description="请从运行列表重新进入。" />
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={run.status} />
                  {run.failureKind ? (
                    <span className="text-xs font-medium text-rose-700">
                      {failureKindLabel(run.failureKind)}
                    </span>
                  ) : null}
                  <span className="font-mono text-xs text-slate-400">{run.id}</span>
                </div>
                <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
                  {plan?.title ?? "（无计划标题）"}
                </h1>
                <p className="mt-1 text-xs text-slate-500">
                  项目 <span className="font-mono">{run.projectId}</span> ·{" "}
                  {runTriggerLabel(run.trigger)}触发
                </p>
              </div>
              <div className="text-left text-xs text-slate-500 sm:text-right">
                <p>创建 {formatDateTime(run.createdAt)}</p>
                <p className="mt-0.5">结束 {formatDateTime(run.finishedAt)}</p>
                <p className={active ? "mt-1 text-sky-700" : "mt-1 text-slate-400"}>
                  {active ? "每 3 秒自动刷新" : "已结束"} · 最后更新 {lastUpdatedAt ?? "—"}
                </p>
              </div>
            </div>

            {run.error ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700"
              >
                {run.error}
              </p>
            ) : null}

            {error && run ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                刷新失败：{error}（当前显示的是上次结果）
              </p>
            ) : null}
          </section>

          <section aria-label="运行统计" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-500">用例</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {summary.passed} 通过 / {summary.failed} 失败
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-500">通过率</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {formatPassRate(summary.passed, summary.total)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">按用例统计</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-500">失败 / 跳过</p>
              <p className={`mt-1 text-2xl font-semibold ${summary.failed > 0 ? "text-rose-600" : "text-slate-900"}`}>
                {summary.failed} / {summary.skipped}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">失败用例数 / 未覆盖用例数</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-500">耗时</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{formatDuration(run.durationMs)}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                开始 {formatTime(run.startedAt)} · 结束 {formatTime(run.finishedAt)}
              </p>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">AI 规划理由</h2>
              {plan ? (
                <span className="text-xs text-slate-500">
                  {plan.steps.length} 个步骤 · 计划 <span className="font-mono">{plan.id}</span>
                </span>
              ) : null}
            </div>

            {plan ? (
              <>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">
                  {plan.summary ?? "本次计划没有记录规划理由。"}
                </p>
                {plan.steps.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-slate-600">
                      查看计划快照（{plan.steps.length} 步）
                    </summary>
                    <ol className="mt-2 space-y-1 text-xs text-slate-600">
                      {plan.steps.map((step) => (
                        <li key={step.id}>
                          <span className="font-medium">
                            {step.order + 1}. {step.description}
                          </span>
                          <span className="ml-2 font-mono text-[11px] text-slate-400">{step.action}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                这次运行没有计划快照，无法展示规划理由与期望值。
              </p>
            )}
          </section>

          <section aria-labelledby="run-cases-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="run-cases-heading" className="text-sm font-semibold text-slate-900">
                用例与步骤
              </h2>
              <span className="text-xs text-slate-500">失败步骤高亮；每步都带期望、实际与证据链接</span>
            </div>

            {run.cases.length === 0 ? (
              <EmptyState
                title={active ? "运行尚未产出用例结果" : "没有用例结果"}
                description={
                  active
                    ? "运行还在进行中，页面会自动刷新。"
                    : "这次运行没有产生用例结果，可以查看上方的整体错误信息。"
                }
              />
            ) : (
              <div className="flex flex-col gap-4">
                {run.cases.map((caseResult) => (
                  <CaseResultCard key={caseResult.caseId} caseResult={caseResult} plan={plan} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
