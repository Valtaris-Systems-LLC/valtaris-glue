// src/runtime/utils/validator.ts
// Valtaris Glue — Validation Utilities
//
// Provides:
// - isRecord()
// - isString()
// - isNumber()
// - isArray()
// - assertRecord()
// - assertString()
// - assertNumber()
// - assertArray()

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value);
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function assertRecord(value: unknown, name = "value"): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`validator.error: '${name}' must be an object`);
  }
}

export function assertString(value: unknown, name = "value"): asserts value is string {
  if (!isString(value)) {
    throw new Error(`validator.error: '${name}' must be a string`);
  }
}

export function assertNumber(value: unknown, name = "value"): asserts value is number {
  if (!isNumber(value)) {
    throw new Error(`validator.error: '${name}' must be a number`);
  }
}

export function assertArray(value: unknown, name = "value"): asserts value is unknown[] {
  if (!isArray(value)) {
    throw new Error(`validator.error: '${name}' must be an array`);
  }
}
