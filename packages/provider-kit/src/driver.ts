import type { z } from "zod";
import type { JsonObject, JsonValue } from "./json.js";
import type { AppliedBinding, BindingEdge } from "./capabilities.js";
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
  /** Environment name for hosting/local targets (for example `local` or `production`). */
  environment?: string;
  /** Provider-specific config, already validated against `intentSchema`. */
  config: JsonObject;
}

export type PlanOperation =
  | { kind: "reconcile" }
  | { kind: "deploy"; environment: string };

/** Durable identity previously resolved into `bahama.lock` for one resource. */
export interface LockedIdentity {
  resourceKey: string;
  /** Provider account/team/org this resource was bound under. */
  accountId?: string;
  /** Provider-defined durable ids only — never attributes, URLs, or secrets. */
  identity: JsonObject;
}

export interface ProviderAccount {
  /** Durable provider id recorded in the plan and lock. */
  id: string;
  label: string;
  /** e.g. `personal`, `team`, `org`. */
  kind?: string;
  /** Non-secret manifest/CLI selector when it differs from the durable id. */
  selector?: string;
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
    /**
     * The account/team/org that operations will run under, with a DURABLE
     * provider id. Usernames and emails are labels that get renamed; the id
     * is what the lock records and revalidates against.
     */
    account?: ProviderAccount;
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
  /** Exact binding edges already materialized successfully in the lock. */
  appliedBindings?: AppliedBinding[];
  /** Why the plan is being compiled. Providers must not deploy during reconcile. */
  operation?: PlanOperation;
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

/** Official provider-CLI commands that Bahama may launch interactively. */
export interface ProviderAuthCommands {
  /** Executable candidates in preference order, e.g. ["neon", "neonctl"]. */
  executables: string[];
  loginArgs: string[];
  /** Omit when the provider CLI has no supported logout command. */
  logoutArgs?: string[];
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
  /** Optional interactive auth delegation; never used during probe/plan/apply. */
  authCommands?: ProviderAuthCommands;
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
