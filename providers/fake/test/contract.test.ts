import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, compilePlan, emptyLock, loadLock, saveLock, savePlan, validateManifest } from "@bahama-ai/core";
import type { ProviderDriver } from "@bahama-ai/provider-kit";
import {
  apply,
  engine,
  expectPlan,
  fakeLiveState,
  makeProject,
  persistedState,
  plan,
} from "./helpers.js";
import { fakeProvider } from "../src/index.js";

describe("planning", () => {
  it("compiles deterministic plans — same inputs, same plan id", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    const second = expectPlan(await plan(root));
    expect(first.plan.planId).toBe(second.plan.planId);
    expect(first.plan.steps.map((s) => s.id)).toEqual(second.plan.steps.map((s) => s.id));
  });

  it("orders steps by dependency: database before transfer before deploy", async () => {
    const root = await makeProject();
    const { plan: doc } = expectPlan(await plan(root));
    const ids = doc.steps.map((s) => s.id);
    expect(ids.indexOf("database-ensure")).toBeLessThan(ids.indexOf("application-env-database_url"));
    expect(ids.indexOf("application-env-database_url")).toBeLessThan(ids.indexOf("application-deploy"));
    expect(ids.indexOf("application-deploy")).toBeLessThan(ids.indexOf("application-verify"));
  });

  it("classifies a first-time stack as consequential", async () => {
    const root = await makeProject();
    const { plan: doc } = expectPlan(await plan(root));
    const byId = new Map(doc.steps.map((s) => [s.id, s]));
    expect(byId.get("database-ensure")!.classification).toBe("consequential");
    expect(byId.get("application-deploy")!.classification).toBe("consequential");
    expect(byId.get("application-verify")!.classification).toBe("routine");
  });

  it("returns installation_required for a missing tool", async () => {
    const root = await makeProject({ simulate: { toolMissing: true } });
    const outcome = await plan(root);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.status).toBe("installation_required");
      expect(outcome.requirements[0]).toMatchObject({ kind: "installation", installHint: "npm i -g fake-cli" });
    }
  });

  it("returns auth_required for a missing session", async () => {
    const root = await makeProject({ simulate: { unauthenticated: true } });
    const outcome = await plan(root);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.status).toBe("auth_required");
  });

  it("requires a decision for multiple accounts, resolved via intent write-back", async () => {
    const root = await makeProject({ simulate: { accounts: ["team-a", "team-b"] } });
    const outcome = await plan(root);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.status).toBe("decision_required");
      expect(outcome.decisions[0]!.writeBack).toBe("application.config.simulate.account");
    }
    const resolved = await makeProject({ simulate: { accounts: ["team-a", "team-b"], account: "team-b" } });
    const ok = expectPlan(await plan(resolved));
    expect(ok.plan.accounts["fake"]).toEqual({ id: "team-b", label: "team-b" });
  });

  it("rejects manifests with unknown structural keys instead of silently stripping them", () => {
    expect(() =>
      validateManifest({
        version: 1,
        project: { name: "x" },
        application: { provider: "fake", framework: "fake-framework" },
        bindingsTypo: {},
      }),
    ).toThrow(/bindingsTypo/);
  });

  it("rejects manifests containing resolved identity fields", () => {
    expect(() =>
      validateManifest({
        version: 1,
        project: { name: "x" },
        application: { provider: "fake", framework: "fake-framework", config: { projectId: "prj_123" } },
      }),
    ).toThrow(/bahama\.lock/);
  });

  it("rejects legacy application binding addresses in an environment manifest", () => {
    expect(() =>
      validateManifest({
        version: 1,
        project: { name: "x" },
        application: { framework: "fake-framework" },
        environments: { production: { provider: "fake" } },
        resources: { database: { provider: "fake", engine: "fakedb" } },
        bindings: {
          DATABASE_URL: {
            from: "resources.database.connectionUrl",
            to: "application.productionEnvironment",
          },
        },
      }),
    ).toThrow(/legacy address/);
  });
});

