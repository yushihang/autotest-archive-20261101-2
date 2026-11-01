import { describe, expect, it } from "vitest";

import {
  PlanValidationError,
  parseTestPlans,
  type PlanCategory,
  type PlanPriority,
  type TestPlan,
} from "./schema";

function makePlan(
  id: string,
  overrides: Partial<TestPlan> & {
    name?: string;
    category?: PlanCategory;
    priority?: PlanPriority;
  } = {},
): TestPlan {
  return {
    id,
    name: `用例 ${id}`,
    priority: "P1",
    category: "happy_path",
    rationale: "覆盖核心交互，失败会影响主流程。",
    expected: `期望 ${id} 出现可观察的具体结果`,
    steps: [
      {
        id: "s1",
        action: "goto",
        description: "打开目标页面",
        target: "/login",
        value: null,
        expected: null,
        timeoutMs: null,
      },
      {
        id: "s2",
        action: "click",
        description: "点击提交按钮",
        target: "button[type=submit]",
        value: null,
        expected: null,
        timeoutMs: null,
      },
    ],
    assertions: [
      {
        id: "a1",
        description: "提交后出现结果文案",
        kind: "assert_text",
        target: "#result",
        expected: "保存成功",
      },
    ],
    ...overrides,
  };
}

function asJson(plans: unknown[]): string {
  return JSON.stringify({ plans });
}

describe("parseTestPlans", () => {
  it("接受 {\"plans\":[...]} 结构", () => {
    const plans = parseTestPlans(asJson([makePlan("login_happy")]));

    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe("login_happy");
    expect(plans[0]?.assertions[0]?.expected).toBe("保存成功");
  });

  it("接受裸数组和 Markdown 代码围栏", () => {
    const raw = `\`\`\`json\n${JSON.stringify([makePlan("bare_array")])}\n\`\`\``;
    const plans = parseTestPlans(raw);

    expect(plans.map((plan) => plan.id)).toEqual(["bare_array"]);
  });

  it("拒绝非法 JSON，不做猜补全", () => {
    expect(() => parseTestPlans('{"plans": [')).toThrowError(PlanValidationError);
    expect(() => parseTestPlans("抱歉，这次无法生成计划。")).toThrowError(
      PlanValidationError,
    );

    try {
      parseTestPlans('{"plans": [');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
      expect((error as PlanValidationError).code).toBe("invalid_json");
    }
  });

  it("拒绝结构不完整的计划", () => {
    const invalid = { ...makePlan("broken"), priority: "P9" };

    try {
      parseTestPlans(asJson([invalid]));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
      expect((error as PlanValidationError).code).toBe("invalid_shape");
      expect((error as PlanValidationError).issues.join(" ")).toContain("priority");
    }
  });

  it("拒绝重复的计划 id", () => {
    expect(() =>
      parseTestPlans(asJson([makePlan("duplicate"), makePlan("duplicate")])),
    ).toThrowError(/计划 id 重复/);
  });

  it("拒绝重复的步骤 / 断言 id", () => {
    const duplicateSteps = makePlan("dup_steps", {
      steps: [
        {
          id: "s1",
          action: "goto",
          description: "打开页面",
          target: "/login",
          value: null,
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s1",
          action: "click",
          description: "点击按钮",
          target: "button",
          value: null,
          expected: null,
          timeoutMs: null,
        },
      ],
    });

    expect(() => parseTestPlans(asJson([duplicateSteps]))).toThrowError(/步骤 id 重复/);
  });

  it("拒绝不确定或不可验证的断言", () => {
    const vague = makePlan("vague", {
      assertions: [
        {
          id: "a1",
          description: "页面可能看起来正常",
          kind: "assert_visible",
          target: "body",
          expected: "应该没问题",
        },
      ],
    });

    expect(() => parseTestPlans(asJson([vague]))).toThrowError(PlanValidationError);
  });

  it("拒绝缺少目标或输入值的步骤", () => {
    const missingTarget = makePlan("missing_target", {
      steps: [
        {
          id: "s1",
          action: "click",
          description: "点击一个不存在的按钮",
          target: null,
          value: null,
          expected: null,
          timeoutMs: null,
        },
      ],
    });

    expect(() => parseTestPlans(asJson([missingTarget]))).toThrowError(/必须给出 target/);
  });
});
