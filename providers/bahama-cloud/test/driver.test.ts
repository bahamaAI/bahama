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
} from "@bahama-ai/provider-kit";
import { bahamaCloudProvider } from "../src/index.js";

const TOKEN = "test-token-abc123";
const BASE = "https://cloud.test";

type CannedResponse = { status: number; body: JsonObject };
type Handler = (req: HttpRequest) => CannedResponse | undefined;

function makeCtx(
  root: string,
  handler: Handler,
  credentials?: { freshToken(): Promise<SecretRef | null> },
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
});

describe("plan", () => {
  it("contributes ensure, database, deploy, and verify steps with the expected shapes", async () => {
    const root = await scratchDir();
    const { ctx } = makeCtx(root, () => undefined);
    const contribution = await bahamaCloudProvider.plan(ctx, planRequest());
    const byId = new Map(contribution.steps.map((s) => [s.id, s]));

    expect(contribution.steps.map((s) => s.id)).toEqual([
      "application-ensure",
      "database-ensure",
      "application-deploy",
      "application-verify",
    ]);
    expect(byId.get("application-ensure")).toMatchObject({
      action: "cloud.project.ensure",
      effects: { createsResource: true },
      inputs: { slug: "my-app", framework: "vite-hono", withDatabase: true },
    });
    expect(byId.get("database-ensure")).toMatchObject({
      action: "cloud.database.ensure",
      effects: { createsResource: true },
      dependsOn: ["application-ensure"],
    });
    expect(byId.get("application-deploy")).toMatchObject({
      action: "cloud.app.deploy",
      effects: { deploys: true },
      dependsOn: ["application-ensure", "database-ensure"],
      produces: ["productionUrl"],
    });
    expect(byId.get("application-verify")).toMatchObject({
      action: "cloud.app.verify",
      effects: { readOnly: true },
      dependsOn: ["application-deploy"],
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

    const issued: string[] = [];
    const holder: { ctx?: ProviderContext } = {};
    const credentials = {
      async freshToken(): Promise<SecretRef | null> {
        // First call hands out an expired token; every later call a fresh one
        // (this is exactly what the CLI's freshCloudToken does after refresh).
        const raw = issued.length === 0 ? "expired-token" : "fresh-token";
        issued.push(raw);
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
    expect(issued[0]).toBe("expired-token");
    expect(issued.length).toBeGreaterThanOrEqual(2);
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

describe("execute cloud.app.deploy", () => {
  it("zips the source with exclusions, uploads, starts, polls to deployed, and verifies the URL", async () => {
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

    let polls = 0;
    const { ctx } = makeCtx(root, (req) => {
      if (req.method === "POST" && req.url === `${BASE}/api/projects/my-app/deploy/upload-url`) {
        return {
          status: 200,
          body: { ok: true, slug: "my-app", uploadId: "u1", uploadUrl: "https://r2.test/signed-put", objectKey: "uploads/u1.zip", expiresAt: "2026-01-01T00:00:00Z", contentType: "application/zip" },
        };
      }
      if (req.method === "POST" && req.url === `${BASE}/api/projects/my-app/deploy/start`) {
        return { status: 200, body: { ok: true, jobId: "job1", status: "building", stage: "build", url: null, errorCode: null, errorMessage: null } };
      }
      if (req.method === "GET" && req.url === `${BASE}/api/projects/my-app/deploy/status/job1`) {
        polls += 1;
        return { status: 200, body: { ok: true, jobId: "job1", status: "deployed", stage: "complete", url: "https://my-app.proj.test", errorCode: null, errorMessage: null } };
      }
      if (req.method === "GET" && req.url === "https://my-app.proj.test") {
        return { status: 200, body: { ok: true } };
      }
      return undefined;
    });

    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy", inputs: { slug: "my-app", framework: "vite-hono" } }),
      { consumed: {} },
    );

    expect(outcome).toMatchObject({
      status: "succeeded",
      postconditionVerified: true,
      produced: { productionUrl: "https://my-app.proj.test" },
      receipt: { jobId: "job1", uploadId: "u1", status: "deployed", files: 3 },
    });
    expect(polls).toBe(1);
    expect(putUrl).toBe("https://r2.test/signed-put");

    // bahama.yaml, bahama.lock, .npmrc, .env, node_modules never ship — for
    // static-site the archive root is SERVED, so inclusion means public URLs.
    const entries = Object.keys(unzipSync(putBytes!));
    expect(entries.sort()).toEqual(["index.html", "package.json", "src/main.ts"]);

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("r2.test"); // signed upload URL stays out of receipts
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
      planned({ action: "cloud.app.deploy", inputs: { slug: "my-app", framework: "static-bundle" } }),
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
      planned({ action: "cloud.app.deploy", inputs: { slug: "my-app", framework: "static-site", dir: "site" } }),
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
      planned({ action: "cloud.app.deploy", inputs: { slug: "my-app", framework: "static-site", dir: "../elsewhere" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("config.dir");
  });

  it("fails with the job error when the deploy job terminates as failed", async () => {
    const root = await scratchDir();
    await writeFile(join(root, "index.html"), "<html></html>");
    vi.stubGlobal("fetch", async () => ({ status: 200 }) as Response);
    const { ctx } = makeCtx(root, (req) => {
      if (req.url === `${BASE}/api/projects/my-app/deploy/upload-url`) {
        return { status: 200, body: { ok: true, uploadId: "u3", uploadUrl: "https://r2.test/p", contentType: "application/zip" } };
      }
      if (req.url === `${BASE}/api/projects/my-app/deploy/start`) {
        return { status: 200, body: { ok: true, jobId: "job3", status: "failed", url: null, errorCode: "build_failed", errorMessage: "vite build exited 1" } };
      }
      return undefined;
    });
    const outcome = await bahamaCloudProvider.execute(
      ctx,
      planned({ action: "cloud.app.deploy", inputs: { slug: "my-app", framework: "vite-spa" } }),
      { consumed: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.postconditionVerified).toBe(false);
    expect(outcome.error?.message).toContain("build_failed");
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
    expect(report.resources[0]).toMatchObject({ exists: false, healthy: false });
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
    expect(report.resources[0]).toMatchObject({ exists: true, healthy: true, detail: "https://my-app.proj.test" });
    expect(report.resources[1]).toMatchObject({ exists: true, healthy: true, detail: "env.DB" });
  });
});
