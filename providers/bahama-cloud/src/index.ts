import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { z } from "zod";
import {
  defineProvider,
  type ContributedStep,
  type ExecutionInputs,
  type HttpResponse,
  type JsonObject,
  type PlanContribution,
  type PlanRequest,
  type PlannedStep,
  type ProbeRequest,
  type ProbeResult,
  type ProviderContext,
  type ResourceStatus,
  type SecretRef,
  type StatusReport,
  type StepOutcome,
} from "@bahama-ai/provider-kit";

/**
 * Bahama Cloud driver: talks to the hosted control plane over REST with an
 * OAuth bearer token. Never MCP. The control plane owns Cloudflare
 * orchestration; this driver only creates/adopts projects by slug, provisions
 * the optional D1 database, and runs the upload → deploy → poll pipeline.
 */

const PROVIDER_ID = "bahama-cloud";
const DEFAULT_BASE_URL = "https://www.bahama.ai";
const LOGIN_HINT = `bahama auth login ${PROVIDER_ID}`;
// Mirrors DEFAULT_MAX_UPLOAD_BYTES in the control plane's deployment contract.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const SUPPORTED_FRAMEWORKS = ["static-site", "static-bundle", "vite-spa", "vite-hono", "hono-api"];
const TERMINAL_JOB_STATUSES = new Set(["deployed", "failed"]);

const namePattern = /^[a-z0-9][a-z0-9-]*$/;

const intentSchema = z
  .object({
    /** Overrides the manifest's project.name as the Bahama Cloud slug. */
    name: z.string().regex(namePattern).optional(),
  })
  .passthrough()
  .transform((value) => value as JsonObject);

/* -------------------------------- control-plane response shapes ---------- */

interface ProjectInfo {
  slug: string;
  status: string;
  app: { framework: string; backend: string };
  resources: {
    d1: {
      enabled: boolean;
      bindingName: string | null;
      databaseId: string | null;
      databaseName: string | null;
      status: string;
    };
  };
  deployment: { url: string | null; currentJobId: string | null };
}

interface ProjectEnvelope {
  ok: boolean;
  user?: { email?: string };
  project?: ProjectInfo;
  projects?: ProjectInfo[];
  error?: string;
}

interface DatabaseEnvelope {
  ok: boolean;
  database?: {
    enabled: boolean;
    exists: boolean;
    id: string | null;
    bindingName: string | null;
    resourceStatus: string;
  };
  error?: string;
}

interface UploadTargetEnvelope {
  ok: boolean;
  uploadId?: string;
  uploadUrl?: string;
  objectKey?: string;
  contentType?: string;
  error?: string;
}

interface DeployJob {
  ok?: boolean;
  jobId?: string;
  status?: string;
  stage?: string;
  url?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  error?: string;
}

/* -------------------------------- auth ----------------------------------- */

function baseUrl(): string {
  return (process.env["BAHAMA_CLOUD_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function configDir(): string {
  const override = process.env["BAHAMA_CONFIG_DIR"];
  if (override) return override;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "bahama");
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "bahama");
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "bahama");
}

function readTokenFile(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir(), "credentials.json"), "utf8")) as {
      [PROVIDER_ID]?: { accessToken?: unknown };
    };
    const token = parsed?.[PROVIDER_ID]?.accessToken;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    // An absent or malformed credentials file simply means "not logged in".
    return null;
  }
}

/** Sealed at load so the redactor knows the token before any request or log. */
function loadToken(ctx: ProviderContext): SecretRef | null {
  const fromEnv = process.env["BAHAMA_TOKEN"];
  const raw = fromEnv && fromEnv.trim() !== "" ? fromEnv.trim() : readTokenFile();
  if (!raw) return null;
  return ctx.secrets.seal("bahama-cloud.accessToken", raw);
}

/**
 * The bearer header is constructed inside secrets.use so the raw token never
 * sits in driver-owned state; ctx.http redacts sealed values from diagnostics.
 */
