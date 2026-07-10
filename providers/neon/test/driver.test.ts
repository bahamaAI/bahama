import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PlanRequest,
  PlannedStep,
  ProbeResult,
  ProviderContext,
  ResourceIntent,
  RunOptions,
  RunResult,
  SecretBroker,
  SecretRef,
} from "@bahama-ai/provider-kit";
import {
  countApplied,
  findDestructiveStatement,
  neonProvider,
  runMigrations,
  type QueryExecutor,
} from "../src/index.js";

const CONNECTION_URL = "postgres://user:sekret@ep-cool-1.aws.neon.tech/neondb?sslmode=require";

type CannedRun = { exitCode?: number; stdout?: string; stderr?: string };
type RunHandler = (cmd: string, args: string[], options?: RunOptions) => CannedRun | undefined;

interface RecordedCall {
  cmd: string;
  args: string[];
  options?: RunOptions;
}

function makeCtx(
  root: string,
  handler: RunHandler,
  which: (cmd: string) => string | null = (cmd) => (cmd === "neon" ? "/usr/local/bin/neon" : null),
): { ctx: ProviderContext; calls: RecordedCall[]; sealed: Map<string, string> } {
  const calls: RecordedCall[] = [];
  const values = new Map<string, string>();
  const secrets: SecretBroker = {
    seal(name, value) {
      const id = `ref-${values.size}`;
      values.set(id, value);
      return { id, name, fingerprint: `sha256:${"0".repeat(16)}` } as unknown as SecretRef;
    },
    async use(ref, fn) {
      return fn(values.get(ref.id)!);
    },
    describe(ref) {
      return { name: ref.name, fingerprint: ref.fingerprint };
    },
  };
  const ctx: ProviderContext = {
    projectRoot: root,
    run: {
      async run(cmd, args, options): Promise<RunResult> {
        calls.push({ cmd, args, ...(options !== undefined ? { options } : {}) });
        const canned = handler(cmd, args, options);
        if (!canned) throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
        return {
          exitCode: canned.exitCode ?? 0,
          stdout: canned.stdout ?? "",
          stderr: canned.stderr ?? "",
          timedOut: false,
        };
      },
      async which(cmd) {
        return which(cmd);
      },
    },
    http: {
      async request() {
        throw new Error("Unexpected HTTP request in neon tests");
      },
    },
    secrets,
    log: { debug() {}, info() {}, warn() {} },
    signal: new AbortController().signal,
    interactive: false,
  };
  return { ctx, calls, sealed: values };
}

const DB_INTENT: ResourceIntent = {
  resourceKey: "database",
  role: "database",
  engine: "postgres",
  projectName: "my-app",
  config: {},
};

function probed(overrides?: Partial<ProbeResult>): ProbeResult {
  return {
    tool: { installed: true, version: "2.15.0", compatibility: "tested" },
    auth: { state: "authenticated", identity: "dev@example.com" },
    accounts: [],
    observed: { database: { exists: false } },
    ...overrides,
  };
}

function planRequest(overrides?: Partial<PlanRequest>): PlanRequest {
  return {
    intent: [DB_INTENT],
    locked: [],
    probe: probed(),
    bindings: [],
    ...overrides,
  };
}

function planned(partial: Partial<PlannedStep> & { action: string }): PlannedStep {
  return {
    id: "database-ensure",
    summary: "",
    effects: {},
    postcondition: "",
    providerId: "neon",
    classification: "routine",
    dependsOn: [],
    resourceKey: "database",
    inputs: { name: "my-app", region: null, orgId: null, projectId: null },
    ...partial,
  };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-test-"));
}

async function withMigrations(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(root, "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(root, "migrations", name), sql);
  }
}

const key = (call: RecordedCall) => `${call.cmd} ${call.args.join(" ")}`;

