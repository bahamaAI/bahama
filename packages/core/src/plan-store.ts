import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@bahama-ai/provider-kit";
import { atomicWriteFile } from "./fs-util.js";
import { contentId } from "./hash.js";
import { BAHAMA_DIR } from "./journal.js";
import type { PlanDocument } from "./planner.js";

/**
 * Immutable plan storage under `.bahama/plans/`. A plan file is written once
 * at compile time and never edited. Because the plan is the artifact a human
 * approves, apply must execute EXACTLY what was reviewed: on load the file is
 * schema-validated and its content hash is recomputed — a plan whose id no
 * longer matches its content (edited, corrupted, or hand-crafted) is rejected.
 */

const stepEffectsSchema = z
  .object({
    createsResource: z.boolean().optional(),
    adoptsResource: z.boolean().optional(),
    destructive: z.boolean().optional(),
    migratesSchema: z.boolean().optional(),
    transfersSecret: z.boolean().optional(),
    deploys: z.boolean().optional(),
    bindsAccount: z.boolean().optional(),
    changesConfiguration: z.boolean().optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();

const plannedStepSchema = z
  .object({
    id: z.string().min(1),
    action: z.string().min(1),
    summary: z.string(),
    resourceKey: z.string().optional(),
    effects: stepEffectsSchema,
    dependsOn: z.array(z.string()),
    inputs: z.record(z.string(), z.custom<JsonValue>()).optional(),
    produces: z.array(z.string()).optional(),
    consumes: z.array(z.string()).optional(),
    postcondition: z.string(),
    providerId: z.string().min(1),
    classification: z.enum(["routine", "consequential"]),
    classificationReasons: z.array(z.string()).optional(),
  })
  .strict();

const planDocumentSchema = z
  .object({
    planId: z.string(),
    createdAt: z.string(),
    manifestHash: z.string(),
    lockHash: z.string(),
    providerConfigFingerprints: z.record(z.string(), z.string()),
    accounts: z.record(
      z.string(),
      z.object({ id: z.string(), label: z.string(), kind: z.string().optional() }).strict(),
    ),
    steps: z.array(plannedStepSchema),
    warnings: z.array(z.string()),
    operation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("reconcile") }).strict(),
      z.object({ kind: z.literal("deploy"), environment: z.string() }).strict(),
    ]),
  })
  .strict();

/**
 * The plan id is a content hash of everything that matters for execution —
 * the full step list (effects, inputs, dependencies, capability wiring,
 * postconditions, classification), the intent and resolution hashes, and the
 * accounts it was compiled against. `createdAt` is display metadata and the
 * only excluded field. The planner and the load-time integrity check both
 * derive the id through this one function so they cannot drift.
 */
export function planContentId(plan: Omit<PlanDocument, "planId" | "createdAt">): string {
  const { manifestHash, lockHash, providerConfigFingerprints, accounts, steps, warnings, operation } = plan;
  return contentId("plan", {
    manifestHash,
    lockHash,
    providerConfigFingerprints,
    accounts,
    steps,
    warnings,
    operation,
  } as unknown as JsonValue);
}

export type LoadPlanResult =
  | { kind: "ok"; plan: PlanDocument }
  | { kind: "missing" }
  | { kind: "invalid"; message: string };

function planPath(projectRoot: string, planId: string): string {
  if (!/^plan_[a-f0-9]{12}$/.test(planId)) {
    throw new Error(`Invalid plan id: ${planId}`);
  }
  return join(projectRoot, BAHAMA_DIR, "plans", `${planId}.json`);
}

export async function savePlan(projectRoot: string, plan: PlanDocument): Promise<void> {
  await atomicWriteFile(planPath(projectRoot, plan.planId), `${JSON.stringify(plan, null, 2)}\n`, 0o600);
}

export async function loadPlan(projectRoot: string, planId: string): Promise<LoadPlanResult> {
  let text: string;
  try {
    text = await readFile(planPath(projectRoot, planId), "utf8");
  } catch {
    return { kind: "missing" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: `Plan ${planId} is not valid JSON.` };
  }
  const parsed = planDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: "invalid",
      message: `Plan ${planId} does not match the plan schema (${issue?.path.join(".")}: ${issue?.message}).`,
    };
  }

  const plan = parsed.data as PlanDocument;
  if (plan.planId !== planId || planContentId(plan) !== planId) {
    return {
      kind: "invalid",
      message: `Plan ${planId} failed its integrity check — the file no longer matches the reviewed plan.`,
    };
  }
  return { kind: "ok", plan };
}
