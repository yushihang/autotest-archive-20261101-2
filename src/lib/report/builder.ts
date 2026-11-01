/**
 * 把一次 run 的原始结果聚合成可读、可归档的报告。
 *
 * 输入只有领域类型（`CaseResult` / `Artifact` / `RunEvent`），输出是 `RunReport`：
 * 通过率、失败清单（输入 / 期望 / 实际 / 最小复现步骤）、未覆盖项及原因、
 * 耗时与 token 成本。归因结论来自 {@link classifyCase}。
 *
 * 纯函数：不读写数据库、不发网络请求、不读时钟。
 * `generatedAt` 缺省取 `run.finishedAt ?? run.createdAt`，保证同一份输入永远得到同一份报告。
 */

import type {
  Artifact,
  CaseResult,
  CaseStatus,
  FailureKind,
  IsoDateTime,
  Run,
  RunEvent,
  RunStatus,
  RunTrigger,
  StepAction,
  StepResult,
  TestStep,
} from "@/lib/domain";

import {
  classifyCase,
  type AttemptInput,
  type Classification,
  type Verdict,
} from "./classify";

/** 单条用例在报告里的归因摘要。 */
export interface CaseReport {
  caseId: string;
  title: string;
  status: CaseStatus;
  verdict: Verdict;
  /** 参与判定的执行次数。 */
  attempts: number;
  passedAttempts: number;
  durationMs: number;
  evidence: string[];
}

/** 失败清单里的一条：能直接交给别人复现。 */
export interface ReportFailure {
  caseId: string;
  title: string;
  verdict: Verdict;
  failureKind: FailureKind | null;
  /** 失败的步骤；用例级失败（没有具体步骤）时为 `null`。 */
  stepId: string | null;
  /** 输入：起点地址与被填入的数据。 */
  input: string[];
  /** 期望：计划里写的结果。 */
  expected: string;
  /** 实际：真实发生了什么。 */
  actual: string;
  /** 最小复现步骤，从最后一次 `goto` 开始，到失败步骤为止。 */
  reproduceSteps: string[];
  error: string;
  durationMs: number;
  artifacts: Artifact[];
  evidence: string[];
}

/** 没有覆盖到的东西，以及为什么没覆盖。 */
export interface UncoveredItem {
  caseId: string;
  caseTitle: string;
  /** 未执行的步骤；整条用例未执行时为 `null`。 */
  stepId: string | null;
  stepDescription: string | null;
  reason: string;
}

/** 报告里的计数。 */
export interface RunReportTotals {
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  /** 归因计数。 */
  real: number;
  flaky: number;
  env: number;
  testBug: number;
}

/** token 与金额成本。 */
export interface CostSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 美元；事件里没有金额时为 `null`。 */
  usd: number | null;
}

/** 一次 run 的完整报告。 */
export interface RunReport {
  runId: string;
  projectId: string;
  planId: string | null;
  planTitle: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  generatedAt: IsoDateTime;
  durationMs: number;
  /** 通过率，0..1；没有执行过用例时为 0。分母不含 skipped。 */
  passRate: number;
  totals: RunReportTotals;
  cost: CostSummary;
  cases: CaseReport[];
  failures: ReportFailure[];
  uncovered: UncoveredItem[];
  /** 报告涉及的全部产物，按 id 去重。 */
  artifacts: Artifact[];
  /** 参与聚合的事件条数，便于核对上游数据是否完整。 */
  eventCount: number;
}

export interface BuildReportInput {
  run: Run;
  /**
   * 按用例提供的重跑记录。缺省时每个用例只用自身结果判定一次；
   * 需要 `TEST_BUG` 归因时必须由调用方带上页面快照（领域类型里不存快照）。
   */
  attemptsByCase?: Record<string, AttemptInput[]>;
  /** 事件流；用于 token 成本、以及未覆盖项的具体原因。 */
  events?: RunEvent[];
  /** 生成时间；缺省用 `run.finishedAt ?? run.createdAt`。 */
  generatedAt?: IsoDateTime;
}

