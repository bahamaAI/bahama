import {
  ProviderPlanError,
  type BindingEdge,
  type Decision,
  type JsonObject,
  type PlanContribution,
  type PlannedStep,
  type ProbeResult,
  type ProviderContext,
  type ProviderDriver,
  type ProviderFailureCode,
  type PlanOperation,
  type Requirement,
  type ResourceIntent,
} from "@bahama/provider-kit";
import { addressString, classifyStep, type ClassificationContext } from "./classify.js";
import { planContentId } from "./plan-store.js";
import { providerConfigFingerprints } from "./inspect.js";
import { lastSuccessfulDeploy, readJournal } from "./journal.js";
import { loadLock, lockHash, type Lockfile } from "./lockfile.js";
import { loadManifest, manifestHash, parseCapabilityAddress, type Manifest } from "./manifest.js";
import { currentRepoIdentity, repoIdentityMatches } from "./repo.js";

/** The immutable artifact `bahama apply` executes. Persisted under `.bahama/plans/`. */
export interface PlanDocument {
  planId: string;
  createdAt: string;
  manifestHash: string;
  lockHash: string;
  /** Provider-owned configuration reviewed when this plan was compiled. */
  providerConfigFingerprints: Record<string, string>;
  /**
   * The account each provider's steps run under: durable id (recorded in the
   * lock) plus display label, e.g. { vercel: { id: "team_abc", label: "studio" } }.
   */
  accounts: Record<string, { id: string; label: string; kind?: string }>;
  steps: PlannedStep[];
  warnings: string[];
  operation: PlanOperation;
}

export type PlanOutcome =
  | { kind: "plan"; plan: PlanDocument; manifest: Manifest; lock: Lockfile | null; edges: BindingEdge[] }
  | {
      kind: "blocked";
      status: "installation_required" | "auth_required" | "decision_required" | "failed";
      message: string;
      code?: ProviderFailureCode;
      requirements: Requirement[];
      decisions: Decision[];
      warnings: string[];
    };

export interface PlannerDeps {
  projectRoot: string;
  registry: ReadonlyMap<string, ProviderDriver>;
  contextFor: (providerId: string) => ProviderContext;
  operation?: PlanOperation;
}

/**
 * Compile declarative intent into a deterministic executable plan. Planning
 * performs READ operations only: manifest/lock/journal loads and provider
 * probes. The same manifest, lock, driver set, and live observations produce
 * the same plan id.
 */
