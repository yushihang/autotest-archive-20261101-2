/**
 * 失败归因：把「跑挂了」翻译成「为什么挂、该谁修」。
 *
 * 三种可行动的结论：
 * - `ENV`：网络 / DNS / 证书 / 网关错误，重跑通常自愈，不该记到用例账上；
 * - `TEST_BUG`：选择器找不到，且页面快照与计划对不上——计划过期或写错了；
 * - `FAIL_REAL`：稳定失败且页面符合计划，应用真的坏了。
 *
 * 另外单次执行还可能是 `PASS` / `SKIPPED`；`FLAKY` 只能由「多次重跑」聚合得出，
 * 单次执行永远不会判定为 flaky。
 *
 * 这一层是纯函数：不读写数据库、不发网络请求、不读时钟。
 * 需要真的跑一遍浏览器时，由调用方传入 `runAttempt` 回调（见 `runWithReruns`）。
 */

import type { CaseStatus, FailureKind } from "@/lib/domain";

/** 默认重跑次数：一次失败不足以区分「真失败」和「偶发」。 */
export const DEFAULT_RERUN_ATTEMPTS = 3;

/** 归因结论。 */
export type Verdict =
  | "PASS"
  | "SKIPPED"
  | "FAIL_REAL"
  | "FLAKY"
  | "ENV"
  | "TEST_BUG";

/** 机器可读的判定理由，报告里用来分组与筛选。 */
export type VerdictReason =
  | "all_passed"
  | "stable_failure"
  | "intermittent"
  | "environment_error"
  | "plan_mismatch"
  | "not_executed";

/** 失败时抓取的页面快照，只保留判定需要的信号。 */
export interface PageSnapshot {
  /** 失败时的地址，仅用于展示。 */
  url: string | null;
  /** 页面可见文本（无需清洗，判定前会归一化）。 */
  text: string;
  /** 页面上实际存在的选择器，例如 `[data-testid="login"]`。 */
  selectors: string[];
}

/** 一次执行（首次或重跑）的结果，判定所需的全部输入。 */
export interface AttemptInput {
  status: CaseStatus;
  failureKind: FailureKind | null;
  error: string | null;
  /** 失败步骤在计划里的选择器。 */
  selector?: string | null;
  /** 失败步骤在计划里的期望结果。 */
  expected?: string | null;
  /** 失败时的页面快照；拿不到时传 `null`，此时不会判定为 `TEST_BUG`。 */
  snapshot?: PageSnapshot | null;
}

/** 单次执行的判定。 */
export interface AttemptVerdict {
  verdict: Exclude<Verdict, "FLAKY">;
  reason: VerdictReason;
  /** 判定依据，逐条给出，报告里原样展示。 */
  evidence: string[];
}

/** 一条用例的整体判定（含重跑）。 */
export interface Classification {
  verdict: Verdict;
  reason: VerdictReason;
  /** 参与判定的全部执行记录，顺序与执行顺序一致。 */
  observations: AttemptInput[];
  /** 与 `observations` 一一对应的单次判定。 */
  perAttempt: AttemptVerdict[];
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** 整体判定依据，报告里原样展示。 */
  evidence: string[];
}

export interface ClassifyOptions {
  /** 期望的重跑次数，默认 {@link DEFAULT_RERUN_ATTEMPTS}；只用于标注“执行次数不足”。 */
  attempts?: number;
}

/**
 * 环境类错误的高精度特征。
 *
 * 这里刻意只收「几乎不可能是代码问题」的信号：宁可把存疑的失败归到 `FAIL_REAL`，
 * 也不要把真 bug 洗成环境问题。
 */
