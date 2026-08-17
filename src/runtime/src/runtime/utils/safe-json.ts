// src/runtime/utils/safe-json.ts
// Valtaris Glue — Safe JSON Utilities
//
// Provides:
// - safe JSON.parse
// - safe JSON.stringify
// - consistent error codes
// - protection against malformed payloads

export interface SafeJsonResult<T> {
  success: boolean;
  value?: T;
  errorCode?: string;
  errorMessage?: string;
}

export function safeParse<T = unknown>(input: string): SafeJsonResult<T> {
  try {
    const value = JSON.parse(input) as T;
    return { success: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "json.parse_failed",
      errorMessage: message,
    };
  }
}

export function safeStringify(input: unknown): SafeJsonResult<string> {
  try {
    const value = JSON.stringify(input);
    return { success: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorCode: "json.stringify_failed",
      errorMessage: message,
    };
  }
}