export async function compilePlan(deps: PlannerDeps): Promise<PlanOutcome> {
  const warnings: string[] = [];
  const operation = deps.operation ?? { kind: "reconcile" as const };
  const manifest = await loadManifest(deps.projectRoot);
  const lock = await loadLock(deps.projectRoot);

  // Repo-identity guard: a lock bound in another repository is the
  // template-copy trap, not a normal plan input.
  if (lock) {
    const repo = await currentRepoIdentity(deps.projectRoot);
    if (!repoIdentityMatches(lock.repo, repo)) {
      return blocked("decision_required", {
        message:
          `bahama.lock was bound in a different repository (${lock.repo.kind}: ${lock.repo.value}). ` +
          `If this project is a copy, run \`bahama detach\` to re-provision under your own accounts; ` +
          `if the repo moved, re-run after confirming the resources are really yours.`,
        decisions: [
          {
            kind: "decision",
            id: "repo-identity",
            question: "This lock was created in a different repository. Reconnect to its resources or detach?",
            options: [
              { id: "detach", label: "Detach", description: "Clear resource identity and provision fresh resources." },
              { id: "reconnect", label: "Reconnect", description: "Keep the lock; these resources belong to this project." },
            ],
          },
        ],
      });
    }
  }

  const intents = collectIntents(manifest, deps.registry);
  if (intents.kind === "error") {
    return blocked("failed", { message: intents.message });
  }

  const edges = resolveBindingEdges(manifest, intents.byResourceKey, deps.registry);
  if (typeof edges === "string") {
    return blocked("failed", { message: edges });
  }

  // Probe every selected provider (read-only, non-interactive).
  const probes = new Map<string, ProbeResult>();
  const requirements: Requirement[] = [];
  for (const [providerId, providerIntents] of intents.byProvider) {
    const driver = deps.registry.get(providerId)!;
    const probe = await driver.probe(deps.contextFor(providerId), {
      intent: providerIntents,
      locked: lockedFor(lock, providerIntents),
    });
    probes.set(providerId, probe);
    warnings.push(...(probe.warnings ?? []));

    if (probe.failure) {
      return blocked("failed", {
        message: `${providerId} probe failed (${probe.failure.code}): ${probe.failure.message}`,
        code: probe.failure.code,
        warnings,
      });
    }
    if (!probe.tool.installed) {
      requirements.push({
        kind: "installation",
        providerId,
        tool: providerId,
        installHint: probe.tool.installHint ?? `Install the ${providerId} tool`,
      });
    } else if (probe.auth.state === "unknown") {
      return blocked("failed", {
        message:
          probe.auth.reason ??
          `${providerId} authentication could not be checked because the provider probe failed.`,
        code: probe.auth.code ?? "unknown",
        warnings,
      });
    } else if (probe.auth.state !== "authenticated") {
      requirements.push({
        kind: "auth",
        providerId,
        loginHint: probe.auth.loginHint ?? `bahama auth login ${providerId}`,
        reason: probe.auth.state === "expired" ? "expired" : probe.auth.state === "mismatch" ? "mismatch" : "missing",
      });
    }
  }
  if (requirements.length > 0) {
    const status = requirements.some((r) => r.kind === "installation") ? "installation_required" : "auth_required";
    return blocked(status, {
      message: "Provider tools or sessions are missing. Resolve the listed requirements, then re-run `bahama plan`.",
      requirements,
      warnings,
    });
  }

  // Collect contributions.
  const decisions: Decision[] = [];
  const steps: PlannedStep[] = [];
  for (const [providerId, providerIntents] of intents.byProvider) {
    const driver = deps.registry.get(providerId)!;
    let contribution: PlanContribution;
    try {
      contribution = await driver.plan(deps.contextFor(providerId), {
        intent: providerIntents,
        locked: lockedFor(lock, providerIntents),
        probe: probes.get(providerId)!,
        bindings: edges.filter((edge) =>
          providerIntents.some((i) => i.resourceKey === edge.from.resourceKey || i.resourceKey === edge.to.resourceKey),
        ),
        operation,
        appliedBindings: lock?.bindings ?? [],
      });
    } catch (error) {
      if (!(error instanceof ProviderPlanError)) throw error;
      return blocked("failed", {
        message: `${providerId} could not compile its plan: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
      });
    }
    warnings.push(...(contribution.warnings ?? []));
    decisions.push(...(contribution.decisions ?? []));
    requirements.push(...(contribution.requirements ?? []));
    for (const step of contribution.steps) {
      steps.push({ ...step, providerId, dependsOn: step.dependsOn ?? [], classification: "consequential" });
    }
  }
  if (requirements.length > 0 || decisions.length > 0) {
    return blocked(decisions.length > 0 ? "decision_required" : "auth_required", {
      message:
        decisions.length > 0
          ? "A choice is needed before a plan can be compiled. Answer by updating bahama.yaml (see each decision's writeBack)."
          : "Provider requirements surfaced during planning.",
      requirements,
      decisions,
      warnings,
    });
  }

  // Unique ids, then wire cross-provider dependencies through capabilities.
  const byId = new Map<string, PlannedStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      return blocked("failed", { message: `Duplicate step id \`${step.id}\` across providers — provider bug.` });
    }
    byId.set(step.id, step);
  }
  const producerByAddress = new Map<string, string>();
  for (const step of steps) {
    for (const capability of step.produces ?? []) {
      const address = addressString({ resourceKey: step.resourceKey ?? "application", capability });
      producerByAddress.set(address, step.id);
    }
  }
  for (const step of steps) {
    for (const consumed of step.consumes ?? []) {
      const producer = producerByAddress.get(consumed);
      if (!producer) {
        return blocked("failed", {
          message: `Step \`${step.id}\` consumes \`${consumed}\`, but no planned step produces it.`,
        });
      }
      if (producer !== step.id && !step.dependsOn.includes(producer)) step.dependsOn.push(producer);
    }
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        return blocked("failed", { message: `Step \`${step.id}\` depends on unknown step \`${dep}\`.` });
      }
    }
  }

  // Classify, then order deterministically.
  const classificationContext = await buildClassificationContext(deps.projectRoot, lock, edges, manifest, probes, intents.byResourceKey);
  for (const step of steps) {
    const { classification, reasons } = classifyStep(step, classificationContext);
    step.classification = classification;
    if (reasons.length > 0) step.classificationReasons = reasons;
  }
  const ordered = topoSort(steps);
  if (typeof ordered === "string") return blocked("failed", { message: ordered });

  // Prefer the durable account id; a display identity alone is the fallback
  // for providers that genuinely have no org/team concept.
  const accounts: PlanDocument["accounts"] = {};
  for (const [providerId, probe] of probes) {
    if (!steps.some((step) => step.providerId === providerId)) continue;
    if (probe.auth.account) {
      const { id, label, kind } = probe.auth.account;
      accounts[providerId] = { id, label, ...(kind !== undefined ? { kind } : {}) };
    } else if (probe.auth.identity) {
      accounts[providerId] = { id: probe.auth.identity, label: probe.auth.identity };
    }
  }

  // The id covers the FULL document (see planContentId): a plan whose
  // effects, wiring, postconditions, or accounts differ is a different plan,
  // and apply re-verifies this hash so the reviewed artifact is the executed one.
  const planBody = {
    manifestHash: manifestHash(manifest),
    lockHash: lockHash(lock),
    providerConfigFingerprints: classificationContext.currentConfigFingerprints,
    accounts,
    steps: ordered,
    warnings,
    operation,
  };

  return {
    kind: "plan",
    plan: {
      planId: planContentId(planBody),
      createdAt: new Date().toISOString(),
      ...planBody,
    },
    manifest,
    lock,
    edges,
  };
}

