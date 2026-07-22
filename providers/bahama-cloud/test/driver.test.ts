import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HttpRequest,
  HttpResponse,
  JsonObject,
  PlanRequest,
  PlannedStep,
  ProbeResult,
  ProviderContext,
  ResourceIntent,
  SecretBroker,
  SecretRef,
} from "@bahama/provider-kit";
import { bahamaCloudProvider } from "../src/index.js";

const TOKEN = "test-token-abc123";
const BASE = "https://cloud.test";

type CannedResponse = { status: number; body: JsonObject };
type Handler = (req: HttpRequest) => CannedResponse | undefined;

function makeCtx(
  root: string,
  handler: Handler,
  credentials?: {
    freshToken(options?: { forceRefresh?: boolean }): Promise<SecretRef | null>;
  },
): { ctx: ProviderContext; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
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
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      which: async () => null,
    },
    http: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        const res = handler(req);
        if (!res) throw new Error(`Unexpected request: ${req.method} ${req.url}`);
        const bodyText = JSON.stringify(res.body);
        return {
          status: res.status,
          headers: {},
          body: bodyText,
          json: <T = unknown>() => JSON.parse(bodyText) as T,
        };
      },
    },
    secrets,
    ...(credentials !== undefined ? { credentials } : {}),
    log: { debug() {}, info() {}, warn() {} },
    signal: new AbortController().signal,
    interactive: false,
  };
  return { ctx, requests };
}

function projectBody(overrides?: {
  framework?: string;
  d1Enabled?: boolean;
  d1Id?: string | null;
  url?: string | null;
}): JsonObject {
  return {
    ok: true,
    user: { email: "dev@example.com" },
    project: {
      slug: "my-app",
      status: "ready",
      app: { framework: overrides?.framework ?? "vite-hono", backend: "hono" },
      resources: {
        d1: {
          enabled: overrides?.d1Enabled ?? false,
          bindingName: "DB",
          databaseId: overrides?.d1Id ?? null,
          databaseName: "my-app-db",
          status: overrides?.d1Id ? "ready" : "not_requested",
        },
      },
      deployment: { url: overrides?.url ?? null, currentJobId: null },
    },
  };
}

const APP_INTENT: ResourceIntent = {
  resourceKey: "application",
  role: "application",
  framework: "vite-hono",
  config: { name: "my-app" },
};
const DB_INTENT: ResourceIntent = {
  resourceKey: "database",
  role: "database",
  engine: "d1",
  config: {},
};

function probed(observed: JsonObject): ProbeResult {
  return {
    tool: { installed: true },
    auth: { state: "authenticated", identity: "dev@example.com" },
    accounts: [],
    observed,
  };
}

function planRequest(overrides?: Partial<PlanRequest>): PlanRequest {
  return {
    intent: [APP_INTENT, DB_INTENT],
    locked: [],
    probe: probed({ application: { exists: false }, database: { exists: false } }),
    bindings: [],
    ...overrides,
  };
}

function planned(partial: Partial<PlannedStep> & { action: string }): PlannedStep {
  return {
    id: "step",
    summary: "",
    effects: {},
    postcondition: "",
    providerId: "bahama-cloud",
    classification: "routine",
    dependsOn: [],
    inputs: { slug: "my-app", framework: "vite-hono" },
    ...partial,
  };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bahama-cloud-test-"));
}

beforeEach(() => {
  process.env["BAHAMA_TOKEN"] = TOKEN;
  process.env["BAHAMA_CLOUD_URL"] = BASE;
});

