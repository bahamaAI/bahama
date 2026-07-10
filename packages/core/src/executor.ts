import { randomUUID } from "node:crypto";
import {
  isSecretRef,
  type ExecutionInputs,
  type JsonObject,
  type JsonValue,
  type PlannedStep,
  type ProviderContext,
  type ProviderDriver,
  type SecretRef,
  type StepOutcome,
} from "@bahama-ai/provider-kit";
import { addressString } from "./classify.js";
import { canonicalJson } from "./hash.js";
import { inspectProject, providerConfigFingerprints } from "./inspect.js";
import { appendJournal, hasUnfinishedApply, readJournal, verifiedSteps } from "./journal.js";
import { loadLock, lockHash, saveLock, emptyLock, type Lockfile } from "./lockfile.js";
import { loadManifest, manifestHash } from "./manifest.js";
import { OperationLock } from "./oplock.js";
import { loadPlan } from "./plan-store.js";
import type { PlanDocument } from "./planner.js";
import { currentRepoIdentity, repoIdentityMatches } from "./repo.js";
import type { Redactor } from "./redact.js";

export interface ApplyDeps {
  projectRoot: string;
  registry: ReadonlyMap<string, ProviderDriver>;
  contextFor: (providerId: string) => ProviderContext;
  redactor: Redactor;
}

export interface StepSummary extends JsonObject {
  id: string;
  summary: string;
  status: "succeeded" | "skipped-verified";
}

export type ApplyOutcome =
  | { kind: "approval_required"; message: string; plan: PlanDocument }
  | { kind: "stale"; message: string }
  | { kind: "repo-mismatch"; message: string }
  | { kind: "succeeded"; opId: string; planId: string; steps: StepSummary[] }
  | { kind: "failed"; opId: string; planId: string; stepId: string; message: string; recovery?: string };

/**
 * Execute an approved plan. Dependency order, one step at a time, verify the
 * postcondition, journal the receipt, update the lock atomically — and after
 * an interruption, resume from verified receipts instead of re-creating
 * resources. Secrets produced in a previous process are RE-DERIVED by
 * re-executing their (idempotent) producing step; they are never persisted.
 */
