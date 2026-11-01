import { describe, expect, it } from "vitest";

import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  type RunStatus,
} from "@/lib/domain";

describe("isTerminalRunStatus", () => {
  it("把活跃状态判为非终态", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("终态列表里的每个状态都返回 true", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("终态列表覆盖除 queued / running 之外的全部状态", () => {
    const all: RunStatus[] = [
      "queued",
      "running",
      "passed",
      "failed",
      "cancelled",
      "timed_out",
      "error",
    ];
    const nonTerminal = all.filter((status) => !isTerminalRunStatus(status));

    expect(nonTerminal).toEqual(["queued", "running"]);
  });
});