/** 哪些动作的 `value` 算「输入」。 */
const INPUT_ACTIONS: ReadonlySet<StepAction> = new Set<StepAction>([
  "goto",
  "fill",
  "select",
  "press",
]);

/** 聚合一次 run。 */
export function buildRunReport(input: BuildReportInput): RunReport {
  const { run, events = [] } = input;
  const attemptsByCase = input.attemptsByCase ?? {};
  const generatedAt = input.generatedAt ?? run.finishedAt ?? run.createdAt;

  const totals: RunReportTotals = {
    cases: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    real: 0,
    flaky: 0,
    env: 0,
    testBug: 0,
  };

  const caseReports: CaseReport[] = [];
  const failures: ReportFailure[] = [];
  const uncovered: UncoveredItem[] = [];
  const artifacts: Artifact[] = [];

  for (const caseResult of run.cases) {
    totals.cases += 1;
    countStatus(totals, caseResult.status);
    artifacts.push(...caseResult.artifacts, ...caseResult.steps.flatMap((step) => step.artifacts));

    const attempts = attemptsByCase[caseResult.caseId] ?? [attemptFromCaseResult(caseResult, run)];
    const classification = classifyCase(attempts);

    caseReports.push({
      caseId: caseResult.caseId,
      title: caseResult.title,
      status: caseResult.status,
      verdict: classification.verdict,
      attempts: classification.counts.total,
      passedAttempts: classification.counts.passed,
      durationMs: caseResult.durationMs,
      evidence: classification.evidence,
    });
    countVerdict(totals, classification.verdict);

    if (classification.verdict !== "PASS" && classification.verdict !== "SKIPPED") {
      failures.push(buildFailure(caseResult, run, classification));
    }

    if (caseResult.status === "skipped") {
      uncovered.push({
        caseId: caseResult.caseId,
        caseTitle: caseResult.title,
        stepId: null,
        stepDescription: null,
        reason: caseSkipReason(events, caseResult, run.status),
      });
    }

    for (const step of caseResult.steps) {
      if (step.status !== "skipped") continue;
      uncovered.push({
        caseId: caseResult.caseId,
        caseTitle: caseResult.title,
        stepId: step.stepId,
        stepDescription: step.description,
        reason: caseResult.status === "skipped"
          ? caseSkipReason(events, caseResult, run.status)
          : "前序步骤失败，未执行",
      });
    }
  }

  const passed = totals.passed;
  const executed = totals.cases - totals.skipped;

  return {
    runId: run.id,
    projectId: run.projectId,
    planId: run.planId,
    planTitle: run.planSnapshot?.title ?? null,
    status: run.status,
    trigger: run.trigger,
    generatedAt,
    durationMs: runDuration(run),
    passRate: executed === 0 ? 0 : passed / executed,
    totals,
    cost: collectCost(events),
    cases: caseReports,
    failures,
    uncovered,
    artifacts: dedupeArtifacts(artifacts),
    eventCount: events.length,
  };
}

// ---------------------------------------------------------------------------
// 用例 -> 单次判定
// ---------------------------------------------------------------------------

/** 用 `CaseResult` 自身信息构造一次执行记录（无页面快照，因此不会判成 `TEST_BUG`）。 */
export function attemptFromCaseResult(caseResult: CaseResult, run: Run): AttemptInput {
  const failedStep = findFailureStep(caseResult);
  const planStep = failedStep === null ? null : findPlanStep(run, failedStep.stepId);

  return {
    status: caseResult.status,
    failureKind: failedStep?.failureKind ?? caseResult.failureKind,
    error: failedStep?.error ?? caseResult.error,
    selector: planStep?.target ?? null,
    expected: planStep?.expected ?? null,
    snapshot: null,
  };
}

// ---------------------------------------------------------------------------
// 失败清单
// ---------------------------------------------------------------------------