export async function applyPlan(
  deps: ApplyDeps,
  planId: string,
  options: { approved: boolean },
): Promise<ApplyOutcome> {
  const loaded = await loadPlan(deps.projectRoot, planId);
  if (loaded.kind === "missing") {
    return { kind: "stale", message: `Plan ${planId} not found. Run \`bahama plan\` to compile a fresh plan.` };
  }
  if (loaded.kind === "invalid") {
    return { kind: "stale", message: `${loaded.message} Run \`bahama plan\` to compile a fresh plan.` };
  }
  const plan = loaded.plan;

  // Validity: intent and resolution must be exactly what was planned. Source
  // drift deliberately does NOT invalidate — apply ships the source that
  // exists now and records its fingerprint in the receipt.
  const manifest = await loadManifest(deps.projectRoot);
  if (manifestHash(manifest) !== plan.manifestHash) {
    return {
      kind: "stale",
      message: "bahama.yaml changed after this plan was compiled. Re-run `bahama plan`.",
    };
  }
  let lock = await loadLock(deps.projectRoot);
  const priorEntries = await readJournal(deps.projectRoot);
  // Resume = the plan's most recent apply never finished. A COMPLETED apply
  // does not make later applies of the same plan "resumes" — they are fresh
  // runs that re-execute every step.
  const isResume = hasUnfinishedApply(priorEntries, planId);
  // A resumed apply legitimately advanced the lock through its own verified
  // steps, so the exact-hash check only applies to a plan's FIRST attempt.
  if (!isResume && lockHash(lock) !== plan.lockHash) {
    return {
      kind: "stale",
      message: "bahama.lock changed after this plan was compiled. Re-run `bahama plan`.",
    };
  }
  const repo = await currentRepoIdentity(deps.projectRoot);
  if (lock && !repoIdentityMatches(lock.repo, repo)) {
    return {
      kind: "repo-mismatch",
      message: "bahama.lock was bound in a different repository. Run `bahama detach` or reconcile before applying.",
    };
  }

  const consequential = plan.steps.filter((step) => step.classification === "consequential");
  if (consequential.length > 0 && !options.approved) {
    return {
      kind: "approval_required",
      message:
        `Plan ${planId} contains ${consequential.length} consequential step(s). ` +
        `Present the plan to the user, then apply with --approved.`,
      plan,
    };
  }

  const opLock = new OperationLock(deps.projectRoot);
  await opLock.acquire();
  const opId = `op_${randomUUID().slice(0, 12)}`;

  try {
    await appendJournal(deps.projectRoot, { type: "apply-start", at: new Date().toISOString(), opId, planId });

    const verified = verifiedSteps(priorEntries, planId);

    /** Capability values available to consumers, keyed by full address. */
    const produced = new Map<string, JsonValue | SecretRef>();
    // Non-secret values from verified receipts are recoverable immediately.
    for (const [stepId, entry] of verified) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) continue;
      for (const [capability, value] of Object.entries(entry.producedValues ?? {})) {
        produced.set(addressString({ resourceKey: step.resourceKey ?? "application", capability }), value);
      }
    }

    lock ??= emptyLock(repo, plan.manifestHash);
    const summaries: StepSummary[] = [];

    for (const step of plan.steps) {
      if (verified.has(step.id)) {
        summaries.push({ id: step.id, summary: step.summary, status: "skipped-verified" });
        continue;
      }

      // Re-derive any missing consumed values whose producer already ran in a
      // previous process (secret values are never persisted, so this is the
      // only way a resumed apply can feed them to consumers).
      for (const address of step.consumes ?? []) {
        if (produced.has(address)) continue;
        const producer = plan.steps.find((candidate) =>
          (candidate.produces ?? []).some(
            (capability) =>
              addressString({ resourceKey: candidate.resourceKey ?? "application", capability }) === address,
          ),
        );
        if (!producer || !verified.has(producer.id)) {
          throw new Error(`Internal: step ${step.id} consumes ${address} but its producer has not completed.`);
        }
        const outcome = await executeStep(deps, plan, producer, produced, lock, opId, { rederivation: true });
        if (outcome.status !== "succeeded") {
          await appendJournal(deps.projectRoot, {
            type: "apply-end",
            at: new Date().toISOString(),
            opId,
            planId,
            status: "failed",
          });
          return failure(opId, planId, producer.id, outcome);
        }
      }

      const outcome = await executeStep(deps, plan, step, produced, lock, opId, { rederivation: false });
      if (outcome.status !== "succeeded") {
        await appendJournal(deps.projectRoot, {
          type: "apply-end",
          at: new Date().toISOString(),
          opId,
          planId,
          status: "failed",
        });
        return failure(opId, planId, step.id, outcome);
      }
      summaries.push({ id: step.id, summary: step.summary, status: "succeeded" });
    }

    // The applied manifest is now the locked baseline.
    lock.manifestHash = plan.manifestHash;
    await saveLock(deps.projectRoot, lock);

    await appendJournal(deps.projectRoot, {
      type: "apply-end",
      at: new Date().toISOString(),
      opId,
      planId,
      status: "succeeded",
    });
    return { kind: "succeeded", opId, planId, steps: summaries };
  } finally {
    await opLock.release();
  }
}

