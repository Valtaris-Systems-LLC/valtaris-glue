// src/runtime/utils/time.ts
// Valtaris Glue — Time Utilities
//
// Provides:
// - now() — ISO timestamp
// - unix() — seconds since epoch
// - ms() — milliseconds since epoch
// - addMs(), addSeconds(), addMinutes(), addHours(), addDays()

export function now(): string {
  return new Date().toISOString();
}

export function unix(): number {
  return Math.floor(Date.now() / 1000);
}

export function ms(): number {
  return Date.now();
}

export function addMs(timestamp: string, amount: number): string {
  return new Date(new Date(timestamp).getTime() + amount).toISOString();
}

export function addSeconds(timestamp: string, amount: number): string {
  return addMs(timestamp, amount * 1000);
}

export function addMinutes(timestamp: string, amount: number): string {
  return addMs(timestamp, amount * 60 * 1000);
}

export function addHours(timestamp: string, amount: number): string {
  return addMs(timestamp, amount * 60 * 60 * 1000);
}

export function addDays(timestamp: string, amount: number): string {
  return addMs(timestamp, amount * 24 * 60 * 60 * 1000);
}
