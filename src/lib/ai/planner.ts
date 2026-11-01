/**
 * 页面快照 → 结构化测试计划。
 *
 * 这是编排链路的第一步：输入探针快照、目标 URL 和范围规则，输出经过 zod
 * 校验的 `TestPlan[]`。规划器本身不做“聪明”的补全：
 * - 模型输出非法 → 直接抛错，由上层记录失败；
 * - 输出合法但低价值 → 按确定性规则丢弃，并记录原因；
 * - 快照超过 token 预算 → 截断并记录原始/截断后大小，提示词里明确告知模型。
 */

import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "./prompts";
import {
  PLAN_CATEGORIES,
  PLAN_CATEGORY_LABELS,
  parseTestPlans,
  type PlanCategory,
  type PlanPriority,
  type TestPlan,
} from "./schema";
import {
  estimateTokens,
  type AiProvider,
  type ChatMessage,
  type TokenUsage,
} from "./provider";

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 探针抓到的可交互元素摘要。字段保持可选，方便探针逐步补全。 */
export interface SnapshotElement {
  role?: string | null;
  name?: string | null;
  selector?: string | null;
  type?: string | null;
  required?: boolean | null;
  disabled?: boolean | null;
  [key: string]: unknown;
}

/** 页面探针快照。未知字段会原样带给模型，避免丢信息。 */
export interface PageSnapshot {
  url: string;
  title?: string | null;
  /** 页面上可见的正文（已做适度清洗）。 */
  text?: string | null;
  elements?: SnapshotElement[];
  links?: string[];
  [key: string]: unknown;
}

/**
 * 范围规则，按“用例入口页”匹配：
 * - 空数组表示不限制；
 * - 支持 `*` 通配，例如 `/settings/*`；
 * - 排除优先于包含。
 */
export interface PlanScope {
  include?: string[];
  exclude?: string[];
}

