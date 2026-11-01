/**
 * autotest 的领域模型。
 *
 * 这一层只描述“数据长什么样”，不含任何持久化或执行逻辑：
 * - 后续的存储层（.data/）与执行器都映射到这里的类型；
 * - REST 契约（docs/api-contract.md）的请求/响应体同样以这里为准。
 *
 * 约定：
 * - 所有 id 为字符串（当前用 `prefix_` + 随机串，具体实现由存储层决定）；
 * - 所有时间字段为 ISO 8601 字符串（UTC，带时区后缀），便于直接 JSON 序列化；
 * - 可缺失的字段用 `null` 表示“明确没有”，而不是省略字段，客户端解析更稳定。
 */

/** ISO 8601 时间戳，例如 `2026-11-01T08:30:00.000Z`。 */
export type IsoDateTime = string;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** 一个被测试的站点/应用。 */
export interface Project {
  id: string;
  /** 展示名，同一实例内唯一。 */
  name: string;
  description: string | null;
  /** 被测系统入口，例如 `https://staging.example.com`。 */
  baseUrl: string;
  /** 该项目下单步动作的默认超时，毫秒。 */
  defaultStepTimeoutMs: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// 测试计划
// ---------------------------------------------------------------------------

/** 单个步骤可执行的原子动作。 */
export type StepAction =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "assert_text"
  | "assert_visible"
  | "assert_url"
  | "wait"
  | "custom";

/** 计划里的一步：人可读的描述 + 机器可执行的动作。 */
export interface TestStep {
  id: string;
  /** 从 0 开始的执行顺序。 */
  order: number;
  /** 自然语言描述，报告里直接展示。 */
  description: string;
  action: StepAction;
  /** 动作目标：选择器、URL、按键名等；`goto` 用绝对/相对 URL。 */
  target: string | null;
  /** 输入值（`fill`/`select`/`press` 等使用）。 */
  value: string | null;
  /** 期望结果（断言类动作使用），例如期望文案。 */
  expected: string | null;
  /** 单步超时覆盖；`null` 表示用项目的默认值。 */
  timeoutMs: number | null;
}

/** 一份可复用的测试计划：一个项目下的一组有序步骤。 */
export interface TestPlan {
  id: string;
  projectId: string;
  title: string;
  /** 这份计划想验证什么，一到两句话。 */
  summary: string | null;
  /** 计划执行时的起点 URL；`null` 表示用项目的 baseUrl。 */
  baseUrl: string | null;
  steps: TestStep[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// 执行结果
// ---------------------------------------------------------------------------

/**
 * run 的生命周期状态。
 * `passed` / `failed` / `cancelled` / `timed_out` / `error` 为终态，终态不可再变更。
 */
export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "error";

/** 单步结果状态。`skipped` 用于因为前面步骤失败而没跑到的步骤。 */
export type StepStatus = "passed" | "failed" | "skipped" | "error";

/** 用例（一次 run 中的一条被测流程）的状态。 */
export type CaseStatus = "passed" | "failed" | "skipped" | "error";

/**
 * 失败归类。报告与统计按这个维度聚合，
 * 让“为什么失败”能落到可行动的一类，而不是一段自由文本。
 */
export type FailureKind =
  | "assertion_failed"
  | "element_not_found"
  | "navigation_error"
  | "timeout"
  | "llm_error"
  | "script_error"
  | "environment_error"
  | "cancelled"
  | "unknown";

/** 产物类型；实际文件落在 `ARTIFACT_DIR` 下。 */
export type ArtifactKind =
  | "screenshot"
  | "video"
  | "trace"
  | "log"
  | "har"
  | "report"
  | "other";

/** 执行过程中落盘的文件。`path` 相对 `ARTIFACT_DIR`。 */
export interface Artifact {
  id: string;
  runId: string;
  /** 关联到用例；run 级别的产物为 `null`。 */
  caseId: string | null;
  /** 关联到步骤；非步骤产物为 `null`。 */
  stepId: string | null;
  kind: ArtifactKind;
  /** 相对 `ARTIFACT_DIR` 的路径，例如 `run_abc/case_login/step_3.png`。 */
  path: string;
  /** 由服务端提供的下载地址，例如 `/api/runs/:id/artifacts/:artifactId`；未实现时为 `null`。 */
  url: string | null;
  contentType: string | null;
  bytes: number;
  createdAt: IsoDateTime;
}

/** 单个步骤的执行结果。 */
export interface StepResult {
  stepId: string;
  order: number;
  description: string;
  action: StepAction;
  status: StepStatus;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  durationMs: number;
  /** 仅 `failed` / `error` 时有值。 */
  failureKind: FailureKind | null;
  /** 人类可读的失败原因；成功时为 `null`。 */
  error: string | null;
  artifacts: Artifact[];
}

/** 单条用例的执行结果：一条用例对应一份计划（或计划中的一条流程）。 */
export interface CaseResult {
  /** 用例标识；由计划派生，报告内唯一。 */
  caseId: string;
  planId: string | null;
  title: string;
  status: CaseStatus;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  durationMs: number;
  failureKind: FailureKind | null;
  error: string | null;
  steps: StepResult[];
  artifacts: Artifact[];
}

/** run 的触发来源。 */
export type RunTrigger = "api" | "ui" | "schedule";

/** 一次执行：某个项目下、某份计划（快照）的一次运行。 */
export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  /** 计划被删除后仍可通过 `planSnapshot` 复现。 */
  planId: string | null;
  /** 创建 run 时的计划快照；执行与报告都以快照为准。 */
  planSnapshot: TestPlan | null;
  trigger: RunTrigger;
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  /** 取消动作发生的时间；未被取消时为 `null`。 */
  cancelledAt: IsoDateTime | null;
  durationMs: number | null;
  /** 整体失败归类；通过或未结束时为 `null`。被取消时为 `"cancelled"`。 */
  failureKind: FailureKind | null;
  /** 整体（非用例级）错误信息，例如取消或超时原因。 */
  error: string | null;
  cases: CaseResult[];
}

/** 列表接口用的轻量视图，不含 cases/steps 详情。 */
export interface RunSummary {
  id: string;
  projectId: string;
  status: RunStatus;
  planId: string | null;
  planTitle: string | null;
  trigger: RunTrigger;
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  durationMs: number | null;
  failureKind: FailureKind | null;
  /** 汇总计数，便于列表页直接渲染。 */
  totals: {
    cases: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

/**
 * `POST /api/runs/:id/cancel` 的响应体：run 的一个切片。
 *
 * 状态不一定立刻收敛——执行器可能还要几百毫秒才把 `running` 改成 `cancelled`，
 * 因此客户端应以随后 `GET /api/runs/:id` 的 `status` 为准。
 */
export interface CancelRunResponse {
  id: string;
  status: RunStatus;
  finishedAt: IsoDateTime | null;
  /** 取消动作发生的时间。 */
  cancelledAt: IsoDateTime | null;
}

/** 已进入终态、不会再变化的 run 状态。 */
export const TERMINAL_RUN_STATUSES = [
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "error",
] as const satisfies readonly RunStatus[];

/** 判断一个 run 是否已经结束。 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
// 执行事件流（SSE）
// ---------------------------------------------------------------------------

/** 事件类型；`GET /api/runs/:id/events` 以 SSE 推送这些事件。 */
export type RunEventType =
  | "run.queued"
  | "run.started"
  | "case.started"
  | "step.finished"
  | "case.finished"
  | "run.finished"
  | "log"
  | "heartbeat";

/** 事件流中的一个事件。`id` 单调递增（字符串化整数），支持断线重连续传。 */
export interface RunEvent {
  id: string;
  runId: string;
  type: RunEventType;
  at: IsoDateTime;
  caseId: string | null;
  stepId: string | null;
  /** 一句话进度描述，直接可展示。 */
  message: string;
  /** 结构化附加信息；不同事件类型字段不同，客户端按需读取。 */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 通用 API 信封
// ---------------------------------------------------------------------------

/** 分页响应外壳。 */
export interface Paginated<T> {
  items: T[];
  total: number;
  /** 从 1 开始。 */
  page: number;
  pageSize: number;
}

/** REST 错误码；与 docs/api-contract.md 的中文说明一一对应。 */
export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "not_found"
  | "conflict"
  | "run_not_cancellable"
  | "payload_too_large"
  | "internal_error";

/** 所有非 2xx 响应共用的错误体。 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** 面向人的说明，可直接展示。 */
    message: string;
    /** 字段级错误：`{ "name": ["不能为空"] }`；没有则为 `null`。 */
    details: Record<string, string[]> | null;
  };
}
