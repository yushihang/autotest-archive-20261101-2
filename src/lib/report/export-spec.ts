/**
 * 把一次 run 里**通过**的用例导出成可直接提交的 Playwright spec 文本。
 *
 * 三条硬要求体现在生成物里：
 * - 稳定选择器：优先 `data-testid`，其次是 role / label / 文本；拿到类名这类脆弱选择器时
 *   会在生成的代码里留一行提示，提醒改成 `data-testid`。
 * - 显式等待：不写 `waitForTimeout`（`wait` 步骤除外），一律用 `expect(...).toBeVisible()`
 *   这种可重试断言，避免「机器快慢决定红绿」。
 * - 固定种子：`{{random}}` / `{{email}}` / `{{seed}}` 占位符由 `FIXED_SEED` 确定性地展开，
 *   同一份 spec 每次运行拿到的数据完全一致。
 *
 * 纯函数：不读写文件、不发网络请求、不读时钟；时间信息只能通过 `run.finishedAt` 传入。
 */

import type { CaseResult, Project, Run, TestPlan, TestStep } from "@/lib/domain";

/** 导出时的默认种子。改这个数字会让所有占位数据整体变化。 */
export const DEFAULT_EXPORT_SEED = 20261101;

/** 生成代码里显式等待的默认超时。 */
export const DEFAULT_STEP_TIMEOUT_MS = 15000;

export interface ExportSpecOptions {
  /** 固定种子，默认 {@link DEFAULT_EXPORT_SEED}。 */
  seed?: number;
  /** 显式等待超时，默认 {@link DEFAULT_STEP_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

export interface ExportSpecInput {
  /** 用例来源的计划快照：提供选择器、输入值与期望。 */
  plan: TestPlan;
  /** 只导出 `status === "passed"` 的用例，其余忽略。 */
  cases: CaseResult[];
  /** 被测项目；用于填 `BASE_URL` 与文件头信息。 */
  project?: Pick<Project, "name" | "baseUrl"> | null;
  /** 来源 run；只取 id 与结束时间，用于溯源。 */
  run?: Pick<Run, "id" | "finishedAt"> | null;
  options?: ExportSpecOptions;
}

interface RenderContext {
  seed: number;
  timeoutMs: number;
  baseUrl: string;
  /** 占位符序号，保证每个取值不同但可复现。 */
  seedCursor: number;
  /** 是否用过占位符；用过才需要生成种子辅助函数。 */
  usedSeed: boolean;
}