afterEach(() => {
  delete process.env["BAHAMA_TOKEN"];
  delete process.env["BAHAMA_CLOUD_URL"];
  delete process.env["BAHAMA_CONFIG_DIR"];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probe", () => {
  it("reports unauthenticated (tool always installed) when no token is available", async () => {
    delete process.env["BAHAMA_TOKEN"];
    const root = await scratchDir();
    process.env["BAHAMA_CONFIG_DIR"] = root; // empty dir: no credentials.json
    const { ctx } = makeCtx(root, () => undefined);
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.tool.installed).toBe(true);
    expect(result.auth).toMatchObject({
      state: "unauthenticated",
      loginHint: "bahama auth login bahama-cloud",
    });
  });

  it("reads the token from the credentials file when the env var is absent", async () => {
    delete process.env["BAHAMA_TOKEN"];
    const root = await scratchDir();
    process.env["BAHAMA_CONFIG_DIR"] = root;
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({ "bahama-cloud": { accessToken: TOKEN } }),
    );
    const { ctx, requests } = makeCtx(root, (req) =>
      req.url === `${BASE}/api/projects` ? { status: 200, body: { ok: true, user: { email: "dev@example.com" }, projects: [], count: 0 } } : undefined,
    );
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth.state).toBe("authenticated");
    expect(requests[0]!.headers?.["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("observes project and database state from the list endpoint", async () => {
    const root = await scratchDir();
    const project = (projectBody({ d1Enabled: true, d1Id: "d1-123", url: "https://my-app.proj.test" }) as { project: JsonObject }).project;
    const { ctx } = makeCtx(root, (req) =>
      req.url === `${BASE}/api/projects`
        ? { status: 200, body: { ok: true, user: { email: "dev@example.com" }, projects: [project], count: 1 } }
        : undefined,
    );
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT, DB_INTENT], locked: [] });
    expect(result.auth).toMatchObject({ state: "authenticated", identity: "dev@example.com" });
    expect(result.observed["application"]).toMatchObject({ exists: true, url: "https://my-app.proj.test" });
    expect(result.observed["database"]).toMatchObject({ exists: true, binding: "DB" });
  });

  it("falls back to get-by-slug when the list endpoint does not exist", async () => {
    const root = await scratchDir();
    const { ctx, requests } = makeCtx(root, (req) => {
      if (req.url === `${BASE}/api/projects`) return { status: 404, body: { ok: false, error: "not found" } };
      if (req.url === `${BASE}/api/projects/my-app`) return { status: 200, body: projectBody() };
      return undefined;
    });
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(requests.map((r) => r.url)).toEqual([`${BASE}/api/projects`, `${BASE}/api/projects/my-app`]);
    expect(result.observed["application"]).toMatchObject({ exists: true });
  });

  it("reports an expired session on 401", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => ({ status: 401, body: { ok: false, error: "unauthorized" } }));
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth.state).toBe("expired");
  });

  it("reports an API transport failure as network state instead of authentication failure", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => {
      throw new Error("fetch failed");
    });
    const result = await bahamaCloudProvider.probe(ctx, { intent: [APP_INTENT], locked: [] });
    expect(result.auth).toMatchObject({ state: "unknown", code: "network" });
    expect(result.failure).toMatchObject({
      code: "network",
      message: expect.stringContaining("could not be reached"),
    });
  });
});

