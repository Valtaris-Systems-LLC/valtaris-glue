// src/runtime/retry-strategy.ts
// Valtaris Glue — Retry Strategy Engine
//
// This module defines how Glue handles retries for workflow jobs.
// It provides:
// - exponential backoff
// - retry windows
// - max attempt enforcement
// - DLQ thresholds
// - retryable vs non-retryable error classification
// - deterministic next-run scheduling

export interface RetryContext {
  attempts: number;
  maxAttempts: number;
  baseBackoffMs?: number;
  errorCode?: string;
}

export interface RetryDecision {
  shouldRetry: boolean;
  nextRunAt: string | null;
  isDeadLetter: boolean;
  reason: string;
}

export class RetryStrategy {
  private readonly defaultBackoff = 5000; // 5 seconds

  constructor(private readonly ctx: RetryContext) {}

  /**
   * Determines whether the job should retry or move to DLQ.
   */
  evaluate(): RetryDecision {
    const { attempts, maxAttempts, errorCode } = this.ctx;

    // Non-retryable errors
    if (this.isNonRetryable(errorCode)) {
      return {
        shouldRetry: false,
        nextRunAt: null,
        isDeadLetter: true,
        reason: `Non-retryable error: ${errorCode}`,
      };
    }

    // Exceeded max attempts
    if (attempts >= maxAttempts) {
      return {
        shouldRetry: false,
        nextRunAt: null,
        isDeadLetter: true,
        reason: `Exceeded max attempts (${attempts}/${maxAttempts})`,
      };
    }

    // Retry allowed
    const nextRunAt = this.calculateNextRun(attempts);

    return {
      shouldRetry: true,
      nextRunAt,
      isDeadLetter: false,
      reason: `Retry scheduled (attempt ${attempts + 1})`,
    };
  }

  /**
   * Determines if an error code is non-retryable.
   */
  private isNonRetryable(errorCode?: string): boolean {
    if (!errorCode) return false;

    const nonRetryableCodes = [
      "connector.not_found",
      "workflow.run.not_found",
      "workflow.definition.invalid",
      "compensation.not_found",
    ];

    return nonRetryableCodes.includes(errorCode);
  }

  /**
   * Calculates exponential backoff.
   */
  private calculateNextRun(attempts: number): string {
    const base = this.ctx.baseBackoffMs ?? this.defaultBackoff;
    const backoff = base * Math.pow(2, attempts);

    const next = new Date(Date.now() + backoff);
    return next.toISOString();
  }
}
