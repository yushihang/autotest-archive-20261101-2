import { describe, expect, it } from "vitest";

import { generateTestPlans } from "./planner";
import type { PageSnapshot } from "./planner";
import { createMockProvider } from "./provider";
import {
  PlanValidationError,
  type PlanCategory,
  type PlanPriority,
  type TestPlan,
} from "./schema";

const TARGET_URL = "https://example.com/login";

function makePlan(
  id: string,
  overrides: {
    name?: string;
    priority?: PlanPriority;
    category?: PlanCategory;
    steps?: TestPlan["steps"];
    assertions?: TestPlan["assertions"];
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

function providerReturning(plans: unknown[]) {
  return createMockProvider({ content: JSON.stringify({ plans }) });
}

const SNAPSHOT: PageSnapshot = {
  url: TARGET_URL,
  title: "登录",
  text: "请使用邮箱和密码登录。还没有账号？注册。",
  elements: [
    { role: "textbox", name: "邮箱", selector: "input[name=email]", type: "email", required: true },
    { role: "textbox", name: "密码", selector: "input[name=password]", type: "password", required: true },
    { role: "button", name: "登录", selector: "button[type=submit]" },
  ],
  links: ["/register", "/forgot-password"],
};

describe("generateTestPlans", () => {
  it("合法输出：返回校验后的计划并汇报四类覆盖", async () => {
    const provider = providerReturning([
      makePlan("login_happy", {
        name: "使用有效账号登录",
        priority: "P0",
        category: "happy_path",
      }),
      makePlan("login_form_validation", {
        name: "邮箱格式非法时阻止提交",
        category: "form_validation",
      }),
      makePlan("dashboard_empty", {
        name: "没有项目时展示空态",
        category: "empty_state",
      }),
      makePlan("admin_permission", {
        name: "普通用户访问管理页被拒绝",
        category: "permission",
      }),
    ]);

    const result = await generateTestPlans(provider, {
      targetUrl: TARGET_URL,
      snapshot: SNAPSHOT,
    });

    expect(result.plans).toHaveLength(4);
    expect(result.plans.map((plan) => plan.category)).toEqual(
      expect.arrayContaining(["happy_path", "form_validation", "empty_state", "permission"]),
    );
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.covered).toEqual([
      "happy_path",
      "form_validation",
      "empty_state",
      "permission",
    ]);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.model).toBe("mock-model");
    expect(result.truncation.truncated).toBe(false);
  });

  it("非法 JSON：直接拒绝，不返回半成品计划", async () => {
    const provider = createMockProvider({
      content: "抱歉，我无法根据当前快照生成计划。",
    });

    await expect(
      generateTestPlans(provider, { targetUrl: TARGET_URL, snapshot: SNAPSHOT }),
    ).rejects.toBeInstanceOf(PlanValidationError);

    await expect(
      generateTestPlans(provider, { targetUrl: TARGET_URL, snapshot: SNAPSHOT }),
    ).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("结构化但语义不可验证：按非法结构拒绝", async () => {
    const vague = makePlan("vague_assertion", {
      assertions: [
        {
          id: "a1",
          description: "页面应该看起来正常",
          kind: "assert_visible",
          target: "body",
          expected: "可能没问题",
        },
      ],
    });
    const provider = providerReturning([vague]);

    await expect(
      generateTestPlans(provider, { targetUrl: TARGET_URL, snapshot: SNAPSHOT }),
    ).rejects.toMatchObject({ code: "invalid_shape" });
  });

  it("provider timeout：mock 慢响应按 timeout 失败，planner 原样透传", async () => {
    const provider = createMockProvider({ delayMs: 50 });

    await expect(
      generateTestPlans(provider, {
        targetUrl: TARGET_URL,
        snapshot: SNAPSHOT,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("超预算：截断快照并记录截断前后的规模", async () => {
    const provider = providerReturning([makePlan("login_happy")]);
    const hugeSnapshot: PageSnapshot = {
      ...SNAPSHOT,
      text: "登录页面内容。".repeat(4_000),
      elements: Array.from({ length: 40 }, (_, index) => ({
        role: "button",
        name: `按钮 ${index}`,
        selector: `button:nth-child(${index})`,
      })),
      links: Array.from({ length: 40 }, (_, index) => `/link-${index}`),
    };

    const result = await generateTestPlans(provider, {
      targetUrl: TARGET_URL,
      snapshot: hugeSnapshot,
      maxInputTokens: 4_200,
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.notes.length).toBeGreaterThan(0);
    expect(result.truncation.snapshotCharsAfter).toBeLessThan(
      result.truncation.snapshotCharsBefore,
    );
    expect(result.truncation.estimatedTokensAfter).toBeLessThan(
      result.truncation.estimatedTokensBefore,
    );
    // 截断只影响输入，合法输出仍然保留。
    expect(result.plans.map((plan) => plan.id)).toEqual(["login_happy"]);
    expect(result.warnings.join(" ")).toContain("token 预算");
  });

  it("主动丢弃低价值用例：只有导航和等待", async () => {
    const lowValue = makePlan("open_page_only", {
      name: "打开页面并等待",
      steps: [
        {
          id: "s1",
          action: "goto",
          description: "打开登录页",
          target: "/login",
          value: null,
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s2",
          action: "wait",
          description: "等待两秒",
          target: null,
          value: "2000",
          expected: null,
          timeoutMs: null,
        },
      ],
    });
    const meaningful = makePlan("login_happy", { name: "使用有效账号登录" });

    const result = await generateTestPlans(providerReturning([lowValue, meaningful]), {
      targetUrl: TARGET_URL,
      snapshot: SNAPSHOT,
    });

    expect(result.plans.map((plan) => plan.id)).toEqual(["login_happy"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("low_value");
    expect(result.dropped[0]?.detail).toContain("交互");
  });

  it("丢弃与已保留用例重复的计划", async () => {
    const first = makePlan("dup_a", { name: "重复的登录用例" });
    const second = makePlan("dup_b", { name: "重复的登录用例" });

    const result = await generateTestPlans(providerReturning([first, second]), {
      targetUrl: TARGET_URL,
      snapshot: SNAPSHOT,
    });

    expect(result.plans).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("duplicate");
  });

  it("按 exclude 规则丢弃越界用例", async () => {
    const adminPlan = makePlan("admin_plan", {
      name: "直接访问管理页",
      category: "permission",
      steps: [
        {
          id: "s1",
          action: "goto",
          description: "打开管理页",
          target: "/admin",
          value: null,
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s2",
          action: "click",
          description: "点击用户管理入口",
          target: "[data-testid=user-management]",
          value: null,
          expected: null,
          timeoutMs: null,
        },
      ],
    });
    const loginPlan = makePlan("login_plan", { name: "使用有效账号登录" });

    const result = await generateTestPlans(providerReturning([adminPlan, loginPlan]), {
      targetUrl: TARGET_URL,
      snapshot: SNAPSHOT,
      scope: { exclude: ["/admin"] },
    });

    expect(result.plans.map((plan) => plan.id)).toEqual(["login_plan"]);
    expect(result.dropped[0]?.reason).toBe("out_of_scope");
    expect(result.dropped[0]?.detail).toContain("/admin");
  });

  it("超过 maxPlans 时按优先级截断", async () => {
    const plans = [
      makePlan("low", {
        name: "低优先级用例",
        priority: "P2",
        assertions: [
          {
            id: "a1",
            description: "低优先级用例出现结果",
            kind: "assert_text",
            target: "#result",
            expected: "低优先级保存成功",
          },
        ],
      }),
      makePlan("high", {
        name: "高优先级用例",
        priority: "P0",
        assertions: [
          {
            id: "a1",
            description: "高优先级用例出现结果",
            kind: "assert_text",
            target: "#result",
            expected: "高优先级保存成功",
          },
        ],
      }),
      makePlan("middle", {
        name: "中优先级用例",
        priority: "P1",
        assertions: [
          {
            id: "a1",
            description: "中优先级用例出现结果",
            kind: "assert_text",
            target: "#result",
            expected: "中优先级保存成功",
          },
        ],
      }),
    ];

    const result = await generateTestPlans(providerReturning(plans), {
      targetUrl: TARGET_URL,
      snapshot: SNAPSHOT,
      maxPlans: 2,
    });

    expect(result.plans.map((plan) => plan.priority)).toEqual(["P0", "P1"]);
    expect(result.dropped.map((item) => item.reason)).toEqual(["over_limit"]);
    expect(result.dropped[0]?.plan.id).toBe("low");
  });
});
