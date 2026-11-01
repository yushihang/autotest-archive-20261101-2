import { describe, expect, it } from "vitest";

import type {
  Artifact,
  CaseResult,
  Run,
  RunEvent,
  StepResult,
  TestPlan,
  TestStep,
} from "@/lib/domain";
import { buildRunReport } from "@/lib/report/builder";
import type { AttemptInput, PageSnapshot } from "@/lib/report/classify";

const NOW = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-01T10:00:30.000Z";

const STEPS: TestStep[] = [
  {
    id: "step_1",
    order: 0,
    description: "打开登录页",
    action: "goto",
    target: "/login",
    value: null,
    expected: null,
    timeoutMs: null,
  },
  {
    id: "step_2",
    order: 1,
    description: "填写邮箱",
    action: "fill",
    target: '[data-testid="email"]',
    value: "qa@example.com",
    expected: null,
    timeoutMs: null,
  },
  {
    id: "step_3",
    order: 2,
    description: "提交登录",
    action: "click",
    target: '[data-testid="submit"]',
    value: null,
    expected: "进入下单成功页",
    timeoutMs: null,
  },
  {
    id: "step_4",
    order: 3,
    description: "看到欢迎语",
    action: "assert_text",
    target: '[data-testid="welcome"]',
    value: null,
    expected: "欢迎回来",
    timeoutMs: null,
  },
];

const PLAN: TestPlan = {
  id: "plan_1",
  projectId: "proj_1",
  title: "登录与下单",
  summary: null,
  baseUrl: null,
  steps: STEPS,
  createdAt: NOW,
  updatedAt: NOW,
};

const SCREENSHOT: Artifact = {
  id: "art_1",
  runId: "run_1",
  caseId: "case_1",
  stepId: "step_3",
  kind: "screenshot",
  path: "run_1/case_1/step_3.png",
  url: null,
  contentType: "image/png",
  bytes: 2048,
  createdAt: LATER,
};

function step(overrides: Partial<StepResult> & Pick<StepResult, "stepId" | "order" | "action">): StepResult {
  return {
    description: `步骤 ${overrides.stepId}`,
    status: "passed",
    startedAt: NOW,
    finishedAt: LATER,
    durationMs: 100,
    failureKind: null,
    error: null,
    artifacts: [],
    ...overrides,
  };
}

function failedCase(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "case_1",
    planId: "plan_1",
    title: "邮箱登录",
    status: "failed",
    startedAt: NOW,
    finishedAt: LATER,
    durationMs: 3000,
    failureKind: "assertion_failed",
    error: "提交后没有进入下单成功页",
    steps: [
      step({ stepId: "step_1", order: 0, action: "goto" }),
      step({ stepId: "step_2", order: 1, action: "fill" }),
      step({
        stepId: "step_3",
        order: 2,
        action: "click",
        status: "failed",
        failureKind: "assertion_failed",
        error: "提交后没有进入下单成功页",
        artifacts: [SCREENSHOT],
      }),
      step({ stepId: "step_4", order: 3, action: "assert_text", status: "skipped" }),
    ],
    artifacts: [],
    ...overrides,
  };
}

function passedCase(): CaseResult {
  return {
    caseId: "case_2",
    planId: "plan_1",
    title: "退出登录",
    status: "passed",
    startedAt: NOW,
    finishedAt: LATER,
    durationMs: 1200,
    failureKind: null,
    error: null,
    steps: [
      step({ stepId: "step_1", order: 0, action: "goto" }),
      step({ stepId: "step_2", order: 1, action: "click" }),
    ],
    artifacts: [],
  };
}

function skippedCase(): CaseResult {
  return {
    caseId: "case_3",
    planId: "plan_1",
    title: "修改密码",
    status: "skipped",
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    failureKind: null,
    error: null,
    steps: [],
    artifacts: [],
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    projectId: "proj_1",
    status: "failed",
    planId: "plan_1",
    planSnapshot: PLAN,
    trigger: "ui",
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: LATER,
    cancelledAt: null,
    durationMs: 5000,
    failureKind: "assertion_failed",
    error: null,
    cases: [failedCase(), passedCase(), skippedCase()],
    ...overrides,
  };
}

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "id" | "type">): RunEvent {
  return {
    runId: "run_1",
    at: LATER,
    caseId: null,
    stepId: null,
    message: "",
    data: {},
    ...overrides,
  };
}

