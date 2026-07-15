import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, ProviderDriver } from "@bahama/provider-kit";
import {
  Engine,
  applyPlan,
  compilePlan,
  savePlan,
  type ApplyOutcome,
  type PlanOutcome,
} from "@bahama/core";
import { testProvider } from "../src/index.js";

export const REGISTRY: ReadonlyMap<string, ProviderDriver> = new Map([["test", testProvider]]);

/** A scratch project with a test-provider manifest. */
export async function makeProject(options?: {
  simulate?: JsonObject;
  withDatabase?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bahama-test-"));
  const withDatabase = options?.withDatabase ?? true;
  const simulate = options?.simulate ? `\n    simulate: ${JSON.stringify(options.simulate)}` : "";
  const manifest = [
    "version: 1",
    "project:",
    "  name: test-app",
    "application:",
    "  provider: test",
    "  framework: test-framework",
    `  config:${simulate || " {}"}`,
    ...(withDatabase
      ? [
          "resources:",
          "  database:",
          "    provider: test",
          "    engine: testdb",
          "bindings:",
          "  DATABASE_URL:",
          "    from: resources.database.connectionUrl",
          "    to: application.productionEnvironment",
        ]
      : []),
    "",
  ].join("\n");
  await writeFile(join(root, "bahama.yaml"), manifest);
  return root;
}

/**
 * Each engine() call is a FRESH process as far as the engine is concerned:
 * new redactor, new secret broker, empty in-memory state. Resume tests rely
 * on this to prove secrets get re-derived rather than remembered.
 */
export function engine(root: string): Engine {
  return new Engine({ projectRoot: root, logSink: () => {} });
}

export async function plan(root: string): Promise<PlanOutcome> {
  const eng = engine(root);
  const outcome = await compilePlan({
    projectRoot: root,
    registry: REGISTRY,
    contextFor: (id) => eng.contextFor(id),
    operation: { kind: "deploy", environment: "production" },
  });
  if (outcome.kind === "plan") await savePlan(root, outcome.plan);
  return outcome;
}

export async function apply(root: string, planId: string, approved = true): Promise<ApplyOutcome> {
  const eng = engine(root);
  return applyPlan(
    { projectRoot: root, registry: REGISTRY, contextFor: (id) => eng.contextFor(id), redactor: eng.redactor },
    planId,
    { approved },
  );
}

export function expectPlan(outcome: PlanOutcome): Extract<PlanOutcome, { kind: "plan" }> {
  if (outcome.kind !== "plan") {
    throw new Error(`Expected a compiled plan, got ${outcome.status}: ${outcome.message}`);
  }
  return outcome;
}

/** Every byte of persisted local state, for no-secret-anywhere scans. */
export async function persistedState(root: string): Promise<string> {
  const chunks: string[] = [];
  const read = async (path: string) => {
    try {
      chunks.push(await readFile(path, "utf8"));
    } catch {
      // absent files are fine
    }
  };
  await read(join(root, "bahama.yaml"));
  await read(join(root, "bahama.lock"));
  await read(join(root, ".bahama", "operations.ndjson"));
  try {
    for (const file of await readdir(join(root, ".bahama", "plans"))) {
      await read(join(root, ".bahama", "plans", file));
    }
  } catch {
    // no plans dir
  }
  return chunks.join("\n");
}

export async function testLiveState(root: string): Promise<{
  resources: Record<string, { id: string; deployments: number; envVars: Record<string, string> }>;
}> {
  return JSON.parse(await readFile(join(root, ".test-live.json"), "utf8"));
}
