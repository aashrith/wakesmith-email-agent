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

/**
 * `String(err)` collapses most library errors down to just their
 * `.message` — fine for our own domain errors, but it silently drops
 * the fields that actually explain *why* for IMAP/SMTP failures.
 * imapflow in particular throws a generic `Error("Command failed")`
 * for any NO/BAD server response and attaches the real reason
 * (`executedCommand`, `responseStatus`, `response`) as extra
 * properties rather than in the message — logging only the message
 * makes every such failure look identical and undiagnosable. This
 * pulls out whatever's actually present without assuming a specific
 * error shape.
 */
export function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const known = ["executedCommand", "responseStatus", "response", "serverResponseCode", "code", "authenticationFailed"] as const;
  const extra: Record<string, unknown> = {};
  for (const key of known) {
    const value = (err as unknown as Record<string, unknown>)[key];
    if (value !== undefined) extra[key] = value;
  }
  return { error: err.message, ...extra };
}
