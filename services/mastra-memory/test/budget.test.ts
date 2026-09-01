import { describe, expect, it } from "vitest";

import { enforceContextBudgets } from "../src/budget.js";

describe("enforceContextBudgets", () => {
  it("keeps context inside component and total budgets", () => {
    const result = enforceContextBudgets(
      "p".repeat(1_000),
      "c".repeat(1_000),
      [{ text: "s".repeat(1_000) }],
      { project: 100, channel: 100, semantic: 100, total: 250 },
    );

    expect(result.estimatedTokens).toBeLessThanOrEqual(250);
    expect(result.projectMemory.length).toBeLessThanOrEqual(400);
    expect(result.channelMemory.length).toBeLessThanOrEqual(400);
    expect(result.relevantMemories[0]?.text.length).toBeLessThanOrEqual(200);
  });

  it("keeps the newest tail when compact memory exceeds its budget", () => {
    const result = enforceContextBudgets(
      "old-" + "x".repeat(500) + "-new",
      "",
      [],
      { project: 10, channel: 10, semantic: 10, total: 30 },
    );

    expect(result.projectMemory).toMatch(/^\.\.\./);
    expect(result.projectMemory).toMatch(/-new$/);
  });
});