function buildFailure(
  caseResult: CaseResult,
  run: Run,
  classification: Classification,
): ReportFailure {
  const failedStep = findFailureStep(caseResult);
  const planStep = failedStep === null ? null : findPlanStep(run, failedStep.stepId);
  const prefix = failedStep === null
    ? caseResult.steps
    : caseResult.steps.slice(0, caseResult.steps.indexOf(failedStep) + 1);

  const error = failedStep?.error ?? caseResult.error ?? classification.evidence[0] ?? "未记录错误信息";
  const lookup = (step: StepResult): TestStep | null => findPlanStep(run, step.stepId);

  return {
    caseId: caseResult.caseId,
    title: caseResult.title,
    verdict: classification.verdict,
    failureKind: failedStep?.failureKind ?? caseResult.failureKind,
    stepId: failedStep?.stepId ?? null,
    input: inputLines(prefix, lookup),
    expected: expectedText(planStep, failedStep, caseResult),
    actual: error,
    reproduceSteps: reproduceSteps(prefix, lookup),
    error,
    durationMs: caseResult.durationMs,
    artifacts: dedupeArtifacts([
      ...caseResult.artifacts,
      ...(failedStep === null ? [] : failedStep.artifacts),
    ]),
    evidence: classification.evidence,
  };
}

/** 期望结果：优先计划里的 `expected`，其次失败步骤的描述、最后退回用例标题。 */
function expectedText(
  planStep: TestStep | null,
  failedStep: StepResult | null,
  caseResult: CaseResult,
): string {
  if (planStep?.expected) return planStep.expected;
  if (failedStep?.description) return `${failedStep.description} 成功完成`;
  return `${caseResult.title} 成功完成`;
}

/** 输入：只保留真正喂给页面的数据。 */
function inputLines(
  steps: StepResult[],
  lookup: (step: StepResult) => TestStep | null,
): string[] {
  return steps
    .filter((step) => INPUT_ACTIONS.has(step.action))
    .map((step) => describeStep(step, lookup(step)));
}

/**
 * 最小复现步骤：从最后一次 `goto` 开始截断。
 *
 * 之前的步骤多半是别的场景的准备动作，保留整段会让复现成本变高。
 */
function reproduceSteps(
  steps: StepResult[],
  lookup: (step: StepResult) => TestStep | null,
): string[] {
  if (steps.length === 0) return [];

  let start = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.action === "goto") {
      start = index;
      break;
    }
  }

  return steps
    .slice(start)
    .map((step, index) => `${index + 1}. ${describeStep(step, lookup(step))}`);
}

function describeStep(step: StepResult, planStep: TestStep | null): string {
  const target = planStep?.target ?? "(未提供目标)";
  const value = planStep?.value ?? null;
  switch (step.action) {
    case "goto":
      return `打开 ${target}`;
    case "fill":
      return `在 ${target} 填入 ${quoteValue(value)}`;
    case "select":
      return `在 ${target} 选择 ${quoteValue(value)}`;
    case "press":
      return `在 ${target} 按下 ${quoteValue(value)}`;
    case "click":
      return `点击 ${target}`;
    case "assert_text":
      return `断言 ${target} 的文案包含 ${quoteValue(planStep?.expected ?? value)}`;
    case "assert_visible":
      return `断言 ${target} 可见`;
    case "assert_url":
      return `断言地址为 ${target}`;
    case "wait":
      return `等待 ${target}`;
    case "custom":
      return `执行自定义步骤 ${target}`;
    default:
      return `${step.action} ${target}`;
  }
}

function quoteValue(value: string | null): string {
  if (value === null || value === "") return "(空)";
  return `“${value}”`;
}

// ---------------------------------------------------------------------------
// 成本
// ---------------------------------------------------------------------------

interface EventUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number | null;
}

/**
 * 成本优先取 `run.finished` 上的汇总；没有时按用例累加 `case.finished`，
 * 同一用例以最后一次为准，避免重跑重复计数。
 */