const ENVIRONMENT_SIGNALS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // Node / undici / fetch
  { pattern: /\bENOTFOUND\b/i, label: "DNS 解析失败（ENOTFOUND）" },
  { pattern: /\bEAI_AGAIN\b/i, label: "DNS 暂时失败（EAI_AGAIN）" },
  { pattern: /\bECONNREFUSED\b/i, label: "连接被拒绝（ECONNREFUSED）" },
  { pattern: /\bECONNRESET\b/i, label: "连接被重置（ECONNRESET）" },
  { pattern: /\bECONNABORTED\b/i, label: "连接被中断（ECONNABORTED）" },
  { pattern: /\bEHOSTUNREACH\b/i, label: "主机不可达（EHOSTUNREACH）" },
  { pattern: /\bENETUNREACH\b/i, label: "网络不可达（ENETUNREACH）" },
  { pattern: /\bENETDOWN\b/i, label: "网络已断开（ENETDOWN）" },
  { pattern: /\bETIMEDOUT\b/i, label: "连接超时（ETIMEDOUT）" },
  { pattern: /getaddrinfo/i, label: "域名解析失败（getaddrinfo）" },
  { pattern: /socket hang up/i, label: "连接被对端断开（socket hang up）" },
  // Chromium / Playwright 网络层
  { pattern: /net::ERR_NAME_NOT_RESOLVED/i, label: "DNS 解析失败（ERR_NAME_NOT_RESOLVED）" },
  { pattern: /net::ERR_CONNECTION_REFUSED/i, label: "连接被拒绝（ERR_CONNECTION_REFUSED）" },
  { pattern: /net::ERR_CONNECTION_RESET/i, label: "连接被重置（ERR_CONNECTION_RESET）" },
  { pattern: /net::ERR_CONNECTION_TIMED_OUT/i, label: "连接超时（ERR_CONNECTION_TIMED_OUT）" },
  { pattern: /net::ERR_CONNECTION_CLOSED/i, label: "连接被关闭（ERR_CONNECTION_CLOSED）" },
  { pattern: /net::ERR_INTERNET_DISCONNECTED/i, label: "本机断网（ERR_INTERNET_DISCONNECTED）" },
  { pattern: /net::ERR_ADDRESS_UNREACHABLE/i, label: "地址不可达（ERR_ADDRESS_UNREACHABLE）" },
  { pattern: /net::ERR_PROXY_CONNECTION_FAILED/i, label: "代理连接失败（ERR_PROXY_CONNECTION_FAILED）" },
  { pattern: /net::ERR_TUNNEL_CONNECTION_FAILED/i, label: "代理隧道失败（ERR_TUNNEL_CONNECTION_FAILED）" },
  // 证书 / TLS
  { pattern: /net::ERR_CERT_/i, label: "证书错误（ERR_CERT_*）" },
  { pattern: /net::ERR_SSL_/i, label: "TLS 握手失败（ERR_SSL_*）" },
  { pattern: /CERT_HAS_EXPIRED/i, label: "证书已过期（CERT_HAS_EXPIRED）" },
  { pattern: /certificate has expired/i, label: "证书已过期" },
  { pattern: /self[- ]signed certificate/i, label: "证书为自签名" },
  { pattern: /unable to (?:verify|get) (?:the first|issuer) certificate/i, label: "证书链不完整" },
  { pattern: /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i, label: "证书链校验失败（UNABLE_TO_VERIFY_LEAF_SIGNATURE）" },
  { pattern: /Hostname\/IP does not match certificate/i, label: "证书与域名不匹配" },
  { pattern: /SSL routines/i, label: "SSL 握手失败（SSL routines）" },
  { pattern: /TLS handshake/i, label: "TLS 握手失败" },
  // 网关 / 上游不可用
  { pattern: /\b502 Bad Gateway\b/i, label: "上游不可用（502 Bad Gateway）" },
  { pattern: /\b503 Service Unavailable\b/i, label: "服务不可用（503 Service Unavailable）" },
  { pattern: /\b504 Gateway Timeout\b/i, label: "上游超时（504 Gateway Timeout）" },
];

/** 看起来像「选择器找不到」的报错，兼容不同运行器的措辞。 */
const SELECTOR_FAILURE_PATTERN =
  /locator|selector|getBy\w+|waiting for (?:selector|locator)|element\s*(?:is\s*)?not\s*(?:found|visible|attached)|no element/i;

/** 过于宽泛、出现在任何页面上都不算证据的词。 */
const GENERIC_TOKENS = new Set([
  "a",
  "div",
  "span",
  "button",
  "input",
  "form",
  "body",
  "html",
  "head",
  "main",
  "root",
  "app",
  "page",
  "text",
  "class",
  "id",
]);

/** 命中的环境错误特征；未命中返回 `null`。 */
export function isEnvironmentError(
  input: Pick<AttemptInput, "failureKind" | "error">,
): string | null {
  const text = input.error ?? "";
  for (const signal of ENVIRONMENT_SIGNALS) {
    if (signal.pattern.test(text)) return signal.label;
  }
  if (input.failureKind === "environment_error") {
    return "运行器显式标记为 environment_error";
  }
  return null;
}

