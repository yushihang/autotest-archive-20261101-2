/** 枚举值 → 界面文案。状态、失败归类、触发来源与产物类型都只在这里维护。 */

import type {
  ArtifactKind,
  CaseStatus,
  FailureKind,
  RunStatus,
  RunTrigger,
  StepAction,
  StepStatus,
} from "@/lib/domain";

type AnyStatus = RunStatus | CaseStatus | StepStatus;

const STATUS_LABELS: Record<AnyStatus, string> = {
  queued: "排队中",
  running: "运行中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
  error: "错误",
  skipped: "已跳过",
};

export function statusLabel(status: AnyStatus): string {
  return STATUS_LABELS[status];
}

const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  assertion_failed: "断言未通过",
  element_not_found: "元素未找到",
  navigation_error: "导航失败",
  timeout: "超时",
  llm_error: "AI 生成失败",
  script_error: "脚本错误",
  environment_error: "环境错误",
  cancelled: "已取消",
  unknown: "未知原因",
};

export function failureKindLabel(kind: FailureKind | null | undefined): string | null {
  return kind ? FAILURE_KIND_LABELS[kind] : null;
}

const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
  api: "API",
  ui: "控制台",
  schedule: "定时",
};

export function runTriggerLabel(trigger: RunTrigger): string {
  return RUN_TRIGGER_LABELS[trigger];
}

const STEP_ACTION_LABELS: Record<StepAction, string> = {
  goto: "打开",
  click: "点击",
  fill: "填入",
  press: "按键",
  select: "选择",
  assert_text: "断言文案",
  assert_visible: "断言可见",
  assert_url: "断言地址",
  wait: "等待",
  custom: "自定义",
};

export function stepActionLabel(action: StepAction): string {
  return STEP_ACTION_LABELS[action];
}

const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  screenshot: "截图",
  video: "录屏",
  trace: "Trace",
  log: "日志",
  har: "HAR",
  report: "报告",
  other: "附件",
};

export function artifactKindLabel(kind: ArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
}
