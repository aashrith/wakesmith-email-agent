/**
 * Deliberately minimal structured logging: JSON lines to stdout/stderr,
 * no external dependency. This project runs as one process against one
 * mailbox — pulling in pino/winston would be solving for a log-shipping
 * scale this doesn't have. If that ever changes, this is a drop-in
 * interface to swap the implementation behind.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
