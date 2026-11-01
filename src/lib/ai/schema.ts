/**
 * AI 规划器的输出契约。
 *
 * 模型返回的是一段 JSON 文本，这里负责把它变成可信的 `TestPlan`：
 * - 结构、枚举、必填字段全部用 zod 校验；
 * - 语义上不可验证的断言（“看起来正常”“可能没问题”）直接判为非法；
 * - 任何非法输出都抛 `PlanValidationError`，绝不猜补全或静默修正。
 *
 * 注意：这里的 `TestPlan` 是“待落库的计划草案”，比领域层的
 * `src/lib/domain/types.ts` 里的 `TestPlan` 多了 category / priority /
 * assertions / rationale，由后续编排层转换成领域对象。
 */

import { z } from "zod";

/** 与领域层 `StepAction` 保持一致，方便后续无损转换。 */
export const STEP_ACTIONS = [
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "assert_text",
  "assert_visible",
  "assert_url",
  "wait",
  "custom",
] as const;

export type PlanStepAction = (typeof STEP_ACTIONS)[number];

/** P0 必测主流程，P1 重要分支，P2 补充覆盖。 */
export const PLAN_PRIORITIES = ["P0", "P1", "P2"] as const;

export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

/**
 * 用例类别。规划器必须尽量覆盖前四类：
 * 主流程、表单校验、空态、权限边界。
 */
export const PLAN_CATEGORIES = [
  "happy_path",
  "form_validation",
  "empty_state",
  "permission",
  "other",
] as const;

export type PlanCategory = (typeof PLAN_CATEGORIES)[number];

export const PLAN_CATEGORY_LABELS: Record<PlanCategory, string> = {
  happy_path: "主流程",
  form_validation: "表单校验",
  empty_state: "空态",
  permission: "权限边界",
  other: "其他",
};

/** 断言只允许这三种可观察行为，避免“验证一下”这类无法执行的要求。 */
export const ASSERTION_KINDS = ["assert_text", "assert_visible", "assert_url"] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

const idSchema = z
  .string()
  .trim()
  .min(1, "id 不能为空")
  .max(64, "id 最长 64 个字符")
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "id 只能包含字母、数字、下划线和连字符");

const selectorSchema = z.string().trim().min(1, "选择器/地址不能为空").max(300);

/** 只有“看起来/可能/应该”这类判断不算可验证的断言。 */
const UNCERTAIN_PATTERN = /(可能|大概|也许|似乎|看起来|应该是|或许|不确定|待确认|视情况|差不多)/;

/** 只写了“正常/成功”而没有可观察结果的断言。 */
const VAGUE_PATTERN =
  /^(正常|正常显示|工作正常|没问题|无异常|成功|已完成|ok|okay|fine|works?|done|pass(ed)?)$/i;

/**
 * 判断一段期望值是否能被机器验证。
 * 这里只做保守判断：命中不确定词或纯空话就视为不可验证。
 */
export function isVerifiableExpectation(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) {
    return false;
  }
  if (VAGUE_PATTERN.test(value)) {
    return false;
  }
  return !UNCERTAIN_PATTERN.test(value);
}

export const TestAssertionSchema = z.object({
  id: idSchema,
  /** 人可读的断言说明，例如“提交空表单后出现邮箱必填提示”。 */
  description: z.string().trim().min(4, "断言说明至少 4 个字符").max(200),
  /** 断言方式，与步骤动作同名，便于执行器直接映射。 */
  kind: z.enum(ASSERTION_KINDS),
  /** 选择器；`assert_url` 可以为 `null`，表示检查当前页面地址。 */
  target: selectorSchema.nullable(),
  /** 期望的可观察结果，例如具体文案、URL 或可见状态。 */
  expected: z.string().trim().min(1, "断言必须有期望结果").max(300),
});

export type TestAssertion = z.infer<typeof TestAssertionSchema>;

export const TestStepSchema = z
  .object({
    id: idSchema,
    action: z.enum(STEP_ACTIONS),
    /** 自然语言描述，报告里直接展示。 */
    description: z.string().trim().min(2, "步骤描述至少 2 个字符").max(200),
    target: selectorSchema.nullable(),
    value: z.string().max(500).nullable(),
    /** 断言类动作的期望结果。 */
    expected: z.string().trim().max(300).nullable(),
    /** 单步超时覆盖，毫秒；`null` 表示使用项目默认值。 */
    timeoutMs: z.number().int().positive().max(600_000).nullable().default(null),
  })
  .superRefine((step, ctx) => {
    const needsTarget = step.action === "goto" || step.action === "click";
    if (needsTarget && !step.target) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: `${step.action} 步骤必须给出 target`,
      });
    }
    if ((step.action === "fill" || step.action === "select") && !step.value) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `${step.action} 步骤必须给出 value`,
      });
    }
    if (step.action.startsWith("assert_") && !step.expected) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "断言步骤必须给出 expected",
      });
    }
  });

