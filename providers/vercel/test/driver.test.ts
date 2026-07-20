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
} from "@bahama/provider-kit";
import {
  parseDeploymentResult,
  parseDeploymentUrl,
  parseTeamsList,
  vercelProvider,
} from "../src/index.js";

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
    inputs: { name: "my-app", scope: null, framework: "nextjs" },
    ...partial,
  };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vercel-test-"));
}

const PROJECT_JSON = JSON.stringify({
  id: "prj_123",
  name: "my-app",
  accountId: "team_acme",
  framework: "nextjs",
  targets: { production: { alias: ["my-app.vercel.app"] } },
});
const USER_JSON = JSON.stringify({ user: { uid: "user_1", username: "andrew" } });
const TEAMS_JSON = JSON.stringify({
  teams: [
    {
      id: "team_personal",
      slug: "andrews-projects",
      name: "Andrew's projects",
      createdDirectToHobby: true,
    },
    { id: "team_acme", slug: "acme", name: "Acme Inc" },
  ],
});
const line = (args: string[]) => args.join(" ");

describe("probe", () => {
  it("declares delegated interactive login and logout", () => {
    expect(vercelProvider.authCommands).toEqual({
      executables: ["vercel"],
      loginArgs: ["login"],
      logoutArgs: ["logout"],
    });
  });

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

  it("parses identity, teams, durable account, and observed project state when authenticated", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "--version") return { stdout: "39.4.2" };
      if (line(args) === "whoami") return { stdout: "andrew\n" };
      if (line(args) === "api /v2/user") return { stdout: USER_JSON };
      if (line(args) === "api /v2/teams?limit=100") return { stdout: TEAMS_JSON };
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const result = await vercelProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth).toMatchObject({ state: "authenticated", identity: "andrew" });
    // The durable USER id, not the username, is what the lock will record.
    expect(result.auth.account).toBeUndefined();
    expect(result.accounts).toEqual([
      {
        id: "team_personal",
        label: "Andrew's projects",
        kind: "personal",
        selector: "andrews-projects",
      },
      { id: "team_acme", label: "Acme Inc", kind: "team", selector: "acme" },
    ]);
    expect(result.observed["application"]).toEqual({
      exists: true,
      projectId: "prj_123",
      framework: "nextjs",
    });
  });

  it("uses the configured team scope as the durable account", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "--version") return { stdout: "39.4.2" };
      if (line(args) === "whoami") return { stdout: "andrew\n" };
      if (line(args) === "api /v2/user") return { stdout: USER_JSON };
      if (line(args) === "api /v2/teams?limit=100") {
        return {
          stdout: JSON.stringify({ teams: [{ id: "team_acme", slug: "acme", name: "Acme Inc" }] }),
        };
      }
      if (line(args) === "api /v9/projects/my-app --scope acme") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const result = await vercelProvider.probe(ctx, {
      intent: [{ ...APP_INTENT, config: { scope: "acme" } }],
      locked: [],
    });
    expect(result.auth.account).toEqual({
      id: "team_acme",
      label: "Acme Inc",
      kind: "team",
      selector: "acme",
    });
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
      if (line(args) === "api /v2/user") return { stdout: USER_JSON };
      if (line(args) === "api /v2/teams?limit=100") return { stdout: JSON.stringify({ teams: [] }) };
      if (line(args) === "api /v9/projects/prj_lock") return { stdout: PROJECT_JSON };
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

  it("ignores inspector and documentation URLs in legacy deploy output", () => {
    expect(parseDeploymentUrl("Inspect: https://vercel.com/acme/my-app/dpl_abc", "")).toBeNull();
    expect(parseDeploymentUrl("", "Learn more: https://vercel.com/docs/deployments")).toBeNull();
  });

  it("parses the structured Vercel CLI 55 agent result", () => {
    const stdout = JSON.stringify({
      status: "ok",
      deployment: {
        id: "dpl_abc",
        url: "https://my-app-abc123.vercel.app",
        inspectorUrl: "https://vercel.com/acme/my-app/dpl_abc",
        readyState: "READY",
        deploymentApiUrl: "https://api.vercel.com/v13/deployments/dpl_abc",
      },
      message: "Deployment my-app-abc123.vercel.app ready.",
    });
    expect(parseDeploymentResult(stdout, "")).toEqual({
      id: "dpl_abc",
      url: "https://my-app-abc123.vercel.app",
      readyState: "READY",
    });
  });
});