describe("probe", () => {
  it("reports the tool as missing when neither neon nor neonctl is on PATH", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined, () => null);
    const result = await neonProvider.probe(ctx, { intent: [DB_INTENT], locked: [] });
    expect(result.tool.installed).toBe(false);
    expect(result.tool.installHint).toContain("neonctl");
  });

  it("falls back to the neonctl alias when neon is absent", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(
      root,
      (cmd, args) => {
        if (args.join(" ") === "--version") return { stdout: "2.15.0" };
        if (args.join(" ") === "me --output json") return { stdout: JSON.stringify({ email: "dev@example.com" }) };
        if (args.join(" ") === "orgs list --output json") return { stdout: "[]" };
        if (args.join(" ") === "projects list --output json") return { stdout: JSON.stringify({ projects: [] }) };
        return undefined;
      },
      (cmd) => (cmd === "neonctl" ? "/usr/local/bin/neonctl" : null),
    );
    const result = await neonProvider.probe(ctx, { intent: [DB_INTENT], locked: [] });
    expect(result.auth).toMatchObject({ state: "authenticated", identity: "dev@example.com" });
    expect(calls.every((call) => call.cmd === "neonctl")).toBe(true);
  });

  it("reports unauthenticated with a login hint when `me` fails", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "--version") return { stdout: "2.15.0" };
      if (args.join(" ") === "me --output json") return { exitCode: 1, stderr: "not authenticated" };
      return undefined;
    });
    const result = await neonProvider.probe(ctx, { intent: [DB_INTENT], locked: [] });
    expect(result.tool).toMatchObject({ installed: true, version: "2.15.0", compatibility: "tested" });
    expect(result.auth.state).toBe("unauthenticated");
    expect(result.auth.loginHint).toContain("neon auth");
    expect(result.auth.loginHint).toContain("NEON_API_KEY");
  });

  it("warns (not blocks) on a newer-than-tested CLI and observes projects by name", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "--version") return { stdout: "3.1.0" };
      if (args.join(" ") === "me --output json") return { stdout: JSON.stringify({ email: "dev@example.com" }) };
      if (args.join(" ") === "orgs list --output json")
        return { stdout: JSON.stringify([{ id: "org-1", name: "Personal" }]) };
      if (args.join(" ") === "projects list --output json")
        return { stdout: JSON.stringify({ projects: [{ id: "proj-123", name: "my-app" }] }) };
      return undefined;
    });
    const result = await neonProvider.probe(ctx, { intent: [DB_INTENT], locked: [] });
    expect(result.tool.compatibility).toBe("untested-newer");
    expect(result.warnings?.some((w) => w.includes("newer"))).toBe(true);
    expect(result.accounts).toEqual([{ id: "org-1", label: "Personal", kind: "org" }]);
    expect(result.observed["database"]).toEqual({ exists: true, projectId: "proj-123" });
  });

  it("observes a locked project via projects get", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "--version") return { stdout: "2.15.0" };
      if (args.join(" ") === "me --output json") return { stdout: JSON.stringify({ email: "dev@example.com" }) };
      if (args.join(" ") === "orgs list --output json") return { stdout: "[]" };
      if (args.join(" ") === "projects get proj-123 --output json")
        return { stdout: JSON.stringify({ id: "proj-123", name: "my-app" }) };
      return undefined;
    });
    const result = await neonProvider.probe(ctx, {
      intent: [DB_INTENT],
      locked: [{ resourceKey: "database", identity: { projectId: "proj-123" } }],
    });
    expect(result.observed["database"]).toEqual({ exists: true, projectId: "proj-123" });
    expect(calls.some((call) => key(call).includes("projects get proj-123"))).toBe(true);
  });
});

describe("plan", () => {
  it("returns a decision with an orgId writeBack when multiple orgs and no config", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await neonProvider.plan(
      ctx,
      planRequest({
        probe: probed({
          accounts: [
            { id: "org-1", label: "Personal", kind: "org" },
            { id: "org-2", label: "Work", kind: "org" },
          ],
        }),
      }),
    );
    expect(contribution.steps).toEqual([]);
    expect(contribution.decisions).toHaveLength(1);
    expect(contribution.decisions![0]).toMatchObject({
      kind: "decision",
      writeBack: "resources.database.config.orgId",
    });
    expect(contribution.decisions![0]!.options.map((o) => o.id)).toEqual(["org-1", "org-2"]);
  });

  it("plans ensure only (no migrate step) when there is no migrations directory", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await neonProvider.plan(ctx, planRequest());
    expect(contribution.steps.map((s) => s.id)).toEqual(["database-ensure"]);
    expect(contribution.steps[0]).toMatchObject({
      action: "neon.project.ensure",
      effects: { createsResource: true },
      produces: ["connectionUrl"],
      inputs: { name: "my-app", region: null, orgId: null, projectId: null },
    });
  });

  it("plans ensure + migrate with the sealed connectionUrl consumed by address", async () => {
    const root = await scratchDir();
    await withMigrations(root, {
      "0002_more.sql": "create table b (id int);",
      "0001_init.sql": "create table a (id int);",
    });
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await neonProvider.plan(
      ctx,
      planRequest({
        intent: [{ ...DB_INTENT, config: { region: "aws-us-east-1", orgId: "org-1" } }],
        probe: probed({ observed: { database: { exists: true, projectId: "proj-123" } } }),
        locked: [{ resourceKey: "database", identity: { projectId: "proj-123" } }],
      }),
    );
    expect(contribution.steps.map((s) => s.id)).toEqual(["database-ensure", "database-migrate"]);
    expect(contribution.steps[0]).toMatchObject({
      effects: { readOnly: true },
      inputs: { name: "my-app", region: "aws-us-east-1", orgId: "org-1", projectId: "proj-123" },
    });
    expect(contribution.steps[1]).toMatchObject({
      action: "neon.migrations.apply",
      effects: { migratesSchema: true },
      dependsOn: ["database-ensure"],
      consumes: ["resources.database.connectionUrl"],
      inputs: { files: ["0001_init.sql", "0002_more.sql"] },
    });
  });

  it("plans adopt when the project is live but unlocked", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await neonProvider.plan(
      ctx,
      planRequest({ probe: probed({ observed: { database: { exists: true, projectId: "proj-123" } } }) }),
    );
    expect(contribution.steps[0]!.effects).toEqual({ adoptsResource: true });
  });
});