/** 生成一份 Playwright spec 文本。 */
export function exportSpec(input: ExportSpecInput): string {
  const { plan, cases } = input;
  const options = input.options ?? {};
  const context: RenderContext = {
    seed: options.seed ?? DEFAULT_EXPORT_SEED,
    timeoutMs: options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    baseUrl: plan.baseUrl ?? input.project?.baseUrl ?? "http://localhost:3000",
    seedCursor: 0,
    usedSeed: false,
  };

  const exported = cases.filter((caseResult) => caseResult.status === "passed");
  const planSteps = new Map<string, TestStep>(
    plan.steps.map((step) => [step.id, step] as const),
  );

  const body: string[] = [];
  for (const caseResult of exported) {
    body.push(...renderCase(caseResult, planSteps, context));
    body.push("");
  }

  const header = renderHeader(input, exported.length, cases.length);
  const prelude: string[] = [`import { expect, test } from "@playwright/test";`, ""];

  prelude.push(`const BASE_URL = ${quote(context.baseUrl)};`);
  prelude.push(`const STEP_TIMEOUT_MS = ${context.timeoutMs};`);
  if (context.usedSeed) {
    prelude.push("");
    prelude.push("/** 固定种子：同一份 spec 每次运行都会得到同一组测试数据。 */");
    prelude.push(`const FIXED_SEED = ${context.seed};`);
    prelude.push("");
    prelude.push("/** 按下标派生确定性字符串；请不要在导出的 spec 里用 Math.random()。 */");
    prelude.push("function seeded(index: number): string {");
    prelude.push("  let hash = Math.imul(FIXED_SEED ^ (index * 0x9e3779b1), 0x85ebca6b) >>> 0;");
    prelude.push("  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;");
    prelude.push('  return ((hash ^ (hash >>> 16)) >>> 0).toString(36).padStart(7, "0");');
    prelude.push("}");
  }
  prelude.push("");

  const describeTitle = plan.title.trim() === "" ? "导出的用例" : plan.title;
  const lines: string[] = [
    ...header,
    ...prelude,
    `test.describe(${quote(describeTitle)}, () => {`,
    "  test.use({ actionTimeout: STEP_TIMEOUT_MS });",
    "",
  ];

  if (body.length === 0) {
    lines.push("  // 本次 run 没有通过（passed）的用例，未生成 test。");
  } else {
    lines.push(...body);
  }

  lines.push("});");
  lines.push("");
  lines.push("export {};");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 文件头
// ---------------------------------------------------------------------------

function renderHeader(input: ExportSpecInput, exportedCount: number, total: number): string[] {
  const { plan, project, run } = input;
  const header = [
    "/**",
    " * 由 autotest 自动导出，请勿手工修改后当作模板。",
    ` * 计划：${plan.title}（${plan.id}）`,
  ];

  if (project) header.push(` * 项目：${project.name}`);
  if (run) header.push(` * 来源 run：${run.id}`);
  if (run?.finishedAt) header.push(` * run 结束时间：${run.finishedAt}`);
  header.push(` * 导出用例：${exportedCount} / ${total}（只包含通过用例）`);
  header.push(" *");
  header.push(" * 选择器：优先 data-testid / role / label；显式等待：用 expect 断言自动重试；");
  header.push(" * 数据：占位符按 FIXED_SEED 确定性展开，重跑结果一致。");
  header.push(" */");

  return header;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

function renderCase(
  caseResult: CaseResult,
  planSteps: Map<string, TestStep>,
  context: RenderContext,
): string[] {
  const lines: string[] = [];
  const steps = [...caseResult.steps].sort((left, right) => left.order - right.order);

  lines.push(`  test(${quote(caseResult.title)}, async ({ page }) => {`);
  lines.push(`    // 用例 ${caseResult.caseId}，共 ${steps.length} 步`);

  if (steps.length === 0) {
    lines.push("    // 没有可导出的步骤，请检查计划快照是否完整。");
    lines.push("  });");
    return lines;
  }

  if (steps[0]?.action !== "goto") {
    lines.push("    // 计划没有以 goto 开头，从项目入口开始");
    lines.push("    await page.goto(BASE_URL);");
  }

  let locatorIndex = 0;

  for (const step of steps) {
    const planStep = planSteps.get(step.stepId) ?? null;
    if (planStep === null) {
      lines.push(`    // TODO: 计划里找不到步骤 ${step.stepId}（${step.description}），需要手工补全`);
      continue;
    }

    const description = planStep.description.replace(/\s+/g, " ").trim();
    lines.push("");
    lines.push(`    // ${step.order + 1}. ${description}`);

    if (planStep.action === "goto") {
      lines.push(`    await page.goto(${urlExpression(planStep.target, context)});`);
      continue;
    }

    if (planStep.action === "wait") {
      lines.push(...renderWait(planStep));
      continue;
    }

    if (planStep.action === "custom") {
      lines.push("    // TODO: 自定义步骤需要人工补全");
      continue;
    }

    const selector = planStep.target;
    if (selector === null || selector.trim() === "") {
      lines.push(`    // TODO: 步骤「${description}」没有选择器，无法生成代码`);
      continue;
    }

    locatorIndex += 1;
    const locator = locatorExpression(selector);
    const variable = `el${locatorIndex}`;

    if (!locator.stable) {
      lines.push(`    // 注意：选择器 ${quote(selector)} 可能不稳定，建议给元素补 data-testid`);
    }

    lines.push(`    const ${variable} = ${locator.code};`);

    switch (planStep.action) {
      case "click":
        lines.push(`    await expect(${variable}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`);
        lines.push(`    await ${variable}.click();`);
        break;
      case "fill":
        lines.push(`    await expect(${variable}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`);
        lines.push(`    await ${variable}.fill(${valueExpression(planStep.value, context)});`);
        break;
      case "press":
        lines.push(`    await expect(${variable}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`);
        lines.push(`    await ${variable}.press(${valueExpression(planStep.value, context)});`);
        break;
      case "select":
        lines.push(`    await expect(${variable}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`);
        lines.push(`    await ${variable}.selectOption(${valueExpression(planStep.value, context)});`);
        break;
      case "assert_text":
        lines.push(
          `    await expect(${variable}).toContainText(${valueExpression(
            planStep.expected ?? planStep.value,
            context,
          )}, { timeout: STEP_TIMEOUT_MS });`,
        );
        break;
      case "assert_visible":
        lines.push(`    await expect(${variable}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`);
        break;
      case "assert_url":
        lines.push(
          `    await expect(page).toHaveURL(${urlExpression(
            planStep.expected ?? planStep.target,
            context,
          )}, { timeout: STEP_TIMEOUT_MS });`,
        );
        break;
      default:
        lines.push(`    // TODO: 暂不支持的动作 ${String(planStep.action)}`);
        break;
    }
  }

  lines.push("  });");
  return lines;
}

function renderWait(step: TestStep): string[] {
  const target = step.target ?? "";

  if (/^\d+$/.test(target.trim())) {
    return [
      `    // 计划里的显式等待；能观测到条件时请改成 expect(...).toBeVisible()`,
      `    await page.waitForTimeout(${Number(target.trim())});`,
    ];
  }

  if (target.trim() === "") {
    return ["    // TODO: wait 步骤没有目标，无法生成"];
  }

  const locator = locatorExpression(target);
  return [
    `    await expect(${locator.code}).toBeVisible({ timeout: STEP_TIMEOUT_MS });`,
  ];
}

// ---------------------------------------------------------------------------
// 选择器
// ---------------------------------------------------------------------------

interface LocatorExpression {
  code: string;
  /** 选择器是否稳定（data-testid / role / label / 语义 id）。 */
  stable: boolean;
}

/**
 * 把计划里的选择器翻译成 Playwright 的定位器。
 *
 * 只做有把握的映射，其余原样交给 `page.locator()` 并标记为不稳定，
 * 免得为了「好看」生成一个语义不同、跑起来却失败的定位器。
 */
export function locatorExpression(selector: string): LocatorExpression {
  const value = selector.trim();

  const testId = /^\[\s*data-(?:testid|test-id|test|qa)\s*=\s*["']?([^"'\]]+)["']?\s*\]$/i.exec(value)?.[1]?.trim();
  if (testId) {
    return { code: `page.getByTestId(${quote(testId)})`, stable: true };
  }

  const label = /^\[\s*aria-label\s*=\s*["']?(.+?)["']?\s*\]$/i.exec(value)?.[1]?.trim();
  if (label) {
    return { code: `page.getByLabel(${quote(label)})`, stable: true };
  }

  const role = /^(?:role=)?([a-z]+)\[name=["'](.+?)["']\]$/i.exec(value);
  const roleName = role?.[1]?.toLowerCase();
  const roleLabel = role?.[2]?.trim();
  if (roleName && roleLabel) {
    return {
      code: `page.getByRole(${quote(roleName)}, { name: ${quote(roleLabel)} })`,
      stable: true,
    };
  }

  const hasText = /^(button|a|link)\s*:\s*has-text\(\s*["'](.+?)["']\s*\)$/i.exec(value);
  const tagName = hasText?.[1]?.toLowerCase();
  const textName = hasText?.[2]?.trim();
  if (tagName && textName) {
    const buttonRole = tagName === "a" || tagName === "link" ? "link" : "button";
    return {
      code: `page.getByRole(${quote(buttonRole)}, { name: ${quote(textName)} })`,
      stable: true,
    };
  }

  if (value.startsWith("text=")) {
    return {
      code: `page.getByText(${quote(value.slice("text=".length).trim())})`,
      stable: true,
    };
  }

  const id = /^#([A-Za-z_][\w-]*)$/.exec(value)?.[1];
  if (id) {
    return { code: `page.locator(${quote(value)})`, stable: !looksGenerated(id) };
  }

  return { code: `page.locator(${quote(value)})`, stable: false };
}

/** 形如 `input-3f2a9c` 的 id 多半是构建产物，下次部署就变了。 */
function looksGenerated(id: string): boolean {
  return /[0-9a-f]{6,}/i.test(id) || /^\d/.test(id);
}

// ---------------------------------------------------------------------------
// 值 / URL / 固定种子
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*(seed|random|uuid|email)\s*\}\}/gi;

/**
 * 渲染输入值。占位符绑定到 `FIXED_SEED`，运行时按固定序列取值，
 * 不会出现 `Math.random()` 那种「这次能过、下次不能过」。
 */
function valueExpression(value: string | null, context: RenderContext): string {
  if (value === null) return quote("");

  const parts: string[] = [];
  let lastIndex = 0;
  let matched = false;

  PLACEHOLDER.lastIndex = 0;
  let match = PLACEHOLDER.exec(value);
  while (match !== null) {
    matched = true;
    const literal = value.slice(lastIndex, match.index);
    if (literal !== "") parts.push(escapeTemplate(literal));
    parts.push(`\${${placeholderValue((match[1] ?? "").toLowerCase(), context)}}`);
    lastIndex = match.index + match[0].length;
    match = PLACEHOLDER.exec(value);
  }

  if (!matched) return quote(value);

  const tail = value.slice(lastIndex);
  if (tail !== "") parts.push(escapeTemplate(tail));

  return `\`${parts.join("")}\``;
}

function placeholderValue(kind: string, context: RenderContext): string {
  context.usedSeed = true;

  if (kind === "seed") return "String(FIXED_SEED)";

  context.seedCursor += 1;
  const call = `seeded(${context.seedCursor})`;
  if (kind === "email") return `${call} + "@example.com"`;
  return call;
}

/** 把地址渲染成 `BASE_URL + "/path"` 或字面量。 */
function urlExpression(target: string | null, context: RenderContext): string {
  const value = (target ?? "").trim();
  if (value === "") return "BASE_URL";
  if (/^https?:\/\//i.test(value)) return quote(value);

  const path = value.startsWith("/") ? value : `/${value}`;
  return `BASE_URL + ${quote(path)}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function escapeTemplate(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
