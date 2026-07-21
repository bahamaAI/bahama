import type { ProviderFailureCode } from "./diagnostics.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { SecretRef } from "./secrets.js";
import type { Decision, Requirement } from "./results.js";

/**
 * Semantic effects of a step, declared by the provider. The CORE engine — not
 * the provider — derives routine/consequential classification from these
 * plus binding-edge and receipt comparisons. Providers state what a step
 * does; they do not get to vote on whether it needs approval.
 */
export interface StepEffects {
  /** Creates a resource that does not exist yet. */
  createsResource?: boolean;
  /** Adopts an existing live resource into the lock. */
  adoptsResource?: boolean;
  /** Destroys or overwrites something unrecoverable. */
  destructive?: boolean;
  /** Executes schema DDL. Always consequential. */
  migratesSchema?: boolean;
  /** Writes a secret to a destination. Consequential unless the binding edge is unchanged. */
  transfersSecret?: boolean;
  /** Publishes application code (a deploy). Routine once the stack exists. */
  deploys?: boolean;
  /** Binds or changes a provider account/team/org. Always consequential. */
  bindsAccount?: boolean;
  /** Changes provider-side runtime/build configuration. Always consequential. */
  changesConfiguration?: boolean;
  /** Pure read/verify. Always routine. */
  readOnly?: boolean;
}

/** A step as contributed by one provider during planning. No mutation yet. */
export interface ContributedStep {
  /** Stable id within the plan, e.g. `database`, `deploy`. */
  id: string;
  /** Namespaced action the driver executes, e.g. `neon.project.ensure`. */
  action: string;
  /** One-sentence summary rendered to humans and agents. */
  summary: string;
  /** Manifest resource this step operates on (`application` or a resources key). */
  resourceKey?: string;
  effects: StepEffects;
  /** Ids of steps (from any provider) this step depends on. */
  dependsOn?: string[];
  /** Serializable inputs. Hash-stable; never contains secrets. */
  inputs?: JsonObject;
  /** Capability names this step produces, e.g. ["connectionUrl"]. */
  produces?: string[];
  /**
   * Capability addresses this step consumes, e.g.
   * ["resources.database.connectionUrl"]. Core wires cross-provider
   * dependencies from these — a consuming step never needs to know which
   * provider (or step id) produces the value.
   */
  consumes?: string[];
  /** What must be true afterwards, stated for the human/agent. */
  postcondition: string;
}

/** A provider's full contribution for one planning pass. */
export interface PlanContribution {
  steps: ContributedStep[];
  requirements?: Requirement[];
  decisions?: Decision[];
  warnings?: string[];
}

export type StepClassification = "routine" | "consequential";

/** A compiled, immutable plan step (core adds ordering and classification). */
export interface PlannedStep extends ContributedStep {
  providerId: string;
  classification: StepClassification;
  /** Present when consequential: the reasons, for rendering. */
  classificationReasons?: string[];
  dependsOn: string[];
}

/**
 * The outcome of executing one step. `receipt` is journaled verbatim, so it
 * must already be redaction-safe; produced secrets travel as SecretRef.
 */
export interface StepOutcome {
  status: "succeeded" | "failed";
  /**
   * Values for the capabilities this step declared. Secret capabilities MUST
   * be SecretRef; plain values must be JSON-safe.
   */
  produced?: Record<string, JsonValue | SecretRef>;
  /**
   * True only after the driver VERIFIED the postcondition against live
   * provider state. Command exit codes are not verification.
   */
  postconditionVerified: boolean;
  /** Durable identity to record in the lock, e.g. { projectId: "prj_123" }. */
  identity?: JsonObject;
  /** Redaction-safe evidence for the journal. */
  receipt?: JsonObject;
  /** Human-readable failure cause and recovery hint. */
  error?: { code?: ProviderFailureCode; message: string; recovery?: string };
}