describe("plan", () => {
  it("reconciles Cloud resources and local runtime access without deploying code", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const environment: ResourceIntent = {
      resourceKey: "environment.production",
      role: "environment",
      environment: "production",
      framework: "vite-hono",
      projectName: "my-app",
      config: {},
    };
    const developmentBindings = [
      ["BAHAMA_API_BASE_URL", "developmentApiBaseUrl"],
      ["BAHAMA_PROJECT_SLUG", "developmentProjectSlug"],
      ["BAHAMA_DEV_TOKEN", "developmentToken"],
    ].map(([name, capability]) => ({
      name: name!,
      from: { resourceKey: environment.resourceKey, capability: capability! },
      to: { resourceKey: "environment.local", capability: "variables" },
      secret: capability === "developmentToken",
    }));
    const contribution = await bahamaCloudProvider.plan(ctx, planRequest({
      intent: [environment, DB_INTENT],
      operation: { kind: "reconcile" },
      bindings: developmentBindings,
      probe: probed({ "environment.production": { exists: false }, database: { exists: false } }),
    }));
    expect(contribution.steps.some((step) => step.action.startsWith("cloud.app.deploy"))).toBe(false);
    expect(contribution.steps.find((step) => step.action === "cloud.dev-access.create")?.produces).toEqual([
      "developmentApiBaseUrl",
      "developmentProjectSlug",
      "developmentToken",
    ]);
  });

  it("contributes ensure, database, resumable deploy, and verify steps with the expected shapes", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await bahamaCloudProvider.plan(ctx, planRequest());
    const byId = new Map(contribution.steps.map((s) => [s.id, s]));

    expect(contribution.steps.map((s) => s.id)).toEqual([
      "application-ensure",
      "database-ensure",
      "application-deploy-start",
      "application-deploy-await",
      "application-verify",
    ]);
    expect(byId.get("application-ensure")).toMatchObject({
      action: "cloud.project.ensure",
      effects: { createsResource: true },
      inputs: { slug: "my-app", framework: "vite-hono", withDatabase: false },
    });
    expect(byId.get("database-ensure")).toMatchObject({
      action: "cloud.database.ensure",
      effects: { createsResource: true },
      dependsOn: ["application-ensure"],
    });
    expect(byId.get("application-deploy-start")).toMatchObject({
      action: "cloud.app.deploy.start",
      effects: { deploys: true },
      dependsOn: ["application-ensure", "database-ensure"],
      produces: ["deploymentId"],
    });
    expect(byId.get("application-deploy-await")).toMatchObject({
      action: "cloud.app.deploy.await",
      effects: { readOnly: true },
      dependsOn: ["application-deploy-start"],
      consumes: ["application.deploymentId"],
      produces: ["productionUrl"],
    });
    expect(byId.get("application-verify")).toMatchObject({
      action: "cloud.app.verify",
      effects: { readOnly: true },
      dependsOn: ["application-deploy-await"],
      consumes: ["application.productionUrl"],
    });
  });

  it("plans adopt when live-but-unlocked and readOnly verify when live-and-locked", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);

    const adopted = await bahamaCloudProvider.plan(
      ctx,
      planRequest({ probe: probed({ application: { exists: true }, database: { exists: false } }) }),
    );
    expect(adopted.steps.find((s) => s.id === "application-ensure")!.effects).toEqual({
      adoptsResource: true,
    });

    const lockedPlan = await bahamaCloudProvider.plan(
      ctx,
      planRequest({
        probe: probed({ application: { exists: true }, database: { exists: false } }),
        locked: [{ resourceKey: "application", identity: { slug: "my-app" } }],
      }),
    );
    expect(lockedPlan.steps.find((s) => s.id === "application-ensure")!.effects).toEqual({
      readOnly: true,
    });
  });

  it("resolves the slug from bahama.yaml project.name when config has no override", async () => {
    const root = await scratchDir();
    await writeFile(join(root, "bahama.yaml"), "version: 1\nproject:\n  name: yaml-app\napplication:\n  provider: bahama-cloud\n  framework: vite-spa\n");
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await bahamaCloudProvider.plan(
      ctx,
      planRequest({ intent: [{ ...APP_INTENT, config: {} }] }),
    );
    expect(contribution.steps[0]!.inputs).toMatchObject({ slug: "yaml-app" });
  });
});

describe("token refresh", () => {
  it("refreshes once and retries when a mid-operation request gets a 401", async () => {
    const root = await scratchDir();
    // No env token: force the credential-source path.
    delete process.env["BAHAMA_TOKEN"];
    process.env["BAHAMA_CONFIG_DIR"] = root; // empty dir: no credentials.json

    const issued: Array<{ token: string; forceRefresh: boolean }> = [];
    let currentToken = "expired-token";
    const holder: { ctx?: ProviderContext } = {};
    const credentials = {
      async freshToken(options?: { forceRefresh?: boolean }): Promise<SecretRef | null> {
        // Match the real supplier contract: a cached token remains cached
        // unless the provider explicitly forces refresh after a 401.
        const forceRefresh = options?.forceRefresh === true;
        if (forceRefresh) currentToken = "fresh-token";
        const raw = currentToken;
        issued.push({ token: raw, forceRefresh });
        return holder.ctx!.secrets.seal("bahama-cloud.accessToken", raw);
      },
    };

    const { ctx, requests } = makeCtx(
      root,
      (req) =>
        req.headers?.["authorization"] === "Bearer fresh-token"
          ? { status: 200, body: projectBody() }
          : { status: 401, body: { ok: false, error: "token expired" } },
      credentials,
    );
    holder.ctx = ctx;

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.project.ensure", inputs: { slug: "my-app", framework: "vite-hono", withDatabase: false } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("succeeded");
    // One 401, then the refreshed token succeeded — never more than one retry.
    expect(issued[0]).toEqual({ token: "expired-token", forceRefresh: false });
    expect(issued[1]).toEqual({ token: "fresh-token", forceRefresh: true });
    expect(issued.slice(2).every((entry) => entry.token === "fresh-token" && !entry.forceRefresh)).toBe(true);
    expect(requests.some((req) => req.headers?.["authorization"] === "Bearer fresh-token")).toBe(true);
  });
});