describe("plan", () => {
  it("offers personal and team accounts when no project scope is selected", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await vercelProvider.plan(
      ctx,
      planRequest({
        probe: probed({
          accounts: [
            { id: "user_1", label: "Andrew", kind: "personal", selector: "personal" },
            { id: "team_acme", label: "Acme Inc", kind: "team", selector: "acme" },
          ],
        }),
      }),
    );
    expect(contribution.steps).toEqual([]);
    expect(contribution.decisions![0]).toMatchObject({
      kind: "decision",
      question: "Which Vercel account should own this application?",
      writeBack: "application.config.scope",
    });
    expect(contribution.decisions![0]!.options.map((option) => option.id)).toEqual(["personal", "acme"]);
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
      inputs: { name: "my-app", scope: null, framework: "nextjs" },
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

  it("plans a consequential configuration change when Vercel has the wrong framework preset", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await vercelProvider.plan(
      ctx,
      planRequest({
        probe: probed({ observed: { application: { exists: true, projectId: "prj_123", framework: "static-site" } } }),
        locked: [{ resourceKey: "application", identity: { projectId: "prj_123" } }],
      }),
    );
    expect(contribution.steps[0]).toMatchObject({
      summary: "Set the Vercel framework preset for `my-app`",
      effects: { changesConfiguration: true },
      inputs: { framework: "nextjs" },
    });
  });

  it("drops a confirmed-missing locked id from every replacement step", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await vercelProvider.plan(
      ctx,
      planRequest({
        probe: probed({
          auth: {
            state: "authenticated",
            identity: "andrew",
            account: { id: "user_1", label: "andrew", kind: "personal", selector: "personal" },
          },
          accounts: [{ id: "user_1", label: "andrew", kind: "personal", selector: "personal" }],
          observed: { application: { exists: false } },
        }),
        locked: [
          { resourceKey: "application", accountId: "user_1", identity: { projectId: "prj_deleted" } },
        ],
      }),
    );
    expect(contribution.steps[0]).toMatchObject({ effects: { createsResource: true } });
    for (const step of contribution.steps) {
      expect(step.inputs?.["projectId"]).toBeNull();
    }
  });
});

describe("execute vercel.project.ensure", () => {
  it("treats Vercel CLI 55 human stderr 404 as an absent project", async () => {
    const root = await scratchDir();
    let created = false;
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app") {
        return created
          ? { stdout: PROJECT_JSON }
          : {
              exitCode: 1,
              stderr:
                "Vercel CLI 55.0.0 (Node.js 22.18.0)\napi is in beta — https://vercel.com/feedback\nError: Project not found. (404)",
            };
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
    expect(outcome.status).toBe("succeeded");
    expect(calls.some((call) => line(call.args) === "project add my-app")).toBe(true);
  });

  it("creates the project when the api lookup reports not_found, then verifies", async () => {
    const root = await scratchDir();
    let created = false;
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app") {
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
      if (line(args) === "api /v9/projects/my-app --scope acme") return { stdout: PROJECT_JSON };
      return undefined;
    });
    const outcome = await vercelProvider.execute(
      ctx,
      planned({
        action: "vercel.project.ensure",
        inputs: { name: "my-app", scope: "acme", framework: "nextjs" },
      }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({ status: "succeeded", receipt: { existed: true } });
    expect(calls.every((call) => call.args[0] !== "project")).toBe(true);
  });

  it("updates and verifies the provider-native framework preset", async () => {
    const root = await scratchDir();
    let framework = "other";
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app" || line(args) === "api /v9/projects/prj_123") {
        return {
          stdout: JSON.stringify({
            id: "prj_123",
            name: "my-app",
            accountId: "team_acme",
            framework,
          }),
        };
      }
      if (line(args) === "api /v9/projects/prj_123 -X PATCH -F framework=nextjs") {
        framework = "nextjs";
        return { stdout: JSON.stringify({ id: "prj_123", framework }) };
      }
      return undefined;
    });
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.project.ensure" }), {
      consumed: {},
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      receipt: { framework: "nextjs" },
    });
    expect(
      calls.some((call) => line(call.args) === "api /v9/projects/prj_123 -X PATCH -F framework=nextjs"),
    ).toBe(true);
  });

  it("uses null to select Vercel Other for a static site", async () => {
    const root = await scratchDir();
    let framework: string | null = "nextjs";
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app" || line(args) === "api /v9/projects/prj_123") {
        return { stdout: JSON.stringify({ id: "prj_123", name: "my-app", accountId: "team_acme", framework }) };
      }
      if (line(args) === "api /v9/projects/prj_123 -X PATCH -F framework=null") {
        framework = null;
        return { stdout: JSON.stringify({ id: "prj_123", framework }) };
      }
      return undefined;
    });
    const outcome = await vercelProvider.execute(
      ctx,
      planned({
        action: "vercel.project.ensure",
        inputs: { name: "my-app", scope: null, framework: "static-site" },
      }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("succeeded");
    expect(calls.some((call) => line(call.args).endsWith("-F framework=null"))).toBe(true);
  });
});

