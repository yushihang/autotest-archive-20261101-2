import { describe, expect, it } from "vitest";

import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "./prompts";

describe("PLANNER_SYSTEM_PROMPT", () => {
  it("强调只写可验证断言、不确定的需求不写", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain("只写能验证的行为断言");
    expect(PLANNER_SYSTEM_PROMPT).toContain("不确定的需求不写");
    expect(PLANNER_SYSTEM_PROMPT).toContain("happy_path");
    expect(PLANNER_SYSTEM_PROMPT).toContain("form_validation");
    expect(PLANNER_SYSTEM_PROMPT).toContain("empty_state");
    expect(PLANNER_SYSTEM_PROMPT).toContain("permission");
  });
});

describe("buildPlannerUserPrompt", () => {
  it("带上目标 URL、范围规则和快照", () => {
    const prompt = buildPlannerUserPrompt({
      targetUrl: "https://example.com/login",
      snapshotJson: '{"url":"https://example.com/login"}',
      include: ["/login", "/settings/*"],
      exclude: ["/billing"],
      maxPlans: 5,
      truncated: false,
    });

    expect(prompt).toContain("https://example.com/login");
    expect(prompt).toContain("/settings/*");
    expect(prompt).toContain("/billing");
    expect(prompt).toContain("最多返回：5 条计划");
    expect(prompt).not.toContain("被截断");
  });

  it("快照被截断时明确告知模型不要假设缺失内容", () => {
    const prompt = buildPlannerUserPrompt({
      targetUrl: "https://example.com/login",
      snapshotJson: "{}",
      include: [],
      exclude: [],
      maxPlans: 3,
      truncated: true,
    });

    expect(prompt).toContain("快照因超出 token 预算被截断");
    expect(prompt).toContain("不要假设被截断部分存在任何元素或需求");
  });
});