async function api(
  ctx: ProviderContext,
  token: SecretRef,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: JsonObject,
): Promise<HttpResponse> {
  return ctx.secrets.use(token, async (raw) =>
    ctx.http.request({
      method,
      url: `${baseUrl()}${path}`,
      headers: { authorization: `Bearer ${raw}` },
      ...(body !== undefined ? { body } : {}),
    }),
  );
}

/* -------------------------------- helpers -------------------------------- */

function parseJson<T>(res: HttpResponse): T | null {
  try {
    return res.json<T>();
  } catch {
    // Non-JSON bodies are reported through status-code errors instead.
    return null;
  }
}

function apiError(what: string, res: HttpResponse): string {
  const detail = parseJson<{ error?: string }>(res)?.error;
  return `${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`;
}

function fail(message: string, recovery?: string): StepOutcome {
  return {
    status: "failed",
    postconditionVerified: false,
    error: { message, ...(recovery !== undefined ? { recovery } : {}) },
  };
}

function authFail(): StepOutcome {
  return fail(
    "Bahama Cloud rejected the access token (HTTP 401).",
    `Set BAHAMA_TOKEN or run \`${LOGIN_HINT}\`.`,
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Minimal extraction of `project.name` from bahama.yaml. Drivers receive no
 * manifest object and carry no YAML dependency, but the name grammar is a
 * single [a-z0-9-] flow scalar, so a line scan of the `project:` block is
 * exact for every manifest the core accepts.
 */
function manifestProjectName(projectRoot: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(projectRoot, "bahama.yaml"), "utf8");
  } catch {
    // No manifest — the slug must come from config or the lock instead.
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^project:\s*(#.*)?$/.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (/^\S/.test(line)) break;
      const match = /^\s+name:\s*['"]?([a-z0-9][a-z0-9-]*)['"]?\s*(#.*)?$/.exec(line);
      if (match) return match[1]!;
    }
  }
  return null;
}

/** Slug resolution order: explicit config override, lock identity, intent project name. */
function resolveSlug(
  ctx: ProviderContext,
  req: Pick<ProbeRequest, "intent" | "locked">,
): string | null {
  for (const intent of req.intent) {
    const fromConfig = intent.config["name"];
    if (typeof fromConfig === "string" && namePattern.test(fromConfig)) return fromConfig;
  }
  for (const locked of req.locked) {
    const fromLock = locked.identity["slug"];
    if (typeof fromLock === "string" && fromLock !== "") return fromLock;
  }
  for (const intent of req.intent) {
    if (intent.projectName && namePattern.test(intent.projectName)) return intent.projectName;
  }
  // Fallback for callers that construct intents without projectName.
  return manifestProjectName(ctx.projectRoot);
}

type FetchedState =
  | { kind: "unauthorized" }
  | { kind: "ok"; identity: string | null; project: ProjectInfo | null }
  | { kind: "error"; message: string };

async function fetchProjectState(
  ctx: ProviderContext,
  token: SecretRef,
  slug: string | null,
): Promise<FetchedState> {
  const list = await api(ctx, token, "GET", "/api/projects");
  if (list.status === 401) return { kind: "unauthorized" };
  if (list.status === 200) {
    const parsed = parseJson<ProjectEnvelope>(list);
    const project = parsed?.projects?.find((p) => p.slug === slug) ?? null;
    return { kind: "ok", identity: parsed?.user?.email ?? null, project };
  }
  // The list endpoint may not exist on older control planes; fall back to
  // get-by-slug, which carries the same project shape.
  if (list.status === 404 || list.status === 405) {
    if (!slug) return { kind: "ok", identity: null, project: null };
    const single = await api(ctx, token, "GET", `/api/projects/${slug}`);
    if (single.status === 401) return { kind: "unauthorized" };
    if (single.status === 404) return { kind: "ok", identity: null, project: null };
    if (single.status === 200) {
      const parsed = parseJson<ProjectEnvelope>(single);
      return { kind: "ok", identity: parsed?.user?.email ?? null, project: parsed?.project ?? null };
    }
    return { kind: "error", message: apiError(`Looking up project ${slug}`, single) };
  }
  return { kind: "error", message: apiError("Listing projects", list) };
}

function observeApplication(project: ProjectInfo | null): JsonObject {
  if (!project) return { exists: false };
  return {
    exists: true,
    status: project.status,
    framework: project.app.framework,
    url: project.deployment.url,
  };
}

function observeDatabase(project: ProjectInfo | null): JsonObject {
  const d1 = project?.resources.d1;
  if (!d1?.enabled || !d1.databaseId) return { exists: false };
  return { exists: true, status: d1.status, binding: d1.bindingName ?? "DB" };
}

/**
 * Ensure semantics: create when absent (consequential), adopt when live but
 * unlocked (consequential), verify when live AND locked (routine read).
 */
function ensureEffects(exists: boolean, locked: boolean): ContributedStep["effects"] {
  if (!exists) return { createsResource: true };
  if (!locked) return { adoptsResource: true };
  return { readOnly: true };
}

function ensureSummary(kind: string, slug: string, exists: boolean, locked: boolean): string {
  if (!exists) return `Create the Bahama Cloud ${kind} for \`${slug}\``;
  if (!locked) return `Adopt the existing Bahama Cloud ${kind} for \`${slug}\``;
  return `Verify the Bahama Cloud ${kind} for \`${slug}\` still exists`;
}

/* -------------------------------- packaging ------------------------------ */

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".bahama", "__MACOSX"]);
const EXCLUDED_FILES = new Set([".fake-live.json", "bahama.lock", ".DS_Store"]);