describe("execute cloud.project.ensure", () => {
  it("adopts an existing project without creating and verifies the postcondition", async () => {
    const root = await scratchDir();
    const { ctx, requests } = makeCtx(root, (req) =>
      req.method === "GET" && req.url === `${BASE}/api/projects/my-app`
        ? { status: 200, body: projectBody() }
        : undefined,
    );
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.project.ensure", inputs: { slug: "my-app", framework: "vite-hono", withDatabase: false } }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { slug: "my-app" },
      receipt: { existed: true },
    });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("creates the project when absent, then verifies it exists by slug", async () => {
    const root = await scratchDir();
    let exists = false;
    const { ctx, requests } = makeCtx(root, (req) => {
      if (req.method === "GET" && req.url === `${BASE}/api/projects/my-app`) {
        return exists ? { status: 200, body: projectBody() } : { status: 404, body: { ok: false, error: "Project was not found." } };
      }
      if (req.method === "POST" && req.url === `${BASE}/api/projects`) {
        exists = true;
        return { status: 201, body: projectBody({ d1Enabled: true }) };
      }
      return undefined;
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.project.ensure", inputs: { slug: "my-app", framework: "vite-hono", withDatabase: true } }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { slug: "my-app" },
      receipt: { existed: false },
    });
    const create = requests.find((r) => r.method === "POST")!;
    expect(create.body).toEqual({
      slug: "my-app",
      app: { framework: "vite-hono" },
      resources: { d1: { enabled: true } },
    });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("preserves actionable guidance when a globally unique project name is unavailable", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (req) => {
      if (req.method === "GET") return { status: 404, body: { ok: false } };
      if (req.method === "POST") {
        return {
          status: 409,
          body: {
            ok: false,
            code: "project_name_unavailable",
            error: "Project name my-app is unavailable. Bahama Cloud project names are globally unique; choose a different project.name.",
          },
        };
      }
      return undefined;
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.project.ensure" }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "provider-api",
        message: expect.stringContaining("choose a different project.name"),
      },
    });
  });

  it("classifies a thrown request timeout without leaking a generic exception", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => {
      throw new Error("request timed out");
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.project.ensure" }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "timeout", recovery: expect.stringContaining("Check network access") },
    });
  });
});

