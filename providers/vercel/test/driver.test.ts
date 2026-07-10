import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BindingEdge,
  HttpRequest,
  HttpResponse,
  JsonObject,
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
import { parseDeploymentUrl, parseTeamsList, vercelProvider } from "../src/index.js";

const SECRET_URL = "postgres://user:sekret@ep-cool-1.aws.neon.tech/neondb?sslmode=require";

type CannedRun = { exitCode?: number; stdout?: string; stderr?: string };
type RunHandler = (cmd: string, args: string[], options?: RunOptions) => CannedRun | undefined;
type HttpHandler = (req: HttpRequest) => { status: number; body?: JsonObject } | undefined;

interface RecordedCall {
  cmd: string;
  args: string[];
  options?: RunOptions;
}

function makeCtx(
  root: string,
  handler: RunHandler,
  options?: { which?: (cmd: string) => string | null; http?: HttpHandler },
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
  const which = options?.which ?? ((cmd: string) => (cmd === "vercel" ? "/usr/local/bin/vercel" : null));
  const http = options?.http ?? (() => undefined);
  const ctx: ProviderContext = {
    projectRoot: root,
    run: {
      async run(cmd, args, runOptions): Promise<RunResult> {
        calls.push({ cmd, args, ...(runOptions !== undefined ? { options: runOptions } : {}) });
        const canned = handler(cmd, args, runOptions);
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
      async request(req: HttpRequest): Promise<HttpResponse> {
        const res = http(req);
        if (!res) throw new Error(`Unexpected HTTP request: ${req.method} ${req.url}`);
        const bodyText = JSON.stringify(res.body ?? {});
        return {
          status: res.status,
          headers: {},
          body: bodyText,
          json: <T = unknown>() => JSON.parse(bodyText) as T,
        };
      },
    },
    secrets,
    log: { debug() {}, info() {}, warn() {} },
    signal: new AbortController().signal,
    interactive: false,
  };
  return { ctx, calls, sealed: values };
}

const APP_INTENT: ResourceIntent = {
  resourceKey: "application",
  role: "application",
  framework: "nextjs",
  projectName: "my-app",
  config: {},
};

const DATABASE_BINDING: BindingEdge = {
  name: "DATABASE_URL",
  from: { resourceKey: "database", capability: "connectionUrl" },
  to: { resourceKey: "application", capability: "productionEnvironment" },
  secret: true,
};

function probed(overrides?: Partial<ProbeResult>): ProbeResult {
  return {
    tool: { installed: true, version: "39.4.2", compatibility: "tested" },
    auth: { state: "authenticated", identity: "andrew" },
    accounts: [],
    observed: { application: { exists: false } },
    ...overrides,
  };
}

function planRequest(overrides?: Partial<PlanRequest>): PlanRequest {
  return {
    intent: [APP_INTENT],
    locked: [],
    probe: probed(),
    bindings: [DATABASE_BINDING],
    ...overrides,
  };
}

function planned(partial: Partial<PlannedStep> & { action: string }): PlannedStep {
  return {
    id: "application-ensure",
    summary: "",
    effects: {},
    postcondition: "",
    providerId: "vercel",
    classification: "routine",
    dependsOn: [],
    resourceKey: "application",
    inputs: { name: "my-app", scope: null },
    ...partial,
  };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vercel-test-"));
}

const PROJECT_JSON = JSON.stringify({ id: "prj_123", name: "my-app" });
const line = (args: string[]) => args.join(" ");

describe("probe", () => {
  it("reports the tool as missing with an install hint", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined, { which: () => null });
    const result = await vercelProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.tool).toMatchObject({ installed: false, installHint: "npm i -g vercel" });
  });

  it("reports unauthenticated when whoami fails", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "--version") return { stdout: "39.4.2" };
      if (line(args) === "whoami") return { exitCode: 1, stderr: "Error: not logged in" };
      return undefined;
    });
    const result = await vercelProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth.state).toBe("unauthenticated");
    expect(result.auth.loginHint).toContain("vercel login");
    expect(result.auth.loginHint).toContain("VERCEL_TOKEN");
  });

  it("parses identity, teams, and observed project state when authenticated", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "--version") return { stdout: "39.4.2" };
      if (line(args) === "whoami") return { stdout: "andrew\n" };
      if (line(args) === "teams list")
        return { stdout: "id            name\n✔ acme        Acme Inc\n  personal    Andrew\n" };
      if (line(args) === "curl /v9/projects/my-app") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const result = await vercelProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth).toMatchObject({ state: "authenticated", identity: "andrew" });
    expect(result.accounts.map((a) => a.id)).toEqual(["acme", "personal"]);
    expect(result.observed["application"]).toEqual({ exists: true, projectId: "prj_123" });
  });

  it("warns when .vercel/project.json disagrees with the lock (the lock wins)", async () => {
    const root = await scratchDir();
    await mkdir(join(root, ".vercel"), { recursive: true });
    await writeFile(
      join(root, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_linked", orgId: "team_1" }),
    );
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "--version") return { stdout: "39.4.2" };
      if (line(args) === "whoami") return { stdout: "andrew\n" };
      if (line(args) === "teams list") return { exitCode: 1, stderr: "nope" };
      if (line(args) === "curl /v9/projects/prj_lock") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const result = await vercelProvider.probe(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { projectId: "prj_lock" } }],
    });
    expect(result.warnings?.some((w) => w.includes("prj_linked") && w.includes("prj_lock"))).toBe(true);
  });
});