export interface PlanGenerationRequest {
  /** 被测页面地址；也是提示词里的目标 URL。 */
  targetUrl: string;
  snapshot: PageSnapshot;
  scope?: PlanScope;
  /** 覆盖 planner 默认值。 */
  maxPlans?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface PlannerOptions {
  /** 最多保留多少条用例，默认 8。 */
  maxPlans?: number;
  /** 单次请求的输入 token 预算（含系统提示词），默认 6000。 */
  maxInputTokens?: number;
  /** 期望的最大输出 token，默认 4000。 */
  maxOutputTokens?: number;
  /** 单次模型调用超时，默认交给 provider。 */
  timeoutMs?: number;
  temperature?: number;
}

export interface SnapshotTruncation {
  truncated: boolean;
  maxInputTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  snapshotCharsBefore: number;
  snapshotCharsAfter: number;
  /** 人可读的截断记录，直接进报告/日志。 */
  notes: string[];
}

export type PlanDropReason = "low_value" | "duplicate" | "out_of_scope" | "over_limit";

export interface DroppedPlan {
  plan: TestPlan;
  reason: PlanDropReason;
  detail: string;
}

export interface CoverageReport {
  /** 规划器要求覆盖的核心类别。 */
  required: PlanCategory[];
  covered: PlanCategory[];
  missing: PlanCategory[];
}

export interface PlanGenerationResult {
  plans: TestPlan[];
  coverage: CoverageReport;
  /** 被主动丢弃的用例及原因，便于解释“为什么少了”。 */
  dropped: DroppedPlan[];
  truncation: SnapshotTruncation;
  usage: TokenUsage;
  model: string;
  warnings: string[];
}

export interface TestPlanner {
  generate(request: PlanGenerationRequest): Promise<PlanGenerationResult>;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PLANS = 8;
const DEFAULT_MAX_INPUT_TOKENS = 6_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

/** 核心覆盖类别；`other` 只是兜底，不计入“必须覆盖”。 */
const REQUIRED_CATEGORIES: PlanCategory[] = [
  "happy_path",
  "form_validation",
  "empty_state",
  "permission",
];

const PRIORITY_RANK: Record<PlanPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

const CATEGORY_RANK: Record<PlanCategory, number> = {
  happy_path: 0,
  form_validation: 1,
  empty_state: 2,
  permission: 3,
  other: 4,
};

const TRUNCATION_MARKER = "\n…（中间内容已按 token 预算截断）…\n";

/** 只描述“打开页面”的用例名，没有可验证行为。 */
const GENERIC_PLAN_NAME =
  /^(打开|访问|进入|查看)(一下)?(首页|页面|网站)?$|^(页面|首页)(可以|能)?(正常)?(打开|访问|显示)$/;

// ---------------------------------------------------------------------------
// 快照处理
// ---------------------------------------------------------------------------

function cloneSnapshot(snapshot: PageSnapshot): PageSnapshot {
  return {
    ...snapshot,
    url: snapshot.url,
    title: snapshot.title ?? null,
    text: snapshot.text ?? "",
    elements: (snapshot.elements ?? []).map((element) => ({ ...element })),
    links: [...(snapshot.links ?? [])],
  };
}

function serializeSnapshot(snapshot: PageSnapshot): string {
  return JSON.stringify(snapshot);
}

/** 保留开头和结尾，中间用固定标记代替；预算按“字符≈token”保守估算。 */
function keepHeadAndTail(text: string, charBudget: number): string {
  if (charBudget <= 0) {
    return "";
  }
  if (text.length <= charBudget) {
    return text;
  }
  const usable = charBudget - TRUNCATION_MARKER.length;
  if (usable <= 1) {
    return text.slice(0, Math.max(0, charBudget));
  }
  const head = Math.ceil(usable * 0.6);
  const tail = Math.floor(usable * 0.4);
  const tailText = tail > 0 ? text.slice(-tail) : "";
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${tailText}`;
}

interface FittedSnapshot {
  snapshotJson: string;
  prompt: string;
  truncation: SnapshotTruncation;
}

interface FitInput {
  snapshot: PageSnapshot;
  targetUrl: string;
  include: string[];
  exclude: string[];
  maxPlans: number;
  maxInputTokens: number;
}

/**
 * 在输入预算内压缩快照。
 *
 * 顺序：正文 → 元素/链接 → 清空可选内容。每一步都重新估算整条 user prompt，
 * 因此系统提示词本身占用的 token 也被计入预算。
 */
function fitSnapshot(input: FitInput): FittedSnapshot {
  const original = cloneSnapshot(input.snapshot);
  const originalJson = serializeSnapshot(original);
  const snapshotCharsBefore = originalJson.length;

  const render = (snapshot: PageSnapshot, truncated: boolean) => {
    const snapshotJson = serializeSnapshot(snapshot);
    const prompt = buildPlannerUserPrompt({
      targetUrl: input.targetUrl,
      snapshotJson,
      include: input.include,
      exclude: input.exclude,
      maxPlans: input.maxPlans,
      truncated,
    });
    return { snapshotJson, prompt };
  };

  // 预算必须覆盖 system + user 两条消息，否则实际请求会悄悄超出上限。
  const systemTokens = estimateTokens(PLANNER_SYSTEM_PROMPT);
  const estimatePromptTokens = (userPrompt: string): number =>
    systemTokens + estimateTokens(userPrompt) + 4;

  const initial = render(original, false);
  const estimatedTokensBefore = estimatePromptTokens(initial.prompt);

  if (estimatedTokensBefore <= input.maxInputTokens) {
    return {
      snapshotJson: initial.snapshotJson,
      prompt: initial.prompt,
      truncation: {
        truncated: false,
        maxInputTokens: input.maxInputTokens,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        snapshotCharsBefore,
        snapshotCharsAfter: initial.snapshotJson.length,
        notes: [],
      },
    };
  }

  const notes: string[] = [
    `快照约 ${estimatedTokensBefore} tokens，超过输入上限 ${input.maxInputTokens}，已截断`,
  ];
  const current = cloneSnapshot(input.snapshot);
  const currentText = current.text ?? "";
  const currentElements = current.elements ?? [];
  const currentLinks = current.links ?? [];

  // 先算出除快照外的固定开销（系统提示词、范围规则、输出要求）。
  const overhead = estimatePromptTokens(
    buildPlannerUserPrompt({
      targetUrl: input.targetUrl,
      snapshotJson: "{}",
      include: input.include,
      exclude: input.exclude,
      maxPlans: input.maxPlans,
      truncated: true,
    }),
  );
  let snapshotBudget = Math.max(0, input.maxInputTokens - overhead - 16);

  if (currentText.length > 0) {
    const charBudget = Math.max(0, snapshotBudget - 64);
    const kept = keepHeadAndTail(currentText, charBudget);
    if (kept.length < currentText.length) {
      notes.push("正文保留开头与结尾，中间内容已省略");
    }
    current.text = kept;
  }

  let rendered = render(current, true);

  // 元素和链接通常比正文次要，按半数递减直到进入预算。
  let shrinkRounds = 0;
  while (
    estimatePromptTokens(rendered.prompt) > input.maxInputTokens &&
    ((current.elements?.length ?? 0) > 0 || (current.links?.length ?? 0) > 0)
  ) {
    shrinkRounds += 1;
    const elements = current.elements ?? [];
    const links = current.links ?? [];
    if (elements.length > 0) {
      current.elements = elements.slice(0, Math.floor(elements.length / 2));
    }
    if (links.length > 0) {
      current.links = links.slice(0, Math.floor(links.length / 2));
    }
    // 元素过多时也同步压缩正文，避免只有元素在让位。
    snapshotBudget = Math.max(0, Math.floor(snapshotBudget * 0.8));
    const text = current.text ?? "";
    if (text.length > snapshotBudget) {
      current.text = keepHeadAndTail(text, Math.max(0, snapshotBudget - 64));
    }
    rendered = render(current, true);
    if (shrinkRounds > 24) {
      break;
    }
  }
  if (shrinkRounds > 0) {
    notes.push(
      `可交互元素按预算缩减（${currentElements.length} → ${current.elements?.length ?? 0}），` +
        `链接（${currentLinks.length} → ${current.links?.length ?? 0}）`,
    );
  }

  // 仍然超预算：继续砍正文。
  let textRounds = 0;
  while (
    estimatePromptTokens(rendered.prompt) > input.maxInputTokens &&
    (current.text?.length ?? 0) > 0
  ) {
    const text = current.text ?? "";
    current.text = keepHeadAndTail(text, Math.max(0, Math.floor(text.length / 2)));
    rendered = render(current, true);
    textRounds += 1;
    if (textRounds > 24) {
      break;
    }
  }
  if (textRounds > 0) {
    notes.push("正文继续按半数压缩以进入 token 预算");
  }

  // 最后清空可选内容，只保留 URL/title。
  if (estimatePromptTokens(rendered.prompt) > input.maxInputTokens) {
    current.text = "";
    current.elements = [];
    current.links = [];
    rendered = render(current, true);
    notes.push("已清空正文、元素和链接，仅保留页面基本信息");
  }

  const estimatedTokensAfter = estimatePromptTokens(rendered.prompt);
  if (estimatedTokensAfter > input.maxInputTokens) {
    notes.push("即使清空快照仍未进入预算：系统提示词本身已接近或超过上限");
  }

  return {
    snapshotJson: rendered.snapshotJson,
    prompt: rendered.prompt,
    truncation: {
      truncated: true,
      maxInputTokens: input.maxInputTokens,
      estimatedTokensBefore,
      estimatedTokensAfter,
      snapshotCharsBefore,
      snapshotCharsAfter: rendered.snapshotJson.length,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// 范围 / 低价值 / 重复
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\*/g, ".*")}$`);
}

function pathOf(target: string): string {
  const value = target.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }
  const queryIndex = value.search(/[?#]/);
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function matchesAny(patterns: string[], target: string): boolean {
  const path = pathOf(target);
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) {
      return false;
    }
    const regex = globToRegExp(trimmed);
    return regex.test(target) || regex.test(path);
  });
}