describe("execute cloud.database.ensure", () => {
  it("enables d1, provisions, and verifies against the database endpoint", async () => {
    const root = await scratchDir();
    let enabled = false;
    let provisioned = false;
    const { ctx, requests } = makeCtx(root, (req) => {
      if (req.method === "GET" && req.url === `${BASE}/api/projects/my-app`) {
        return { status: 200, body: projectBody({ d1Enabled: enabled }) };
      }
      if (req.method === "PATCH" && req.url === `${BASE}/api/projects/my-app`) {
        enabled = true;
        return { status: 200, body: projectBody({ d1Enabled: true }) };
      }
      if (req.method === "POST" && req.url === `${BASE}/api/projects/my-app/database/provision`) {
        provisioned = true;
        return {
          status: 200,
          body: { ok: true, database: { enabled: true, exists: true, id: "d1-123", bindingName: "DB", resourceStatus: "ready" } },
        };
      }
      if (req.method === "GET" && req.url === `${BASE}/api/projects/my-app/database`) {
        return {
          status: 200,
          body: {
            ok: true,
            database: provisioned
              ? { enabled: true, exists: true, id: "d1-123", bindingName: "DB", resourceStatus: "ready" }
              : { enabled, exists: false, id: null, bindingName: "DB", resourceStatus: "not_requested" },
          },
        };
      }
      return undefined;
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.database.ensure", inputs: { slug: "my-app" } }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      identity: { slug: "my-app", binding: "DB" },
      receipt: { resourceStatus: "ready" },
    });
    expect(requests.some((r) => r.method === "PATCH")).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/database/provision"))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });
});

describe("local-first bindings", () => {
  it("writes an externally produced secret through the project secret API without returning it", async () => {
    const root = await scratchDir();
    const raw = "postgres://user:password@example.test/db";
    const { ctx, requests } = makeCtx(root, (req) =>
      req.method === "PUT" && req.url === `${BASE}/api/projects/my-app/secrets`
        ? { status: 200, body: { ok: true, secret: { name: "LOG_DATABASE_URL" } } }
        : undefined,
    );
    const secret = ctx.secrets.seal("logs.connectionUrl", raw);
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.secret.set", inputs: { slug: "my-app", bindingName: "LOG_DATABASE_URL" } }),
      { consumed: { "resources.logs.connectionUrl": secret } },
    );
    expect(outcome).toMatchObject({ status: "succeeded", postconditionVerified: true, receipt: { name: "LOG_DATABASE_URL" } });
    expect(requests[0]!.body).toEqual({ name: "LOG_DATABASE_URL", value: raw });
    expect(JSON.stringify(outcome)).not.toContain(raw);
  });

  it("turns the Cloud dev-token response into three capabilities and keeps the token sealed", async () => {
    const root = await scratchDir();
    const raw = "bahama_dev_public_secret";
    const { ctx } = makeCtx(root, (req) =>
      req.method === "POST" && req.url === `${BASE}/api/projects/my-app/dev-tokens`
        ? {
            status: 201,
            body: {
              ok: true,
              devToken: { publicId: "public", expiresAt: "2026-08-01T00:00:00Z" },
              env: { BAHAMA_API_BASE_URL: BASE, BAHAMA_PROJECT_SLUG: "my-app", BAHAMA_DEV_TOKEN: raw },
            },
          }
        : undefined,
    );
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.dev-access.create", inputs: { slug: "my-app" } }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      produced: { developmentApiBaseUrl: BASE, developmentProjectSlug: "my-app" },
      receipt: { publicId: "public" },
    });
    expect((outcome.produced?.["developmentToken"] as SecretRef).name).toBe("bahama-cloud.developmentToken");
    expect(JSON.stringify(outcome)).not.toContain(raw);
  });
});

