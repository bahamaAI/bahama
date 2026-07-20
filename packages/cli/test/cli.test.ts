import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end tests against the built `bahama` binary — every invocation is a
 * fresh process, which is exactly how agents drive the CLI. Requires
 * `tsc -b packages/cli` to have run (npm test does a full build first in CI).
 */
const BIN = resolve(fileURLToPath(import.meta.url), "../../dist/bin.js");

interface Envelope {
  protocolVersion: number;
  command: string;
  status: string;
  message: string;
  data: Record<string, unknown>;
}

async function bahama(cwd: string, args: string[]): Promise<{ exitCode: number; env: Envelope | null; raw: string }> {
  const result = await execa("node", [BIN, ...args, "--json"], {
    cwd,
    reject: false,
    env: { BAHAMA_ENABLE_TEST: "1", BAHAMA_CONFIG_DIR: join(cwd, ".test-config") },
  });
  let env: Envelope | null = null;
  try {
    env = JSON.parse(result.stdout) as Envelope;
  } catch {
    // non-envelope output (e.g. providers --format agent)
  }
  return { exitCode: result.exitCode ?? -1, env, raw: result.stdout };
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bahama-cli-e2e-"));
});

describe("bahama CLI golden path (test provider)", () => {
  let planId: string;

  it("reports the package version embedded by the build", async () => {
    const packageVersion = JSON.parse(
      await readFile(resolve(fileURLToPath(import.meta.url), "../../package.json"), "utf8"),
    ) as { version: string };
    const result = await execa("node", [BIN, "--version"], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(packageVersion.version);
  });

  it("reports the same package version from setup", async () => {
    const packageVersion = JSON.parse(
      await readFile(resolve(fileURLToPath(import.meta.url), "../../package.json"), "utf8"),
    ) as { version: string };
    const result = await bahama(root, ["setup", "--host", "none"]);
    expect(result.exitCode).toBe(0);
    expect(result.env).toMatchObject({
      command: "setup",
      status: "succeeded",
      data: { cliVersion: packageVersion.version },
    });
  });

  it("init writes a valid manifest and gitignores .bahama/", async () => {
    const { exitCode, env } = await bahama(root, [
      "init",
      "--name",
      "e2e-app",
      "--application",
      "test",
      "--framework",
      "test-framework",
      "--database",
      "test",
    ]);
    expect(exitCode).toBe(0);
    expect(env!.status).toBe("succeeded");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".bahama/");
  });

  it("init refuses to overwrite (usage error, exit 2)", async () => {
    const { exitCode } = await bahama(root, [
      "init",
      "--name",
      "x",
      "--application",
      "test",
      "--framework",
      "test-framework",
    ]);
    expect(exitCode).toBe(2);
  });

  it("inspect reports bahama file validity", async () => {
    const { exitCode, env } = await bahama(root, ["inspect"]);
    expect(exitCode).toBe(0);
    expect((env!.data["bahama"] as { manifestValid: boolean }).manifestValid).toBe(true);
  });

  it("plan compiles and requires approval (exit 0 — expected workflow state)", async () => {
    const { exitCode, env } = await bahama(root, ["plan"]);
    expect(exitCode).toBe(0);
    expect(env!.status).toBe("approval_required");
    expect(env!.data["consequentialSteps"]).toBeGreaterThan(0);
    const steps = env!.data["steps"] as Array<{ providerId: string; classificationReasons?: string[] }>;
    const localReason = steps.find((step) => step.providerId === "local")!.classificationReasons!.join(" ");
    const hostedReason = steps.find((step) => step.providerId === "test" && step.classificationReasons?.some((reason) => reason.includes("binding DATABASE_URL")))!.classificationReasons!.join(" ");
    expect(localReason).toContain("environments.local.variables");
    expect(hostedReason).toContain("environments.production.variables");
    planId = env!.data["planId"] as string;
  });

  it("apply without --approved stops; with --approved succeeds", async () => {
    const gated = await bahama(root, ["apply", planId]);
    expect(gated.exitCode).toBe(0);
    expect(gated.env!.status).toBe("approval_required");

    const applied = await bahama(root, ["apply", planId, "--approved"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.env!.status).toBe("succeeded");
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("DATABASE_URL=");
  });

  it("reports an all-routine plan as succeeded without auto-applying it", async () => {
    const result = await bahama(root, ["plan"]);
    expect(result.env!.status).toBe("succeeded");
    expect(result.env!.data["planId"]).toEqual(expect.any(String));
    expect(result.env!.data["consequentialSteps"]).toBe(0);
  });

  it("status distinguishes a provisioned but undeployed application from drift", async () => {
    const { exitCode, env } = await bahama(root, ["status"]);
    expect(exitCode).toBe(0);
    expect(env!.status).toBe("succeeded");
    expect(env!.message).toContain("1 not ready");
    expect(env!.message).toContain("no material drift");
    const resources = env!.data["resources"] as Array<{
      resourceKey: string;
      health: { state: string; reason?: string };
    }>;
    expect(resources.find((resource) => resource.resourceKey === "environment.production")?.health).toEqual({
      state: "not_ready",
      reason: "Application has not been deployed.",
    });
  });

  it("first deploy stops for approval, then later deploys use the routine fast path", async () => {
    const first = await bahama(root, ["deploy"]);
    expect(first.exitCode).toBe(0);
    expect(first.env!.status).toBe("approval_required");
    const firstPlanId = first.env!.data["planId"] as string;
    expect((await bahama(root, ["apply", firstPlanId, "--approved"])).env!.status).toBe("succeeded");

    const routine = await bahama(root, ["deploy"]);
    expect(routine.exitCode).toBe(0);
    expect(routine.env!.status).toBe("succeeded");
    expect(routine.env!.command).toBe("deploy");
  });

  it("deploy stops for approval when provider config changes", async () => {
    await writeFile(join(root, "vercel.json"), `{"crons":[{"path":"/x","schedule":"* * * * *"}]}`);
    const { exitCode, env } = await bahama(root, ["deploy"]);
    expect(exitCode).toBe(0);
    expect(env!.status).toBe("approval_required");
    const steps = env!.data["steps"] as Array<{ id: string; classificationReasons?: string[] }>;
    const deploy = steps.find((s) => s.id === "environment.production-deploy")!;
    expect(deploy.classificationReasons!.join(" ")).toContain("vercel.json");
  });

  it("status reports clean state against the lock", async () => {
    const { exitCode, env } = await bahama(root, ["status"]);
    expect(exitCode).toBe(0);
    expect(env!.status).toBe("succeeded");
    expect(env!.message).toContain("3 ready");
    const resources = env!.data["resources"] as Array<{ health: { state: string } }>;
    expect(resources.every((resource) => resource.health.state === "ready")).toBe(true);
  });

  it("auth status reports the test session", async () => {
    const { env } = await bahama(root, ["auth", "status", "test"]);
    expect(env!.status).toBe("succeeded");
    expect(env!.data["identity"]).toBe("default-account");
  });

  it("providers --format agent emits a compact capability index", async () => {
    const result = await execa("node", [BIN, "providers", "--format", "agent"], {
      cwd: root,
      env: { BAHAMA_ENABLE_TEST: "1" },
      reject: false,
    });
    expect(result.stdout).toContain("## Application hosts");
    expect(result.stdout).toContain("## Databases");
    expect(result.stdout).toContain("`test`");
    expect(result.stdout).not.toContain("Use when:");
    expect(result.stdout).toContain("bahama providers <id> --format agent");
  });

  it("targeted provider discovery includes use and avoid guidance", async () => {
    const result = await execa("node", [BIN, "providers", "test", "--format", "agent"], {
      cwd: root,
      env: { BAHAMA_ENABLE_TEST: "1" },
      reject: false,
    });
    expect(result.stdout).toContain("Use when:");
    expect(result.stdout).toContain("Avoid when:");
    expect(result.stdout).toContain("Produces:");
  });

  it("does not expose the internal test provider by default", async () => {
    const result = await execa("node", [BIN, "providers", "--format", "agent"], {
      cwd: root,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("`test`");
  });

  it("detach requires explicit approval, then clears only local identity", async () => {
    const blocked = await bahama(root, ["detach"]);
    expect(blocked.env!.status).toBe("approval_required");
    expect(blocked.env!.message).toContain("deletes no remote resources");

    const detach = await bahama(root, ["detach", "--approved"]);
    expect(detach.env!.status).toBe("succeeded");

    const replan = await bahama(root, ["plan"]);
    expect(replan.env!.status).toBe("approval_required");
    const steps = replan.env!.data["steps"] as Array<{ id: string; classification: string }>;
    // Live resources still exist but are no longer locked: adoption, not creation.
    expect(steps.find((s) => s.id === "database-ensure")!.classification).toBe("consequential");
  });

  it("stale plans fail with exit 1 after the manifest changes", async () => {
    const fresh = await bahama(root, ["plan"]);
    const staleId = fresh.env!.data["planId"] as string;
    const manifest = await readFile(join(root, "bahama.yaml"), "utf8");
    await writeFile(join(root, "bahama.yaml"), manifest.replace("e2e-app", "renamed"));
    const { exitCode, env } = await bahama(root, ["apply", staleId, "--approved"]);
    expect(exitCode).toBe(1);
    expect(env!.status).toBe("failed");
    expect(env!.data["code"]).toBe("stale-plan");
  });
});
