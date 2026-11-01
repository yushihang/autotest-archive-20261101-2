"use client";

import { useMemo } from "react";

import type { CaseResult, StepResult, TestPlan, TestStep } from "@/lib/domain";
import { failureKindLabel, stepActionLabel } from "@/lib/labels";

import { ArtifactLinks } from "@/components/artifact-links";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration } from "@/lib/format";

interface UncoveredStep {
  key: string;
  order: number;
  description: string;
  skipped: boolean;
}

function isFailedStep(status: StepResult["status"]): boolean {
  return status === "failed" || status === "error";
}

function actualText(step: StepResult): string {
  if (step.status === "passed") return "符合预期";
  if (step.status === "skipped") return "未执行";
  return step.error ?? "未通过";
}

/**
 * 单条用例：失败高亮、每一步的期望/实际/证据、以及计划里没有跑到的步骤。
 *
 * `plan` 是可选的计划快照：期望值只存在于计划里，StepResult 本身不带 `expected`。
 */
export function CaseResultCard({ caseResult, plan }: { caseResult: CaseResult; plan: TestPlan | null }) {
  const planSteps = useMemo(() => {
    const map = new Map<string, TestStep>();
    for (const step of plan?.steps ?? []) {
      map.set(step.id, step);
    }
    return map;
  }, [plan]);

  const uncovered = useMemo<UncoveredStep[]>(() => {
    const resultByStep = new Map<string, StepResult>(
      caseResult.steps.map((step) => [step.stepId, step] as const),
    );

    if (plan) {
      return plan.steps
        .filter((step) => {
          const result = resultByStep.get(step.id);
          return !result || result.status === "skipped";
        })
        .map((step) => ({
          key: step.id,
          order: step.order,
          description: step.description,
          skipped: resultByStep.has(step.id),
        }));
    }

    return caseResult.steps
      .filter((step) => step.status === "skipped")
      .map((step) => ({
        key: step.stepId,
        order: step.order,
        description: step.description,
        skipped: true,
      }));
  }, [caseResult.steps, plan]);

  const caseFailed = caseResult.status === "failed" || caseResult.status === "error";
  const failure = failureKindLabel(caseResult.failureKind);

  return (
    <section
      aria-label={`用例：${caseResult.title}`}
      className={[
        "overflow-hidden rounded-xl border bg-white shadow-sm",
        caseFailed ? "border-rose-300" : "border-slate-200",
      ].join(" ")}
    >
      <header
        className={[
          "flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
          caseFailed ? "border-rose-200 bg-rose-50" : "border-slate-200",
        ].join(" ")}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge status={caseResult.status} />
          <h3 className="text-sm font-semibold text-slate-900">{caseResult.title}</h3>
          <span className="font-mono text-[11px] text-slate-400">{caseResult.caseId}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {failure ? <span className="font-medium text-rose-700">{failure}</span> : null}
          <span>耗时 {formatDuration(caseResult.durationMs)}</span>
          <span>{caseResult.steps.length} 步</span>
        </div>
      </header>

      {caseResult.error ? (
        <p className="border-b border-rose-200 bg-rose-50/70 px-4 py-2 text-xs leading-relaxed text-rose-700">
          {caseResult.error}
        </p>
      ) : null}

      {caseResult.steps.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">这条用例没有步骤结果。</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {caseResult.steps.map((step) => {
            const planStep = planSteps.get(step.stepId);
            const failed = isFailedStep(step.status);
            const actual = actualText(step);

            return (
              <li
                key={step.stepId}
                className={[
                  "border-l-4",
                  failed ? "border-rose-400 bg-rose-50/60" : "border-transparent",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusBadge status={step.status} />
                    <span className="text-sm font-medium text-slate-900">
                      {step.order + 1}. {step.description}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">耗时 {formatDuration(step.durationMs)}</span>
                </div>

                <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="font-medium text-slate-500">动作</dt>
                    <dd className="mt-0.5 break-words font-mono text-slate-700">
                      {stepActionLabel(step.action)}
                      {planStep?.target ? ` · ${planStep.target}` : ""}
                      {planStep?.value ? ` · 值：${planStep.value}` : ""}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-medium text-slate-500">期望</dt>
                    <dd className="mt-0.5 whitespace-pre-line break-words text-slate-700">
                      {planStep?.expected ?? "—"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-medium text-slate-500">实际</dt>
                    <dd
                      className={[
                        "mt-0.5 whitespace-pre-line break-words",
                        failed ? "text-rose-700" : "text-slate-700",
                      ].join(" ")}
                    >
                      {actual}
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-slate-500">
                  <span className="font-medium">证据</span>
                  <ArtifactLinks artifacts={step.artifacts} />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {caseResult.artifacts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
          <span className="font-medium">用例级证据</span>
          <ArtifactLinks artifacts={caseResult.artifacts} />
        </div>
      ) : null}

      {uncovered.length > 0 ? (
        <div className="border-t border-amber-200 bg-amber-50/70 px-4 py-3">
          <h4 className="text-xs font-semibold text-amber-900">未覆盖项（{uncovered.length}）</h4>
          <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-amber-900">
            {uncovered.map((item) => (
              <li key={item.key}>
                第 {item.order + 1} 步 · {item.description}
                <span className="text-amber-700">（{item.skipped ? "已跳过" : "无执行结果"}）</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
