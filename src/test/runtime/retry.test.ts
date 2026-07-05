import { describe, expect, it, vi } from "vitest";
import { nextBackoffMs, shouldRetry } from "../../../supabase/functions/_shared/retry.ts";
import { createRetryPlan } from "../../../supabase/functions/run-worker/logic.ts";

describe("retry and backoff logic", () => {
  it("retries only retryable connector failures within policy bounds", () => {
    expect(shouldRetry({ kind: "timeout", retryable: true, message: "slow" }, 1, { maxRetries: 3, baseMs: 500, capMs: 30_000 })).toBe(true);
    expect(shouldRetry({ kind: "validation", retryable: false, message: "bad input" }, 1, { maxRetries: 3, baseMs: 500, capMs: 30_000 })).toBe(false);
    expect(shouldRetry({ kind: "timeout", retryable: true, message: "slow" }, 3, { maxRetries: 3, baseMs: 500, capMs: 30_000 })).toBe(false);
  });

  it("caps randomized backoff at the retry policy maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(nextBackoffMs(10, { maxRetries: 3, baseMs: 500, capMs: 30_000 })).toBe(30_000);
  });

  it("builds a retry plan with a requeue timestamp for transient failures", () => {
    const plan = createRetryPlan({
      jobId: "job-1",
      nodeName: "Charge card",
      retryAttempt: 0,
      maxRetries: 4,
      error: { kind: "rate_limit", retryable: true, message: "back off" },
      now: new Date("2026-01-01T00:00:00.000Z"),
      backoffFactory: () => 1500,
    });

    expect(plan).not.toBeNull();
    expect(plan?.jobUpdate).toMatchObject({
      state: "retrying",
      retry_attempt: 1,
      error: "back off",
    });
    expect(plan?.event.message).toContain("retry 1/4 in 1500ms");
  });
});
