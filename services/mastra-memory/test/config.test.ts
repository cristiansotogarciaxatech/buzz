import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults observer and reflector to subscription-authenticated Codex", () => {
    const config = loadConfig({});

    expect(config.observerModel).toBe("codex/gpt-5.6-sol");
    expect(config.reflectorModel).toBe("codex/gpt-5.6-sol");
    expect(config.codexReasoningEffort).toBe("low");
  });

  it("allows observer and reflector to be changed independently", () => {
    const config = loadConfig({
      MASTRA_OBSERVER_MODEL: "anthropic/claude-haiku",
      MASTRA_REFLECTOR_MODEL: "anthropic/claude-haiku",
    });

    expect(config.observerModel).toBe("anthropic/claude-haiku");
    expect(config.reflectorModel).toBe("anthropic/claude-haiku");
  });

  it("requires authentication when listening beyond loopback", () => {
    expect(() => loadConfig({ MASTRA_MEMORY_BIND: "0.0.0.0" })).toThrow(
      "MASTRA_MEMORY_AUTH_TOKEN",
    );
  });
});
