import type { JsonObject } from "@bahama-ai/provider-kit";
import { applyPlan } from "@bahama-ai/core";
import { compileAndDescribe } from "../plan-shared.js";
import { buildEngine, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

export async function runPlan(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const compiled = await compileAndDescribe(projectRoot, "plan");
  // `plan` always stops for review — even an all-routine plan is worth a look
  // when someone asked for the plan explicitly. `deploy` is the fast path.
  if (compiled.plan && compiled.allRoutine) {
    emit(
      {
        ...compiled.envelope,
        status: "approval_required",
        message: `Plan ${compiled.plan.planId} contains only routine steps. Apply it with \`bahama apply ${compiled.plan.planId}\` (or use \`bahama deploy\` next time).`,
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
  emit(await applyToEnvelope(projectRoot, "apply", planId, options.approved), emitOptions);
}

/**
 * `deploy` is the iteration loop: compile, and auto-apply ONLY when every
 * step is routine. Anything consequential stops with the full plan, exactly
 * like `bahama plan` — there is no flag to force it through.
 */
export async function runDeploy(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const compiled = await compileAndDescribe(projectRoot, "deploy");
  if (!compiled.plan) emit(compiled.envelope, emitOptions);
  if (!compiled.allRoutine) {
    emit(
      {
        ...compiled.envelope,
        status: "approval_required",
        message: `Deploy needs approval first: ${compiled.envelope.message}`,
      },
      emitOptions,
    );
  }
  emit(await applyToEnvelope(projectRoot, "deploy", compiled.plan.planId, true), emitOptions);
}

async function applyToEnvelope(projectRoot: string, command: string, planId: string, approved: boolean) {
  const engine = buildEngine(projectRoot);
  const outcome = await applyPlan(
    {
      projectRoot,
      registry: buildRegistry(),
      contextFor: (id) => engine.contextFor(id),
      redactor: engine.redactor,
    },
    planId,
    { approved },
  );

  switch (outcome.kind) {
    case "approval_required":
      return envelope(command, "approval_required", outcome.message, {
        planId: outcome.plan.planId,
        accounts: outcome.plan.accounts,
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