/** 用首个 `goto` 作为用例入口；没有 `goto` 时用请求的目标 URL。 */
function entryTarget(plan: TestPlan, fallback: string): string {
  const goto = plan.steps.find((step) => step.action === "goto" && step.target);
  return goto?.target ?? fallback;
}

function scopeViolation(
  plan: TestPlan,
  scope: PlanScope,
  targetUrl: string,
): string | null {
  const include = (scope.include ?? []).filter((item) => item.trim().length > 0);
  const exclude = (scope.exclude ?? []).filter((item) => item.trim().length > 0);
  if (include.length === 0 && exclude.length === 0) {
    return null;
  }

  const entry = entryTarget(plan, targetUrl);
  if (exclude.length > 0 && matchesAny(exclude, entry)) {
    return `入口 ${entry} 命中排除规则`;
  }
  if (include.length > 0 && !matchesAny(include, entry)) {
    return `入口 ${entry} 不在 include 范围内`;
  }
  return null;
}

function lowValueReason(plan: TestPlan): string | null {
  if (GENERIC_PLAN_NAME.test(plan.name.trim())) {
    return "用例名只描述打开页面，没有可验证的行为";
  }

  const meaningfulSteps = plan.steps.filter((step) =>
    [
      "click",
      "fill",
      "select",
      "press",
      "assert_text",
      "assert_visible",
      "assert_url",
    ].includes(step.action),
  );
  if (meaningfulSteps.length === 0) {
    return "步骤只有导航或等待，没有交互与断言";
  }

  return null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_/，。,:：;；!！?？"'()（）]/g, "");
}

interface PlanSignatures {
  byName: string;
  byBehavior: string;
}

function signaturesOf(plan: TestPlan): PlanSignatures {
  const stepSequence = plan.steps
    .map((step) => `${step.action}:${step.target ?? ""}:${step.value ?? ""}:${step.expected ?? ""}`)
    .join(">");
  const assertionSequence = plan.assertions
    .map((assertion) => `${assertion.kind}:${assertion.target ?? ""}:${assertion.expected}`)
    .join(">");
  return {
    byName: `${plan.category}::${normalizeName(plan.name)}`,
    byBehavior: `${plan.category}::${stepSequence}::${assertionSequence}`,
  };
}

