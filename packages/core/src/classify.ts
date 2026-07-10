import type { BindingEdge, ContributedStep, StepClassification } from "@bahama-ai/provider-kit";
import type { Lockfile } from "./lockfile.js";

/**
 * Routine/consequential classification lives HERE, in one place, and is
 * default-deny: a step is routine only when it provably (a) mutates no node
 * or edge of the resource/binding graph and (b) is reversible by another
 * routine step. Everything else — including step shapes this code has never
 * seen — is consequential. Providers declare effects; they don't vote.
 *
 * There is deliberately no "the user asked for this" input: any provenance
 * flag would be set by the agent operating the CLI and would provide only
 * false comfort. Auto-apply on all-routine is safe because of what routine
 * is DEFINED to be, not because of who initiated it.
 */

export interface ClassificationContext {
  lock: Lockfile | null;
  /** Resolved binding edges for the whole plan. */
  edges: BindingEdge[];
  /** Provider config fingerprints of the current working tree. */
  currentConfigFingerprints: Record<string, string>;
  /** Fingerprints recorded by the last successful deploy, per resource key. */
  lastDeployConfigFingerprints: Record<string, Record<string, string> | undefined>;
  /** Resource keys whose live provider framework disagrees with the manifest. */
  frameworkMismatches: Set<string>;
}

export interface Classified {
  classification: StepClassification;
  reasons: string[];
}

export function classifyStep(step: ContributedStep, ctx: ClassificationContext): Classified {
  const effects = step.effects;
  const reasons: string[] = [];

  if (effects.readOnly) return { classification: "routine", reasons: [] };

  if (effects.createsResource) reasons.push("creates a resource");
  if (effects.adoptsResource) reasons.push("adopts an existing resource into the lock");
  if (effects.destructive) reasons.push("destructive");
  if (effects.migratesSchema) reasons.push("executes a schema migration");
  if (effects.bindsAccount) reasons.push("binds or changes a provider account");

  if (effects.transfersSecret) {
    const reason = classifySecretTransfer(step, ctx);
    if (reason) reasons.push(reason);
  }

  if (effects.deploys) {
    reasons.push(...classifyDeploy(step, ctx));
  }

  const declared = Object.values(effects).some(Boolean);
  if (!declared) {
    // Default-deny: an effect-less mutation step is a provider bug, and it
    // does not get to ride the fast path because of it.
    reasons.push("step declared no effects; unclassifiable mutations require approval");
  }

  return reasons.length > 0
    ? { classification: "consequential", reasons }
    : { classification: "routine", reasons: [] };
}

/**
 * A secret transfer is routine ONLY when the exact binding edge — name,
 * source address, destination address — has been applied before (recorded in
 * the lock). Same destination name fed from a different source resource is
 * how production silently gets rewired to a different database; that is
 * consequential rewiring, not a refresh.
 */
function classifySecretTransfer(step: ContributedStep, ctx: ClassificationContext): string | null {
  const stepEdges = edgesForStep(step, ctx.edges);
  if (stepEdges.length === 0) {
    return "transfers a secret through an undeclared binding";
  }
  for (const edge of stepEdges) {
    const applied = (ctx.lock?.bindings ?? []).some(
      (known) =>
        known.name === edge.name &&
        known.from === addressString(edge.from) &&
        known.to === addressString(edge.to),
    );
    if (!applied) {
      return `first-time or rewired secret binding ${edge.name} (${addressString(edge.from)} → ${addressString(edge.to)})`;
    }
  }
  return null; // rotation of an unchanged edge
}

function classifyDeploy(step: ContributedStep, ctx: ClassificationContext): string[] {
  const reasons: string[] = [];
  const resourceKey = step.resourceKey ?? "application";

  const locked = ctx.lock?.resources[resourceKey];
  if (!locked || Object.keys(locked.identity).length === 0) {
    reasons.push("first deploy of this application");
    return reasons;
  }

  if (ctx.frameworkMismatches.has(resourceKey)) {
    reasons.push("live provider framework setting disagrees with the manifest");
  }

  // Provider config files (vercel.json, wrangler.toml…) ride the source
  // archive and can create crons/rewrites/etc. — compare against the last
  // successful deploy's receipt. No prior receipt on this machine means no
  // baseline, and no baseline means no fast path.
  const baseline = ctx.lastDeployConfigFingerprints[resourceKey];
  if (!baseline) {
    reasons.push("no local deploy receipt to compare provider config files against");
  } else {
    const files = new Set([...Object.keys(baseline), ...Object.keys(ctx.currentConfigFingerprints)]);
    for (const file of files) {
      if (baseline[file] !== ctx.currentConfigFingerprints[file]) {
        reasons.push(`provider config ${file} changed since the last verified deploy`);
      }
    }
  }
  return reasons;
}

function edgesForStep(step: ContributedStep, edges: BindingEdge[]): BindingEdge[] {
  const consumed = new Set(step.consumes ?? []);
  return edges.filter((edge) => consumed.has(addressString(edge.from)));
}

export function addressString(address: { resourceKey: string; capability: string }): string {
  return address.resourceKey === "application"
    ? `application.${address.capability}`
    : `resources.${address.resourceKey}.${address.capability}`;
}
