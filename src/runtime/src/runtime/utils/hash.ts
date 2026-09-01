// src/runtime/utils/hash.ts
// Valtaris Glue — Hash Utility
//
// Provides:
// - hashString()
// - hashObject()
// - stable SHA-256 hashing for payloads, configs, metadata

export async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

export async function hashObject(obj: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(obj);
  return hashString(json);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
