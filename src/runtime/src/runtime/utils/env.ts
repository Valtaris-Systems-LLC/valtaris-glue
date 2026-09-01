// src/runtime/utils/env.ts
// Valtaris Glue — Environment Variable Utility
//
// Provides:
// - env(key) — returns string or undefined
// - envOr(key, defaultValue)
// - envRequired(key) — throws if missing

export function env(key: string): string | undefined {
  return process.env[key];
}

export function envOr(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value !== undefined ? value : defaultValue;
}

export function envRequired(key: string): string {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`env.missing: Required environment variable '${key}' is not set`);
  }
  return value;
}