describe("teams and URL parsing", () => {
  it("returns no accounts when teams output has no recognizable header", () => {
    expect(parseTeamsList("something unexpected\nno table here")).toEqual([]);
  });

  it("extracts the last https:// line from deploy output", () => {
    const stdout = [
      "Vercel CLI 39.4.2",
      "Inspect: https://vercel.com/acme/my-app/dpl_abc",
      "https://my-app-abc123.vercel.app",
      "",
    ].join("\n");
    expect(parseDeploymentUrl(stdout, "")).toBe("https://my-app-abc123.vercel.app");
    expect(parseDeploymentUrl("", "Queued... https://my-app-xyz.vercel.app")).toBe(
      "https://my-app-xyz.vercel.app",
    );
    expect(parseDeploymentUrl("no url here", "")).toBeNull();
  });
});

describe("plan", () => {
  it("returns a scope decision when multiple teams and no config.scope", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await vercelProvider.plan(
      ctx,
      planRequest({
        probe: probed({
          accounts: [
            { id: "acme", label: "Acme Inc", kind: "team" },
            { id: "personal", label: "Andrew", kind: "team" },
          ],
        }),
      }),
    );
    expect(contribution.steps).toEqual([]);
    expect(contribution.decisions![0]).toMatchObject({
      kind: "decision",
      writeBack: "application.config.scope",
    });
  });

  it("contributes ensure, one env step per binding, deploy, and verify", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await vercelProvider.plan(ctx, planRequest());
    const byId = new Map(contribution.steps.map((s) => [s.id, s]));

    expect(contribution.steps.map((s) => s.id)).toEqual([
      "application-ensure",
      "application-env-database_url",
      "application-deploy",
      "application-verify",
    ]);
    expect(byId.get("application-ensure")).toMatchObject({
      action: "vercel.project.ensure",
      effects: { createsResource: true },
      inputs: { name: "my-app", scope: null },
    });
    expect(byId.get("application-env-database_url")).toMatchObject({
      action: "vercel.env.set",
      effects: { transfersSecret: true },
      consumes: ["resources.database.connectionUrl"],
      dependsOn: ["application-ensure"],
      inputs: { bindingName: "DATABASE_URL", bindingTo: "application.productionEnvironment" },
    });
    expect(byId.get("application-deploy")).toMatchObject({
      action: "vercel.deploy",
      effects: { deploys: true },
      dependsOn: ["application-ensure", "application-env-database_url"],
      produces: ["productionUrl"],
    });
    expect(byId.get("application-verify")).toMatchObject({
      action: "vercel.verify",
      effects: { readOnly: true },
      dependsOn: ["application-deploy"],
      consumes: ["application.productionUrl"],
    });
  });

  it("plans adopt when live-but-unlocked and readOnly verify when locked", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const adopted = await vercelProvider.plan(
      ctx,
      planRequest({ probe: probed({ observed: { application: { exists: true, projectId: "prj_123" } } }) }),
    );
    expect(adopted.steps[0]!.effects).toEqual({ adoptsResource: true });

    const locked = await vercelProvider.plan(
      ctx,
      planRequest({
        probe: probed({ observed: { application: { exists: true, projectId: "prj_123" } } }),
        locked: [{ resourceKey: "application", identity: { projectId: "prj_123" } }],
      }),
    );
    expect(locked.steps[0]!.effects).toEqual({ readOnly: true });
  });
});

