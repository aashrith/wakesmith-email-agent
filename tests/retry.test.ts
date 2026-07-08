import { describe, expect, it, vi } from "vitest";
import { isTransientNetworkError, withRetry } from "../src/lib/retry.js";

describe("withRetry", () => {
  it("returns the result immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a retryable failure and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("recovered");
    const result = await withRetry(fn, { retries: 2, baseDelayMs: 1, isRetryable: () => true });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max number of retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry when isRetryable returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("not retryable"));
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1, isRetryable: () => false })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientNetworkError", () => {
  it("treats connection-level error codes as retryable", () => {
    expect(isTransientNetworkError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientNetworkError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("treats a 5xx-shaped error message as retryable", () => {
    expect(isTransientNetworkError(new Error("OpenRouter request failed (503): overloaded"))).toBe(true);
  });

  it("does not treat a 4xx-shaped error message as retryable", () => {
    expect(isTransientNetworkError(new Error("OpenRouter request failed (401): bad key"))).toBe(false);
  });

  it("does not treat an arbitrary error as retryable", () => {
    expect(isTransientNetworkError(new Error("something else"))).toBe(false);
  });
});
