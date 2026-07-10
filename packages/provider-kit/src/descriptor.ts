import type { CapabilitySpec } from "./capabilities.js";

/**
 * Roles a provider can fill for a project. The set is open by design:
 * `service` covers future non-hosting providers (payments, auth, email)
 * without a kit rewrite.
 */
export type ProviderRole = "application" | "database" | "service";

export interface TestedToolVersion {
  tool: string;
  /** Semver range the driver is tested against. Newer versions warn, never block. */
  range: string;
}

/**
 * Everything the MODEL needs to choose this provider. The prose fields are
 * product behavior, not documentation garnish: `bahama providers` composes
 * them into the agent-facing selection guide, so they must stay accurate
 * next to the code they describe.
 */
export interface ProviderDescriptor {
  /** Stable id used in manifests, e.g. `vercel`. */
  id: string;
  name: string;
  roles: ProviderRole[];
  description: string;
  useWhen: string;
  avoidWhen: string;
  /** Human-readable prerequisites (account, CLI, pricing notes). */
  requirements: string[];
  /** Frameworks supported when filling the application role. */
  frameworks?: string[];
  /** Database engines supported when filling the database role. */
  engines?: string[];
  produces: CapabilitySpec[];
  consumes: CapabilitySpec[];
  testedVersions?: TestedToolVersion[];
  docsUrl?: string;
}