describe("apply and receipts", () => {
  it("applies a full stack, records lock identity and applied bindings, and seals secrets everywhere", async () => {
    const root = await makeProject();
    const { plan: doc } = expectPlan(await plan(root));

    // Consequential plans refuse to run without approval.
    const unapproved = await apply(root, doc.planId, false);
    expect(unapproved.kind).toBe("approval_required");

    const outcome = await apply(root, doc.planId, true);
    expect(outcome.kind).toBe("succeeded");

    const lock = (await loadLock(root))!;
    expect(lock.resources["database"]!.identity["resourceId"]).toBe("fakedb_database");
    expect(lock.resources["application"]!.identity["resourceId"]).toBe("fakeapp_application");
    expect(lock.bindings).toContainEqual({
      name: "DATABASE_URL",
      from: "resources.database.connectionUrl",
      to: "application.productionEnvironment",
    });

    // The secret reached the fake "remote" side...
    const live = await fakeLiveState(root);
    const secretValue = live.resources["application"]!.envVars["DATABASE_URL"]!;
    expect(secretValue).toMatch(/^fakedb:\/\//);

    // ...and appears in NO persisted local state: journal, plans, lock, manifest.
    const persisted = await persistedState(root);
    expect(persisted).not.toContain(secretValue);
    expect(persisted).not.toContain("fakedb://");
  });

  it("records config fingerprints on deploy receipts", async () => {
    const root = await makeProject();
    const { plan: doc } = expectPlan(await plan(root));
    await apply(root, doc.planId);
    const journal = await readFile(join(root, ".bahama", "operations.ndjson"), "utf8");
    expect(journal).toContain("configFingerprints");
    expect(journal).toContain("shippedSourceFingerprint");
  });

  it("re-plans as all-routine after a successful apply (deploy fast path eligibility)", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    const second = expectPlan(await plan(root));
    expect(second.plan.planId).not.toBe(first.plan.planId); // lock changed
    for (const step of second.plan.steps) {
      expect(step, `step ${step.id} should be routine`).toMatchObject({ classification: "routine" });
    }
    // All-routine plans apply without --approved: the fast path.
    const outcome = await apply(root, second.plan.planId, false);
    expect(outcome.kind).toBe("succeeded");
  });

  it("re-executes every step when an unchanged plan is applied again (edit → deploy → edit → deploy)", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    // Iteration loop: routine redeploy, applied to completion.
    const second = expectPlan(await plan(root));
    expect((await apply(root, second.plan.planId, false)).kind).toBe("succeeded");
    const before = (await fakeLiveState(root)).resources["application"]!.deployments;

    // A code edit does not change intent or lock, so the NEXT compile yields
    // the SAME plan id — and applying it must still redeploy, not skip every
    // step against the previous run's receipts.
    await writeFile(join(root, "index.ts"), "export const edited = true;\n");
    const third = expectPlan(await plan(root));
    expect(third.plan.planId).toBe(second.plan.planId);
    const outcome = await apply(root, third.plan.planId, false);
    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind === "succeeded") {
      const deployStep = outcome.steps.find((step) => step.id === "application-deploy")!;
      expect(deployStep.status).toBe("succeeded");
      expect(outcome.steps.every((step) => step.status === "succeeded")).toBe(true);
    }
    const after = (await fakeLiveState(root)).resources["application"]!.deployments;
    expect(after).toBe(before + 1);
  });

  it("downgrades a redeploy to consequential when provider config files change", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    await writeFile(join(root, "vercel.json"), JSON.stringify({ crons: [{ path: "/api/cron", schedule: "* * * * *" }] }));
    const second = expectPlan(await plan(root));
    const deploy = second.plan.steps.find((s) => s.id === "application-deploy")!;
    expect(deploy.classification).toBe("consequential");
    expect(deploy.classificationReasons!.join(" ")).toContain("vercel.json");
  });

  it("keeps a plan valid across unrelated source edits (source drift ≠ stale plan)", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await writeFile(join(root, "index.ts"), "export const x = 1;\n");
    const outcome = await apply(root, first.plan.planId);
    expect(outcome.kind).toBe("succeeded");
  });

  it("rejects a plan when provider configuration changes after review", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await writeFile(join(root, "vercel.json"), JSON.stringify({ rewrites: [{ source: "/x", destination: "/y" }] }));
    const outcome = await apply(root, first.plan.planId, true);
    expect(outcome.kind).toBe("stale");
    if (outcome.kind === "stale") expect(outcome.message).toContain("Provider configuration changed");
  });

  it("rejects a plan when the manifest changes (intent drift = stale plan)", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    const manifest = await readFile(join(root, "bahama.yaml"), "utf8");
    await writeFile(join(root, "bahama.yaml"), manifest.replace("test-app", "renamed-app"));
    const outcome = await apply(root, first.plan.planId);
    expect(outcome.kind).toBe("stale");
  });

  it("rejects a plan file that was edited after review (integrity check)", async () => {
    const root = await makeProject();
    const { plan: doc } = expectPlan(await plan(root));

    // Tamper with a step input after the plan was reviewed. The plan id is a
    // content hash of the whole document, so apply must refuse the file.
    const path = join(root, ".bahama", "plans", `${doc.planId}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      steps: Array<{ inputs?: Record<string, unknown> }>;
    };
    stored.steps[0]!.inputs = { ...stored.steps[0]!.inputs, name: "tampered-target" };
    await writeFile(path, JSON.stringify(stored, null, 2));

    const outcome = await apply(root, doc.planId);
    expect(outcome.kind).toBe("stale");
    if (outcome.kind === "stale") expect(outcome.message).toContain("integrity");
  });
});

describe("failure, resume, and re-derivation", () => {
  it("resumes after a mid-apply failure without recreating resources, re-deriving secrets in a fresh process", async () => {
    const root = await makeProject({ simulate: { failOnce: ["fake.env.set"] } });
    const { plan: doc } = expectPlan(await plan(root));

    const first = await apply(root, doc.planId);
    expect(first.kind).toBe("failed");
    if (first.kind === "failed") expect(first.stepId).toBe("application-env-database_url");

    // The database was created and its identity survived the interruption.
    const lockAfterFailure = (await loadLock(root))!;
    expect(lockAfterFailure.resources["database"]).toBeDefined();

    // Second attempt runs in a FRESH engine (new broker: nothing sealed).
    // The env step's secret must be re-derived by re-executing the producer.
    const second = await apply(root, doc.planId);
    expect(second.kind).toBe("succeeded");
    if (second.kind === "succeeded") {
      const skipped = second.steps.filter((s) => s.status === "skipped-verified").map((s) => s.id);
      expect(skipped).toContain("database-ensure");
      expect(skipped).toContain("application-ensure");
    }

    // Not recreated: same resource id, and the transfer landed the right value.
    const live = await fakeLiveState(root);
    expect(live.resources["database"]!.id).toBe("fakedb_database");
    expect(live.resources["application"]!.envVars["DATABASE_URL"]).toMatch(/^fakedb:\/\//);

    const persisted = await persistedState(root);
    expect(persisted).not.toContain("fakedb://");
  });

  it("treats success-without-verified-postcondition as failure", async () => {
    const root = await makeProject({ withDatabase: false });
    const lying: ProviderDriver = {
      ...fakeProvider,
      execute: async () => ({ status: "succeeded", postconditionVerified: false }),
    };
    const registry = new Map([["fake", lying]]);
    const eng = engine(root);
    const planned = await compilePlan({ projectRoot: root, registry, contextFor: (id) => eng.contextFor(id) });
    if (planned.kind !== "plan") throw new Error("expected plan");
    await savePlan(root, planned.plan);
    const outcome = await applyPlan(
      { projectRoot: root, registry, contextFor: (id) => eng.contextFor(id), redactor: eng.redactor },
      planned.plan.planId,
      { approved: true },
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("postcondition");
  });
});

describe("drift and identity guards", () => {
  it("blocks planning when the lock was bound in a different repository", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    const lock = (await loadLock(root))!;
    lock.repo = { kind: "git-origin", value: "https://github.com/someone-else/original" };
    await saveLock(root, lock);

    const outcome = await plan(root);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.status).toBe("decision_required");
      expect(outcome.message).toContain("detach");
    }
  });

  it("classifies a rewired binding (same name, different source) as consequential", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    // Rewire DATABASE_URL to a second database resource.
    const manifest = (await readFile(join(root, "bahama.yaml"), "utf8"))
      .replace("  database:\n", "  database:\n    provider: fake\n    engine: fakedb\n  database2:\n")
      .replace("from: resources.database.connectionUrl", "from: resources.database2.connectionUrl");
    await writeFile(join(root, "bahama.yaml"), manifest);

    const second = expectPlan(await plan(root));
    const transfer = second.plan.steps.find((s) => s.action === "fake.env.set")!;
    expect(transfer.classification).toBe("consequential");
    expect(transfer.classificationReasons!.join(" ")).toContain("rewired");
  });

  it("refuses to write a lock whose identity smuggles state or secrets", async () => {
    const root = await makeProject();
    const lock = emptyLock({ kind: "path", value: root }, "sha256:x");
    lock.resources["database"] = { provider: "fake", identity: { connectionUrl: "postgres://nope" } };
    await expect(saveLock(root, lock)).rejects.toThrow();
  });

  it("reports material drift when live state diverges from the lock", async () => {
    const root = await makeProject();
    const first = expectPlan(await plan(root));
    await apply(root, first.plan.planId);

    // Simulate out-of-band replacement of the live resource.
    const statePath = join(root, ".fake-live.json");
    const live = JSON.parse(await readFile(statePath, "utf8"));
    live.resources["database"].id = "fakedb_replaced";
    await writeFile(statePath, JSON.stringify(live));

    const eng = engine(root);
    const report = await fakeProvider.status(eng.contextFor("fake"), {
      intent: [{ resourceKey: "database", role: "database", config: {} }],
      locked: [{ resourceKey: "database", identity: { resourceId: "fakedb_database" } }],
    });
    expect(report.resources[0]!.drift[0]).toMatchObject({ severity: "material" });
  });
});
