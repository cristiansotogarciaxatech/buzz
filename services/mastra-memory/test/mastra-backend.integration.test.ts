import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import type { Memory } from "@mastra/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemoryServiceConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { ContextRequest, MemoryRequest } from "../src/contracts.js";
import type { Logger } from "../src/logger.js";
import {
  createBuzzMemory,
  type MemoryComponents,
  MastraMemoryBackend,
} from "../src/mastra-backend.js";

describe("Mastra persistent project memory", () => {
  let directory: string;
  let databaseUrl: string;
  let runtime: TestRuntime;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "buzz-mastra-memory-"));
    databaseUrl = "file:" + join(directory, "memory.db").replaceAll("\\", "/");
    runtime = await openRuntime(databaseUrl);
  });

  afterAll(async () => {
    await runtime?.backend.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("uses Mastra's built-in Observer and Reflector", async () => {
    const engine = await runtime.memory.omEngine;

    expect(engine).not.toBeNull();
    expect(engine?.observer).toBeDefined();
    expect(engine?.reflector).toBeDefined();
  });

  it("recalls across channels, sessions, and agents inside one project", async () => {
    await runtime.backend.remember(
      memoryRequest({
        channelId: "architecture",
        agentId: "claude",
        sessionId: "session-a",
        userMessage:
          "Architecture decision: authentication uses custom JWT refresh-token rotation.",
        agentResponse:
          "The custom JWT rotation decision is active and replaces Supabase Auth.",
      }),
    );

    const context = await runtime.backend.context(
      contextRequest({
        channelId: "backend",
        agentId: "codex",
        sessionId: "session-b",
        message: "Implement JWT authentication and refresh token rotation.",
      }),
    );

    expect(
      context.relevantMemories.some((memory) =>
        memory.text.includes("custom JWT refresh-token rotation"),
      ),
    ).toBe(true);
    expect(
      context.relevantMemories.some(
        (memory) =>
          memory.sourceChannelId === "architecture" &&
          memory.sourceAgentId === "claude" &&
          memory.sourceSessionId === "session-a",
      ),
    ).toBe(true);
  });

  it("does not leak memory across communities or projects", async () => {
    const otherCommunity = await runtime.backend.context(
      contextRequest({
        communityId: "wss://other.example",
        channelId: "backend",
        message: "custom JWT refresh-token rotation",
      }),
    );
    const otherProject = await runtime.backend.context(
      contextRequest({
        projectId: "30621:owner:other-project",
        channelId: "backend",
        message: "custom JWT refresh-token rotation",
      }),
    );

    expect(otherCommunity.relevantMemories).toEqual([]);
    expect(otherProject.relevantMemories).toEqual([]);
  });

  it("survives a service restart and remains cross-agent", async () => {
    await runtime.backend.close();
    runtime = await openRuntime(databaseUrl);

    const context = await runtime.backend.context(
      contextRequest({
        channelId: "ideas",
        agentId: "grok",
        sessionId: "session-c",
        message: "What authentication architecture was selected?",
      }),
    );

    expect(
      context.relevantMemories.some((memory) =>
        memory.text.includes("custom JWT refresh-token rotation"),
      ),
    ).toBe(true);
  });
});

interface TestRuntime {
  backend: MastraMemoryBackend;
  memory: Memory;
}

async function openRuntime(databaseUrl: string): Promise<TestRuntime> {
  const config = testConfig();
  const store = new LibSQLStore({
    id: "buzz-memory-test-store",
    url: databaseUrl,
  });
  const vector = new LibSQLVector({
    id: "buzz-memory-test-vector",
    url: databaseUrl,
  });
  await store.init();
  const memory = createBuzzMemory(
    config,
    {
      storage: store,
      vector,
      embedder: deterministicEmbedder(),
    },
    silentLogger,
  );
  const backend = await MastraMemoryBackend.fromComponents(
    config,
    memory,
    {
      async health() {},
      async close() {
        await store.close();
        await vector.close();
      },
    },
    silentLogger,
  );
  return { backend, memory };
}

function deterministicEmbedder(): MemoryComponents["embedder"] {
  return {
    specificationVersion: "v2",
    provider: "buzz-test",
    modelId: "deterministic-words",
    maxEmbeddingsPerCall: 2_048,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map(wordVector),
        usage: {
          tokens: values.reduce(
            (total, value) => total + value.split(/\s+/u).length,
            0,
          ),
        },
      };
    },
  };
}

function wordVector(value: string): number[] {
  const vector = Array.from({ length: 32 }, () => 0);
  for (const word of value.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    let hash = 2_166_136_261;
    for (const character of word) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
    const bucket = Math.abs(hash) % vector.length;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) vector[0] = 1;
  else {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] ?? 0) / magnitude;
    }
  }
  return vector;
}

function testConfig(): MemoryServiceConfig {
  return loadConfig({
    MASTRA_OBSERVATION_MESSAGE_TOKENS: "900000",
    MASTRA_REFLECTION_OBSERVATION_TOKENS: "1000000",
    MASTRA_SEMANTIC_TOP_K: "6",
  });
}

function contextRequest(
  overrides: Partial<ContextRequest> = {},
): ContextRequest {
  return {
    communityId: "wss://community.example",
    projectId: "30621:owner:project",
    channelId: "architecture",
    agentId: "codex",
    sessionId: "session-default",
    message: "authentication architecture",
    ...overrides,
  };
}

function memoryRequest(
  overrides: Partial<MemoryRequest> = {},
): MemoryRequest {
  return {
    communityId: "wss://community.example",
    projectId: "30621:owner:project",
    channelId: "architecture",
    agentId: "codex",
    sessionId: "session-default",
    userMessage: "Use custom JWT authentication.",
    agentResponse: "Recorded.",
    toolEvents: [],
    metadata: {},
    ...overrides,
  };
}

const silentLogger: Logger = {
  log() {},
};