function packageSource(
  projectRoot: string,
  framework: string | null,
): { archive: Uint8Array; fileCount: number } {
  const files: Record<string, Uint8Array> = {};
  // static-bundle ships prebuilt output; every other target is built from
  // source by the deployer, and a stale local dist/ breaks its validation.
  const includeDist = framework === "static-bundle";
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entryRel === "dist" && !includeDist) continue;
        walk(join(dir, entry.name), entryRel);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.has(entry.name) || entry.name.startsWith(".env")) continue;
        files[entryRel] = readFileSync(join(dir, entry.name));
      }
    }
  };
  walk(projectRoot, "");
  return { archive: zipSync(files), fileCount: Object.keys(files).length };
}

/* -------------------------------- step execution ------------------------- */

async function ensureProject(
  ctx: ProviderContext,
  token: SecretRef,
  slug: string,
  step: PlannedStep,
): Promise<StepOutcome> {
  const framework = typeof step.inputs?.["framework"] === "string" ? step.inputs["framework"] : null;
  const withDatabase = step.inputs?.["withDatabase"] === true;

  const existing = await api(ctx, token, "GET", `/api/projects/${slug}`);
  if (existing.status === 401) return authFail();
  const existed = existing.status === 200;
  if (existing.status === 404) {
    const created = await api(ctx, token, "POST", "/api/projects", {
      slug,
      ...(framework ? { app: { framework } } : {}),
      ...(withDatabase ? { resources: { d1: { enabled: true } } } : {}),
    });
    if (created.status !== 201) return fail(apiError(`Creating project ${slug}`, created));
  } else if (!existed) {
    return fail(apiError(`Looking up project ${slug}`, existing));
  } else if (framework) {
    // Adoption keeps manifest intent authoritative: align the framework so
    // later deploys build the target the manifest declares.
    const project = parseJson<ProjectEnvelope>(existing)?.project;
    if (project && project.app.framework !== framework) {
      const patched = await api(ctx, token, "PATCH", `/api/projects/${slug}`, {
        app: { framework },
      });
      if (patched.status !== 200) return fail(apiError(`Updating framework for ${slug}`, patched));
    }
  }

  const check = await api(ctx, token, "GET", `/api/projects/${slug}`);
  const verified = check.status === 200;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    identity: { slug },
    receipt: { slug, existed },
    ...(verified ? {} : { error: { message: apiError(`Verifying project ${slug}`, check) } }),
  };
}