describe("execute resumable Cloud deployment", () => {
  it("packages, uploads, starts, and returns the durable job id before polling", async () => {
    const root = await scratchDir();
    await writeFile(join(root, "index.html"), "<html></html>");
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "export {};");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "junk.js"), "junk");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle.js"), "built");
    await writeFile(join(root, ".env"), `SECRET=${TOKEN}`);
    await writeFile(join(root, "bahama.yaml"), "version: 1\n");
    await writeFile(join(root, "bahama.lock"), "{}");
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=npm-secret");

    let putUrl: string | null = null;
    let putBytes: Uint8Array | null = null;
    vi.stubGlobal("fetch", async (url: string | URL, init?: { body?: unknown }) => {
      putUrl = String(url);
      putBytes = init?.body as Uint8Array;
      return { status: 200 } as Response;
    });

    const { ctx, requests } = makeCtx(root, (req) => {
      if (req.method === "POST" && req.url === `${BASE}/api/projects/my-app/deploy/upload-url`) {
        return {
          status: 200,
          body: { ok: true, slug: "my-app", uploadId: "u1", uploadUrl: "https://r2.test/signed-put", objectKey: "uploads/u1.zip", expiresAt: "2026-01-01T00:00:00Z", contentType: "application/zip" },
        };
      }
      if (req.method === "POST" && req.url === `${BASE}/api/projects/my-app/deploy/start`) {
        return { status: 200, body: { ok: true, jobId: "job1", status: "building", stage: "build", url: null, errorCode: null, errorMessage: null } };
      }
      return undefined;
    });

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.start", inputs: { slug: "my-app", framework: "vite-hono" } }),
      { consumed: {} },
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      produced: { deploymentId: "job1" },
      receipt: { jobId: "job1", uploadId: "u1", status: "building", files: 3 },
    });
    expect(requests.some((req) => req.url.includes("/deploy/status/"))).toBe(false);
    expect(putUrl).toBe("https://r2.test/signed-put");

    // bahama.yaml, bahama.lock, .npmrc, .env, node_modules never ship — for
    // static-site the archive root is SERVED, so inclusion means public URLs.
    const entries = Object.keys(unzipSync(putBytes!));
    expect(entries.sort()).toEqual(["index.html", "package.json", "src/main.ts"]);

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("r2.test"); // signed upload URL stays out of receipts
  });

  it("polls an already accepted job id and returns its production URL", async () => {
    const root = await scratchDir();
    const { ctx, requests } = makeCtx(root, (req) =>
      req.method === "GET" && req.url === `${BASE}/api/projects/my-app/deploy/status/job1`
        ? {
            status: 200,
            body: {
              ok: true,
              jobId: "job1",
              status: "deployed",
              stage: "complete",
              url: "https://my-app.proj.test",
              errorCode: null,
              errorMessage: null,
            },
          }
        : undefined,
    );

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ id: "application-deploy-await", action: "cloud.app.deploy.await" }),
      { consumed: { "application.deploymentId": "job1" } },
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      produced: { productionUrl: "https://my-app.proj.test" },
      receipt: { jobId: "job1", status: "deployed", productionUrl: "https://my-app.proj.test" },
    });
    expect(requests.map((req) => req.url)).toEqual([
      `${BASE}/api/projects/my-app/deploy/status/job1`,
    ]);
  });

  it("keeps dist/ for static-bundle deploys", async () => {
    const root = await scratchDir();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "index.html"), "<html></html>");

    let putBytes: Uint8Array | null = null;
    vi.stubGlobal("fetch", async (_url: string | URL, init?: { body?: unknown }) => {
      putBytes = init?.body as Uint8Array;
      return { status: 200 } as Response;
    });
    const { ctx } = makeCtx(root, (req) => {
      if (req.url === `${BASE}/api/projects/my-app/deploy/upload-url`) {
        return { status: 200, body: { ok: true, uploadId: "u2", uploadUrl: "https://r2.test/p", contentType: "application/zip" } };
      }
      if (req.url === `${BASE}/api/projects/my-app/deploy/start`) {
        return { status: 200, body: { ok: true, jobId: "job2", status: "deployed", url: "https://my-app.proj.test" } };
      }
      if (req.url === "https://my-app.proj.test") return { status: 200, body: { ok: true } };
      return undefined;
    });

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.start", inputs: { slug: "my-app", framework: "static-bundle" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("succeeded");
    expect(Object.keys(unzipSync(putBytes!))).toEqual(["dist/index.html"]);
  });

  it("packages only config.dir when set (static-site asset root)", async () => {
    const root = await scratchDir();
    await writeFile(join(root, "bahama.yaml"), "version: 1\n");
    await writeFile(join(root, "README.md"), "# repo file that must not be served");
    await mkdir(join(root, "site"));
    await writeFile(join(root, "site", "index.html"), "<html></html>");
    await writeFile(join(root, "site", "style.css"), "body{}");

    let putBytes: Uint8Array | null = null;
    vi.stubGlobal("fetch", async (_url: string | URL, init?: { body?: unknown }) => {
      putBytes = init?.body as Uint8Array;
      return { status: 200 } as Response;
    });
    const { ctx } = makeCtx(root, (req) => {
      if (req.url === `${BASE}/api/projects/my-app/deploy/upload-url`) {
        return { status: 200, body: { ok: true, uploadId: "u4", uploadUrl: "https://r2.test/p", contentType: "application/zip" } };
      }
      if (req.url === `${BASE}/api/projects/my-app/deploy/start`) {
        return { status: 200, body: { ok: true, jobId: "job4", status: "deployed", url: "https://my-app.proj.test" } };
      }
      if (req.url === "https://my-app.proj.test") return { status: 200, body: { ok: true } };
      return undefined;
    });

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.start", inputs: { slug: "my-app", framework: "static-site", dir: "site" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("succeeded");
    expect(Object.keys(unzipSync(putBytes!)).sort()).toEqual(["index.html", "style.css"]);
  });

  it("rejects a config.dir that escapes the project root", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.start", inputs: { slug: "my-app", framework: "static-site", dir: "../elsewhere" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("config.dir");
  });

  it("fails with the job error when the deploy job terminates as failed", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (req) => {
      if (req.url === `${BASE}/api/projects/my-app/deploy/status/job3`) {
        return { status: 200, body: { ok: true, jobId: "job3", status: "failed", url: null, errorCode: "build_failed", errorMessage: "vite build exited 1" } };
      }
      return undefined;
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.await", inputs: { slug: "my-app" } }),
      { consumed: { "application.deploymentId": "job3" } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.postconditionVerified).toBe(false);
    expect(outcome.error?.code).toBe("provider-api");
    expect(outcome.error?.message).toContain("build_failed");
  });

  it("classifies cancellation while awaiting an accepted job without resubmitting it", async () => {
    const root = await scratchDir();
    const { ctx, requests } = makeCtx(root, () => undefined);
    const controller = new AbortController();
    controller.abort();
    ctx.signal = controller.signal;

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.await" }),
      { consumed: { "application.deploymentId": "job-cancelled" } },
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "cancelled",
        recovery: expect.stringContaining("will not create another one"),
      },
    });
    expect(requests).toEqual([]);
  });

  it("classifies a bounded polling timeout as resumable", async () => {
    vi.useFakeTimers();
    const root = await scratchDir();
    const { ctx, requests } = makeCtx(root, () => ({
      status: 503,
      body: { ok: false, error: "temporarily unavailable" },
    }));

    const pending = bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy.await" }),
      { consumed: { "application.deploymentId": "job-timeout" } },
    );
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "timeout",
        recovery: expect.stringContaining("will not create another one"),
      },
    });
    expect(requests.every((request) => request.url.endsWith("/deploy/status/job-timeout"))).toBe(true);
  });

  it("rejects saved pre-resume deploy actions and requires a fresh plan", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy" }),
      { consumed: {} },
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "incompatible-output", recovery: expect.stringContaining("bahama deploy") },
    });
  });
});