/**
 * 判定单次执行。
 *
 * 顺序很重要：环境错误优先（重跑能自愈的失败不该被当成用例问题），
 * 其次是「选择器缺失 + 页面与计划不符」，最后才落到真失败。
 */
export function classifyAttempt(attempt: AttemptInput): AttemptVerdict {
  if (attempt.status === "passed") {
    return { verdict: "PASS", reason: "all_passed", evidence: ["本次执行通过"] };
  }
  if (attempt.status === "skipped") {
    return { verdict: "SKIPPED", reason: "not_executed", evidence: ["本次执行被跳过，未产生结果"] };
  }

  const environment = isEnvironmentError(attempt);
  if (environment !== null) {
    return {
      verdict: "ENV",
      reason: "environment_error",
      evidence: [
        `命中环境错误特征：${environment}`,
        `原始错误：${truncate(attempt.error)}`,
      ],
    };
  }

  const mismatch = detectPlanMismatch(attempt);
  if (mismatch !== null) {
    return { verdict: "TEST_BUG", reason: "plan_mismatch", evidence: mismatch };
  }

  const evidence = [
    `稳定失败（${describeFailureKind(attempt.failureKind)}），未命中环境错误特征`,
    `原始错误：${truncate(attempt.error)}`,
  ];
  if (attempt.failureKind === "element_not_found" && attempt.snapshot !== null && attempt.snapshot !== undefined) {
    evidence.push("页面快照与计划一致，元素确实缺失——按应用缺陷处理");
  }
  return { verdict: "FAIL_REAL", reason: "stable_failure", evidence };
}

/**
 * 聚合多次执行：稳定失败 -> `FAIL_REAL`，时好时坏 -> `FLAKY`。
 *
 * `options.attempts` 只影响证据里的「执行次数不足」提示，不会补跑。
 */
export function classifyCase(
  attempts: AttemptInput[],
  options: ClassifyOptions = {},
): Classification {
  const expectedAttempts = Math.max(1, options.attempts ?? DEFAULT_RERUN_ATTEMPTS);
  const perAttempt = attempts.map(classifyAttempt);
  const passed = perAttempt.filter((item) => item.verdict === "PASS").length;
  const skipped = perAttempt.filter((item) => item.verdict === "SKIPPED").length;
  const failed = perAttempt.length - passed - skipped;
  const counts = { total: attempts.length, passed, failed, skipped };

  if (attempts.length === 0) {
    return {
      verdict: "SKIPPED",
      reason: "not_executed",
      observations: attempts,
      perAttempt,
      counts,
      evidence: ["没有执行记录，无法判定"],
    };
  }

  const executionNote =
    attempts.length < expectedAttempts
      ? [`只执行了 ${attempts.length}/${expectedAttempts} 次，稳定性结论偏弱`]
      : [];

  if (passed > 0 && failed === 0) {
    return {
      verdict: "PASS",
      reason: "all_passed",
      observations: attempts,
      perAttempt,
      counts,
      evidence: [`${attempts.length} 次执行全部通过`, ...executionNote],
    };
  }

  if (passed > 0 && failed > 0) {
    const firstFailure = perAttempt.find(
      (item) => item.verdict !== "PASS" && item.verdict !== "SKIPPED",
    );
    return {
      verdict: "FLAKY",
      reason: "intermittent",
      observations: attempts,
      perAttempt,
      counts,
      evidence: [
        `${attempts.length} 次重跑中 ${passed} 次通过、${failed} 次失败：结果不稳定（flaky）`,
        ...(firstFailure?.evidence ?? []),
        ...executionNote,
      ],
    };
  }

  if (failed === 0) {
    return {
      verdict: "SKIPPED",
      reason: "not_executed",
      observations: attempts,
      perAttempt,
      counts,
      evidence: [`${skipped} 次执行全部被跳过，未产生结果`, ...executionNote],
    };
  }

  const failedVerdicts = unique(
    perAttempt
      .filter((item) => item.verdict !== "PASS" && item.verdict !== "SKIPPED")
      .map((item) => item.verdict),
  );

  if (failedVerdicts.length > 1) {
    return {
      verdict: "FLAKY",
      reason: "intermittent",
      observations: attempts,
      perAttempt,
      counts,
      evidence: [
        `${failed} 次执行全部失败，但失败形态不一致（${failedVerdicts.join(" / ")}）：按 flaky 处理`,
        ...(perAttempt.find((item) => item.verdict !== "PASS" && item.verdict !== "SKIPPED")
          ?.evidence ?? []),
        ...executionNote,
      ],
    };
  }

  const failureVerdict = failedVerdicts[0] ?? "FAIL_REAL";
  const reason: VerdictReason =
    failureVerdict === "ENV"
      ? "environment_error"
      : failureVerdict === "TEST_BUG"
        ? "plan_mismatch"
        : "stable_failure";
  const firstFailure = perAttempt.find(
    (item) => item.verdict === failureVerdict,
  );

  return {
    verdict: failureVerdict,
    reason,
    observations: attempts,
    perAttempt,
    counts,
    evidence: [
      `${failed} 次执行全部失败，归因为 ${failureVerdict}`,
      ...(firstFailure?.evidence ?? []),
      ...executionNote,
    ],
  };
}