async function ensureDatabase(
  ctx: ProviderContext,
  token: SecretRef,
  slug: string,
): Promise<StepOutcome> {
  const existing = await api(ctx, token, "GET", `/api/projects/${slug}`);
  if (existing.status === 401) return authFail();
  if (existing.status === 404) {
    // A database-only intent still needs the owning project.
    const created = await api(ctx, token, "POST", "/api/projects", {
      slug,
      resources: { d1: { enabled: true } },
    });
    if (created.status !== 201) return fail(apiError(`Creating project ${slug}`, created));
  } else if (existing.status !== 200) {
    return fail(apiError(`Looking up project ${slug}`, existing));
  } else {
    const project = parseJson<ProjectEnvelope>(existing)?.project;
    if (project && !project.resources.d1.enabled) {
      const patched = await api(ctx, token, "PATCH", `/api/projects/${slug}`, {
        resources: { d1: { enabled: true } },
      });
      if (patched.status !== 200) {
        return fail(apiError(`Enabling the database for ${slug}`, patched));
      }
    }
  }

  const before = await api(ctx, token, "GET", `/api/projects/${slug}/database`);
  const beforeDb = before.status === 200 ? parseJson<DatabaseEnvelope>(before)?.database : undefined;
  if (!(beforeDb?.exists && beforeDb.id)) {
    const provisioned = await api(ctx, token, "POST", `/api/projects/${slug}/database/provision`);
    if (provisioned.status !== 200) {
      return fail(apiError(`Provisioning the database for ${slug}`, provisioned));
    }
  }

  const check = await api(ctx, token, "GET", `/api/projects/${slug}/database`);
  const db = check.status === 200 ? parseJson<DatabaseEnvelope>(check)?.database : undefined;
  const verified = Boolean(db?.exists && db.id);
  const binding = db?.bindingName ?? "DB";
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    identity: { slug, binding },
    receipt: { slug, binding, resourceStatus: db?.resourceStatus ?? null },
    ...(verified
      ? {}
      : { error: { message: `Database for ${slug} did not report as provisioned after ensure.` } }),
  };
}