interface CollectedIntents {
  kind: "ok";
  byProvider: Map<string, ResourceIntent[]>;
  byResourceKey: Map<string, ResourceIntent>;
}

function collectIntents(
  manifest: Manifest,
  registry: ReadonlyMap<string, ProviderDriver>,
): CollectedIntents | { kind: "error"; message: string } {
  const byProvider = new Map<string, ResourceIntent[]>();
  const byResourceKey = new Map<string, ResourceIntent>();
  const environmentProviders = new Map<string, string>();
  for (const [name, environment] of Object.entries(manifest.environments)) {
    if (manifest.legacyApplication) continue;
    const prior = environmentProviders.get(environment.provider);
    if (prior) {
      return {
        kind: "error",
        message: `Provider \`${environment.provider}\` is selected for both \`${prior}\` and \`${name}\`. ` +
          "This alpha supports one environment per provider; use distinct providers or keep one hosted environment.",
      };
    }
    environmentProviders.set(environment.provider, name);
  }

  const push = (intent: ResourceIntent): string | null => {
    const driver = registry.get(intentProvider(manifest, intent.resourceKey));
    if (!driver) {
      return `Unknown provider \`${intentProvider(manifest, intent.resourceKey)}\` for \`${intent.resourceKey}\`. Run \`bahama providers\` to list available providers.`;
    }
    if (!driver.descriptor.roles.includes(intent.role)) {
      return `Provider \`${driver.descriptor.id}\` does not support the \`${intent.role}\` role.`;
    }
    if ((intent.role === "application" || intent.role === "environment") && intent.framework && driver.descriptor.frameworks) {
      if (!driver.descriptor.frameworks.includes(intent.framework)) {
        return (
          `Provider \`${driver.descriptor.id}\` does not support framework \`${intent.framework}\` ` +
          `(supported: ${driver.descriptor.frameworks.join(", ")}).`
        );
      }
    }
    const parsed = driver.intentSchema.safeParse(intent.config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<config>"}: ${issue.message}`);
      return `Invalid config for \`${intent.resourceKey}\` (provider ${driver.descriptor.id}): ${issues.join("; ")}`;
    }
    intent.config = parsed.data;
    const list = byProvider.get(driver.descriptor.id) ?? [];
    list.push(intent);
    byProvider.set(driver.descriptor.id, list);
    byResourceKey.set(intent.resourceKey, intent);
    return null;
  };

  if (manifest.legacyApplication) {
    const error = push({
      resourceKey: "application",
      role: "application",
      projectName: manifest.project.name,
      ...(manifest.application?.framework ? { framework: manifest.application.framework } : {}),
      config: manifest.legacyApplication.config ?? {},
    });
    if (error) return { kind: "error", message: error };
  }
  for (const [name, environment] of Object.entries(manifest.environments)) {
    if (manifest.legacyApplication) continue;
    const intent: ResourceIntent = {
      resourceKey: `environment.${name}`,
      role: "environment",
      environment: name,
      projectName: manifest.project.name,
      ...(manifest.application?.framework ? { framework: manifest.application.framework } : {}),
      config: {
        ...(environment.config ?? {}),
        ...(manifest.application?.dir ? { dir: manifest.application.dir } : {}),
      },
    };
    const error = push(intent);
    if (error) return { kind: "error", message: error };
  }

  for (const [key, resource] of Object.entries(manifest.resources)) {
    const driver = registry.get(resource.provider);
    const role = driver?.descriptor.roles.includes("database") && (resource.engine || driver.descriptor.engines)
      ? ("database" as const)
      : ("service" as const);
    const intent: ResourceIntent = {
      resourceKey: key,
      role,
      projectName: manifest.project.name,
      ...(resource.environment ? { environment: resource.environment } : {}),
      config: resource.config ?? {},
    };
    if (resource.engine !== undefined) intent.engine = resource.engine;
    const error = push(intent);
    if (error) return { kind: "error", message: error };
  }

  return { kind: "ok", byProvider, byResourceKey };
}

