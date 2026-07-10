import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-util.js";
import { BAHAMA_DIR } from "./journal.js";
import type { PlanDocument } from "./planner.js";

/**
 * Immutable plan storage under `.bahama/plans/`. A plan file is written once
 * at compile time and never edited; apply re-validates it against current
 * state instead of trusting it.
 */

function planPath(projectRoot: string, planId: string): string {
  if (!/^plan_[a-f0-9]{12}$/.test(planId)) {
    throw new Error(`Invalid plan id: ${planId}`);
  }
  return join(projectRoot, BAHAMA_DIR, "plans", `${planId}.json`);
}

export async function savePlan(projectRoot: string, plan: PlanDocument): Promise<void> {
  await atomicWriteFile(planPath(projectRoot, plan.planId), `${JSON.stringify(plan, null, 2)}\n`, 0o600);
}

export async function loadPlan(projectRoot: string, planId: string): Promise<PlanDocument | null> {
  try {
    return JSON.parse(await readFile(planPath(projectRoot, planId), "utf8")) as PlanDocument;
  } catch {
    return null;
  }
}
