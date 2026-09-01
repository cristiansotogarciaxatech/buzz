import { z } from "zod";

const DEFAULT_DATABASE_URL =
  "postgresql://buzz_memory:buzz_memory_dev@127.0.0.1:5433/buzz_memory";

const integerFromEnv = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : value),
    z.coerce.number().int().min(minimum).max(maximum),
  );

const configSchema = z
  .object({
    bind: z.string().default("127.0.0.1"),
    port: integerFromEnv(4112, 1, 65_535),
    databaseUrl: z.string().min(1).default(DEFAULT_DATABASE_URL),
    schemaName: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default("buzz_mastra_memory"),
    authToken: z.string().min(24).optional(),
    observerModel: z.string().min(1).default("codex/gpt-5.6-sol"),
    reflectorModel: z.string().min(1).default("codex/gpt-5.6-sol"),
    codexPath: z.string().min(1).optional(),
    codexWorkingDirectory: z.string().min(1).optional(),
    codexReasoningEffort: z
      .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
      .default("low"),
    observationMessageTokens: integerFromEnv(6_000, 256, 1_000_000),
    reflectionObservationTokens: integerFromEnv(12_000, 512, 1_000_000),
    previousObserverTokens: integerFromEnv(2_000, 0, 100_000),
    semanticTopK: integerFromEnv(4, 1, 6),
    projectTokenBudget: integerFromEnv(1_800, 100, 5_000),
    channelTokenBudget: integerFromEnv(2_200, 100, 5_000),
    semanticTokenBudget: integerFromEnv(1_500, 100, 3_000),
    totalTokenBudget: integerFromEnv(5_500, 500, 6_000),
    maxBodyBytes: integerFromEnv(262_144, 4_096, 2_097_152),
    maxTurnChars: integerFromEnv(65_536, 1_024, 262_144),
  })
  .superRefine((config, context) => {
    if (
      !isLoopback(config.bind) &&
      (config.authToken === undefined || config.authToken.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authToken"],
        message: "MASTRA_MEMORY_AUTH_TOKEN is required for non-loopback binds",
      });
    }
    if (config.reflectionObservationTokens <= config.observationMessageTokens) {
      context.addIssue({
        code: "custom",
        path: ["reflectionObservationTokens"],
        message: "reflection threshold must exceed observation threshold",
      });
    }
    if (
      config.projectTokenBudget +
        config.channelTokenBudget +
        config.semanticTokenBudget <
      config.totalTokenBudget
    ) {
      context.addIssue({
        code: "custom",
        path: ["totalTokenBudget"],
        message: "total budget cannot exceed the sum of component budgets",
      });
    }
  });

export type MemoryServiceConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MemoryServiceConfig {
  return configSchema.parse({
    bind: environment.MASTRA_MEMORY_BIND,
    port: environment.MASTRA_MEMORY_PORT,
    databaseUrl: environment.MASTRA_MEMORY_DATABASE_URL,
    schemaName: environment.MASTRA_MEMORY_SCHEMA,
    authToken: environment.MASTRA_MEMORY_AUTH_TOKEN,
    observerModel: environment.MASTRA_OBSERVER_MODEL,
    reflectorModel: environment.MASTRA_REFLECTOR_MODEL,
    codexPath: environment.MASTRA_CODEX_PATH,
    codexWorkingDirectory: environment.MASTRA_CODEX_WORKING_DIRECTORY,
    codexReasoningEffort: environment.MASTRA_CODEX_REASONING_EFFORT,
    observationMessageTokens:
      environment.MASTRA_OBSERVATION_MESSAGE_TOKENS,
    reflectionObservationTokens:
      environment.MASTRA_REFLECTION_OBSERVATION_TOKENS,
    previousObserverTokens: environment.MASTRA_PREVIOUS_OBSERVER_TOKENS,
    semanticTopK: environment.MASTRA_SEMANTIC_TOP_K,
    projectTokenBudget: environment.MASTRA_PROJECT_TOKEN_BUDGET,
    channelTokenBudget: environment.MASTRA_CHANNEL_TOKEN_BUDGET,
    semanticTokenBudget: environment.MASTRA_SEMANTIC_TOKEN_BUDGET,
    totalTokenBudget: environment.MASTRA_TOTAL_TOKEN_BUDGET,
    maxBodyBytes: environment.MASTRA_MAX_BODY_BYTES,
    maxTurnChars: environment.MASTRA_MAX_TURN_CHARS,
  });
}

function isLoopback(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
