/**
 * 报告模块的公共入口。
 *
 * - {@link classifyAttempt} / {@link classifyCase} / {@link runWithReruns}：失败归因；
 * - {@link buildRunReport}：把 run 结果聚合成 `RunReport`；
 * - {@link exportSpec}：把通过的用例导出成 Playwright spec。
 *
 * 全部是纯函数，不依赖存储层与网络。
 */

export {
  DEFAULT_RERUN_ATTEMPTS,
  classifyAttempt,
  classifyCase,
  isEnvironmentError,
  runWithReruns,
} from "./classify";
export type {
  AttemptInput,
  AttemptVerdict,
  Classification,
  ClassifyOptions,
  PageSnapshot,
  Verdict,
  VerdictReason,
} from "./classify";

export { attemptFromCaseResult, buildRunReport } from "./builder";
export type {
  BuildReportInput,
  CaseReport,
  CostSummary,
  ReportFailure,
  RunReport,
  RunReportTotals,
  UncoveredItem,
} from "./builder";

export {
  DEFAULT_EXPORT_SEED,
  DEFAULT_STEP_TIMEOUT_MS,
  exportSpec,
  locatorExpression,
} from "./export-spec";
export type { ExportSpecInput, ExportSpecOptions } from "./export-spec";
