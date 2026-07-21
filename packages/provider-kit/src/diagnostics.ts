/** Stable, provider-neutral categories for expected external failures. */
export type ProviderFailureCode =
  | "authentication"
  | "permission"
  | "network"
  | "not-found"
  | "provider-api"
  | "incompatible-output"
  | "timeout"
  | "cancelled"
  | "unknown";
