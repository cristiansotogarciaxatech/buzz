import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryBackend } from "../src/backend.js";
import { loadConfig } from "../src/config.js";
import type { ContextRequest, MemoryRequest } from "../src/contracts.js";
import { createMemoryHttpServer } from "../src/http.js";
import type { Logger } from "../src/logger.js";

const TOKEN = "a-secure-test-token-with-24-characters";

describe("memory HTTP service", () => {
  const servers: ReturnType<typeof createMemoryHttpServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("serves health, structured context, and memory writes", async () => {
    const backend = new FakeBackend();
    const { baseUrl } = await start(backend, servers);

    const health = await request(baseUrl + "/health", { method: "GET" });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", fake: true });

    const context = await request(baseUrl + "/context", {
      method: "POST",
      body: JSON.stringify(contextRequest()),
    });
    expect(context.status).toBe(200);
    expect(await context.json()).toEqual({
      projectMemory: "project",
      channelMemory: "channel",
      relevantMemories: [],
      estimatedTokens: 2,
    });

    const write = await request(baseUrl + "/memory", {
      method: "POST",
      body: JSON.stringify(memoryRequest()),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ stored: true, observed: false });
    expect(backend.writes).toHaveLength(1);
  });

  it("rejects missing bearer authentication", async () => {
    const { baseUrl } = await start(new FakeBackend(), servers);
    const response = await fetch(baseUrl + "/health");

    expect(response.status).toBe(401);
  });

  it("returns a bounded error without leaking backend details", async () => {
    const backend = new FakeBackend();
    backend.failContext = true;
    const { baseUrl, logs } = await start(backend, servers);

    const response = await request(baseUrl + "/context", {
      method: "POST",
      body: JSON.stringify(contextRequest()),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(logs.some((entry) => entry.event === "memory_http_error")).toBe(
      true,
    );
  });
});

class FakeBackend implements MemoryBackend {
  readonly writes: MemoryRequest[] = [];
  failContext = false;

  async health() {
    return { fake: true };
  }

  async context(_request: ContextRequest) {
    if (this.failContext) throw new Error("database-password-must-not-leak");
    return {
      projectMemory: "project",
      channelMemory: "channel",
      relevantMemories: [],
      estimatedTokens: 2,
    };
  }

  async remember(request: MemoryRequest) {
    this.writes.push(request);
    return { stored: true, observed: false };
  }

  async close() {}
}

async function start(
  backend: MemoryBackend,
  servers: ReturnType<typeof createMemoryHttpServer>[],
) {
  const logs: Array<{ event: string }> = [];
  const logger: Logger = {
    log(_level, event) {
      logs.push({ event });
    },
  };
  const config = loadConfig({ MASTRA_MEMORY_AUTH_TOKEN: TOKEN });
  const server = createMemoryHttpServer(backend, config, logger);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: "http://127.0.0.1:" + address.port, logs };
}

function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: "Bearer " + TOKEN,
      "content-type": "application/json",
    },
  });
}

function contextRequest(): ContextRequest {
  return {
    communityId: "community",
    projectId: "project",
    channelId: "channel",
    agentId: "agent",
    sessionId: "session",
    message: "remember the decision",
  };
}

function memoryRequest(): MemoryRequest {
  return {
    ...contextRequest(),
    userMessage: "Use JWT authentication.",
    agentResponse: "Recorded.",
    toolEvents: [],
    metadata: {},
  };
}
