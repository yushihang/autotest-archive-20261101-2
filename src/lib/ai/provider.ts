/**
 * 模型提供方适配层。
 *
 * 生产路径走 OpenAI 兼容的 `/chat/completions` HTTP 接口：
 * - baseURL / apiKey / model 全部来自环境变量（`.env.example` 已列出）；
 * - 每次请求有超时，失败按指数退避重试；
 * - 返回 token 用量，供预算控制与成本统计使用。
 *
 * 离线开发或单测时设置 `AI_PROVIDER=mock`，走确定性 mock：
 * 同样的输入永远得到同样的输出，不需要网络和密钥。
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** 本次请求的总超时，毫秒；不传则用 provider 默认值。 */
  timeoutMs?: number;
  /** 期望的最大输出 token 数。 */
  maxOutputTokens?: number;
  temperature?: number;
  /** 调用方取消信号（例如用户关掉页面）。 */
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 接口没有返回 usage 时，用字符数估算，标记为 true。 */
  estimated: boolean;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  /** 实际发起的 HTTP 尝试次数（含首次）。 */
  attempts: number;
}

export interface AiProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type AiErrorKind =
  | "config"
  | "timeout"
  | "network"
  | "rate_limit"
  | "http"
  | "invalid_response"
  | "cancelled";

export interface AiProviderErrorOptions {
  kind: AiErrorKind;
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}

/** 模型调用失败。`kind` 用于上游归类（报告里的 failure kind、重试策略）。 */
export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: AiProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * 粗略估算 token 数：CJK 字符按 1 token，其他字符按 4 字符 1 token。
 * 只用于预算保护，不追求与具体 tokenizer 完全一致。
 */
const CJK_PATTERN = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type { FetchLike };

export interface ProviderEnvOptions {
  /** 测试注入用；默认使用全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 测试注入用，避免真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenAiProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** 测试注入用；默认使用全局 fetch。 */
  fetchImpl?: FetchLike;
  /** 重试基础等待，毫秒；实际等待按 2 的幂次增长。 */
  retryDelayMs?: number;
  /** 测试注入用，避免真的等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 网关不支持 JSON mode 时关掉。 */
  jsonMode?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function extractContent(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  // 部分兼容网关会返回 [{ type: "text", text: "..." }]。
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!isRecord(part)) {
          return null;
        }
        if (typeof part.text === "string") {
          return part.text;
        }
        return null;
      })
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

