// src/runtime/utils/safe-try.ts
// Valtaris Glue — Safe Try Utility
//
// Provides:
// - safeTry(asyncFn)
// - wraps async functions in a consistent success/error contract
// - used by worker, connectors, scheduler, replay, rollback

export interface SafeTrySuccess<T> {
  success: true;
  value: T;
}

export interface SafeTryFailure {
  success: false;
  errorCode: string;
  errorMessage: string;
}

export type SafeTryResult<T> = SafeTrySuccess<T> | SafeTryFailure;

export async function safeTry<T>(
  fn: () => Promise<T>
): Promise<SafeTryResult<T>> {
  try {
    const value = await fn();
    return { success: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "safe_try.failed",
      errorMessage: message,
    };
  }
}