describe("execute cloud.app.verify", () => {
  it("checks the consumed production URL and verifies on a non-5xx response", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, (req) =>
      req.url === "https://my-app.proj.test" ? { status: 200, body: { ok: true } } : undefined,
    );
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.verify", inputs: { slug: "my-app" } }),
      { consumed: { "application.productionUrl": "https://my-app.proj.test" } },
    );
    expect(outcome).toMatchObject({ status: "succeeded", postconditionVerified: true });
  });
});

describe("status", () => {
  it("reports material drift when the locked slug no longer exists", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => ({ status: 404, body: { ok: false, error: "Project was not found." } }));
    const report = await bahamaCloudProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { slug: "my-app" } }],
    });
    expect(report.resources[0]).toMatchObject({ exists: false, health: { state: "unhealthy" } });
    expect(report.resources[0]!.drift[0]).toMatchObject({ severity: "material" });
  });

  it("reports a healthy deployed application with its production URL", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => ({
      status: 200,
      body: projectBody({ d1Enabled: true, d1Id: "d1-123", url: "https://my-app.proj.test" }),
    }));
    const report = await bahamaCloudProvider.status(ctx, {
      intent: [APP_INTENT, DB_INTENT],
      locked: [
        { resourceKey: "application", identity: { slug: "my-app" } },
        { resourceKey: "database", identity: { slug: "my-app", binding: "DB" } },
      ],
    });
    expect(report.resources[0]).toMatchObject({ exists: true, health: { state: "ready" }, detail: "https://my-app.proj.test" });
    expect(report.resources[1]).toMatchObject({ exists: true, health: { state: "ready" }, detail: "env.DB" });
  });

  it("reports an unknown check instead of deletion drift when the API fails", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => ({ status: 523, body: { ok: false, error: "origin unavailable" } }));
    const report = await bahamaCloudProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { slug: "my-app" } }],
    });
    expect(report.resources[0]).toMatchObject({
      exists: false,
      health: { state: "unknown", reason: expect.stringContaining("HTTP 523") },
      drift: [],
    });
  });

  it("reports a structured network health failure when status cannot reach the API", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => {
      throw new Error("fetch failed");
    });
    const report = await bahamaCloudProvider.status(ctx, {
      intent: [APP_INTENT],
      locked: [{ resourceKey: "application", identity: { slug: "my-app" } }],
    });
    expect(report.resources[0]).toMatchObject({
      resourceKey: "application",
      exists: false,
      health: { state: "unknown", code: "network" },
      drift: [],
    });
  });
});
