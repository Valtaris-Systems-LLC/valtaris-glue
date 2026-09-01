// src/runtime/utils/pretty.ts
// Valtaris Glue — Pretty Print Utility
//
// Provides:
// - pretty(obj)
// - safe pretty-printing for logs, debugging, workflow payloads

export function pretty(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
