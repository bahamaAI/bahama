import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { z } from "zod";
import {
  defineProvider,
  formatCapabilityAddress,
  isSecretRef,
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
 * OAuth bearer token. Never MCP. The control plane owns deployment
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
    /**
     * Directory (relative to the project root) to package and deploy instead
     * of the whole project. Recommended for `static-site`, where the archive
     * root is served publicly — point it at the folder holding index.html.
     */
    dir: z.string().min(1).optional(),
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
  user?: { id?: string; email?: string };
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

/**
 * A token that is valid RIGHT NOW, sealed before any request or log can see
 * it. Resolution order: BAHAMA_TOKEN (CI), then the CLI-injected credential
 * source (which refreshes a stale stored token), then the raw credentials
 * file as a last resort for embedders without a credential source.
 */
async function freshToken(ctx: ProviderContext, forceRefresh = false): Promise<SecretRef | null> {
  const fromEnv = process.env["BAHAMA_TOKEN"];
  if (fromEnv && fromEnv.trim() !== "") {
    return ctx.secrets.seal("bahama-cloud.accessToken", fromEnv.trim());
  }
  if (ctx.credentials) return ctx.credentials.freshToken({ forceRefresh });
  const raw = readTokenFile();
  return raw ? ctx.secrets.seal("bahama-cloud.accessToken", raw) : null;
}

/** Synthetic 401 so "no token" and "rejected token" flow through one path. */
const UNAUTHENTICATED: HttpResponse = {
  status: 401,
  headers: {},
  body: "",
  json: <T = unknown>() => ({}) as T,
};

/**
 * Authenticated control-plane request. The token is fetched fresh PER CALL
 * (cheap when still valid) and a 401 gets one refresh-and-retry — deploy
 * polls routinely outlive a 15-minute access token, and this is what keeps a
 * long apply from dying mid-operation. The bearer header is constructed
 * inside secrets.use so the raw token never sits in driver-owned state.
 */
async function api(
  ctx: ProviderContext,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: JsonObject,
): Promise<HttpResponse> {
  const send = async (token: SecretRef): Promise<HttpResponse> =>
    ctx.secrets.use(token, async (raw) =>
      ctx.http.request({
        method,
        url: `${baseUrl()}${path}`,
        headers: { authorization: `Bearer ${raw}` },
        ...(body !== undefined ? { body } : {}),
      }),
    );

  const token = await freshToken(ctx);
  if (!token) return UNAUTHENTICATED;
  const first = await send(token);
  if (first.status !== 401) return first;
  const refreshed = await freshToken(ctx, true);
  if (!refreshed) return first;
  return send(refreshed);
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
  | { kind: "ok"; identity: string | null; userId: string | null; project: ProjectInfo | null }
  | { kind: "error"; message: string };

async function fetchProjectState(
  ctx: ProviderContext,
  slug: string | null,
): Promise<FetchedState> {
  const list = await api(ctx, "GET", "/api/projects");
  if (list.status === 401) return { kind: "unauthorized" };
  if (list.status === 200) {
    const parsed = parseJson<ProjectEnvelope>(list);
    const project = parsed?.projects?.find((p) => p.slug === slug) ?? null;
    return { kind: "ok", identity: parsed?.user?.email ?? null, userId: parsed?.user?.id ?? null, project };
  }
  // The list endpoint may not exist on older control planes; fall back to
  // get-by-slug, which carries the same project shape.
  if (list.status === 404 || list.status === 405) {
    if (!slug) return { kind: "ok", identity: null, userId: null, project: null };
    const single = await api(ctx, "GET", `/api/projects/${slug}`);
    if (single.status === 401) return { kind: "unauthorized" };
    if (single.status === 404) return { kind: "ok", identity: null, userId: null, project: null };
    if (single.status === 200) {
      const parsed = parseJson<ProjectEnvelope>(single);
      return {
        kind: "ok",
        identity: parsed?.user?.email ?? null,
        userId: parsed?.user?.id ?? null,
        project: parsed?.project ?? null,
      };
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
// Bahama state and credential-adjacent files never belong in an archive —
// for static-site the archive root is SERVED, so anything included here
// becomes a public URL.
const EXCLUDED_FILES = new Set([
  ".fake-live.json",
  "bahama.yaml",
  "bahama.lock",
  ".DS_Store",
  ".npmrc",
  ".yarnrc",
  ".netrc",
]);

function packageSource(
  projectRoot: string,
  framework: string | null,
  sourceDir: string | null,
): { archive: Uint8Array; fileCount: number } {
  // config.dir narrows the archive to one directory — the skill tells agents
  // to deploy only what the site needs, and this is the lever for that.
  if (sourceDir !== null && (sourceDir.startsWith("/") || sourceDir.split("/").includes(".."))) {
    throw new Error(`config.dir must be a relative path inside the project (got \`${sourceDir}\`).`);
  }
  const root = sourceDir ? join(projectRoot, sourceDir) : projectRoot;
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
  walk(root, "");
  return { archive: zipSync(files), fileCount: Object.keys(files).length };
}

/* -------------------------------- step execution ------------------------- */

async function ensureProject(
  ctx: ProviderContext,
  slug: string,
  step: PlannedStep,
): Promise<StepOutcome> {
  const framework = typeof step.inputs?.["framework"] === "string" ? step.inputs["framework"] : null;
  const withDatabase = step.inputs?.["withDatabase"] === true;

  const existing = await api(ctx, "GET", `/api/projects/${slug}`);
  if (existing.status === 401) return authFail();
  const existed = existing.status === 200;
  if (existing.status === 404) {
    const created = await api(ctx, "POST", "/api/projects", {
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
      const patched = await api(ctx, "PATCH", `/api/projects/${slug}`, {
        app: { framework },
      });
      if (patched.status !== 200) return fail(apiError(`Updating framework for ${slug}`, patched));
    }
  }

  const check = await api(ctx, "GET", `/api/projects/${slug}`);
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
  slug: string,
): Promise<StepOutcome> {
  const existing = await api(ctx, "GET", `/api/projects/${slug}`);
  if (existing.status === 401) return authFail();
  if (existing.status === 404) {
    // A database-only intent still needs the owning project.
    const created = await api(ctx, "POST", "/api/projects", {
      slug,
      resources: { d1: { enabled: true } },
    });
    if (created.status !== 201) return fail(apiError(`Creating project ${slug}`, created));
  } else if (existing.status !== 200) {
    return fail(apiError(`Looking up project ${slug}`, existing));
  } else {
    const project = parseJson<ProjectEnvelope>(existing)?.project;
    if (project && !project.resources.d1.enabled) {
      const patched = await api(ctx, "PATCH", `/api/projects/${slug}`, {
        resources: { d1: { enabled: true } },
      });
      if (patched.status !== 200) {
        return fail(apiError(`Enabling the database for ${slug}`, patched));
      }
    }
  }

  const before = await api(ctx, "GET", `/api/projects/${slug}/database`);
  const beforeDb = before.status === 200 ? parseJson<DatabaseEnvelope>(before)?.database : undefined;
  if (!(beforeDb?.exists && beforeDb.id)) {
    const provisioned = await api(ctx, "POST", `/api/projects/${slug}/database/provision`);
    if (provisioned.status !== 200) {
      return fail(apiError(`Provisioning the database for ${slug}`, provisioned));
    }
  }

  const check = await api(ctx, "GET", `/api/projects/${slug}/database`);
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
  slug: string,
  step: PlannedStep,
): Promise<StepOutcome> {
  const framework = typeof step.inputs?.["framework"] === "string" ? step.inputs["framework"] : null;
  const sourceDir = typeof step.inputs?.["dir"] === "string" ? step.inputs["dir"] : null;

  let archive: Uint8Array;
  let fileCount: number;
  try {
    ({ archive, fileCount } = packageSource(ctx.projectRoot, framework, sourceDir));
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

  const target = await api(ctx, "POST", `/api/projects/${slug}/deploy/upload-url`);
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

  const started = await api(ctx, "POST", `/api/projects/${slug}/deploy/start`, {
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
    const polled = await api(ctx, "GET", `/api/projects/${slug}/deploy/status/${jobId}`);
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
  slug: string,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const consumed = Object.values(inputs.consumed).find((value) => typeof value === "string");
  let url = typeof consumed === "string" ? consumed : null;
  if (!url) {
    const res = await api(ctx, "GET", `/api/projects/${slug}`);
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

async function setProjectSecret(
  ctx: ProviderContext,
  slug: string,
  step: PlannedStep,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const name = step.inputs?.["bindingName"];
  const value = Object.values(inputs.consumed)[0];
  if (typeof name !== "string" || value === undefined) {
    return fail(`Step ${step.id} is missing a binding input.`);
  }
  if (!isSecretRef(value) && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return fail(`Step ${step.id} received a non-scalar environment value.`);
  }
  const ref = isSecretRef(value) ? value : ctx.secrets.seal(`env.${name}`, String(value));
  return ctx.secrets.use(ref, async (raw) => {
    const response = await api(ctx, "PUT", `/api/projects/${slug}/secrets`, { name, value: raw });
    if (response.status === 401) return authFail();
    if (response.status !== 200) return fail(apiError(`Setting project secret ${name}`, response));
    const metadata = parseJson<{ secret?: { name?: string } }>(response)?.secret;
    const verified = metadata?.name === name;
    return {
      status: verified ? "succeeded" : "failed",
      postconditionVerified: verified,
      receipt: { slug, name },
      ...(verified ? {} : { error: { message: `Secret ${name} was not present after update.` } }),
    };
  });
}

async function createDevelopmentAccess(ctx: ProviderContext, slug: string): Promise<StepOutcome> {
  const response = await api(ctx, "POST", `/api/projects/${slug}/dev-tokens`, {
    name: "Bahama CLI local development",
    expiresInDays: 30,
  });
  if (response.status === 401) return authFail();
  if (response.status !== 201) return fail(apiError("Creating local development access", response));
  const env = parseJson<{ env?: Record<string, unknown>; devToken?: { publicId?: string; expiresAt?: string } }>(response);
  const base = env?.env?.["BAHAMA_API_BASE_URL"];
  const project = env?.env?.["BAHAMA_PROJECT_SLUG"];
  const token = env?.env?.["BAHAMA_DEV_TOKEN"];
  if (typeof base !== "string" || typeof project !== "string" || typeof token !== "string") {
    return fail("Bahama Cloud returned an incomplete local-development credential set.");
  }
  return {
    status: "succeeded",
    postconditionVerified: true,
    produced: {
      developmentApiBaseUrl: base,
      developmentProjectSlug: project,
      developmentToken: ctx.secrets.seal("bahama-cloud.developmentToken", token),
    },
    receipt: {
      slug,
      publicId: env?.devToken?.publicId ?? null,
      expiresAt: env?.devToken?.expiresAt ?? null,
    },
  };
}

/* -------------------------------- driver --------------------------------- */

export const bahamaCloudProvider = defineProvider({
  descriptor: {
    id: PROVIDER_ID,
    name: "Bahama Cloud",
    roles: ["environment", "application", "database"],
    description:
      "Managed hosting on the Bahama control plane: zero-config deploys of static, Vite, and Hono apps to Bahama's edge runtime, with an optional built-in SQL database.",
    useWhen:
      "You want a managed zero-config path for a static site, Vite SPA, Vite + Hono full-stack app, or Hono API, optionally with a built-in D1 database.",
    avoidWhen:
      "The app is Next.js or another unsupported runtime, or it needs a directly-addressable database connection string rather than the in-runtime `env.DB` binding.",
    requirements: ["Bahama account (https://www.bahama.ai)"],
    frameworks: SUPPORTED_FRAMEWORKS,
    engines: ["d1"],
    produces: [
      { capability: "productionUrl", secret: false, description: "Public URL of the deployed application." },
      { capability: "developmentApiBaseUrl", secret: false, description: "Bahama development API origin." },
      { capability: "developmentProjectSlug", secret: false, description: "Bahama project slug used by the local SDK." },
      { capability: "developmentToken", secret: true, description: "Scoped token used by the Bahama SDK during local development." },
    ],
    // D1 is an in-runtime Worker binding (`env.DB`), never a connection
    // string — the database resource produces nothing bindable in v0.1.
    consumes: [
      { capability: "variables", secret: false, description: "Server-side project environment variables." },
      { capability: "productionEnvironment", secret: false, description: "Legacy spelling for server-side variables." },
    ],
  },

  intentSchema,

  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    // REST-only driver: there is no external CLI to install.
    const tool = { installed: true } as const;
    if ((await freshToken(ctx)) === null) {
      return {
        tool,
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
      };
    }

    const slug = resolveSlug(ctx, req);
    const fetched = await fetchProjectState(ctx, slug);
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
    // The durable user id is what the lock records; email is just a label.
    const accountId = fetched.userId ?? "personal";
    const observed: JsonObject = {};
    for (const intent of req.intent) {
      observed[intent.resourceKey] =
        intent.role === "database"
          ? observeDatabase(fetched.project)
          : observeApplication(fetched.project);
    }
    return {
      tool,
      auth: {
        state: "authenticated",
        identity,
        account: { id: accountId, label: identity, kind: "personal" },
      },
      accounts: [{ id: accountId, label: identity, kind: "personal" }],
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

    const appIntent = req.intent.find((intent) => intent.role === "environment" || intent.role === "application");
    const dbIntent = req.intent.find((intent) => intent.role === "database");
    const lockHas = (resourceKey: string) =>
      req.locked.some((entry) => entry.resourceKey === resourceKey);
    const observedExists = (resourceKey: string) =>
      (req.probe.observed[resourceKey] as JsonObject | undefined)?.["exists"] === true;

    const steps: ContributedStep[] = [];
    const appKey = appIntent?.resourceKey;
    const ensureId = appKey ? `${appKey.replaceAll(".", "-")}-ensure` : null;
    if (appIntent) {
      steps.push({
        id: ensureId!,
        action: "cloud.project.ensure",
        summary: ensureSummary("project", slug, observedExists(appIntent.resourceKey), lockHas(appIntent.resourceKey)),
        resourceKey: appIntent.resourceKey,
        effects: ensureEffects(observedExists(appIntent.resourceKey), lockHas(appIntent.resourceKey)),
        inputs: { slug, framework: appIntent.framework ?? null, withDatabase: false },
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
        ...(ensureId ? { dependsOn: [ensureId] } : {}),
        inputs: { slug },
        postcondition:
          "The project's D1 database is provisioned and available to the app as the runtime binding `env.DB`.",
      });
    }
    const secretStepIds: string[] = [];
    if (appIntent && ensureId) {
      for (const edge of req.bindings.filter((binding) => binding.to.resourceKey === appIntent.resourceKey)) {
        const id = `${appIntent.resourceKey.replaceAll(".", "-")}-secret-${edge.name.toLowerCase()}`;
        secretStepIds.push(id);
        steps.push({
          id,
          action: "cloud.secret.set",
          summary: `Transfer ${edge.name} to the Bahama Cloud environment`,
          resourceKey: appIntent.resourceKey,
          effects: { transfersSecret: edge.secret },
          consumes: [formatCapabilityAddress(edge.from)],
          dependsOn: [ensureId],
          inputs: { slug, bindingName: edge.name, bindingTo: formatCapabilityAddress(edge.to) },
          postcondition: `${edge.name} is present as a server-side Bahama Cloud project secret.`,
        });
      }

      const devEdges = req.bindings.filter((binding) => {
        if (binding.from.resourceKey !== appIntent.resourceKey || !binding.from.capability.startsWith("development")) return false;
        const from = formatCapabilityAddress(binding.from);
        const to = formatCapabilityAddress(binding.to);
        return !(req.appliedBindings ?? []).some((known) => known.name === binding.name && known.from === from && known.to === to);
      });
      if (devEdges.length > 0 && req.operation?.kind === "reconcile") {
        steps.push({
          id: `${appIntent.resourceKey.replaceAll(".", "-")}-development-access`,
          action: "cloud.dev-access.create",
          summary: `Create scoped local-development access for \`${slug}\``,
          resourceKey: appIntent.resourceKey,
          effects: { transfersSecret: true },
          dependsOn: [ensureId, ...(dbIntent ? ["database-ensure"] : [])],
          inputs: { slug },
          produces: ["developmentApiBaseUrl", "developmentProjectSlug", "developmentToken"],
          postcondition: "A scoped Bahama development token is issued for this project.",
        });
      }
    }

    const operation = req.operation ?? { kind: "deploy" as const, environment: appIntent?.environment ?? "production" };
    if (appIntent && ensureId && operation.kind === "deploy" && operation.environment === (appIntent.environment ?? "production")) {
      steps.push({
        id: `${appIntent.resourceKey.replaceAll(".", "-")}-deploy`,
        action: "cloud.app.deploy",
        summary: `Package the source and deploy \`${slug}\` to Bahama Cloud`,
        resourceKey: appIntent.resourceKey,
        effects: { deploys: true },
        dependsOn: [ensureId, ...(dbIntent ? ["database-ensure"] : []), ...secretStepIds],
        inputs: {
          slug,
          framework: appIntent.framework ?? null,
          dir: typeof appIntent.config["dir"] === "string" ? appIntent.config["dir"] : null,
        },
        produces: ["productionUrl"],
        postcondition: "The deploy job reports `deployed` and the production URL responds.",
      });
      steps.push({
        id: `${appIntent.resourceKey.replaceAll(".", "-")}-verify`,
        action: "cloud.app.verify",
        summary: `Verify \`${slug}\` responds in production`,
        resourceKey: appIntent.resourceKey,
        effects: { readOnly: true },
        dependsOn: [`${appIntent.resourceKey.replaceAll(".", "-")}-deploy`],
        consumes: [formatCapabilityAddress({ resourceKey: appIntent.resourceKey, capability: "productionUrl" })],
        inputs: { slug },
        postcondition: "A production request returns a non-5xx response.",
      });
    }
    return { steps };
  },

  async execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
    const slug = step.inputs?.["slug"];
    if (typeof slug !== "string" || slug === "") {
      return fail(`Step ${step.id} is missing its project slug input.`);
    }

    switch (step.action) {
      case "cloud.project.ensure":
        return ensureProject(ctx, slug, step);
      case "cloud.database.ensure":
        return ensureDatabase(ctx, slug);
      case "cloud.secret.set":
        return setProjectSecret(ctx, slug, step, inputs);
      case "cloud.dev-access.create":
        return createDevelopmentAccess(ctx, slug);
      case "cloud.app.deploy":
        return deployApplication(ctx, slug, step);
      case "cloud.app.verify":
        return verifyApplication(ctx, slug, inputs);
      default:
        return fail(`Unknown bahama-cloud action ${step.action}`);
    }
  },

  async status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport> {
    const token = await freshToken(ctx);
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
        const res = await api(ctx, "GET", `/api/projects/${slug}`);
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