describe("execute neon.project.ensure", () => {
  it("creates the project when absent, seals the connection string, and verifies", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      const line = args.join(" ");
      if (line === "projects list --output json") return { stdout: JSON.stringify({ projects: [] }) };
      if (line === "projects create --name my-app --output json") {
        return {
          stdout: JSON.stringify({
            project: { id: "proj-new", name: "my-app" },
            connection_uris: [{ connection_uri: CONNECTION_URL }],
          }),
        };
      }
      if (line === "projects get proj-new --output json")
        return { stdout: JSON.stringify({ id: "proj-new", name: "my-app" }) };
      return undefined;
    });
    const outcome = await neonProvider.execute(ctx, planned({ action: "neon.project.ensure" }), {
      consumed: {},
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { projectId: "proj-new" },
      receipt: { projectId: "proj-new", existed: false },
    });
    const produced = outcome.produced!["connectionUrl"] as SecretRef;
    expect(produced).toMatchObject({ name: "database.connectionUrl" });
    // The raw connection string never leaves the broker.
    expect(JSON.stringify(outcome)).not.toContain("sekret");
    expect(JSON.stringify(outcome)).not.toContain("neon.tech");
    // connection_uris from create was used; no separate connection-string call.
    expect(calls.some((call) => call.args[0] === "connection-string")).toBe(false);
  });

  it("adopts an existing project by name and fetches the connection string via the CLI", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      const line = args.join(" ");
      if (line === "projects list --org-id org-1 --output json")
        return { stdout: JSON.stringify({ projects: [{ id: "proj-123", name: "my-app" }] }) };
      if (line === "connection-string --project-id proj-123") return { stdout: `${CONNECTION_URL}\n` };
      if (line === "projects get proj-123 --output json")
        return { stdout: JSON.stringify({ id: "proj-123", name: "my-app" }) };
      return undefined;
    });
    const outcome = await neonProvider.execute(
      ctx,
      planned({
        action: "neon.project.ensure",
        inputs: { name: "my-app", region: null, orgId: "org-1", projectId: null },
      }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { projectId: "proj-123" },
      receipt: { existed: true },
    });
    expect(calls.some((call) => call.args.join(" ").startsWith("projects create"))).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("sekret");
  });

  it("fails with recovery guidance when the locked project no longer exists", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "projects get proj-gone --output json")
        return { exitCode: 1, stderr: "project not found" };
      return undefined;
    });
    const outcome = await neonProvider.execute(
      ctx,
      planned({
        action: "neon.project.ensure",
        inputs: { name: "my-app", region: null, orgId: null, projectId: "proj-gone" },
      }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("proj-gone");
  });
});

