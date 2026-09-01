export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export const jsonLogger: Logger = {
  log(level, event, fields = {}) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
    const target =
      level === "error" || level === "warn" ? console.error : console.log;
    target(line);
  },
};
