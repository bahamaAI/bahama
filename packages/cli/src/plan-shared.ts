import type { JsonObject, PlanOperation, ResultEnvelope } from "@bahama-ai/provider-kit";
import { compilePlan, savePlan, type PlanDocument } from "@bahama-ai/core";
import { buildEngine, buildRegistry, envelope } from "./runtime.js";

export interface CompiledPlanResult {
  envelope: ResultEnvelope;
  plan: PlanDocument | null;
  allRoutine: boolean;
}

/** Shared by `bahama plan` and `bahama deploy`: compile, persist, describe. */
export async function compileAndDescribe(projectRoot: string, command: string, operation: PlanOperation): Promise<CompiledPlanResult> {
  const engine = buildEngine(projectRoot);
  const outcome = await compilePlan({
    projectRoot,
    registry: buildRegistry(),
    contextFor: (id) => engine.contextFor(id),
    operation,
  });

  if (outcome.kind === "blocked") {
    return {
      envelope: envelope(command, outcome.status, outcome.message, {}, {
        requirements: outcome.requirements,
        decisions: outcome.decisions,
        warnings: outcome.warnings,
      }),
      plan: null,
      allRoutine: false,
    };
  }

  await savePlan(projectRoot, outcome.plan);
  const consequential = outcome.plan.steps.filter((step) => step.classification === "consequential");
  const allRoutine = consequential.length === 0;
  const data: JsonObject = {
    planId: outcome.plan.planId,
    accounts: outcome.plan.accounts as unknown as JsonObject,
    steps: outcome.plan.steps as unknown as JsonObject[],
    consequentialSteps: consequential.length,
  };

  return {
    envelope: envelope(
      command,
      allRoutine ? "succeeded" : "approval_required",
      allRoutine
        ? `Plan ${outcome.plan.planId} contains only routine steps.`
        : `Plan ${outcome.plan.planId} has ${outcome.plan.steps.length} steps.`,
      data,
      { warnings: outcome.plan.warnings },
    ),
    plan: outcome.plan,
    allRoutine,
  };
}
