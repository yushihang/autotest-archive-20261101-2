import { describe, expect, it } from "vitest";

import type { CaseResult, Project, Run, StepResult, TestPlan, TestStep } from "@/lib/domain";
import {
  DEFAULT_EXPORT_SEED,
  exportSpec,
  locatorExpression,
} from "@/lib/report/export-spec";

const NOW = "2026-11-01T10:00:00.000Z";

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
    value: "{{email}}",
    expected: null,
    timeoutMs: null,
  },
  {
    id: "step_3",
    order: 2,
    description: "点击登录",
    action: "click",
    target: 'button:has-text("登录")',
    value: null,
    expected: null,
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
  title: "登录流程",
  summary: null,
  baseUrl: null,
  steps: STEPS,
  createdAt: NOW,
  updatedAt: NOW,
};

const PROJECT: Pick<Project, "name" | "baseUrl"> = {
  name: "demo",
  baseUrl: "https://staging.example.com",
};

const RUN: Pick<Run, "id" | "finishedAt"> = {
  id: "run_1",
  finishedAt: "2026-11-01T10:00:30.000Z",
};

function step(stepId: string, order: number, action: StepResult["action"]): StepResult {
  return {
    stepId,
    order,
    description: `步骤 ${stepId}`,
    action,
    status: "passed",
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 100,
    failureKind: null,
    error: null,
    artifacts: [],
  };
}

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "case_1",
    planId: "plan_1",
    title: "邮箱登录成功",
    status: "passed",
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 900,
    failureKind: null,
    error: null,
    steps: [
      step("step_1", 0, "goto"),
      step("step_2", 1, "fill"),
      step("step_3", 2, "click"),
      step("step_4", 3, "assert_text"),
    ],
    artifacts: [],
    ...overrides,
  };
}

function generate(cases: CaseResult[] = [caseResult()]): string {
  return exportSpec({ plan: PLAN, project: PROJECT, run: RUN, cases });
}

describe("exportSpec", () => {
  it("只导出通过的用例", () => {
    const spec = generate([
      caseResult(),
      caseResult({ caseId: "case_2", title: "失败用例", status: "failed" }),
    ]);

    expect(spec).toContain("邮箱登录成功");
    expect(spec).not.toContain("失败用例");
    expect(spec).toContain("导出用例：1 / 2（只包含通过用例）");
  });

  it("生成可提交的 Playwright 结构", () => {
    const spec = generate();

    expect(spec).toContain('import { expect, test } from "@playwright/test";');
    expect(spec).toContain('test.describe("登录流程", () => {');
    expect(spec).toContain('test.use({ actionTimeout: STEP_TIMEOUT_MS });');
    expect(spec).toContain("await page.goto(BASE_URL + \"/login\");");
  });

  it("把稳定选择器翻译成 getByTestId / getByRole", () => {
    const spec = generate();

    expect(spec).toContain('page.getByTestId("email")');
    expect(spec).toContain('page.getByRole("button", { name: "登录" })');
  });

  it("用显式等待代替固定 sleep", () => {
    const spec = generate();

    expect(spec).toContain("await expect(el1).toBeVisible({ timeout: STEP_TIMEOUT_MS });");
    expect(spec).toContain(
      'await expect(el3).toContainText("欢迎回来", { timeout: STEP_TIMEOUT_MS });',
    );
    expect(spec).not.toContain("waitForTimeout");
  });

  it("占位数据由固定种子确定性展开", () => {
    const first = generate();
    const second = generate();

    expect(first).toContain(`const FIXED_SEED = ${DEFAULT_EXPORT_SEED};`);
    expect(first).toContain("seeded(1)");
    expect(first).toBe(second);
  });

  it("没有通过用例时仍然产出可读文本", () => {
    const spec = generate([caseResult({ status: "failed" })]);

    expect(spec).toContain("没有通过（passed）的用例");
    expect(spec).not.toContain("邮箱登录成功");
  });
});

describe("locatorExpression", () => {
  it("data-testid 是稳定选择器", () => {
    expect(locatorExpression('[data-testid="submit"]')).toEqual({
      code: 'page.getByTestId("submit")',
      stable: true,
    });
  });

  it("文本选择器转成 getByText", () => {
    expect(locatorExpression("text=提交订单")).toEqual({
      code: 'page.getByText("提交订单")',
      stable: true,
    });
  });

  it("类名选择器标记为不稳定", () => {
    const result = locatorExpression(".btn-primary");

    expect(result.stable).toBe(false);
    expect(result.code).toBe('page.locator(".btn-primary")');
  });

  it("带哈希的 id 视为构建产物", () => {
    expect(locatorExpression("#login-3f2a9c").stable).toBe(false);
    expect(locatorExpression("#login").stable).toBe(true);
  });
});
