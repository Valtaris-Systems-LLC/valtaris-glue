// src/runtime/utils/random.ts
// Valtaris Glue — Random Utilities
//
// Provides:
// - randomId()
// - randomInt()
// - randomString()

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomString(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
