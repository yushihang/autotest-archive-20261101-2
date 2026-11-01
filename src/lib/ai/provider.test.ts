import { describe, expect, it, vi } from "vitest";

import {
  AiProviderError,
  createMockProvider,
  createOpenAiProvider,
  createProviderFromEnv,
  estimateTokens,
} from "./provider";
import { parseTestPlans } from "./schema";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const COMPLETION_PAYLOAD = {
  model: "gpt-test-2026",
  choices: [{ message: { content: '{"plans":[]}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("estimateTokens", () => {
  it("中文按 1 token、英文按 4 字符估算", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("createProviderFromEnv", () => {
  it("AI_PROVIDER=mock 时不需要密钥，输出确定且可解析", async () => {
    const provider = createProviderFromEnv({ AI_PROVIDER: "mock" });
    expect(provider.name).toBe("mock");

    const request = { messages: [{ role: "user" as const, content: "生成登录测试计划" }] };
    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(first.content).toBe(second.content);
    expect(first.usage.estimated).toBe(true);
    const plans = parseTestPlans(first.content);
    expect(plans.map((plan) => plan.category)).toEqual([
      "happy_path",
      "form_validation",
      "empty_state",
      "permission",
    ]);
  });

  it("缺少 LLM_API_KEY 时抛出配置错误", () => {
    try {
      createProviderFromEnv({});
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).kind).toBe("config");
      expect((error as Error).message).toContain("LLM_API_KEY");
    }
  });

  it("不支持的 AI_PROVIDER 抛配置错误", () => {
    expect(() => createProviderFromEnv({ AI_PROVIDER: "other" })).toThrowError(
      /不支持的 AI_PROVIDER/,
    );
  });

  it("读取超时与重试配置", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION_PAYLOAD));
    const provider = createProviderFromEnv(
      {
        AI_PROVIDER: "openai",
        LLM_BASE_URL: "https://llm.example.com/v1/",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AI_TIMEOUT_MS: "1234",
        AI_MAX_RETRIES: "0",
      },
      { fetchImpl, sleep: async () => undefined },
    );

    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(provider.name).toBe("openai-compatible");
    expect(result.content).toBe('{"plans":[]}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createMockProvider", () => {
  it("支持按请求动态生成内容", async () => {
    const provider = createMockProvider({
      content: (request) => `echo:${request.messages.at(-1)?.content ?? ""}`,
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("echo:hello");
  });
});

describe("createOpenAiProvider", () => {
  it("返回内容、模型名和 token 用量", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION_PAYLOAD));
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "生成计划" }],
      maxOutputTokens: 100,
    });

    expect(result.content).toBe('{"plans":[]}');
    expect(result.model).toBe("gpt-test-2026");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: false,
    });
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("5xx 按指数退避重试，最终成功", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return textResponse("overloaded", 503);
      }
      return jsonResponse(COMPLETION_PAYLOAD);
    });
    const sleep = vi.fn(async () => undefined);
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      maxRetries: 2,
      retryDelayMs: 10,
      sleep,
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("401 不重试，直接抛 http 错误", async () => {
    const fetchImpl = vi.fn(async () => textResponse("unauthorized", 401));
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      maxRetries: 3,
      sleep: async () => undefined,
    });

    try {
      await provider.complete({ messages: [{ role: "user", content: "hi" }] });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).kind).toBe("http");
      expect((error as AiProviderError).retryable).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("接口未返回 usage 时用字符数估算并标记 estimated", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: "gpt-test",
        choices: [{ message: { content: "你好" } }],
      }),
    );
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      maxRetries: 0,
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.completionTokens).toBe(2);
    expect(result.usage.totalTokens).toBe(
      result.usage.promptTokens + result.usage.completionTokens,
    );
  });

  it("请求超时归为 timeout，并按配置重试", async () => {
    const fetchImpl = vi.fn(
      (_input: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      timeoutMs: 10,
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: async () => undefined,
      fetchImpl,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("响应缺少 choices 时归为 invalid_response，且不重试", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: "gpt-test" }));
    const provider = createOpenAiProvider({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      maxRetries: 3,
      sleep: async () => undefined,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
