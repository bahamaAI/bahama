import { createHash } from "node:crypto";
import type { JsonValue } from "@bahama-ai/provider-kit";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Two
 * semantically equal values always hash identically, which is what makes
 * plan IDs deterministic across machines and processes.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = sortValue(entry);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashJson(value: JsonValue): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Short, prefixed id derived from content, e.g. `plan_7f4c9b21a3d0`. */
export function contentId(prefix: string, value: JsonValue): string {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 12)}`;
}