describe("execute vercel.project.ensure", () => {
  it("creates the project when the curl lookup reports not_found, then verifies", async () => {
    const root = await scratchDir();
    let created = false;
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "curl /v9/projects/my-app") {
        return created
          ? { stdout: PROJECT_JSON }
          : { stdout: JSON.stringify({ error: { code: "not_found", message: "Project not found" } }) };
      }
      if (line(args) === "project add my-app") {
        created = true;
        return { stdout: "Success!" };
      }
      return undefined;
    });
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.project.ensure" }), {
      consumed: {},
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { projectId: "prj_123", name: "my-app" },
      receipt: { projectId: "prj_123", existed: false },
    });
    expect(calls.some((call) => line(call.args) === "project add my-app")).toBe(true);
  });

  it("adopts an existing project without creating and passes --scope through", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "curl /v9/projects/my-app --scope acme") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const outcome = await vercelProvider.execute(
      ctx,
      planned({ action: "vercel.project.ensure", inputs: { name: "my-app", scope: "acme" } }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({ status: "succeeded", receipt: { existed: true } });
    expect(calls.every((call) => call.args[0] !== "project")).toBe(true);
  });
});

describe("execute vercel.env.set", () => {
  it("pipes the sealed secret via secretStdin and verifies the name for production", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "env add DATABASE_URL production --yes --force") return { stdout: "Added" };
      if (line(args) === "curl /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "curl /v9/projects/prj_123/env") {
        return {
          stdout: JSON.stringify({
            envs: [{ key: "DATABASE_URL", target: ["production"], type: "encrypted" }],
          }),
        };
      }
      return undefined;
    });
    const ref = ctx.secrets.seal("database.connectionUrl", SECRET_URL);
    const outcome = await vercelProvider.execute(
      ctx,
      planned({
        id: "application-env-database_url",
        action: "vercel.env.set",
        inputs: {
          name: "my-app",
          scope: null,
          bindingName: "DATABASE_URL",
          bindingTo: "application.productionEnvironment",
        },
      }),
      { consumed: { "resources.database.connectionUrl": ref } },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      receipt: { name: "DATABASE_URL", target: "production" },
    });
    const envAdd = calls.find((call) => call.args[0] === "env")!;
    expect(envAdd.options?.secretStdin).toBe(ref);
    expect(envAdd.args).toEqual(["env", "add", "DATABASE_URL", "production", "--yes", "--force"]);
    // The secret value itself never appears in arguments or the outcome.
    expect(envAdd.args.join(" ")).not.toContain("sekret");
    expect(JSON.stringify(outcome)).not.toContain("sekret");
  });

  it("fails the postcondition when the env list does not include the name", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "env add DATABASE_URL production --yes --force") return { stdout: "Added" };
      if (line(args) === "curl /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "curl /v9/projects/prj_123/env")
        return { stdout: JSON.stringify({ envs: [{ key: "OTHER", target: ["production"] }] }) };
      return undefined;
    });
    const ref = ctx.secrets.seal("database.connectionUrl", SECRET_URL);
    const outcome = await vercelProvider.execute(
      ctx,
      planned({
        action: "vercel.env.set",
        inputs: { name: "my-app", scope: null, bindingName: "DATABASE_URL", bindingTo: "x" },
      }),
      { consumed: { "resources.database.connectionUrl": ref } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.postconditionVerified).toBe(false);
    expect(outcome.error?.message).toContain("DATABASE_URL");
  });

  it("surfaces the CLI message when env add exits nonzero", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "env add DATABASE_URL production --yes --force")
        return { exitCode: 1, stderr: "Error: unknown or unexpected option: --force" };
      return undefined;
    });
    const ref = ctx.secrets.seal("database.connectionUrl", SECRET_URL);
    const outcome = await vercelProvider.execute(
      ctx,
      planned({
        action: "vercel.env.set",
        inputs: { name: "my-app", scope: null, bindingName: "DATABASE_URL", bindingTo: "x" },
      }),
      { consumed: { "resources.database.connectionUrl": ref } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("--force");
  });
});