function bodySnippet(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

/**
 * 创建 OpenAI 兼容 provider。
 *
 * 重试只发生在可恢复错误上：超时、网络错误、429、5xx。
 * 4xx（除 408/429）和响应结构错误直接失败，避免无意义地重复烧 token。
 */
export function createOpenAiProvider(options: OpenAiProviderOptions): AiProvider {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const jsonMode = options.jsonMode ?? true;

  if (baseUrl.length === 0) {
    throw new AiProviderError("模型 baseURL 不能为空", { kind: "config" });
  }
  if (apiKey.length === 0) {
    throw new AiProviderError("模型 apiKey 不能为空", { kind: "config" });
  }
  if (model.length === 0) {
    throw new AiProviderError("模型名不能为空", { kind: "config" });
  }

  const url = `${baseUrl}/chat/completions`;

  async function attempt(
    request: CompletionRequest,
    attemptNo: number,
    startedAt: number,
  ): Promise<CompletionResult> {
    const attemptTimeout = request.timeoutMs ?? timeoutMs;
    if (!Number.isFinite(attemptTimeout) || attemptTimeout <= 0) {
      throw new AiProviderError(`请求超时必须为正数，收到 ${attemptTimeout}`, { kind: "config" });
    }

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const externalSignal = request.signal;

    const onExternalAbort = (): void => {
      cancelled = true;
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeout);

    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
    };
    if (request.maxOutputTokens && request.maxOutputTokens > 0) {
      body.max_tokens = Math.floor(request.maxOutputTokens);
    }
    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }

    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw new AiProviderError(`模型请求超时（${attemptTimeout}ms）`, {
            kind: "timeout",
            retryable: true,
            cause: error,
          });
        }
        if (cancelled) {
          throw new AiProviderError("模型请求已被取消", {
            kind: "cancelled",
            retryable: false,
            cause: error,
          });
        }
        throw new AiProviderError("模型请求网络错误", {
          kind: "network",
          retryable: true,
          cause: error,
        });
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        if (timedOut) {
          throw new AiProviderError(`读取模型响应超时（${attemptTimeout}ms）`, {
            kind: "timeout",
            retryable: true,
            cause: error,
          });
        }
        throw new AiProviderError("读取模型响应失败", {
          kind: "network",
          retryable: true,
          cause: error,
        });
      }

      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AiProviderError(
          `模型接口返回 ${response.status}${rawBody ? `：${bodySnippet(rawBody)}` : ""}`,
          {
            kind: response.status === 429 ? "rate_limit" : "http",
            retryable,
            status: response.status,
          },
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(rawBody) as unknown;
      } catch (error) {
        throw new AiProviderError("模型响应不是合法 JSON", {
          kind: "invalid_response",
          cause: error,
        });
      }

      if (!isRecord(data)) {
        throw new AiProviderError("模型响应结构异常", { kind: "invalid_response" });
      }

      const choices = data.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new AiProviderError("模型响应缺少 choices", { kind: "invalid_response" });
      }
      const first = choices[0];
      if (!isRecord(first) || !isRecord(first.message)) {
        throw new AiProviderError("模型响应缺少 message", { kind: "invalid_response" });
      }
      const content = extractContent(first.message);
      if (content === null || content.trim().length === 0) {
        throw new AiProviderError("模型返回了空内容", { kind: "invalid_response" });
      }

      const rawUsage = isRecord(data.usage) ? data.usage : null;
      const promptTokens =
        toNonNegativeInt(rawUsage?.prompt_tokens) ??
        estimateTokens(request.messages.map((message) => message.content).join("\n"));
      const completionTokens =
        toNonNegativeInt(rawUsage?.completion_tokens) ?? estimateTokens(content);
      const totalTokens =
        toNonNegativeInt(rawUsage?.total_tokens) ?? promptTokens + completionTokens;
      const estimated = rawUsage === null;

      const responseModel = typeof data.model === "string" && data.model.length > 0
        ? data.model
        : model;

      return {
        content,
        model: responseModel,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          estimated,
        },
        latencyMs: Date.now() - startedAt,
        attempts: attemptNo,
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    name: "openai-compatible",
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const maxAttempts = Math.max(0, Math.floor(maxRetries)) + 1;
      let lastError: AiProviderError | null = null;

      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
        try {
          return await attempt(request, attemptNo, startedAt);
        } catch (error) {
          const providerError =
            error instanceof AiProviderError
              ? error
              : new AiProviderError("模型调用失败", {
                  kind: "network",
                  retryable: true,
                  cause: error,
                });
          lastError = providerError;
          if (!providerError.retryable || attemptNo >= maxAttempts) {
            throw providerError;
          }
          const delay = Math.min(2_000, retryDelayMs * 2 ** (attemptNo - 1));
          await sleep(delay);
        }
      }

      throw (
        lastError ??
        new AiProviderError("模型调用失败", { kind: "network", retryable: false })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// mock provider
// ---------------------------------------------------------------------------

/**
 * 默认 mock 计划：确定性、覆盖四类场景，方便离线跑通整条链路。
 * 真实页面结构不同，只把它当作“合法输出样例”，不要断言具体业务。
 */
function defaultMockPlans(): string {
  const plans = [
    {
      id: "mock_login_happy_path",
      name: "使用有效账号登录",
      priority: "P0",
      category: "happy_path",
      rationale: "登录是进入控制台的主流程，失败会阻断全部后续业务。",
      expected: "登录成功后跳转到控制台并显示用户菜单",
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
          action: "fill",
          description: "填写邮箱",
          target: "input[name=email]",
          value: "qa@example.com",
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s3",
          action: "fill",
          description: "填写密码",
          target: "input[name=password]",
          value: "correct-password",
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s4",
          action: "click",
          description: "提交登录表单",
          target: "button[type=submit]",
          value: null,
          expected: null,
          timeoutMs: null,
        },
      ],
      assertions: [
        {
          id: "a1",
          description: "提交后地址变为控制台",
          kind: "assert_url",
          target: null,
          expected: "/dashboard",
        },
        {
          id: "a2",
          description: "控制台显示用户菜单",
          kind: "assert_visible",
          target: "[data-testid=user-menu]",
          expected: "用户菜单可见",
        },
      ],
    },
    {
      id: "mock_login_form_validation",
      name: "邮箱格式非法时阻止提交",
      priority: "P1",
      category: "form_validation",
      rationale: "邮箱格式校验是最常见的表单边界，错误提示必须可定位。",
      expected: "提交非法邮箱时停留在表单并显示格式错误提示",
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
          action: "fill",
          description: "填写非法邮箱",
          target: "input[name=email]",
          value: "not-an-email",
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s3",
          action: "click",
          description: "提交表单",
          target: "button[type=submit]",
          value: null,
          expected: null,
          timeoutMs: null,
        },
      ],
      assertions: [
        {
          id: "a1",
          description: "邮箱输入框下方出现格式错误文案",
          kind: "assert_text",
          target: "[data-testid=email-error]",
          expected: "请输入有效的邮箱地址",
        },
        {
          id: "a2",
          description: "仍停留在登录页",
          kind: "assert_url",
          target: null,
          expected: "/login",
        },
      ],
    },
    {
      id: "mock_dashboard_empty_state",
      name: "没有项目时展示空态",
      priority: "P2",
      category: "empty_state",
      rationale: "新用户第一次进入控制台时没有数据，空态决定下一步能否继续。",
      expected: "没有项目时展示空态说明和创建入口",
      steps: [
        {
          id: "s1",
          action: "goto",
          description: "打开控制台",
          target: "/dashboard",
          value: null,
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s2",
          action: "assert_text",
          description: "检查空态文案",
          target: "[data-testid=empty-state]",
          value: null,
          expected: "还没有任何项目，请创建第一个项目",
          timeoutMs: null,
        },
      ],
      assertions: [
        {
          id: "a1",
          description: "空态说明可见",
          kind: "assert_text",
          target: "[data-testid=empty-state]",
          expected: "还没有任何项目，请创建第一个项目",
        },
        {
          id: "a2",
          description: "创建入口可见",
          kind: "assert_visible",
          target: "[data-testid=create-project]",
          expected: "创建项目按钮可见",
        },
      ],
    },
    {
      id: "mock_admin_permission_denied",
      name: "普通用户直接访问管理页被拒绝",
      priority: "P1",
      category: "permission",
      rationale: "越权访问管理页是高风险路径，必须有明确的拒绝结果。",
      expected: "普通用户访问管理页时被拒绝并回到登录页",
      steps: [
        {
          id: "s1",
          action: "goto",
          description: "直接访问管理页",
          target: "/admin",
          value: null,
          expected: null,
          timeoutMs: null,
        },
        {
          id: "s2",
          action: "assert_text",
          description: "检查拒绝提示",
          target: "body",
          value: null,
          expected: "无访问权限",
          timeoutMs: null,
        },
      ],
      assertions: [
        {
          id: "a1",
          description: "页面出现无权限文案",
          kind: "assert_text",
          target: "body",
          expected: "无访问权限",
        },
        {
          id: "a2",
          description: "未登录用户被导回登录页",
          kind: "assert_url",
          target: null,
          expected: "/login",
        },
      ],
    },
  ];

  return JSON.stringify({ plans });
}