function intentProvider(manifest: Manifest, resourceKey: string): string {
  if (resourceKey === "application" && manifest.legacyApplication) return manifest.legacyApplication.provider;
  if (resourceKey.startsWith("environment.")) {
    return manifest.environments[resourceKey.slice("environment.".length)]!.provider;
  }
  return manifest.resources[resourceKey]!.provider;
}

function resolveBindingEdges(
  manifest: Manifest,
  intents: Map<string, ResourceIntent>,
  registry: ReadonlyMap<string, ProviderDriver>,
): BindingEdge[] | string {
  const edges: BindingEdge[] = [];
  for (const [name, binding] of Object.entries(manifest.bindings)) {
    const from = parseCapabilityAddress(binding.from);
    const destinations = Array.isArray(binding.to) ? binding.to : [binding.to];
    const fromProvider = registry.get(intentProvider(manifest, from.resourceKey))!;

    const produced = fromProvider.descriptor.produces.find((c) => c.capability === from.capability);
    if (!produced) {
      return `Binding ${name}: provider \`${fromProvider.descriptor.id}\` does not produce \`${from.capability}\`.`;
    }
    for (const destination of destinations) {
      const to = parseCapabilityAddress(destination);
      const toProvider = registry.get(intentProvider(manifest, to.resourceKey))!;
      const consumed = toProvider.descriptor.consumes.find((c) => c.capability === to.capability);
      if (!consumed) {
        return `Binding ${name}: provider \`${toProvider.descriptor.id}\` does not consume \`${to.capability}\`.`;
      }
      if (!intents.has(from.resourceKey) || !intents.has(to.resourceKey)) {
        return `Binding ${name} references a resource that is not part of this project.`;
      }
      edges.push({ name, from, to, secret: produced.secret });
    }
  }
  return edges;
}

