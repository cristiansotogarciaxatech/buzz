import { randomUUID } from "node:crypto";

import type { MastraDBMessage } from "@mastra/core/agent";
import { fastembed } from "@mastra/fastembed";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";

import type { MemoryBackend } from "./backend.js";
import { enforceContextBudgets } from "./budget.js";
import { resolveMemoryModel } from "./codex-language-model.js";
import type { MemoryServiceConfig } from "./config.js";
import type {
  ContextRequest,
  ContextResponse,
  MemoryRequest,
  MemoryWriteResponse,
  RelevantMemory,
  ToolEvent,
} from "./contracts.js";
import { channelThreadId, projectResourceId } from "./ids.js";
import { jsonLogger, type Logger } from "./logger.js";

const PROJECT_MEMORY_TEMPLATE = [
  "# Project Memory",
  "",
  "## Architecture",
  "",
  "## Decisions",
  "",
  "## Requirements",
  "",
  "## Constraints",
  "",
  "## Current State",
  "",
  "## Known Issues",
  "",
  "## Todo",
  "",
  "## Dependencies",
  "",
  "## Deployment",
  "",
  "## Preferences",
].join("\n");

const OBSERVER_INSTRUCTION = [
  "Treat this resource as a shared software project, not a personal profile.",
  "Promote only durable architecture, decisions, requirements, constraints,",
  "current state, known issues, todos, dependencies, deployment facts, and",
  "explicit preferences. Ignore acknowledgements and routine conversational noise.",
  "When newer evidence replaces an older decision, preserve the history while",
  "marking the older fact as superseded. Repository state and current instructions",
  "are more authoritative than remembered information.",
].join(" ");

const REFLECTOR_INSTRUCTION = [
  "Keep project observations compact, factual, and useful across agents and channels.",
  "Prefer active facts over superseded facts while preserving material decision history.",
  "Drop routine chatter and repetitive tool output.",
].join(" ");

interface BuzzMessageMetadata {
  communityId: string;
  projectId: string;
  channelId: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  requestMetadata?: Record<string, unknown>;
}

type MemoryConstructorConfig = NonNullable<
  ConstructorParameters<typeof Memory>[0]
>;

export interface MemoryComponents {
  storage: NonNullable<MemoryConstructorConfig["storage"]>;
  vector: NonNullable<MemoryConstructorConfig["vector"]>;
  embedder: NonNullable<MemoryConstructorConfig["embedder"]>;
}

export interface BackendLifecycle {
  health(): Promise<void>;
  close(): Promise<void>;
}

export class MastraMemoryBackend implements MemoryBackend {
  private readonly tails = new Map<string, Promise<void>>();

  private constructor(
    private readonly config: MemoryServiceConfig,
    private readonly memory: Memory,
    private readonly lifecycle: BackendLifecycle,
    private readonly logger: Logger,
  ) {}

  static async create(
    config: MemoryServiceConfig,
    logger: Logger = jsonLogger,
  ): Promise<MastraMemoryBackend> {
    const store = new PostgresStore({
      id: "buzz-mastra-memory",
      connectionString: config.databaseUrl,
      schemaName: config.schemaName,
      max: 10,
    });
    const vector = new PgVector({
      id: "buzz-mastra-memory-vector",
      connectionString: config.databaseUrl,
      schemaName: config.schemaName,
      max: 10,
    });
    try {
      await store.init();
    } catch (error) {
      await Promise.allSettled([store.close(), vector.pool.end()]);
      throw error;
    }
    const memory = createBuzzMemory(
      config,
      {
        storage: store,
        vector,
        embedder: fastembed,
      },
      logger,
    );
    return MastraMemoryBackend.fromComponents(
      config,
      memory,
      {
        async health() {
          await store.db.one("SELECT 1 AS ok");
        },
        async close() {
          await store.close();
          await vector.pool.end();
        },
      },
      logger,
    );
  }

  static async fromComponents(
    config: MemoryServiceConfig,
    memory: Memory,
    lifecycle: BackendLifecycle,
    logger: Logger = jsonLogger,
  ): Promise<MastraMemoryBackend> {
    const om = await memory.omEngine;
    if (om === null) {
      await lifecycle.close();
      throw new Error("Mastra observational memory failed to initialize");
    }
    logger.log("info", "mastra_memory_initialized", {
      schemaName: config.schemaName,
      observerModel: config.observerModel,
      reflectorModel: config.reflectorModel,
      semanticTopK: config.semanticTopK,
    });
    return new MastraMemoryBackend(config, memory, lifecycle, logger);
  }

  async health(): Promise<Record<string, unknown>> {
    await this.lifecycle.health();
    return {
      storage: "persistent",
      observerModel: this.config.observerModel,
      reflectorModel: this.config.reflectorModel,
    };
  }