export type TestStepPlan = z.infer<typeof TestStepSchema>;

export const TestPlanSchema = z
  .object({
    /** 模型给出的稳定标识，例如 `login_happy_path`。 */
    id: idSchema,
    /** 用例名，中文，一句话说清“测什么”。 */
    name: z.string().trim().min(2, "用例名至少 2 个字符").max(120),
    priority: z.enum(PLAN_PRIORITIES),
    category: z.enum(PLAN_CATEGORIES),
    /** 为什么值得测：业务风险、边界条件或快照里的证据。 */
    rationale: z.string().trim().min(4, "必须说明用例价值").max(400),
    /** 整条用例的期望结果，一句话。 */
    expected: z.string().trim().min(2, "用例必须有整体期望").max(300),
    steps: z.array(TestStepSchema).min(1, "至少一个步骤").max(20),
    assertions: z.array(TestAssertionSchema).min(1, "至少一条可验证断言").max(10),
  })
  .superRefine((plan, ctx) => {
    const stepIds = new Set<string>();
    plan.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `步骤 id 重复：${step.id}`,
        });
      }
      stepIds.add(step.id);
    });

    const assertionIds = new Set<string>();
    plan.assertions.forEach((assertion, index) => {
      if (assertionIds.has(assertion.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "id"],
          message: `断言 id 重复：${assertion.id}`,
        });
      }
      assertionIds.add(assertion.id);

      if (!isVerifiableExpectation(assertion.description)) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "description"],
          message: "断言说明包含不确定措辞，无法验证",
        });
      }
      if (!isVerifiableExpectation(assertion.expected)) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "expected"],
          message: "期望结果过于模糊或不确定，无法验证",
        });
      }
    });

    if (!isVerifiableExpectation(plan.expected)) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "用例整体期望过于模糊或不确定，无法验证",
      });
    }
  });

export type TestPlan = z.infer<typeof TestPlanSchema>;

export const TestPlanListSchema = z
  .object({
    plans: z.array(TestPlanSchema).min(1, "至少返回一条计划").max(20, "一次最多返回 20 条计划"),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.plans.forEach((plan, index) => {
      if (seen.has(plan.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", index, "id"],
          message: `计划 id 重复：${plan.id}`,
        });
      }
      seen.add(plan.id);
    });
  });

export type TestPlanList = z.infer<typeof TestPlanListSchema>;

export type PlanValidationCode = "invalid_json" | "invalid_shape";

/** 模型输出不合法时抛出；调用方据此记录失败原因，不能自行补全。 */
export class PlanValidationError extends Error {
  readonly code: PlanValidationCode;
  readonly issues: string[];

  constructor(code: PlanValidationCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "PlanValidationError";
    this.code = code;
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/** 去掉 Markdown 代码围栏；围栏只是包装，不是内容。 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/;
  const match = fence.exec(text);
  return match?.[1]?.trim() ?? text;
}

/** 只截取最外层的 JSON 对象/数组，容忍模型在前后加一句人话。 */
function extractJson(text: string): string {
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }
  return text;
}

/**
 * 解析并校验模型输出。
 *
 * 接受 `{"plans":[...]}` 或裸数组 `[...]`；其余形式一律拒绝。
 * 不做字段猜测、不补默认计划、不丢弃单条非法计划。
 */
export function parseTestPlans(raw: string): TestPlan[] {
  const trimmed = stripCodeFence(raw);
  if (trimmed.length === 0) {
    throw new PlanValidationError("invalid_json", "模型返回为空，无法解析测试计划");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = JSON.parse(extractJson(trimmed));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PlanValidationError("invalid_json", `模型输出不是合法 JSON：${detail}`);
    }
  }

  const candidate = Array.isArray(parsed) ? { plans: parsed } : parsed;
  const result = TestPlanListSchema.safeParse(candidate);
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new PlanValidationError(
      "invalid_shape",
      `模型输出不符合测试计划结构：${issues.slice(0, 5).join("; ")}`,
      issues,
    );
  }

  return result.data.plans;
}