describe("migration executor", () => {
  function recordingExec(alreadyApplied: string[] = []): {
    exec: QueryExecutor;
    statements: string[];
    inserted: string[];
  } {
    const statements: string[] = [];
    const inserted: string[] = [...alreadyApplied];
    const exec: QueryExecutor = async (sql, params) => {
      statements.push(sql);
      if (/^select name from _bahama_migrations$/i.test(sql.trim())) {
        return { rows: inserted.map((name) => ({ name })) };
      }
      if (/^insert into _bahama_migrations/i.test(sql.trim())) {
        inserted.push(String(params?.[0]));
        return { rows: [] };
      }
      if (/^select count\(\*\)::int as count/i.test(sql.trim())) {
        const names = params?.[0] as string[];
        return { rows: [{ count: inserted.filter((name) => names.includes(name)).length }] };
      }
      return { rows: [] };
    };
    return { exec, statements, inserted };
  }

  it("applies unapplied migrations in filename order inside transactions", async () => {
    const { exec, statements, inserted } = recordingExec(["0001_init.sql"]);
    const summary = await runMigrations(
      [
        { name: "0001_init.sql", sql: "create table a (id int);" },
        { name: "0002_more.sql", sql: "create table b (id int);" },
      ],
      exec,
    );
    expect(summary).toEqual({ total: 2, applied: ["0002_more.sql"], alreadyApplied: ["0001_init.sql"] });
    expect(inserted).toEqual(["0001_init.sql", "0002_more.sql"]);
    const beginIndex = statements.indexOf("begin");
    expect(beginIndex).toBeGreaterThan(-1);
    expect(statements[beginIndex + 1]).toBe("create table b (id int);");
    expect(statements[beginIndex + 2]).toContain("insert into _bahama_migrations");
    expect(statements[beginIndex + 3]).toBe("commit");
    // The already-applied migration was never re-executed.
    expect(statements).not.toContain("create table a (id int);");
    expect(await countApplied(["0001_init.sql", "0002_more.sql"], exec)).toBe(2);
  });

  it("rolls back and reports the failing migration", async () => {
    const statements: string[] = [];
    const exec: QueryExecutor = async (sql) => {
      statements.push(sql);
      if (sql.includes("boom")) throw new Error("syntax error at boom");
      if (/^select name from/i.test(sql.trim())) return { rows: [] };
      return { rows: [] };
    };
    await expect(
      runMigrations([{ name: "0001_bad.sql", sql: "boom;" }], exec),
    ).rejects.toThrow(/0001_bad\.sql.*syntax error/);
    expect(statements).toContain("rollback");
  });

  it("rejects destructive SQL before touching the database", async () => {
    expect(findDestructiveStatement("SELECT 1; DROP   TABLE users;")).toBe("DROP TABLE");
    expect(findDestructiveStatement("alter table x drop column y")).toBe("DROP COLUMN");
    expect(findDestructiveStatement("TRUNCATE sessions")).toBe("TRUNCATE");
    expect(findDestructiveStatement("create index drop_zone on t (id)")).toBeNull();

    const exec: QueryExecutor = async () => {
      throw new Error("database must not be touched");
    };
    await expect(
      runMigrations([{ name: "0001_drop.sql", sql: "drop table users;" }], exec),
    ).rejects.toThrow(/destructive migrations are rejected in v0\.1/);
  });
});

describe("execute neon.migrations.apply", () => {
  it("rejects destructive migrations before using the connection secret", async () => {
    const root = await scratchDir();
    await withMigrations(root, { "0001_drop.sql": "DROP TABLE users;" });
    const { ctx } = makeCtx(root, () => undefined);
    const ref = ctx.secrets.seal("database.connectionUrl", CONNECTION_URL);
    const outcome = await neonProvider.execute(
      ctx,
      planned({ id: "database-migrate", action: "neon.migrations.apply", inputs: {} }),
      { consumed: { "resources.database.connectionUrl": ref } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.postconditionVerified).toBe(false);
    expect(outcome.error?.message).toContain("destructive migrations are rejected in v0.1");
    expect(outcome.error?.message).toContain("0001_drop.sql");
  });

  it("fails cleanly when no sealed connection string was consumed", async () => {
    const root = await scratchDir();
    await withMigrations(root, { "0001_init.sql": "create table a (id int);" });
    const { ctx } = makeCtx(root, () => undefined);
    const outcome = await neonProvider.execute(
      ctx,
      planned({ id: "database-migrate", action: "neon.migrations.apply", inputs: {} }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("no sealed connection string");
  });
});

describe("status", () => {
  it("reports material drift when the locked project no longer exists", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "projects get proj-gone --output json")
        return { exitCode: 1, stderr: "not found" };
      return undefined;
    });
    const report = await neonProvider.status(ctx, {
      intent: [DB_INTENT],
      locked: [{ resourceKey: "database", identity: { projectId: "proj-gone" } }],
    });
    expect(report.resources[0]).toMatchObject({ exists: false, healthy: false });
    expect(report.resources[0]!.drift[0]).toMatchObject({
      severity: "material",
      message: expect.stringContaining("proj-gone"),
    });
  });

  it("reports a healthy locked project", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (args.join(" ") === "projects get proj-123 --output json")
        return { stdout: JSON.stringify({ id: "proj-123", name: "my-app" }) };
      return undefined;
    });
    const report = await neonProvider.status(ctx, {
      intent: [DB_INTENT],
      locked: [{ resourceKey: "database", identity: { projectId: "proj-123" } }],
    });
    expect(report.resources[0]).toMatchObject({ exists: true, healthy: true, detail: "my-app", drift: [] });
  });
});