describe("execute vercel.deploy", () => {
  it("parses the deployment URL, polls to READY, and verifies the production URL", async () => {
    const root = await scratchDir();
    let polls = 0;
    const { ctx } = makeCtx(
      root,
      (cmd, args, options) => {
        if (line(args) === "deploy --prod --yes") {
          expect(options?.cwd).toBe(root);
          return {
            stdout: "Inspect: https://vercel.com/acme/my-app/dpl_abc\nhttps://my-app-abc123.vercel.app\n",
          };
        }
        if (line(args) === "curl /v13/deployments/my-app-abc123.vercel.app") {
          polls += 1;
          return {
            stdout: JSON.stringify({
              id: "dpl_abc",
              readyState: polls === 1 ? "BUILDING" : "READY",
            }),
          };
        }
        return undefined;
      },
      {
        http: (req) =>
          req.url === "https://my-app-abc123.vercel.app" ? { status: 200, body: {} } : undefined,
      },
    );
    const outcome = await vercelProvider.execute(
      ctx,
      planned({ id: "application-deploy", action: "vercel.deploy" }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      produced: { productionUrl: "https://my-app-abc123.vercel.app" },
      receipt: { deploymentId: "dpl_abc", state: "READY", httpStatus: 200 },
    });
    expect(polls).toBe(2);
  });

  it("fails when the deployment ends in ERROR", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "deploy --prod --yes") return { stdout: "https://my-app-err.vercel.app\n" };
      if (line(args) === "curl /v13/deployments/my-app-err.vercel.app")
        return { stdout: JSON.stringify({ id: "dpl_err", readyState: "ERROR" }) };
      return undefined;
    });
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.deploy" }), {
      consumed: {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("ERROR");
  });
});

describe("execute vercel.verify", () => {
  it("verifies the consumed production URL on a non-5xx response", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined, {
      http: (req) => (req.url === "https://my-app.vercel.app" ? { status: 200, body: {} } : undefined),
    });
    const outcome = await vercelProvider.execute(
      ctx,
      planned({ id: "application-verify", action: "vercel.verify" }),
      { consumed: { "application.productionUrl": "https://my-app.vercel.app" } },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      receipt: { httpStatus: 200 },
    });
  });

  it("falls back to the project's production target when nothing was consumed", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(
      root,
      (cmd, args) => {
        if (line(args) === "curl /v9/projects/my-app") {
          return {
            stdout: JSON.stringify({
              id: "prj_123",
              name: "my-app",
              targets: { production: { alias: ["my-app.vercel.app"], url: "my-app-abc.vercel.app" } },
            }),
          };
        }
        return undefined;
      },
      { http: (req) => (req.url === "https://my-app.vercel.app" ? { status: 200, body: {} } : undefined) },
    );
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.verify" }), {
      consumed: {},
    });
    expect(outcome.status).toBe("succeeded");
  });
});

describe("status", () => {
  it("reports material drift when the locked project no longer exists", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "curl /v9/projects/prj_gone")
        return { stdout: JSON.stringify({ error: { code: "not_found", message: "gone" } }) };
      return undefined;
    });
    const report = await vercelProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { projectId: "prj_gone" } }],
    });
    expect(report.resources[0]).toMatchObject({ exists: false, healthy: false });
    expect(report.resources[0]!.drift[0]).toMatchObject({ severity: "material" });
  });

  it("reports a healthy project with its production URL", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "curl /v9/projects/prj_123") {
        return {
          stdout: JSON.stringify({
            id: "prj_123",
            name: "my-app",
            targets: { production: { alias: ["my-app.vercel.app"] } },
          }),
        };
      }
      return undefined;
    });
    const report = await vercelProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { projectId: "prj_123" } }],
    });
    expect(report.resources[0]).toMatchObject({
      exists: true,
      healthy: true,
      detail: "https://my-app.vercel.app",
    });
  });
});
