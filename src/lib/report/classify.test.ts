import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RERUN_ATTEMPTS,
  classifyAttempt,
  classifyCase,
  isEnvironmentError,
  runWithReruns,
  type AttemptInput,
  type PageSnapshot,
} from "@/lib/report/classify";

const SELECTOR = '[data-testid="checkout"]';

/** 页面与计划一致：期望文案和选择器都能在快照里找到。 */
const MATCHING_SNAPSHOT: PageSnapshot = {
  url: "https://shop.example.com/cart",
  text: "购物车 共 2 件商品 提交订单 去结算",
  selectors: ['[data-testid="checkout"]', '[data-testid="cart-total"]'],
};

/** 页面与计划不一致：整站改版了，计划里的线索全都不在。 */
const STALE_SNAPSHOT: PageSnapshot = {
  url: "https://shop.example.com/cart",
  text: "欢迎使用全新购物车 商品推荐 猜你喜欢",
  selectors: ['[data-testid="hero"]', '[data-testid="recommend-list"]'],
};

function passedAttempt(): AttemptInput {
  return { status: "passed", failureKind: null, error: null };
}

function failedAttempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    status: "failed",
    failureKind: "assertion_failed",
    error: "expect(received).toBe(expected) // 期望 200，实际 500",
    ...overrides,
  };
}

function missingElementAttempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    status: "failed",
    failureKind: "element_not_found",
    error: `locator('${SELECTOR}') not found: waiting for selector`,
    selector: SELECTOR,
    expected: "提交订单",
    snapshot: STALE_SNAPSHOT,
    ...overrides,
  };
}

