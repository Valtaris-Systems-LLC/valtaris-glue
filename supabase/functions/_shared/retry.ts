# `supabase/functions/_shared/retry.ts`

```typescript
// Centralized retry / backoff policy.
//
// Workers ask this module:
//   1. whether a failed operation is eligible for retry
//   2. how long the next attempt should wait
//
// Design goals:
//   - retry only explicitly retryable failures
//   - never exceed the configured retry budget
//   - never produce a zero-delay retry
//   - cap exponential growth
//   - add jitter so concurrent workers do not synchronize retries
//   - tolerate malformed runtime values defensively
//
// This module intentionally contains no database or network behavior.

import type { ConnectorError } from "./connectors.ts";

export interface RetryPolicy {
  maxRetries: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseMs: 500,
  capMs: 30_000,
};

function finiteNonNegative(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return fallback;
  }

  return value;
}

function normalizePolicy(
  policy: RetryPolicy,
): RetryPolicy {
  const baseMs = Math.max(
    1,
    finiteNonNegative(
      policy.baseMs,
      DEFAULT_POLICY.baseMs,
    ),
  );

  const capMs = Math.max(
    baseMs,
    finiteNonNegative(
      policy.capMs,
      DEFAULT_POLICY.capMs,
    ),
  );

  const maxRetries = Math.max(
    0,
    Math.floor(
      finiteNonNegative(
        policy.maxRetries,
        DEFAULT_POLICY.maxRetries,
      ),
    ),
  );

  return {
    maxRetries,
    baseMs,
    capMs,
  };
}

/**
 * Determine whether a connector failure is eligible for another attempt.
 *
 * `attempt` represents the attempt that is about to occur.
 *
 * Example:
 *   maxRetries = 3
 *
 *   attempt 1 → retry allowed
 *   attempt 2 → retry allowed
 *   attempt 3 → retry allowed
 *   attempt 4 → retry denied
 *
 * The connector itself must explicitly mark the error as retryable.
 * Authentication, validation, and ordinary 4xx failures therefore
 * remain terminal unless the connector deliberately classifies them
 * otherwise.
 */
export function shouldRetry(
  err: ConnectorError | undefined,
  attempt: number,
  policy: RetryPolicy,
): boolean {
  if (!err) {
    return false;
  }

  if (!err.retryable) {
    return false;
  }

  const normalized =
    normalizePolicy(policy);

  const normalizedAttempt =
    Number.isFinite(attempt)
      ? Math.max(
          0,
          Math.floor(attempt),
        )
      : 0;

  return (
    normalizedAttempt <
    normalized.maxRetries
  );
}

/**
 * Calculate the delay before the next retry.
 *
 * Uses exponential growth with full jitter:
 *
 *   base × 2^attempt
 *
 * capped at `capMs`, then randomized within the resulting window.
 *
 * A minimum delay is enforced so a retry can never become an
 * immediate tight loop because Math.random() returned 0.
 */
export function nextBackoffMs(
  attempt: number,
  policy: RetryPolicy,
): number {
  const normalized =
    normalizePolicy(policy);

  const normalizedAttempt =
    Number.isFinite(attempt)
      ? Math.max(
          0,
          Math.floor(attempt),
        )
      : 0;

  /*
   * Avoid relying on a huge `2 ** attempt` value.
   *
   * Once the retry budget has grown beyond the cap, the result
   * remains capped instead of allowing Infinity or unsafe numbers.
   */
  let exponential =
    normalized.baseMs;

  for (
    let index = 0;
    index < normalizedAttempt;
    index += 1
  ) {
    if (
      exponential >=
      normalized.capMs
    ) {
      exponential =
        normalized.capMs;
      break;
    }

    exponential =
      Math.min(
        normalized.capMs,
        exponential * 2,
      );
  }

  const ceiling =
    Math.max(
      normalized.baseMs,
      Math.min(
        normalized.capMs,
        exponential,
      ),
    );

  /*
   * Full jitter:
   *
   *   0 < delay <= ceiling
   *
   * The lower bound is intentionally one millisecond rather than
   * zero. This prevents an eligible retry from becoming an immediate
   * upstream request.
   */
  const jitter =
    Math.random() *
      ceiling;

  return Math.max(
    1,
    Math.min(
      normalized.capMs,
      Math.round(jitter),
    ),
  );
}
```
