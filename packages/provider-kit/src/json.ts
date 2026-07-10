/**
 * JSON-safe values. Everything that crosses a provider boundary — step inputs,
 * receipts, probe facts — must be representable as JsonValue so it can be
 * hashed, journaled, and rendered without surprises. Secrets are deliberately
 * not representable; they travel as SecretRef handles instead.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