function collectCost(events: RunEvent[]): CostSummary {
  const runUsage = [...events]
    .reverse()
    .filter((event) => event.type === "run.finished")
    .map(readUsage)
    .find((usage): usage is EventUsage => usage !== null);

  if (runUsage) return sumUsage([runUsage]);

  const perCase = new Map<string, EventUsage>();
  for (const event of events) {
    if (event.type !== "case.finished") continue;
    const usage = readUsage(event);
    if (usage === null) continue;
    perCase.set(event.caseId ?? event.id, usage);
  }

  return sumUsage([...perCase.values()]);
}

function sumUsage(usages: EventUsage[]): CostSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let usd: number | null = null;

  for (const usage of usages) {
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
    if (usage.usd !== null) usd = (usd ?? 0) + usage.usd;
  }

  return { promptTokens, completionTokens, totalTokens, usd };
}

/** 从事件 `data`（或 `data.usage`）里读取用量；完全没有相关字段时返回 `null`。 */
function readUsage(event: RunEvent): EventUsage | null {
  const data = event.data ?? {};
  const usage = data["usage"];
  const nested: Record<string, unknown> = isRecord(usage) ? usage : {};

  const read = (keys: readonly string[]): number | null =>
    readNumber(data, keys) ?? readNumber(nested, keys);

  const promptTokens = read(["promptTokens", "prompt_tokens", "inputTokens"]) ?? 0;
  const completionTokens = read(["completionTokens", "completion_tokens", "outputTokens"]) ?? 0;
  const totalTokens =
    read(["totalTokens", "total_tokens", "tokens"]) ?? promptTokens + completionTokens;
  const usd = read(["costUsd", "cost_usd", "cost", "usd"]);

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0 && usd === null) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens, usd };
}

function readNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// 未覆盖原因 / 杂项
// ---------------------------------------------------------------------------

function caseSkipReason(events: RunEvent[], caseResult: CaseResult, status: RunStatus): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.caseId !== caseResult.caseId) continue;
    if (event.type !== "case.finished" && event.type !== "log") continue;

    const explicit = readString(event.data ?? {}, ["skipReason", "skippedReason", "reason"]);
    if (explicit !== null) return explicit;

    if (event.type === "case.finished") {
      const markedSkipped =
        event.data?.["skipped"] === true || event.data?.["status"] === "skipped";
      if (markedSkipped && event.message.trim() !== "") return event.message.trim();
    }
  }

  if (status === "cancelled") return "run 已取消，未执行";
  if (status === "timed_out") return "run 超时，未执行";
  return "用例被跳过，未执行";
}

function runDuration(run: Run): number {
  if (typeof run.durationMs === "number") return run.durationMs;

  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? null;
  const elapsed = elapsedMs(start, end);
  if (elapsed !== null) return elapsed;

  return run.cases.reduce((sum, caseResult) => sum + (caseResult.durationMs || 0), 0);
}

function elapsedMs(start: IsoDateTime | null, end: IsoDateTime | null): number | null {
  if (start === null || end === null) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
}

function findFailureStep(caseResult: CaseResult): StepResult | null {
  return (
    caseResult.steps.find(
      (step) => step.status === "failed" || step.status === "error",
    ) ?? null
  );
}

function findPlanStep(run: Run, stepId: string): TestStep | null {
  return run.planSnapshot?.steps.find((step) => step.id === stepId) ?? null;
}

function countStatus(totals: RunReportTotals, status: CaseStatus): void {
  switch (status) {
    case "passed":
      totals.passed += 1;
      break;
    case "failed":
      totals.failed += 1;
      break;
    case "skipped":
      totals.skipped += 1;
      break;
    case "error":
      totals.errored += 1;
      break;
  }
}

function countVerdict(totals: RunReportTotals, verdict: Verdict): void {
  switch (verdict) {
    case "FAIL_REAL":
      totals.real += 1;
      break;
    case "FLAKY":
      totals.flaky += 1;
      break;
    case "ENV":
      totals.env += 1;
      break;
    case "TEST_BUG":
      totals.testBug += 1;
      break;
    default:
      break;
  }
}

function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const result: Artifact[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    result.push(artifact);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
