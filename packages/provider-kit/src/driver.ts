import type { z } from "zod";
import type { JsonObject, JsonValue } from "./json.js";
import type { BindingEdge } from "./capabilities.js";
import type { ProviderContext } from "./context.js";
import type { ProviderDescriptor, ProviderRole } from "./descriptor.js";
import type { SecretRef } from "./secrets.js";
import type { PlanContribution, PlannedStep, StepOutcome } from "./steps.js";

/** One resource this provider fills, as validated from `bahama.yaml`. */
export interface ResourceIntent {
  /** Manifest key: `application`, or a key under `resources:` (e.g. `database`). */
  resourceKey: string;
  role: ProviderRole;
  /** The manifest's `project.name` — the default name for provider resources. */
  projectName?: string;
  framework?: string;
  engine?: string;
  /** Provider-specific config, already validated against `intentSchema`. */
  config: JsonObject;
}

/** Durable identity previously resolved into `bahama.lock` for one resource. */
export interface LockedIdentity {
  resourceKey: string;
  /** Provider account/team/org this resource was bound under. */
  accountId?: string;
  /** Provider-defined durable ids only — never attributes, URLs, or secrets. */
  identity: JsonObject;
}

export interface ProviderAccount {
  id: string;
  label: string;
  /** e.g. `personal`, `team`, `org`. */
  kind?: string;
}

export type ToolCompatibility = "tested" | "untested-newer" | "unsupported";

/**
 * Read-only inspection of tool, session, accounts, and live resource state.
 * Probing runs with stdin closed and interactivity disabled: it must never
 * mutate anything or start a browser login.
 */
export interface ProbeResult {
  tool: {
    installed: boolean;
    version?: string;
    compatibility?: ToolCompatibility;
    installHint?: string;
  };
  auth: {
    state: "authenticated" | "unauthenticated" | "expired" | "mismatch";
    /** Display identity, e.g. an email or username. Never a token. */
    identity?: string;
    loginHint?: string;
  };
  accounts: ProviderAccount[];
  /** Live observations relevant to the given intent/lock (existence, settings). */
  observed: JsonObject;
  warnings?: string[];
}

export interface ProbeRequest {
  intent: ResourceIntent[];
  locked: LockedIdentity[];
}

export interface PlanRequest {
  intent: ResourceIntent[];
  locked: LockedIdentity[];
  probe: ProbeResult;
  /** Binding edges that touch this provider's resources (either side). */
  bindings: BindingEdge[];
}

/** Values resolved from dependency steps at execution time. */
export interface ExecutionInputs {
  /**
   * Capability values consumed by this step, keyed by full address
   * (`resources.database.connectionUrl`, `application.productionUrl`).
   * Secret capabilities arrive as SecretRef.
   */
  consumed: Record<string, JsonValue | SecretRef>;
}

export interface DriftFinding {
  severity: "info" | "material";
  resourceKey: string;
  message: string;
}

export interface ResourceStatus {
  resourceKey: string;
  exists: boolean;
  healthy: boolean | "unknown";
  /** Display detail, e.g. a deployment URL or branch name. */
  detail?: string;
  drift: DriftFinding[];
}

export interface StatusReport {
  resources: ResourceStatus[];
}

/**
 * A Bahama provider driver. Four verbs, one discipline:
 *
 * - `probe` inspects; it never mutates.
 * - `plan` compares validated intent with observed state and contributes
 *   steps; it never mutates.
 * - `execute` performs exactly one previously planned step, then VERIFIES its
 *   postcondition against live state before reporting success.
 * - `status` reports normalized live state and drift.
 */
export interface ProviderDriver {
  descriptor: ProviderDescriptor;
  /** Validates the provider-specific `config` block of each resource. */
  intentSchema: z.ZodType<JsonObject, z.ZodTypeDef, unknown>;
  probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult>;
  plan(ctx: ProviderContext, req: PlanRequest): Promise<PlanContribution>;
  execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome>;
  status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport>;
}

/**
 * Identity helper that pins the driver shape at the definition site, so
 * provider packages get full type checking without importing core.
 */
export function defineProvider(driver: ProviderDriver): ProviderDriver {
  return driver;
}
