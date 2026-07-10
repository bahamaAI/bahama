/**
 * Secrets never travel as strings through plans, receipts, logs, or provider
 * return values. A producing step seals the raw value with the SecretBroker
 * and gets back a SecretRef — an opaque, JSON-hostile handle carrying only
 * metadata. Consuming code hands the ref back to an injected primitive
 * (secret stdin, broker.use) at the moment of use.
 */

declare const SECRET_REF_BRAND: unique symbol;

export interface SecretRef {
  readonly [SECRET_REF_BRAND]: true;
  readonly id: string;
  /** Logical name, e.g. `DATABASE_URL`. Safe to display. */
  readonly name: string;
  /** One-way fingerprint (algorithm-prefixed) for drift checks. Safe to display. */
  readonly fingerprint: string;
}

/** Runtime check for values that may be either plain JSON or a sealed secret. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SecretRef).id === "string" &&
    typeof (value as SecretRef).name === "string" &&
    typeof (value as SecretRef).fingerprint === "string" &&
    (value as SecretRef).fingerprint.startsWith("sha256:")
  );
}

export interface SecretBroker {
  /**
   * Register a raw secret value. The value is registered with the redactor
   * before this call returns, so no later log line can leak it.
   */
  seal(name: string, value: string): SecretRef;

  /**
   * Use the raw value without ever holding it in provider-owned state.
   * The callback's return value must not contain the secret; the broker
   * re-scans and throws if it does.
   *
   * Only legal during step execution. Producing steps must be idempotently
   * re-callable: an interrupted apply resumes in a fresh process by
   * RE-DERIVING secrets from the provider, never from local state.
   */
  use<T>(ref: SecretRef, fn: (raw: string) => Promise<T>): Promise<T>;

  /** Metadata-only view for receipts and rendering. */
  describe(ref: SecretRef): { name: string; fingerprint: string };
}