function comparePlans(a: TestPlan, b: TestPlan): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) {
    return priority;
  }
  const category = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
  if (category !== 0) {
    return category;
  }
  return a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function resolveLimit(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

/**
 * 创建规划器。
 *
 * provider 可以来自 `createProviderFromEnv()`，也可以在测试里注入 mock。
 */
export function createTestPlanner(
  provider: AiProvider,
  options: PlannerOptions = {},
): TestPlanner {
  return {
    async generate(request: PlanGenerationRequest): Promise<PlanGenerationResult> {
      const targetUrl = request.targetUrl?.trim() ?? "";
      if (targetUrl.length === 0) {
        throw new TypeError("planGeneration.targetUrl 不能为空");
      }

      const maxPlans = resolveLimit(
        request.maxPlans ?? options.maxPlans,
        DEFAULT_MAX_PLANS,
        1,
      );
      const maxInputTokens = resolveLimit(
        request.maxInputTokens ?? options.maxInputTokens,
        DEFAULT_MAX_INPUT_TOKENS,
        1,
      );
      const maxOutputTokens = resolveLimit(
        request.maxOutputTokens ?? options.maxOutputTokens,
        DEFAULT_MAX_OUTPUT_TOKENS,
        1,
      );
      const scope: PlanScope = {
        include: request.scope?.include ?? [],
        exclude: request.scope?.exclude ?? [],
      };

      const fitted = fitSnapshot({
        snapshot: request.snapshot,
        targetUrl,
        include: scope.include ?? [],
        exclude: scope.exclude ?? [],
        maxPlans,
        maxInputTokens,
      });

      const messages: ChatMessage[] = [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        { role: "user", content: fitted.prompt },
      ];

      const completion = await provider.complete({
        messages,
        maxOutputTokens,
        timeoutMs: request.timeoutMs ?? options.timeoutMs,
        temperature: options.temperature,
      });

      const parsed = parseTestPlans(completion.content);
      const ordered = [...parsed].sort(comparePlans);

      const dropped: DroppedPlan[] = [];
      const kept: TestPlan[] = [];
      const seenNames = new Set<string>();
      const seenBehavior = new Set<string>();

      for (const plan of ordered) {
        const lowValue = lowValueReason(plan);
        if (lowValue) {
          dropped.push({ plan, reason: "low_value", detail: lowValue });
          continue;
        }

        const scopeDetail = scopeViolation(plan, scope, targetUrl);
        if (scopeDetail) {
          dropped.push({ plan, reason: "out_of_scope", detail: scopeDetail });
          continue;
        }

        const signatures = signaturesOf(plan);
        if (seenNames.has(signatures.byName) || seenBehavior.has(signatures.byBehavior)) {
          dropped.push({
            plan,
            reason: "duplicate",
            detail: "与已保留用例的名称或步骤序列重复",
          });
          continue;
        }

        if (kept.length >= maxPlans) {
          dropped.push({
            plan,
            reason: "over_limit",
            detail: `超过 maxPlans=${maxPlans}，按优先级丢弃`,
          });
          continue;
        }

        seenNames.add(signatures.byName);
        seenBehavior.add(signatures.byBehavior);
        kept.push(plan);
      }

      const covered = PLAN_CATEGORIES.filter((category) =>
        kept.some((plan) => plan.category === category),
      );
      const missing = REQUIRED_CATEGORIES.filter(
        (category) => !covered.includes(category),
      );

      const warnings: string[] = [];
      if (missing.length > 0) {
        warnings.push(
          `未覆盖核心场景：${missing.map((category) => PLAN_CATEGORY_LABELS[category]).join("、")}` +
            "；通常表示快照中缺少对应入口，不要凭空补用例",
        );
      }
      if (fitted.truncation.truncated) {
        warnings.push(
          `输入超 token 预算（${fitted.truncation.estimatedTokensBefore} → ` +
            `${fitted.truncation.estimatedTokensAfter}），快照已截断`,
        );
      }
      if (kept.length === 0) {
        warnings.push("没有留下任何可执行用例：请检查快照质量、范围规则或模型输出");
      }

      return {
        plans: kept,
        coverage: {
          required: [...REQUIRED_CATEGORIES],
          covered,
          missing,
        },
        dropped,
        truncation: fitted.truncation,
        usage: completion.usage,
        model: completion.model,
        warnings,
      };
    },
  };
}

/** 一次性调用的便捷封装。 */
export function generateTestPlans(
  provider: AiProvider,
  request: PlanGenerationRequest,
  options: PlannerOptions = {},
): Promise<PlanGenerationResult> {
  return createTestPlanner(provider, options).generate(request);
}