async function deployApplication(
  ctx: ProviderContext,
  token: SecretRef,
  slug: string,
  step: PlannedStep,
): Promise<StepOutcome> {
  const framework = typeof step.inputs?.["framework"] === "string" ? step.inputs["framework"] : null;

  let archive: Uint8Array;
  let fileCount: number;
  try {
    ({ archive, fileCount } = packageSource(ctx.projectRoot, framework));
  } catch (error) {
    return fail(`Packaging the project source failed: ${(error as Error).message}`);
  }
  if (fileCount === 0) {
    return fail(`No deployable files found in ${ctx.projectRoot} after exclusions.`);
  }
  if (archive.byteLength > MAX_UPLOAD_BYTES) {
    return fail(
      `Source archive is ${archive.byteLength} bytes, over the ${MAX_UPLOAD_BYTES}-byte upload limit.`,
      "Remove large assets that are not part of the app, then re-run bahama apply.",
    );
  }

  const target = await api(ctx, token, "POST", `/api/projects/${slug}/deploy/upload-url`);
  if (target.status === 401) return authFail();
  if (target.status !== 200) return fail(apiError("Requesting a source upload URL", target));
  const upload = parseJson<UploadTargetEnvelope>(target);
  if (!upload?.uploadId || !upload.uploadUrl) {
    return fail("Upload URL response was missing uploadId or uploadUrl.");
  }

  // ctx.http is JSON-only; this one signed-URL PUT carries raw zip bytes, so
  // it uses fetch directly. The signed URL itself is never journaled.
  let putStatus: number;
  try {
    const put = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "content-type": upload.contentType ?? "application/zip" },
      body: archive,
      signal: ctx.signal,
    });
    putStatus = put.status;
  } catch (error) {
    return fail(`Uploading the source archive failed: ${(error as Error).message}`);
  }
  if (putStatus < 200 || putStatus >= 300) {
    return fail(`Uploading the source archive failed (HTTP ${putStatus}).`);
  }

  const started = await api(ctx, token, "POST", `/api/projects/${slug}/deploy/start`, {
    uploadId: upload.uploadId,
  });
  if (started.status !== 200) return fail(apiError("Starting the deploy", started));
  let job = parseJson<DeployJob>(started);
  const jobId = job?.jobId;
  if (!job || !jobId) return fail("Deploy start response was missing jobId.");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!TERMINAL_JOB_STATUSES.has(job.status ?? "")) {
    if (ctx.signal.aborted) {
      return fail(
        `Deploy ${jobId} was cancelled while ${job.status ?? "running"}.`,
        "Re-run bahama apply to poll the job again.",
      );
    }
    if (Date.now() >= deadline) {
      return fail(
        `Deploy ${jobId} did not reach a terminal status within ${POLL_TIMEOUT_MS / 1000}s (last: ${job.status ?? "unknown"}).`,
        "Re-run bahama apply to poll the job again; the deployer may still finish.",
      );
    }
    await sleep(POLL_INTERVAL_MS, ctx.signal);
    const polled = await api(ctx, token, "GET", `/api/projects/${slug}/deploy/status/${jobId}`);
    if (polled.status === 200) {
      job = parseJson<DeployJob>(polled) ?? job;
    } else if (polled.status >= 400 && polled.status < 500) {
      return fail(apiError(`Polling deploy ${jobId}`, polled));
    }
    // 5xx while polling is transient; keep going until the deadline.
  }

  if (job.status !== "deployed") {
    const code = job.errorCode ? ` (${job.errorCode})` : "";
    const detail = job.errorMessage ? `: ${job.errorMessage}` : "";
    return fail(
      `Deploy ${jobId} failed${code}${detail}`,
      "Fix the reported source issue and re-run bahama apply.",
    );
  }
  const url = job.url;
  if (!url) return fail(`Deploy ${jobId} reported deployed but returned no production URL.`);

  const live = await ctx.http.request({ method: "GET", url });
  const verified = live.status < 500;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    produced: { productionUrl: url },
    receipt: {
      slug,
      jobId,
      uploadId: upload.uploadId,
      status: job.status,
      files: fileCount,
      archiveBytes: archive.byteLength,
    },
    ...(verified
      ? {}
      : { error: { message: `Production URL responded HTTP ${live.status} after deploy ${jobId}.` } }),
  };
}

async function verifyApplication(
  ctx: ProviderContext,
  token: SecretRef,
  slug: string,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const consumed = Object.values(inputs.consumed).find((value) => typeof value === "string");
  let url = typeof consumed === "string" ? consumed : null;
  if (!url) {
    const res = await api(ctx, token, "GET", `/api/projects/${slug}`);
    if (res.status === 200) url = parseJson<ProjectEnvelope>(res)?.project?.deployment.url ?? null;
  }
  if (!url) {
    return fail(`No production URL is recorded for ${slug}.`, "Deploy the application first.");
  }
  const live = await ctx.http.request({ method: "GET", url });
  const verified = live.status < 500;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    receipt: { slug, httpStatus: live.status },
    ...(verified
      ? {}
      : { error: { message: `Production URL for ${slug} responded HTTP ${live.status}.` } }),
  };
}

/* -------------------------------- driver --------------------------------- */

