import { redactObject, redactString } from "./security/redact";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === "production" ? "info" : "debug");

/**
 * Structured JSON logger. Every payload goes through redaction so API keys, tokens,
 * passwords, OTPs and card data never reach the logs.
 */
function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: redactString(msg),
    ...(data ? (redactObject(data) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.name, message: err.message };
  return { error: String(err) };
}