describe("execute vercel.env.set", () => {
  it("pipes the sealed secret via secretStdin and verifies the name for production", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(root, (cmd, args) => {
      if (line(args) === "env add DATABASE_URL production --yes --force") return { stdout: "Added" };
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "api /v9/projects/prj_123/env") {
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
    // The invocation is pinned to the PLANNED project, not .vercel/project.json.
    expect(envAdd.options?.env).toEqual({ VERCEL_PROJECT_ID: "prj_123", VERCEL_ORG_ID: "team_acme" });
    // The secret value itself never appears in arguments or the outcome.
    expect(envAdd.args.join(" ")).not.toContain("sekret");
    expect(JSON.stringify(outcome)).not.toContain("sekret");
  });

  it("fails the postcondition when the env list does not include the name", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "env add DATABASE_URL production --yes --force") return { stdout: "Added" };
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "api /v9/projects/prj_123/env")
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
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
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
        if (
          line(args) === "api /v9/projects/my-app" ||
          line(args) === "api /v9/projects/prj_123"
        ) return { stdout: PROJECT_JSON };
        if (line(args) === "deploy --prod --yes --format=json") {
          expect(options?.cwd).toBe(root);
          // The deploy itself is pinned to the planned project via env.
          expect(options?.env).toEqual({ VERCEL_PROJECT_ID: "prj_123", VERCEL_ORG_ID: "team_acme" });
          return {
            stdout: JSON.stringify({
              status: "ok",
              deployment: {
                id: "dpl_abc",
                url: "https://my-app-abc123.vercel.app",
                inspectorUrl: "https://vercel.com/acme/my-app/dpl_abc",
                readyState: "BUILDING",
                deploymentApiUrl: "https://api.vercel.com/v13/deployments/dpl_abc",
              },
            }),
          };
        }
        if (line(args) === "api /v13/deployments/dpl_abc") {
          polls += 1;
          return {
            stdout: JSON.stringify({
              id: "dpl_abc",
              projectId: "prj_123",
              readyState: polls === 1 ? "BUILDING" : "READY",
            }),
          };
        }
        return undefined;
      },
      {
        http: (req) => (req.url === "https://my-app.vercel.app" ? { status: 200, body: {} } : undefined),
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
      produced: { productionUrl: "https://my-app.vercel.app" },
      receipt: { deploymentId: "dpl_abc", state: "READY", httpStatus: 200 },
    });
    expect(polls).toBe(2);
  });

  it("fails when the deployment ends in ERROR", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "deploy --prod --yes --format=json") return { stdout: "https://my-app-err.vercel.app\n" };
      if (line(args) === "api /v13/deployments/my-app-err.vercel.app")
        return { stdout: JSON.stringify({ id: "dpl_err", readyState: "ERROR" }) };
      return undefined;
    });
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.deploy" }), {
      consumed: {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("ERROR");
  });

  it("fails when the polled deployment belongs to a different project", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/my-app") return { stdout: PROJECT_JSON };
      if (line(args) === "deploy --prod --yes --format=json") return { stdout: "https://my-app-other.vercel.app\n" };
      if (line(args) === "api /v13/deployments/my-app-other.vercel.app")
        return { stdout: JSON.stringify({ id: "dpl_x", projectId: "prj_OTHER", readyState: "READY" }) };
      return undefined;
    });
    const outcome = await vercelProvider.execute(ctx, planned({ action: "vercel.deploy" }), {
      consumed: {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("prj_OTHER");
  });

  it("looks up the LOCKED project id when the plan pinned one", async () => {
    const root = await scratchDir();
    const { ctx, calls } = makeCtx(
      root,
      (cmd, args) => {
        if (line(args) === "api /v9/projects/prj_123") return { stdout: PROJECT_JSON };
        if (line(args) === "deploy --prod --yes --format=json") return { stdout: "https://my-app-abc.vercel.app\n" };
        if (line(args) === "api /v13/deployments/my-app-abc.vercel.app")
          return { stdout: JSON.stringify({ id: "dpl_abc", projectId: "prj_123", readyState: "READY" }) };
        return undefined;
      },
      { http: (req) => (req.url === "https://my-app.vercel.app" ? { status: 200, body: {} } : undefined) },
    );
    const outcome = await vercelProvider.execute(
      ctx,
      planned({ action: "vercel.deploy", inputs: { name: "my-app", scope: null, projectId: "prj_123" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("succeeded");
    expect(calls.some((call) => line(call.args) === "api /v9/projects/prj_123")).toBe(true);
  });
});

describe("execute vercel.verify", () => {
  it("verifies the consumed production URL on a successful response", async () => {
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

  it("rejects a production 404", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined, {
      http: (req) => (req.url === "https://my-app.vercel.app" ? { status: 404, body: {} } : undefined),
    });
    const outcome = await vercelProvider.execute(
      ctx,
      planned({ id: "application-verify", action: "vercel.verify" }),
      { consumed: { "application.productionUrl": "https://my-app.vercel.app" } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("404");
  });

  it("falls back to the project's production target when nothing was consumed", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(
      root,
      (cmd, args) => {
        if (line(args) === "api /v9/projects/my-app") {
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
      if (line(args) === "api /v9/projects/prj_gone")
        return { stdout: JSON.stringify({ error: { code: "not_found", message: "gone" } }) };
      return undefined;
    });
    const report = await vercelProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { projectId: "prj_gone" } }],
    });
    expect(report.resources[0]).toMatchObject({ exists: false, health: { state: "unhealthy" } });
    expect(report.resources[0]!.drift[0]).toMatchObject({ severity: "material" });
  });

  it("reports a healthy project with its production URL", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (cmd, args) => {
      if (line(args) === "api /v9/projects/prj_123") {
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
      health: { state: "ready" },
      detail: "https://my-app.vercel.app",
    });
  });
});
