import { loadConfig } from "./config.js";
import { createMemoryHttpServer } from "./http.js";
import { jsonLogger } from "./logger.js";
import { MastraMemoryBackend } from "./mastra-backend.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const backend = await MastraMemoryBackend.create(config, jsonLogger);
  const server = createMemoryHttpServer(backend, config, jsonLogger);

  server.listen(config.port, config.bind, () => {
    jsonLogger.log("info", "mastra_memory_listening", {
      bind: config.bind,
      port: config.port,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    jsonLogger.log("info", "mastra_memory_shutdown", { signal });
    server.close();
    await backend.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  jsonLogger.log("error", "mastra_memory_start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
