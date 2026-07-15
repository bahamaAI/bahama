import { randomUUID } from "node:crypto";
import type { SecretBroker, SecretRef } from "@bahama/provider-kit";
import { sha256Hex } from "./hash.js";
import type { Redactor } from "./redact.js";

interface InternalRef {
  id: string;
  name: string;
  fingerprint: string;
}

/**
 * In-process secret store. Values live only in this map for the lifetime of
 * one CLI invocation — they are never journaled, so resume in a fresh process
 * re-derives them from the provider (drivers are contractually idempotent).
 */
export class InMemorySecretBroker implements SecretBroker {
  private readonly values = new Map<string, string>();

  constructor(private readonly redactor: Redactor) {}

  seal(name: string, value: string): SecretRef {
    const id = randomUUID();
    // Redaction registration happens BEFORE the ref escapes this function.
    this.redactor.register(value, name);
    this.values.set(id, value);
    const ref: InternalRef = {
      id,
      name,
      fingerprint: `sha256:${sha256Hex(value).slice(0, 16)}`,
    };
    return ref as unknown as SecretRef;
  }

  async use<T>(ref: SecretRef, fn: (raw: string) => Promise<T>): Promise<T> {
    const raw = this.values.get(ref.id);
    if (raw === undefined) {
      throw new Error(
        `Secret ${ref.name} (${ref.id}) is not available in this process. ` +
          `Secrets are never persisted; the producing step must be re-run to re-derive it.`,
      );
    }
    const result = await fn(raw);
    // Defense in depth: a driver must not return the raw value.
    try {
      const serialized = JSON.stringify(result);
      if (serialized !== undefined && this.redactor.contains(serialized)) {
        throw new Error(`SecretBroker.use callback for ${ref.name} returned the raw secret value.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("returned the raw secret")) throw error;
      // Non-serializable results (circular, bigint) cannot be journaled anyway.
    }
    return result;
  }

  describe(ref: SecretRef): { name: string; fingerprint: string } {
    return { name: ref.name, fingerprint: ref.fingerprint };
  }
}