export const bahamaCloudProvider = defineProvider({
  descriptor: {
    id: PROVIDER_ID,
    name: "Bahama Cloud",
    roles: ["application", "database"],
    description:
      "Managed hosting on the Bahama control plane: zero-config deploys of static, Vite, and Hono apps to Cloudflare's edge, with an optional built-in D1 SQL database.",
    useWhen:
      "You want a managed zero-config path for a static site, Vite SPA, Vite + Hono full-stack app, or Hono API, optionally with a built-in D1 database.",
    avoidWhen:
      "The app is Next.js or another unsupported runtime, or it needs a directly-addressable database connection string rather than the in-runtime `env.DB` binding.",
    requirements: ["Bahama account (https://www.bahama.ai)"],
    frameworks: SUPPORTED_FRAMEWORKS,
    engines: ["d1"],
    produces: [
      { capability: "productionUrl", secret: false, description: "Public URL of the deployed application." },
    ],
    // D1 is an in-runtime Worker binding (`env.DB`), never a connection
    // string — the database resource produces nothing bindable in v0.1.
    consumes: [],
  },

  intentSchema,

  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    // REST-only driver: there is no external CLI to install.
    const tool = { installed: true } as const;
    const token = loadToken(ctx);
    if (!token) {
      return {
        tool,
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
      };
    }

    const slug = resolveSlug(ctx, req);
    const fetched = await fetchProjectState(ctx, token, slug);
    if (fetched.kind === "unauthorized") {
      return {
        tool,
        auth: { state: "expired", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
      };
    }
    if (fetched.kind === "error") {
      return {
        tool,
        auth: { state: "authenticated", identity: "bahama-cloud user" },
        accounts: [],
        observed: {},
        warnings: [fetched.message],
      };
    }

    const identity = fetched.identity ?? "bahama-cloud user";
    const observed: JsonObject = {};
    for (const intent of req.intent) {
      observed[intent.resourceKey] =
        intent.role === "database"
          ? observeDatabase(fetched.project)
          : observeApplication(fetched.project);
    }
    return {
      tool,
      auth: { state: "authenticated", identity },
      accounts: [{ id: "personal", label: identity, kind: "personal" }],
      observed,
    };
  },

  async plan(ctx: ProviderContext, req: PlanRequest): Promise<PlanContribution> {
    const slug = resolveSlug(ctx, req);
    if (!slug) {
      return {
        steps: [],
        warnings: [
          "Could not determine the Bahama Cloud project slug (bahama.yaml project.name or application config.name).",
        ],
      };
    }

    const appIntent = req.intent.find((intent) => intent.role === "application");
    const dbIntent = req.intent.find((intent) => intent.role === "database");
    const lockHas = (resourceKey: string) =>
      req.locked.some((entry) => entry.resourceKey === resourceKey);
    const observedExists = (resourceKey: string) =>
      (req.probe.observed[resourceKey] as JsonObject | undefined)?.["exists"] === true;

    const steps: ContributedStep[] = [];
    if (appIntent) {
      steps.push({
        id: "application-ensure",
        action: "cloud.project.ensure",
        summary: ensureSummary("project", slug, observedExists(appIntent.resourceKey), lockHas(appIntent.resourceKey)),
        resourceKey: appIntent.resourceKey,
        effects: ensureEffects(observedExists(appIntent.resourceKey), lockHas(appIntent.resourceKey)),
        inputs: { slug, framework: appIntent.framework ?? null, withDatabase: Boolean(dbIntent) },
        postcondition: `Project \`${slug}\` exists on Bahama Cloud.`,
      });
    }
    if (dbIntent) {
      steps.push({
        id: "database-ensure",
        action: "cloud.database.ensure",
        summary: ensureSummary("D1 database", slug, observedExists(dbIntent.resourceKey), lockHas(dbIntent.resourceKey)),
        resourceKey: dbIntent.resourceKey,
        effects: ensureEffects(observedExists(dbIntent.resourceKey), lockHas(dbIntent.resourceKey)),
        ...(appIntent ? { dependsOn: ["application-ensure"] } : {}),
        inputs: { slug },
        postcondition:
          "The project's D1 database is provisioned and available to the app as the runtime binding `env.DB`.",
      });
    }
    if (appIntent) {
      steps.push({
        id: "application-deploy",
        action: "cloud.app.deploy",
        summary: `Package the source and deploy \`${slug}\` to Bahama Cloud`,
        resourceKey: appIntent.resourceKey,
        effects: { deploys: true },
        dependsOn: ["application-ensure", ...(dbIntent ? ["database-ensure"] : [])],
        inputs: { slug, framework: appIntent.framework ?? null },
        produces: ["productionUrl"],
        postcondition: "The deploy job reports `deployed` and the production URL responds.",
      });
      steps.push({
        id: "application-verify",
        action: "cloud.app.verify",
        summary: `Verify \`${slug}\` responds in production`,
        resourceKey: appIntent.resourceKey,
        effects: { readOnly: true },
        dependsOn: ["application-deploy"],
        consumes: [`${appIntent.resourceKey}.productionUrl`],
        inputs: { slug },
        postcondition: "A production request returns a non-5xx response.",
      });
    }
    return { steps };
  },

  async execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
    const token = loadToken(ctx);
    if (!token) {
      return fail(
        "Not authenticated with Bahama Cloud.",
        `Set BAHAMA_TOKEN or run \`${LOGIN_HINT}\`.`,
      );
    }
    const slug = step.inputs?.["slug"];
    if (typeof slug !== "string" || slug === "") {
      return fail(`Step ${step.id} is missing its project slug input.`);
    }

    switch (step.action) {
      case "cloud.project.ensure":
        return ensureProject(ctx, token, slug, step);
      case "cloud.database.ensure":
        return ensureDatabase(ctx, token, slug);
      case "cloud.app.deploy":
        return deployApplication(ctx, token, slug, step);
      case "cloud.app.verify":
        return verifyApplication(ctx, token, slug, inputs);
      default:
        return fail(`Unknown bahama-cloud action ${step.action}`);
    }
  },

  async status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport> {
    const token = loadToken(ctx);
    const fetched = new Map<string, { status: number; project: ProjectInfo | null }>();
    const resources: ResourceStatus[] = [];

    for (const intent of req.intent) {
      const locked = req.locked.find((entry) => entry.resourceKey === intent.resourceKey);
      const lockedSlug = typeof locked?.identity["slug"] === "string" ? locked.identity["slug"] : null;
      const slug = lockedSlug ?? resolveSlug(ctx, req);

      if (!token || !slug) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: token ? "project name unresolved" : "not authenticated",
          drift: [],
        });
        continue;
      }

      if (!fetched.has(slug)) {
        const res = await api(ctx, token, "GET", `/api/projects/${slug}`);
        fetched.set(slug, {
          status: res.status,
          project: res.status === 200 ? (parseJson<ProjectEnvelope>(res)?.project ?? null) : null,
        });
      }
      const { status, project } = fetched.get(slug)!;

      if (status === 401) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: "not authenticated",
          drift: [],
        });
        continue;
      }
      if (!project) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: false,
          drift: lockedSlug
            ? [
                {
                  severity: "material",
                  resourceKey: intent.resourceKey,
                  message: `Locked project \`${slug}\` no longer exists on Bahama Cloud.`,
                },
              ]
            : [],
        });
        continue;
      }

      if (intent.role === "database") {
        const d1 = project.resources.d1;
        const exists = Boolean(d1.enabled && d1.databaseId);
        resources.push({
          resourceKey: intent.resourceKey,
          exists,
          healthy: exists ? d1.status === "ready" : false,
          ...(exists ? { detail: `env.${d1.bindingName ?? "DB"}` } : {}),
          drift:
            locked && !exists
              ? [
                  {
                    severity: "material",
                    resourceKey: intent.resourceKey,
                    message: `Locked database for \`${slug}\` is no longer provisioned.`,
                  },
                ]
              : [],
        });
      } else {
        const url = project.deployment.url;
        resources.push({
          resourceKey: intent.resourceKey,
          exists: true,
          healthy: url ? project.status !== "failed" : "unknown",
          ...(url ? { detail: url } : {}),
          drift: [],
        });
      }
    }
    return { resources };
  },
});