async function executeStep(
  deps: ApplyDeps,
  plan: PlanDocument,
  step: PlannedStep,
  produced: Map<string, JsonValue | SecretRef>,
  lock: Lockfile,
  opId: string,
  options: { rederivation: boolean },
): Promise<StepOutcome> {
  const driver = deps.registry.get(step.providerId);
  if (!driver) {
    return {
      status: "failed",
      postconditionVerified: false,
      error: { message: `Provider ${step.providerId} is not registered in this CLI build.` },
    };
  }

  const inputs: ExecutionInputs = { consumed: {} };
  for (const address of step.consumes ?? []) {
    const value = produced.get(address);
    if (value === undefined) {
      return {
        status: "failed",
        postconditionVerified: false,
        error: { message: `Internal: consumed value ${address} unavailable for step ${step.id}.` },
      };
    }
    inputs.consumed[address] = value;
  }

  let outcome: StepOutcome;
  try {
    outcome = await driver.execute(deps.contextFor(step.providerId), step, inputs);
  } catch (error) {
    outcome = {
      status: "failed",
      postconditionVerified: false,
      error: { message: deps.redactor.redact(error instanceof Error ? error.message : String(error)) },
    };
  }

  // A command that "succeeded" without a verified postcondition did not succeed.
  if (outcome.status === "succeeded" && !outcome.postconditionVerified) {
    outcome = {
      ...outcome,
      status: "failed",
      error: {
        message: `Step ${step.id} reported success without verifying its postcondition (provider bug).`,
      },
    };
  }

  // Stage produced values for downstream consumers.
  const producedValues: JsonObject = {};
  const producedSecrets: Array<{ capability: string; name: string; fingerprint: string }> = [];
  if (outcome.status === "succeeded") {
    for (const [capability, value] of Object.entries(outcome.produced ?? {})) {
      const address = addressString({ resourceKey: step.resourceKey ?? "application", capability });
      produced.set(address, value);
      if (isSecretRef(value)) {
        producedSecrets.push({ capability, name: value.name, fingerprint: value.fingerprint });
      } else {
        producedValues[capability] = value as JsonValue;
      }
    }
  }

  // Receipts must be redaction-safe BEFORE journaling — a receipt containing
  // a registered secret is a provider bug we refuse to persist.
  let receipt = outcome.receipt;
  if (receipt && deps.redactor.contains(canonicalJson(receipt))) {
    receipt = { redacted: "receipt withheld: it contained a sealed secret value (provider bug)" };
  }
  if (outcome.status === "succeeded" && step.effects.deploys && !options.rederivation) {
    const [configFingerprints, inspection] = await Promise.all([
      providerConfigFingerprints(deps.projectRoot),
      inspectProject(deps.projectRoot),
    ]);
    receipt = {
      ...receipt,
      configFingerprints,
      shippedSourceFingerprint: inspection.sourceFingerprint,
    };
  }

  if (!options.rederivation || outcome.status !== "succeeded") {
    const entry = {
      type: "step" as const,
      at: new Date().toISOString(),
      opId,
      planId: plan.planId,
      stepId: step.id,
      providerId: step.providerId,
      action: step.action,
      status: outcome.status,
      classification: step.classification,
      ...(step.resourceKey !== undefined ? { resourceKey: step.resourceKey } : {}),
      ...(options.rederivation ? { rederived: true } : {}),
      ...(receipt !== undefined ? { receipt } : {}),
      ...(outcome.identity !== undefined ? { identity: outcome.identity } : {}),
      ...(Object.keys(producedValues).length > 0 ? { producedValues } : {}),
      ...(producedSecrets.length > 0 ? { producedSecrets } : {}),
      ...(outcome.error ? { error: outcome.error.message } : {}),
    };
    await appendJournal(deps.projectRoot, entry);
  }

  // Durable identity and applied binding edges land in the lock immediately,
  // so an interruption after this step keeps what it created.
  if (outcome.status === "succeeded" && !options.rederivation) {
    let dirty = false;
    if (outcome.identity && Object.keys(outcome.identity).length > 0) {
      const resourceKey = step.resourceKey ?? "application";
      const existing = lock.resources[resourceKey];
      const accountId = plan.accounts[step.providerId]?.id;
      lock.resources[resourceKey] = {
        provider: step.providerId,
        ...(accountId !== undefined ? { accountId } : {}),
        identity: { ...existing?.identity, ...(outcome.identity as Record<string, string | number>) },
      };
      dirty = true;
    }
    if (step.effects.transfersSecret) {
      for (const address of step.consumes ?? []) {
        const name = (step.inputs?.["bindingName"] as string | undefined) ?? address;
        const to = (step.inputs?.["bindingTo"] as string | undefined) ?? "";
        if (!lock.bindings.some((b) => b.name === name && b.from === address && b.to === to)) {
          lock.bindings.push({ name, from: address, to });
          dirty = true;
        }
      }
    }
    if (dirty) await saveLock(deps.projectRoot, lock);
  }

  return outcome;
}

function failure(opId: string, planId: string, stepId: string, outcome: StepOutcome): ApplyOutcome {
  const failed: ApplyOutcome = {
    kind: "failed",
    opId,
    planId,
    stepId,
    message: outcome.error?.message ?? "Step failed without an error message.",
  };
  if (outcome.error?.recovery !== undefined) failed.recovery = outcome.error.recovery;
  return failed;
}