  async context(request: ContextRequest): Promise<ContextResponse> {
    const resourceId = projectResourceId(request);
    const threadId = channelThreadId(request);
    return this.serialized(threadId, async () => {
      await this.ensureThread(request, resourceId, threadId);
      const [projectMemory, channelMemory, relevantMemories] = await Promise.all([
        this.memory.getWorkingMemory({ threadId, resourceId }),
        this.getChannelObservations(threadId, resourceId),
        this.recall(request, threadId, resourceId),
      ]);

      return enforceContextBudgets(
        projectMemory ?? "",
        channelMemory,
        relevantMemories,
        {
          project: this.config.projectTokenBudget,
          channel: this.config.channelTokenBudget,
          semantic: this.config.semanticTokenBudget,
          total: this.config.totalTokenBudget,
        },
      );
    });
  }

  async remember(request: MemoryRequest): Promise<MemoryWriteResponse> {
    const resourceId = projectResourceId(request);
    const threadId = channelThreadId(request);
    return this.serialized(threadId, async () => {
      await this.ensureThread(request, resourceId, threadId);
      const messages = this.turnMessages(request, resourceId, threadId);
      if (messages.length === 0) {
        return { stored: false, observed: false };
      }

      await this.memory.saveMessages({ messages });
      const observed = await this.runObservationalMemory(threadId, resourceId);
      return { stored: true, observed };
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.tails.values());
    await this.memory.settled();
    await this.lifecycle.close();
  }

  private async getChannelObservations(
    threadId: string,
    resourceId: string,
  ): Promise<string> {
    const om = await this.memory.omEngine;
    if (om === null) return "";
    return (await om.getObservations(threadId, resourceId)) ?? "";
  }

  private async recall(
    request: ContextRequest,
    threadId: string,
    resourceId: string,
  ): Promise<RelevantMemory[]> {
    if (request.message.trim().length === 0) return [];
    const result = await this.memory.recall({
      threadId,
      resourceId,
      vectorSearchString: request.message,
      threadConfig: {
        lastMessages: false,
        semanticRecall: {
          topK: this.config.semanticTopK,
          messageRange: 0,
          scope: "resource",
        },
      },
    });
    return result.messages
      .map((message) => toRelevantMemory(message))
      .filter((message): message is RelevantMemory => message !== null)
      .slice(0, this.config.semanticTopK);
  }

  private async ensureThread(
    request: Pick<
      ContextRequest,
      "communityId" | "projectId" | "channelId" | "agentId" | "sessionId"
    >,
    resourceId: string,
    threadId: string,
  ): Promise<void> {
    const existing = await this.memory.getThreadById({ threadId, resourceId });
    if (existing !== null) return;
    const now = new Date();
    await this.memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "Buzz channel " + request.channelId,
        createdAt: now,
        updatedAt: now,
        metadata: {
          buzz: {
            communityId: request.communityId,
            projectId: request.projectId,
            channelId: request.channelId,
            createdByAgentId: request.agentId,
            createdBySessionId: request.sessionId,
          },
        },
      },
    });
  }

  private turnMessages(
    request: MemoryRequest,
    resourceId: string,
    threadId: string,
  ): MastraDBMessage[] {
    const userText = clip(request.userMessage.trim(), this.config.maxTurnChars);
    const assistantText = clip(
      appendToolEvents(request.agentResponse.trim(), request.toolEvents),
      this.config.maxTurnChars,
    );
    if (userText.length === 0 && assistantText.length === 0) return [];

    const turnId = randomUUID();
    const timestamp = Date.now();
    const messages: MastraDBMessage[] = [];
    if (userText.length > 0) {
      messages.push(
        createMessage({
          id: randomUUID(),
          text: userText,
          role: "user",
          createdAt: new Date(timestamp),
          threadId,
          resourceId,
          metadata: buzzMetadata(request, turnId, "user"),
        }),
      );
    }
    if (assistantText.length > 0) {
      messages.push(
        createMessage({
          id: randomUUID(),
          text: assistantText,
          role: "assistant",
          createdAt: new Date(timestamp + 1),
          threadId,
          resourceId,
          metadata: buzzMetadata(request, turnId, "assistant"),
        }),
      );
    }
    return messages;
  }

  private async runObservationalMemory(
    threadId: string,
    resourceId: string,
  ): Promise<boolean> {
    const om = await this.memory.omEngine;
    if (om === null) return false;

    let status = await om.getStatus({ threadId, resourceId });
    if (status.canActivate) {
      await om.activate({ threadId, resourceId });
      status = await om.getStatus({ threadId, resourceId });
    }

    let observed = false;
    if (status.shouldObserve) {
      const result = await om.observe({
        threadId,
        resourceId,
        trigger: "manual",
      });
      observed = result.observed;
    } else if (status.shouldBuffer) {
      const result = await om.buffer({
        threadId,
        resourceId,
        pendingTokens: status.pendingTokens,
        record: status.record,
      });
      observed = result.buffered;
    }

    status = await om.getStatus({ threadId, resourceId });
    if (status.canActivate) {
      await om.activate({ threadId, resourceId, record: status.record });
      status = await om.getStatus({ threadId, resourceId });
    }
    if (status.shouldReflect) {
      const result = await om.reflect(threadId, resourceId);
      observed = observed || result.reflected;
    }
    return observed;
  }

  private async serialized<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.tails.set(key, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function createBuzzMemory(
  config: MemoryServiceConfig,
  components: MemoryComponents,
  logger: Logger = jsonLogger,
): Memory {
  const models = new Map<string, ReturnType<typeof resolveMemoryModel>>();
  const resolveModel = (specification: string) => {
    const existing = models.get(specification);
    if (existing !== undefined) return existing;
    const model = resolveMemoryModel(specification, {
      reasoningEffort: config.codexReasoningEffort,
      ...(config.codexPath === undefined ? {} : { codexPath: config.codexPath }),
      ...(config.codexWorkingDirectory === undefined
        ? {}
        : { workingDirectory: config.codexWorkingDirectory }),
    });
    models.set(specification, model);
    return model;
  };
  return new Memory({
    ...components,
    options: {
        lastMessages: false,
        workingMemory: {
          enabled: true,
          scope: "resource",
          agentManaged: false,
          template: PROJECT_MEMORY_TEMPLATE,
        },
        semanticRecall: {
          topK: config.semanticTopK,
          messageRange: 0,
          scope: "resource",
          indexConfig: {
            type: "hnsw",
            metric: "cosine",
          },
        },
        observationalMemory: {
          scope: "thread",
          observation: {
            model: resolveModel(config.observerModel),
            messageTokens: config.observationMessageTokens,
            bufferTokens: 0.2,
            bufferOnIdle: true,
            previousObserverTokens: config.previousObserverTokens,
            continuationHints: {
              currentTask: true,
              suggestedResponse: false,
            },
            manageWorkingMemory: true,
            observeAttachments: false,
            instruction: OBSERVER_INSTRUCTION,
          },
          reflection: {
            model: resolveModel(config.reflectorModel),
            observationTokens: config.reflectionObservationTokens,
            bufferActivation: 0.5,
            continuationHints: {
              currentTask: true,
              suggestedResponse: false,
            },
            instruction: REFLECTOR_INSTRUCTION,
          },
          hooks: {
            onObservationStart(info) {
              logger.log("debug", "mastra_observer_started", identifiers(info));
            },
            onObservationEnd(result) {
              logger.log(
                result.error ? "error" : "info",
                "mastra_observer_finished",
                {
                  ...identifiers(result),
                  inputTokens: result.usage?.inputTokens,
                  outputTokens: result.usage?.outputTokens,
                  error: result.error?.message,
                },
              );
            },
            onReflectionStart(info) {
              logger.log("debug", "mastra_reflector_started", identifiers(info));
            },
            onReflectionEnd(result) {
              logger.log(
                result.error ? "error" : "info",
                "mastra_reflector_finished",
                {
                  ...identifiers(result),
                  inputTokens: result.usage?.inputTokens,
                  outputTokens: result.usage?.outputTokens,
                  error: result.error?.message,
                },
              );
            },
          },
        },
    },
  });
}

function createMessage(input: {
  id: string;
  text: string;
  role: "user" | "assistant";
  createdAt: Date;
  threadId: string;
  resourceId: string;
  metadata: BuzzMessageMetadata;
}): MastraDBMessage {
  return {
    id: input.id,
    role: input.role,
    createdAt: input.createdAt,
    threadId: input.threadId,
    resourceId: input.resourceId,
    content: {
      format: 2,
      parts: [{ type: "text", text: input.text }],
      metadata: { buzz: input.metadata },
    },
  };
}

function buzzMetadata(
  request: MemoryRequest,
  turnId: string,
  role: "user" | "assistant",
): BuzzMessageMetadata {
  return {
    communityId: request.communityId,
    projectId: request.projectId,
    channelId: request.channelId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    turnId,
    role,
    ...(role === "assistant" && Object.keys(request.metadata).length > 0
      ? { requestMetadata: request.metadata }
      : {}),
  };
}

function appendToolEvents(response: string, toolEvents: ToolEvent[]): string {
  if (toolEvents.length === 0) return response;
  const summaries = toolEvents.map((event) => {
    const summary = event.summary ? " - " + clip(event.summary, 2_048) : "";
    return "- " + event.name + ": " + event.status + summary;
  });
  return [response, "", "Tool outcomes:", ...summaries].join("\n").trim();
}

function toRelevantMemory(message: MastraDBMessage): RelevantMemory | null {
  const text = message.content.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text.length === 0) return null;

  const metadata = message.content.metadata?.buzz;
  const buzz =
    metadata !== null && typeof metadata === "object"
      ? (metadata as Partial<BuzzMessageMetadata>)
      : undefined;
  return {
    text,
    ...(typeof buzz?.channelId === "string"
      ? { sourceChannelId: buzz.channelId }
      : {}),
    ...(typeof buzz?.agentId === "string"
      ? { sourceAgentId: buzz.agentId }
      : {}),
    ...(typeof buzz?.sessionId === "string"
      ? { sourceSessionId: buzz.sessionId }
      : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

function clip(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return value.slice(0, Math.max(0, maxCharacters - 3)) + "...";
}

function identifiers(
  info:
    | {
        threadId?: string;
        resourceId?: string;
        trigger?: string;
      }
    | undefined,
): Record<string, unknown> {
  return {
    threadId: info?.threadId,
    resourceId: info?.resourceId,
    trigger: info?.trigger,
  };
}