export interface MockProviderOptions {
  /** 固定返回内容，或按请求动态生成；默认返回四类场景的合法样例。 */
  content?: string | ((request: CompletionRequest) => string | Promise<string>);
  model?: string;
  name?: string;
  /** 模拟慢响应；默认 0。 */
  delayMs?: number;
  /** 覆盖返回的 usage；默认按字符估算。 */
  usage?: Partial<Omit<TokenUsage, "estimated">>;
  /** 测试注入用，避免真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 确定性 mock provider：同样输入永远得到同样输出，便于离线测试。 */
export function createMockProvider(options: MockProviderOptions = {}): AiProvider {
  const model = options.model ?? "mock-model";
  const name = options.name ?? "mock";
  const delayMs = options.delayMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;

  return {
    name,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const requestTimeout = request.timeoutMs;
      if (
        requestTimeout !== undefined &&
        requestTimeout > 0 &&
        delayMs > requestTimeout
      ) {
        // 离线模拟慢接口：不真的等待，直接按超时失败，测试确定性更好。
        throw new AiProviderError(`mock 响应超过超时（${requestTimeout}ms）`, {
          kind: "timeout",
          retryable: true,
        });
      }
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      const content =
        typeof options.content === "function"
          ? await options.content(request)
          : (options.content ?? defaultMockPlans());

      const promptText = request.messages.map((message) => message.content).join("\n");
      const promptTokens = options.usage?.promptTokens ?? estimateTokens(promptText);
      const completionTokens = options.usage?.completionTokens ?? estimateTokens(content);
      const totalTokens =
        options.usage?.totalTokens ?? promptTokens + completionTokens;

      return {
        content,
        model,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          estimated: true,
        },
        latencyMs: Date.now() - startedAt,
        attempts: 1,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

export type ProviderEnv = Record<string, string | undefined>;

function parseInteger(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * 按 `AI_PROVIDER` 选择 provider：
 * - `mock`：确定性离线输出，单测/本地演示用；
 * - `openai`（默认）：OpenAI 兼容 HTTP 接口，需要 `LLM_API_KEY`。
 */
export function createProviderFromEnv(
  env: ProviderEnv = process.env,
  overrides: ProviderEnvOptions = {},
): AiProvider {
  const mode = (env.AI_PROVIDER ?? "openai").trim().toLowerCase();

  if (mode === "mock") {
    return createMockProvider();
  }
  if (mode !== "openai") {
    throw new AiProviderError(
      `不支持的 AI_PROVIDER：${mode}（可选 openai / mock）`,
      { kind: "config" },
    );
  }

  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new AiProviderError(
      "LLM_API_KEY 未配置；离线开发可设置 AI_PROVIDER=mock",
      { kind: "config" },
    );
  }

  return createOpenAiProvider({
    baseUrl: env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: parseInteger(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
    maxRetries: parseInteger(env.AI_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0),
    jsonMode: (env.AI_JSON_MODE ?? "true").trim().toLowerCase() !== "false",
    fetchImpl: overrides.fetchImpl,
    sleep: overrides.sleep,
  });
}