/**
 * 重跑 N 次再判定。
 *
 * 回调由调用方提供，本身不做任何 IO；单次执行抛异常时记为 `script_error` 继续重跑，
 * 避免一次崩溃中断整条用例的归因。
 */
export async function runWithReruns(
  runAttempt: () => AttemptInput | Promise<AttemptInput>,
  options: ClassifyOptions = {},
): Promise<Classification> {
  const total = Math.max(1, options.attempts ?? DEFAULT_RERUN_ATTEMPTS);
  const observations: AttemptInput[] = [];

  for (let index = 0; index < total; index += 1) {
    try {
      observations.push(await runAttempt());
    } catch (error) {
      observations.push({
        status: "error",
        failureKind: "script_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return classifyCase(observations, { ...options, attempts: total });
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 选择器与期望文案都与页面快照对不上时返回判定依据，否则返回 `null`。 */
function detectPlanMismatch(attempt: AttemptInput): string[] | null {
  const looksLikeSelectorFailure =
    attempt.failureKind === "element_not_found" ||
    SELECTOR_FAILURE_PATTERN.test(attempt.error ?? "");

  if (!looksLikeSelectorFailure) return null;

  const snapshot = attempt.snapshot;
  if (!snapshot) return null;
  if (snapshot.text.trim().length === 0 && snapshot.selectors.length === 0) return null;

  const checked = unique([
    ...selectorTokens(attempt.selector ?? ""),
    ...expectedTokens(attempt.expected ?? null),
  ]);
  if (checked.length === 0) return null;

  const haystack = normalize([snapshot.text, ...snapshot.selectors].join(" "));
  const matched = checked.filter((token) => haystack.includes(normalize(token)));
  if (matched.length > 0) return null;

  return [
    `选择器 ${attempt.selector ?? "(未提供)"} 在页面上找不到`,
    `计划里的线索（${checked.join(" / ")}）在页面快照中都不存在`,
    `页面实际内容（${snapshot.url ?? "未知地址"}）：${truncate(snapshot.text) || "(空页面)"}`,
  ];
}

/** 从选择器里提取可用于核对页面的「指纹」。 */
function selectorTokens(selector: string): string[] {
  const tokens: string[] = [];

  const testId = /\[\s*data-(?:testid|test-id|test|qa)\s*=\s*["']?([^"'\]]+)["']?\s*\]/i.exec(selector)?.[1]?.trim();
  if (testId) tokens.push(testId);

  const quoted = /["']([^"']{2,})["']/.exec(selector)?.[1]?.trim();
  if (quoted) tokens.push(quoted);

  const hasText = /(?:^|[\s>])text\s*=\s*(.+)$/i.exec(selector)?.[1]?.trim();
  if (hasText) tokens.push(hasText);

  const id = /#([A-Za-z_][\w-]*)/.exec(selector)?.[1];
  if (id) tokens.push(id);

  const className = /\.([A-Za-z_][\w-]*)/.exec(selector)?.[1];
  if (className) tokens.push(className);

  return unique(
    tokens
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token.toLowerCase())),
  );
}

/** 期望结果按标点切分，避免整句匹配过于严格。 */
function expectedTokens(expected: string | null): string[] {
  if (!expected) return [];
  return unique(
    expected
      .split(/[，,。.;；!！?？\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && !GENERIC_TOKENS.has(part.toLowerCase())),
  );
}

function describeFailureKind(kind: FailureKind | null): string {
  if (kind === null) return "未提供 failureKind";
  return `failureKind=${kind}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncate(text: string | null, max = 160): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length === 0) return "(无错误信息)";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
