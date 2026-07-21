import type { JsonObject } from "@bahama/provider-kit";
import { applyPlan, loadManifest } from "@bahama/core";
import { compileAndDescribe } from "../plan-shared.js";
import { createApplyProgressReporter } from "../progress.js";
import { buildEngine, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

export async function runPlan(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const compiled = await compileAndDescribe(projectRoot, "plan", { kind: "reconcile" });
  // `plan` always stops after displaying the plan. An all-routine plan is a
  // successful result and can be applied without approval; `deploy` remains
  // the only command that auto-applies routine work.
  if (compiled.plan && compiled.allRoutine) {
    emit(
      {
        ...compiled.envelope,
        message: `Plan ${compiled.plan.planId} contains only routine reconciliation steps and no code deployment.`,
      },
      emitOptions,
    );
  }
  emit(compiled.envelope, emitOptions);
}

export async function runApply(
  projectRoot: string,
  planId: string,
  options: { approved: boolean },
  emitOptions: EmitOptions,
): Promise<never> {
  emit(await applyToEnvelope(projectRoot, "apply", planId, options.approved, emitOptions), emitOptions);
}

/**
 * `deploy` is the iteration loop: compile, and auto-apply ONLY when every
 * step is routine. Anything consequential stops with the full plan, exactly
 * like `bahama plan` — there is no flag to force it through.
 */
export async function runDeploy(projectRoot: string, environment: string | undefined, emitOptions: EmitOptions): Promise<never> {
  const manifest = await loadManifest(projectRoot);
  const deployable = Object.entries(manifest.environments)
    .filter(([, value]) => value.provider !== "local")
    .map(([name]) => name);
  const target = environment ?? (deployable.length === 1 ? deployable[0] : undefined);
  if (!target) throw new Error(`Choose a deployment environment: ${deployable.join(", ") || "none are defined"}.`);
  if (!(target in manifest.environments) || manifest.environments[target]!.provider === "local") {
    throw new Error(`Environment \`${target}\` is not a deployable environment in bahama.yaml.`);
  }
  const compiled = await compileAndDescribe(projectRoot, "deploy", { kind: "deploy", environment: target });
  if (!compiled.plan) emit(compiled.envelope, emitOptions);
  if (!compiled.allRoutine) {
    emit(
      {
        ...compiled.envelope,
        status: "approval_required",
      },
      emitOptions,
    );
  }
  emit(await applyToEnvelope(projectRoot, "deploy", compiled.plan.planId, true, emitOptions), emitOptions);
}

async function applyToEnvelope(
  projectRoot: string,
  command: string,
  planId: string,
  approved: boolean,
  emitOptions: EmitOptions,
) {
  const engine = buildEngine(projectRoot);
  const progress = !emitOptions.json && process.stderr.isTTY ? createApplyProgressReporter() : null;
  let outcome: Awaited<ReturnType<typeof applyPlan>>;
  try {
    outcome = await applyPlan(
      {
        projectRoot,
        registry: buildRegistry(),
        contextFor: (id) => engine.contextFor(id),
        redactor: engine.redactor,
        ...(progress ? { onProgress: progress.onProgress } : {}),
      },
      planId,
      { approved },
    );
  } finally {
    progress?.finish();
  }

  switch (outcome.kind) {
    case "approval_required":
      return envelope(command, "approval_required", outcome.message, {
        planId: outcome.plan.planId,
        accounts: outcome.plan.accounts as unknown as JsonObject,
        steps: outcome.plan.steps as unknown as JsonObject[],
      });
    case "stale":
      return envelope(command, "failed", outcome.message, { code: "stale-plan" });
    case "repo-mismatch":
      return envelope(command, "decision_required", outcome.message, { code: "repo-mismatch" });
    case "failed":
      return envelope(command, "failed", `Step ${outcome.stepId} failed: ${outcome.message}`, {
        planId: outcome.planId,
        opId: outcome.opId,
        stepId: outcome.stepId,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.recovery ? { recovery: outcome.recovery } : {}),
      });
    case "succeeded":
      return envelope(command, "succeeded", `Applied ${outcome.planId} (${outcome.steps.length} steps).`, {
        planId: outcome.planId,
        opId: outcome.opId,
        steps: outcome.steps,
      });
  }
}