describe("buildRunReport", () => {
  it("统计通过率、失败清单与未覆盖项", () => {
    const report = buildRunReport({ run: makeRun() });

    expect(report.runId).toBe("run_1");
    expect(report.planTitle).toBe("登录与下单");
    expect(report.totals).toEqual({
      cases: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      errored: 0,
      real: 1,
      flaky: 0,
      env: 0,
      testBug: 0,
    });
    // 分母不含 skipped：1 / 2
    expect(report.passRate).toBe(0.5);
    expect(report.generatedAt).toBe(LATER);
    expect(report.durationMs).toBe(5000);

    expect(report.failures).toHaveLength(1);
    const failure = report.failures[0];
    expect(failure?.caseId).toBe("case_1");
    expect(failure?.verdict).toBe("FAIL_REAL");
    expect(failure?.failureKind).toBe("assertion_failed");
    expect(failure?.expected).toBe("进入下单成功页");
    expect(failure?.actual).toBe("提交后没有进入下单成功页");
    expect(failure?.artifacts.map((item) => item.id)).toEqual(["art_1"]);

    // 输入只保留真正喂给页面的数据
    expect(failure?.input).toEqual([
      "打开 /login",
      "在 [data-testid=\"email\"] 填入 “qa@example.com”",
    ]);

    // 最小复现步骤：从最后一次 goto 开始，到失败步骤为止
    expect(failure?.reproduceSteps).toHaveLength(3);
    expect(failure?.reproduceSteps[0]).toBe("1. 打开 /login");
    expect(failure?.reproduceSteps[2]).toBe("3. 点击 [data-testid=\"submit\"]");

    // 一条整用例跳过 + 一条失败用例里没跑到的步骤
    expect(report.uncovered).toHaveLength(2);
    expect(report.uncovered.map((item) => item.caseId)).toEqual(["case_1", "case_3"]);
    expect(report.uncovered[0]?.reason).toBe("前序步骤失败，未执行");
    expect(report.uncovered[1]?.reason).toBe("用例被跳过，未执行");
  });

  it("从事件里汇总 token 成本，并按用例去重", () => {
    const events: RunEvent[] = [
      event({
        id: "1",
        type: "case.finished",
        caseId: "case_1",
        data: { usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } },
      }),
      event({
        id: "2",
        type: "case.finished",
        caseId: "case_1",
        data: { usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180 } },
      }),
      event({
        id: "3",
        type: "case.finished",
        caseId: "case_2",
        data: { usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 } },
      }),
    ];

    const report = buildRunReport({ run: makeRun(), events });

    expect(report.cost.totalTokens).toBe(250);
    expect(report.cost.promptTokens).toBe(170);
    expect(report.cost.completionTokens).toBe(80);
    expect(report.cost.usd).toBeNull();
    expect(report.eventCount).toBe(3);
  });

  it("run.finished 上的汇总优先于按用例累加", () => {
    const events: RunEvent[] = [
      event({
        id: "1",
        type: "case.finished",
        caseId: "case_1",
        data: { totalTokens: 10 },
      }),
      event({
        id: "2",
        type: "run.finished",
        data: { totalTokens: 900, costUsd: 0.02 },
      }),
    ];

    const report = buildRunReport({ run: makeRun(), events });

    expect(report.cost.totalTokens).toBe(900);
    expect(report.cost.usd).toBeCloseTo(0.02);
  });

  it("带上页面快照时可以把失败归因为 TEST_BUG", () => {
    const snapshot: PageSnapshot = {
      url: "https://staging.example.com/login",
      text: "全新改版的登录方式：扫码登录",
      selectors: ['[data-testid="qr-code"]'],
    };
    const attempts: Record<string, AttemptInput[]> = {
      case_1: [
        {
          status: "failed",
          failureKind: "element_not_found",
          error: 'locator(\'[data-testid="submit"]\') not found',
          selector: '[data-testid="submit"]',
          expected: "进入下单成功页",
          snapshot,
        },
        {
          status: "failed",
          failureKind: "element_not_found",
          error: 'locator(\'[data-testid="submit"]\') not found',
          selector: '[data-testid="submit"]',
          expected: "进入下单成功页",
          snapshot,
        },
        {
          status: "failed",
          failureKind: "element_not_found",
          error: 'locator(\'[data-testid="submit"]\') not found',
          selector: '[data-testid="submit"]',
          expected: "进入下单成功页",
          snapshot,
        },
      ],
    };

    const report = buildRunReport({ run: makeRun(), attemptsByCase: attempts });

    expect(report.totals.testBug).toBe(1);
    expect(report.failures[0]?.verdict).toBe("TEST_BUG");
    expect(report.failures[0]?.evidence.join("\n")).toContain("页面快照");
  });

  it("未覆盖原因优先取事件里写明的理由", () => {
    const events: RunEvent[] = [
      event({
        id: "1",
        type: "case.finished",
        caseId: "case_3",
        message: "计划依赖的账号未准备",
        data: { status: "skipped", skipReason: "测试账号缺失" },
      }),
    ];

    const report = buildRunReport({ run: makeRun(), events });

    expect(report.uncovered[1]?.reason).toBe("测试账号缺失");
  });

  it("没有可执行用例时通过率为 0，且不产生日期漂移", () => {
    const run = makeRun({ cases: [skippedCase()], durationMs: null, finishedAt: null });

    const report = buildRunReport({ run });

    expect(report.passRate).toBe(0);
    expect(report.generatedAt).toBe(NOW);
  });
});