function lockedFor(lock: Lockfile | null, intents: ResourceIntent[]) {
  if (!lock) return [];
  const result = [];
  for (const intent of intents) {
    const locked = lock.resources[intent.resourceKey];
    if (locked) {
      const entry: { resourceKey: string; identity: JsonObject; accountId?: string } = {
        resourceKey: intent.resourceKey,
        identity: locked.identity,
      };
      if (locked.accountId !== undefined) entry.accountId = locked.accountId;
      result.push(entry);
    }
  }
  return result;
}

async function buildClassificationContext(
  projectRoot: string,
  lock: Lockfile | null,
  edges: BindingEdge[],
  manifest: Manifest,
  probes: Map<string, ProbeResult>,
  intents: Map<string, ResourceIntent>,
): Promise<ClassificationContext> {
  const journal = await readJournal(projectRoot);
  const lastDeployConfigFingerprints: Record<string, Record<string, string> | undefined> = {};
  for (const resourceKey of intents.keys()) {
    const last = lastSuccessfulDeploy(journal, resourceKey);
    lastDeployConfigFingerprints[resourceKey] = last?.receipt?.["configFingerprints"] as
      | Record<string, string>
      | undefined;
  }

  // A provider reports each resource under its resource key. A live framework
  // disagreement downgrades deploys off the fast path.
  // disagreement with the manifest downgrades deploys off the fast path.
  const frameworkMismatches = new Set<string>();
  for (const [name, environment] of Object.entries(manifest.environments)) {
    if (manifest.legacyApplication) continue;
    const key = `environment.${name}`;
    const observed = probes.get(environment.provider)?.observed[key] as JsonObject | undefined;
    const observedFramework = observed?.["framework"];
    if (manifest.application && typeof observedFramework === "string" && observedFramework !== manifest.application.framework) {
      frameworkMismatches.add(key);
    }
  }
  if (manifest.legacyApplication && manifest.application) {
    const observed = probes.get(manifest.legacyApplication.provider)?.observed["application"] as JsonObject | undefined;
    const observedFramework = observed?.["framework"];
    if (typeof observedFramework === "string" && observedFramework !== manifest.application.framework) frameworkMismatches.add("application");
  }

  return {
    lock,
    edges,
    currentConfigFingerprints: await providerConfigFingerprints(projectRoot),
    lastDeployConfigFingerprints,
    frameworkMismatches,
  };
}

/** Kahn's algorithm with lexicographic tie-breaking for stable ordering. */
function topoSort(steps: PlannedStep[]): PlannedStep[] | string {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const inDegree = new Map(steps.map((step) => [step.id, step.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }
  const ready = steps
    .filter((step) => step.dependsOn.length === 0)
    .map((step) => step.id)
    .sort(compareIds(byId));
  const ordered: PlannedStep[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareIds(byId));
      }
    }
  }
  if (ordered.length !== steps.length) {
    const stuck = steps.filter((step) => !ordered.includes(step)).map((step) => step.id);
    return `Dependency cycle among steps: ${stuck.join(", ")}`;
  }
  return ordered;
}

function compareIds(byId: Map<string, PlannedStep>) {
  return (a: string, b: string): number => {
    const stepA = byId.get(a)!;
    const stepB = byId.get(b)!;
    return stepA.providerId.localeCompare(stepB.providerId) || stepA.id.localeCompare(stepB.id);
  };
}

function blocked(
  status: "installation_required" | "auth_required" | "decision_required" | "failed",
  fields: Partial<{
    message: string;
    code: ProviderFailureCode;
    requirements: Requirement[];
    decisions: Decision[];
    warnings: string[];
  }>,
): PlanOutcome {
  return {
    kind: "blocked",
    status,
    message: fields.message ?? "Planning is blocked.",
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    requirements: fields.requirements ?? [],
    decisions: fields.decisions ?? [],
    warnings: fields.warnings ?? [],
  };
}
