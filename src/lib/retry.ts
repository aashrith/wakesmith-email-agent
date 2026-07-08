/**
 * Small exponential-backoff retry for the two genuinely transient IO
 * paths in this project: the OpenRouter HTTP call and the SMTP/IMAP
 * connections. Not applied anywhere else — retrying a domain error
 * (e.g. IllegalTransitionError) would be wrong, since it's not going to
 * succeed on attempt two.
 */

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 300, isRetryable = () => true } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const delayMs = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/** Transient network errors (connection refused/reset, timeouts) — the
 * class of failure a retry can plausibly fix. Malformed input, auth
 * failures, and 4xx responses are not included on purpose. */
export function isTransientNetworkError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /request failed \(5\d\d\)/i.test(message);
}