describe("classifyAttempt", () => {
  it("通过的执行判定为 PASS", () => {
    const result = classifyAttempt(passedAttempt());

    expect(result.verdict).toBe("PASS");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("被跳过的执行不算失败", () => {
    const result = classifyAttempt({
      status: "skipped",
      failureKind: null,
      error: null,
    });

    expect(result.verdict).toBe("SKIPPED");
  });

  it("网络 / DNS / 证书错误归因为 ENV", () => {
    const dns = classifyAttempt(
      failedAttempt({
        failureKind: "navigation_error",
        error: "page.goto: getaddrinfo ENOTFOUND staging.example.com",
      }),
    );
    const cert = classifyAttempt(
      failedAttempt({
        failureKind: "navigation_error",
        error: "net::ERR_CERT_AUTHORITY_INVALID at https://staging.example.com",
      }),
    );

    expect(dns.verdict).toBe("ENV");
    expect(dns.reason).toBe("environment_error");
    expect(cert.verdict).toBe("ENV");
    expect(dns.evidence.join("\n")).toContain("ENOTFOUND");
  });

  it("选择器找不到且页面快照与计划不符，归因为 TEST_BUG", () => {
    const result = classifyAttempt(missingElementAttempt());

    expect(result.verdict).toBe("TEST_BUG");
    expect(result.reason).toBe("plan_mismatch");
    expect(result.evidence.join("\n")).toContain("提交订单");
  });

  it("选择器找不到但页面符合计划，仍然算真失败", () => {
    const result = classifyAttempt(
      missingElementAttempt({ snapshot: MATCHING_SNAPSHOT }),
    );

    expect(result.verdict).toBe("FAIL_REAL");
    expect(result.evidence.join("\n")).toContain("页面快照与计划一致");
  });

  it("没有快照时不会武断判成用例写错", () => {
    const result = classifyAttempt(missingElementAttempt({ snapshot: null }));

    expect(result.verdict).toBe("FAIL_REAL");
  });

  it("普通断言失败归因为 FAIL_REAL", () => {
    const result = classifyAttempt(failedAttempt());

    expect(result.verdict).toBe("FAIL_REAL");
    expect(result.reason).toBe("stable_failure");
  });
});

describe("classifyCase（含 flaky 重跑）", () => {
  it("多次执行全部通过才算稳定通过", () => {
    const result = classifyCase([passedAttempt(), passedAttempt(), passedAttempt()]);

    expect(result.verdict).toBe("PASS");
    expect(result.counts).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
  });

  it("稳定失败三次归因为 FAIL_REAL", () => {
    const result = classifyCase([
      failedAttempt(),
      failedAttempt(),
      failedAttempt(),
    ]);

    expect(result.verdict).toBe("FAIL_REAL");
    expect(result.reason).toBe("stable_failure");
    expect(result.evidence.join("\n")).toContain("3 次执行全部失败");
  });

  it("时好时坏判为 FLAKY", () => {
    const result = classifyCase([
      failedAttempt({ error: "第一次超时" }),
      passedAttempt(),
      failedAttempt({ error: "第三次超时" }),
    ]);

    expect(result.verdict).toBe("FLAKY");
    expect(result.reason).toBe("intermittent");
    expect(result.counts).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
    expect(result.evidence.join("\n")).toContain("结果不稳定");
  });

  it("失败形态不一致也按 FLAKY 处理", () => {
    const result = classifyCase([
      failedAttempt({ failureKind: "navigation_error", error: "getaddrinfo ENOTFOUND" }),
      missingElementAttempt(),
      failedAttempt(),
    ]);

    expect(result.verdict).toBe("FLAKY");
    expect(result.evidence.join("\n")).toContain("失败形态不一致");
  });

  it("稳定复现的环境错误归因为 ENV", () => {
    const result = classifyCase([
      failedAttempt({ failureKind: "navigation_error", error: "connect ECONNREFUSED 127.0.0.1:443" }),
      failedAttempt({ failureKind: "navigation_error", error: "connect ECONNREFUSED 127.0.0.1:443" }),
    ]);

    expect(result.verdict).toBe("ENV");
    expect(result.reason).toBe("environment_error");
  });

  it("每次都命中选择器与快照不符才归因为 TEST_BUG", () => {
    const result = classifyCase([
      missingElementAttempt(),
      missingElementAttempt(),
      missingElementAttempt(),
    ]);

    expect(result.verdict).toBe("TEST_BUG");
  });

  it("没有执行记录时标记为未执行", () => {
    const result = classifyCase([]);

    expect(result.verdict).toBe("SKIPPED");
    expect(result.reason).toBe("not_executed");
    expect(result.counts.total).toBe(0);
  });

  it("执行次数不足时在证据里说明", () => {
    const result = classifyCase([failedAttempt()]);

    expect(result.evidence.join("\n")).toContain(`只执行了 1/${DEFAULT_RERUN_ATTEMPTS} 次`);
  });
});

describe("runWithReruns", () => {
  it("默认重跑 3 次再判定", async () => {
    const runAttempt = vi.fn(() => passedAttempt());

    const result = await runWithReruns(runAttempt);

    expect(runAttempt).toHaveBeenCalledTimes(DEFAULT_RERUN_ATTEMPTS);
    expect(result.verdict).toBe("PASS");
    expect(result.observations).toHaveLength(DEFAULT_RERUN_ATTEMPTS);
  });

  it("首次失败、重跑通过时判为 FLAKY", async () => {
    const outcomes = [failedAttempt(), passedAttempt(), passedAttempt()];
    let index = 0;

    const result = await runWithReruns(() => {
      const outcome = outcomes[index] ?? passedAttempt();
      index += 1;
      return outcome;
    });

    expect(result.verdict).toBe("FLAKY");
  });

  it("单次执行抛异常时记为 script_error 并继续重跑", async () => {
    const result = await runWithReruns(() => {
      throw new Error("browser crashed");
    }, { attempts: 2 });

    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]?.failureKind).toBe("script_error");
    expect(result.verdict).toBe("FAIL_REAL");
  });
});

describe("isEnvironmentError", () => {
  it("识别常见的网络与证书特征", () => {
    expect(isEnvironmentError({ failureKind: null, error: "socket hang up" })).not.toBeNull();
    expect(
      isEnvironmentError({ failureKind: null, error: "unable to verify the first certificate" }),
    ).not.toBeNull();
  });

  it("运行器显式标记的 environment_error 也算环境问题", () => {
    expect(isEnvironmentError({ failureKind: "environment_error", error: null })).toBe(
      "运行器显式标记为 environment_error",
    );
  });

  it("普通断言失败不会误判为环境问题", () => {
    expect(
      isEnvironmentError({ failureKind: "assertion_failed", error: "expected 1 to equal 2" }),
    ).toBeNull();
  });
});
