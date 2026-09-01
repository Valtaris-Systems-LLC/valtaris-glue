// src/runtime/utils/deep-merge.ts
// Valtaris Glue — Deep Merge Utility
//
// Provides:
// - deepMerge(a, b)
// - recursively merges objects
// - used for workflow payloads, connector outputs, metadata

export function deepMerge<T extends Record<string, any>, U extends Record<string, any>>(
  target: T,
  source: U
): T & U {
  const output: any = { ...target };

  for (const key of Object.keys(source)) {
    const value = source[key];

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof output[key] === "object" &&
      output[key] !== null &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}
