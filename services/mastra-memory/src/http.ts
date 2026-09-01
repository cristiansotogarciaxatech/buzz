import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ZodError } from "zod";

import type { MemoryBackend } from "./backend.js";
import type { MemoryServiceConfig } from "./config.js";
import { contextRequestSchema, memoryRequestSchema } from "./contracts.js";
import { jsonLogger, type Logger } from "./logger.js";

export function createMemoryHttpServer(
  backend: MemoryBackend,
  config: MemoryServiceConfig,
  logger: Logger = jsonLogger,
) {
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    try {
      if (!isAuthorized(request, config.authToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        const details = await backend.health();
        sendJson(response, 200, { status: "ok", ...details });
        return;
      }

      if (request.method === "POST" && pathname === "/context") {
        const payload = contextRequestSchema.parse(
          await readJson(request, config.maxBodyBytes),
        );
        const context = await backend.context(payload);
        logger.log("info", "memory_context_retrieved", {
          communityId: payload.communityId,
          projectId: payload.projectId,
          channelId: payload.channelId,
          resultCount: context.relevantMemories.length,
          estimatedTokens: context.estimatedTokens,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        sendJson(response, 200, context);
        return;
      }

      if (request.method === "POST" && pathname === "/memory") {
        const payload = memoryRequestSchema.parse(
          await readJson(request, config.maxBodyBytes),
        );
        const result = await backend.remember(payload);
        logger.log("info", "memory_turn_stored", {
          communityId: payload.communityId,
          projectId: payload.projectId,
          channelId: payload.channelId,
          agentId: payload.agentId,
          observed: result.observed,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status =
        error instanceof ZodError
          ? 400
          : error instanceof RequestBodyError
            ? error.status
            : 500;
      logger.log(status >= 500 ? "error" : "warn", "memory_http_error", {
        method: request.method,
        path: request.url,
        status,
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(response, status, {
        error: status >= 500 ? "internal_error" : "invalid_request",
      });
    }
  });
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new RequestBodyError(413, "request body exceeds configured limit");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "request body must be valid JSON");
  }
}

function isAuthorized(
  request: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
