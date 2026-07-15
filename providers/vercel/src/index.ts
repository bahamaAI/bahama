import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  defineProvider,
  formatCapabilityAddress,
  isSecretRef,
  type ContributedStep,
  type Decision,
  type ExecutionInputs,
  type JsonObject,
  type PlanContribution,
  type PlanRequest,
  type PlannedStep,
  type ProbeRequest,
  type ProbeResult,
  type ProviderAccount,
  type ProviderContext,
  type ResourceIntent,
  type ResourceStatus,
  type StatusReport,
  type StepOutcome,
  type ToolCompatibility,
} from "@bahama-ai/provider-kit";

/**
 * Vercel driver: wraps the official `vercel` CLI. Mutations go through the
 * CLI's own commands (`project add`, `env add`, `deploy`); structured reads go
 * through `vercel api`, the CLI's authenticated Vercel REST API command, so
 * this driver never handles a Vercel token itself. (`vercel curl` is NOT that
 * — it sends requests to your deployments, not to the Vercel API.)
 *
 * Project-scoped mutations always carry VERCEL_PROJECT_ID/VERCEL_ORG_ID
 * resolved from the planned project — never from `.vercel/project.json` — so
 * the lock, not a stray link file, decides which project gets deployed.
 */

const PROVIDER_ID = "vercel";
const BIN = "vercel";
const INSTALL_HINT = "npm i -g vercel";
const LOGIN_HINT = "vercel login (or set VERCEL_TOKEN — the CLI honors it directly)";
/** Tested against vercel CLI v39; newer majors warn, never block. */
const TESTED_MAJOR = 39;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;

const intentSchema = z
  .object({
    /** Overrides the manifest's project.name as the Vercel project name. */
    name: z.string().min(1).optional(),
    /** Team/user scope slug or id; a decision writes this back when ambiguous. */
    scope: z.string().min(1).optional(),
  })
  .passthrough()
  .transform((value) => value as JsonObject);

/* -------------------------------- helpers -------------------------------- */

function extractVersion(stdout: string, stderr: string): string | undefined {
  const match = /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`);
  return match?.[1];
}

function compatibilityOf(version: string | undefined): ToolCompatibility | undefined {
  if (!version) return undefined;
  const major = Number(version.split(".")[0]);
  if (!Number.isFinite(major)) return undefined;
  if (major < TESTED_MAJOR) return "unsupported";
  if (major === TESTED_MAJOR) return "tested";
  return "untested-newer";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON output is handled by the callers' exit-code/shape checks.
    return null;
  }
}

function configString(config: JsonObject, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Name resolution order: explicit config.name, then the manifest project name. */
function resolveName(intent: ResourceIntent): string | null {
  return configString(intent.config, "name") ?? intent.projectName ?? null;
}

function scopeArgs(scope: string | null): string[] {
  return scope && scope !== "personal" ? ["--scope", scope] : [];
}

function inputString(step: PlannedStep, key: string): string | null {
  const value = step.inputs?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function fail(message: string, recovery?: string): StepOutcome {
  return {
    status: "failed",
    postconditionVerified: false,
    error: { message, ...(recovery !== undefined ? { recovery } : {}) },
  };
}

function errText(stderr: string, stdout: string): string {
  const text = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-3).join(" ");
  return text === "" ? "(no output)" : text;
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
 * Best-effort parse of `vercel teams list` (a human table, not JSON): after a
 * header line whose first column is `id`, each row's first token is the team
 * id/slug. Anything unparsable yields no accounts rather than a wrong guess.
 */
export function parseTeamsList(stdout: string): ProviderAccount[] {
  const lines = stdout.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*id\s+/i.test(line));
  if (headerIndex === -1) return [];
  const accounts: ProviderAccount[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cleaned = line.replace(/[✔✓]/g, " ").trim();
    if (cleaned === "") continue;
    const [id, ...rest] = cleaned.split(/\s{2,}|\s+/);
    if (!id) continue;
    accounts.push({ id, label: rest.length > 0 ? rest.join(" ") : id, kind: "team", selector: id });
  }
  return accounts;
}

function parseTeamsApi(body: JsonObject): ProviderAccount[] {
  const teams = body["teams"];
  if (!Array.isArray(teams)) return [];
  const accounts: ProviderAccount[] = [];
  for (const value of teams) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const team = value as JsonObject;
    const id = team["id"];
    const slug = team["slug"];
    if (typeof id !== "string" || id === "" || typeof slug !== "string" || slug === "") continue;
    const name = team["name"];
    const kind = team["createdDirectToHobby"] === true ? "personal" : "team";
    accounts.push({
      id,
      label: typeof name === "string" && name !== "" ? name : slug,
      kind,
      selector: slug,
    });
  }
  return accounts;
}

/** Extracts the deployment URL: the last stdout (then stderr) line carrying https://. */
export function parseDeploymentUrl(stdout: string, stderr: string): string | null {
  for (const channel of [stdout, stderr]) {
    const lines = channel
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("https://"));
    const last = lines[lines.length - 1];
    if (last) {
      const match = /https:\/\/[^\s"')]+/.exec(last);
      if (match) return match[0];
    }
  }
  return null;
}

/* -------------------------------- vercel api ------------------------------ */

type ApiResult =
  | { kind: "ok"; json: JsonObject }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** Reads via `vercel api <endpoint>`: the CLI authenticates against the Vercel REST API and prints JSON. */
async function vapi(ctx: ProviderContext, path: string, scope: string | null): Promise<ApiResult> {
  const res = await ctx.run.run(BIN, ["api", path, ...scopeArgs(scope)]);
  const parsed = parseJson(res.stdout);
  if (parsed && typeof parsed === "object") {
    const body = parsed as JsonObject;
    const error = body["error"] as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === "object") {
      const code = String(error.code ?? "");
      if (code.includes("not_found") || code === "forbidden") return { kind: "not-found" };
      return { kind: "error", message: `Vercel API error on ${path}: ${String(error.message ?? code)}` };
    }
    return { kind: "ok", json: body };
  }
  if (res.exitCode !== 0) {
    // Vercel CLI 55 prints REST 404s as human stderr (with its version/banner)
    // instead of the JSON error body older versions emitted. Absence is an
    // expected probe result, not a provider failure.
    const diagnostic = `${res.stdout}\n${res.stderr}`;
    if (/\bnot found\b.*\(404\)|\b404\b.*\bnot found\b/is.test(diagnostic)) {
      return { kind: "not-found" };
    }
    return { kind: "error", message: `vercel api ${path} failed: ${errText(res.stderr, res.stdout)}` };
  }
  return { kind: "error", message: `vercel api ${path} returned no parsable JSON.` };
}

async function updateProjectFramework(
  ctx: ProviderContext,
  projectId: string,
  scope: string | null,
  framework: string | null,
): Promise<ApiResult> {
  const res = await ctx.run.run(BIN, [
    "api",
    `/v9/projects/${encodeURIComponent(projectId)}`,
    "-X",
    "PATCH",
    "-F",
    `framework=${framework === null ? "null" : framework}`,
    ...scopeArgs(scope),
  ]);
  const parsed = parseJson(res.stdout);
  if (res.exitCode !== 0 || !parsed || typeof parsed !== "object") {
    return {
      kind: "error",
      message: `Updating the Vercel framework preset failed: ${errText(res.stderr, res.stdout)}`,
    };
  }
  return { kind: "ok", json: parsed as JsonObject };
}

interface VercelProject {
  id: string;
  name: string;
  /** Owning account/team id — becomes VERCEL_ORG_ID for mutations. */
  accountId: string | null;
  /** Vercel's provider-native framework preset. */
  framework: string | null;
}

function vercelFramework(framework: string): string | null {
  if (framework === "nextjs") return "nextjs";
  if (framework === "vite-spa") return "vite";
  return null;
}

function manifestFramework(framework: string | null): string | null {
  if (framework === "nextjs") return "nextjs";
  if (framework === "vite") return "vite-spa";
  if (framework === "other" || framework === null) return "static-site";
  return framework;
}

/**
 * Environment that pins every project-scoped `vercel` invocation to the
 * PLANNED project. The vercel CLI otherwise falls back to
 * `.vercel/project.json`, which would let a stale link file silently target a
 * different project than the plan the user approved.
 */
function projectEnv(project: VercelProject): Record<string, string> {
  return {
    VERCEL_PROJECT_ID: project.id,
    ...(project.accountId !== null ? { VERCEL_ORG_ID: project.accountId } : {}),
  };
}

async function lookupProject(
  ctx: ProviderContext,
  nameOrId: string,
  scope: string | null,
): Promise<{ kind: "found"; project: VercelProject } | { kind: "absent" } | { kind: "error"; message: string }> {
  const res = await vapi(ctx, `/v9/projects/${encodeURIComponent(nameOrId)}`, scope);
  if (res.kind === "not-found") return { kind: "absent" };
  if (res.kind === "error") return res;
  const id = res.json["id"];
  if (typeof id !== "string" || id === "") {
    return { kind: "error", message: "Vercel project lookup returned no id." };
  }
  const accountId = res.json["accountId"];
  return {
    kind: "found",
    project: {
      id,
      name: String(res.json["name"] ?? nameOrId),
      accountId: typeof accountId === "string" && accountId !== "" ? accountId : null,
      framework:
        typeof res.json["framework"] === "string" ? String(res.json["framework"]).toLowerCase() : null,
    },
  };
}

/** Production URL from a project body: prefer the production target's alias. */
function productionUrlOf(project: JsonObject): string | null {
  const targets = project["targets"] as { production?: JsonObject } | undefined;
  const production = targets?.production;
  if (!production) return null;
  const alias = production["alias"];
  if (Array.isArray(alias) && typeof alias[0] === "string" && alias[0] !== "") {
    return `https://${alias[0]}`;
  }
  const url = production["url"];
  if (typeof url === "string" && url !== "") return `https://${url}`;
  return null;
}

/* -------------------------------- linked-dir check ------------------------ */

/**
 * `.vercel/project.json` (created by `vercel link`) is advisory only. When it
 * disagrees with the LOCK, the lock wins — surfaced loudly, never silently.
 */
function linkedProjectWarning(projectRoot: string, req: Pick<ProbeRequest, "locked">): string | null {
  let linkedId: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, ".vercel", "project.json"), "utf8")) as {
      projectId?: unknown;
    };
    linkedId = typeof parsed.projectId === "string" && parsed.projectId !== "" ? parsed.projectId : null;
  } catch {
    // No linked directory is the common case.
    return null;
  }
  if (!linkedId) return null;
  const locked = req.locked.find((entry) => entry.resourceKey === "application");
  const lockedId = locked?.identity["projectId"];
  if (typeof lockedId === "string" && lockedId !== "" && lockedId !== linkedId) {
    return (
      `.vercel/project.json links this directory to project ${linkedId}, but bahama.lock records ` +
      `${lockedId}. The lock wins: Bahama operates on ${lockedId}. Run \`vercel link\` again or ` +
      "remove .vercel/ to clear the mismatch."
    );
  }
  return null;
}

function lockedProjectId(req: Pick<ProbeRequest, "locked">, resourceKey: string): string | null {
  const locked = req.locked.find((entry) => entry.resourceKey === resourceKey);
  const id = locked?.identity["projectId"];
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Ensure semantics: create when absent (consequential), adopt when live but
 * unlocked (consequential), verify when live AND locked (routine read).
 */
function ensureEffects(exists: boolean, locked: boolean, frameworkMismatch: boolean): ContributedStep["effects"] {
  if (!exists) return { createsResource: true };
  if (!locked) return { adoptsResource: true };
  if (frameworkMismatch) return { changesConfiguration: true };
  return { readOnly: true };
}

function ensureSummary(name: string, exists: boolean, locked: boolean, frameworkMismatch: boolean): string {
  if (!exists) return `Create the Vercel project \`${name}\``;
  if (!locked) return `Adopt the existing Vercel project \`${name}\``;
  if (frameworkMismatch) return `Set the Vercel framework preset for \`${name}\``;
  return `Verify the Vercel project \`${name}\` still exists`;
}

/* -------------------------------- step execution ------------------------- */

async function ensureProject(ctx: ProviderContext, step: PlannedStep): Promise<StepOutcome> {
  const name = inputString(step, "name");
  if (!name) return fail(`Step ${step.id} is missing its project name input.`);
  const scope = inputString(step, "scope");
  const framework = inputString(step, "framework");
  if (!framework) return fail(`Step ${step.id} is missing its framework input.`);

  const existing = await lookupProject(ctx, name, scope);
  if (existing.kind === "error") return fail(existing.message, LOGIN_HINT);
  const existed = existing.kind === "found";
  if (!existed) {
    const created = await ctx.run.run(BIN, ["project", "add", name, ...scopeArgs(scope)]);
    if (created.exitCode !== 0) {
      return fail(`Creating Vercel project \`${name}\` failed: ${errText(created.stderr, created.stdout)}`);
    }
  }

  const check = await lookupProject(ctx, name, scope);
  if (check.kind !== "found") {
    return fail(
      check.kind === "error"
        ? check.message
        : `Vercel project \`${name}\` was not found after ensure.`,
    );
  }
  const expectedFramework = vercelFramework(framework);
  if (manifestFramework(check.project.framework) !== framework) {
    const updated = await updateProjectFramework(ctx, check.project.id, scope, expectedFramework);
    if (updated.kind !== "ok") {
      return fail(
        updated.kind === "error"
          ? updated.message
          : `Vercel project \`${name}\` disappeared while its framework preset was being updated.`,
      );
    }
    const verified = await lookupProject(ctx, check.project.id, scope);
    if (verified.kind !== "found" || manifestFramework(verified.project.framework) !== framework) {
      return fail(
        `Vercel did not retain framework preset \`${expectedFramework ?? "Other"}\` for \`${name}\`.`,
      );
    }
  }
  return {
    status: "succeeded",
    postconditionVerified: true,
    identity: { projectId: check.project.id, name: check.project.name },
    receipt: { projectId: check.project.id, existed, framework: expectedFramework ?? "Other" },
  };
}

async function setEnv(
  ctx: ProviderContext,
  step: PlannedStep,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const bindingName = inputString(step, "bindingName");
  if (!bindingName) return fail(`Step ${step.id} is missing its bindingName input.`);
  const name = inputString(step, "name");
  if (!name) return fail(`Step ${step.id} is missing its project name input.`);
  const scope = inputString(step, "scope");

  const consumed = Object.values(inputs.consumed)[0];
  if (consumed === undefined) {
    return fail(`Step ${step.id} received no value to transfer to ${bindingName}.`);
  }
  // Secret or not, the value travels to the CLI exclusively via the sealed
  // stdin channel — it never appears in an argument array or the environment.
  const ref = isSecretRef(consumed)
    ? consumed
    : ctx.secrets.seal(`env.${bindingName}`, String(consumed));

  // Resolve the PLANNED project up front: env add is project-scoped and must
  // be pinned via VERCEL_PROJECT_ID, not left to `.vercel/project.json`.
  const target = await lookupProject(ctx, inputString(step, "projectId") ?? name, scope);
  if (target.kind !== "found") {
    return fail(target.kind === "error" ? target.message : `Vercel project \`${name}\` was not found.`);
  }

  const added = await ctx.run.run(
    BIN,
    ["env", "add", bindingName, "production", "--yes", "--force", ...scopeArgs(scope)],
    { cwd: ctx.projectRoot, env: projectEnv(target.project), secretStdin: ref },
  );
  if (added.exitCode !== 0) {
    return fail(
      `vercel env add ${bindingName} failed: ${errText(added.stderr, added.stdout)}`,
      "If the installed vercel CLI does not support --yes/--force here, upgrade it (npm i -g vercel).",
    );
  }

  // Postcondition: env values are write-only, so the NAME's presence for the
  // production target is what gets verified.
  const envRes = await vapi(ctx, `/v9/projects/${target.project.id}/env`, scope);
  if (envRes.kind !== "ok") {
    return fail(envRes.kind === "error" ? envRes.message : "Listing project env vars failed.");
  }
  const envs = envRes.json["envs"];
  const present =
    Array.isArray(envs) &&
    envs.some((entry) => {
      const env = entry as { key?: unknown; target?: unknown };
      const targets = Array.isArray(env.target) ? env.target : [env.target];
      return env.key === bindingName && targets.includes("production");
    });
  return {
    status: present ? "succeeded" : "failed",
    postconditionVerified: present,
    receipt: { name: bindingName, target: "production", destination: step.inputs?.["bindingTo"] ?? null },
    ...(present
      ? {}
      : {
          error: {
            message: `${bindingName} is not listed for the production target after vercel env add.`,
          },
        }),
  };
}

async function deploy(ctx: ProviderContext, step: PlannedStep): Promise<StepOutcome> {
  const scope = inputString(step, "scope");
  const name = inputString(step, "name");
  if (!name) return fail(`Step ${step.id} is missing its project name input.`);

  // Deploy targets the PLANNED project via VERCEL_PROJECT_ID/VERCEL_ORG_ID.
  // Without this the vercel CLI resolves the project from
  // `.vercel/project.json`, and a stale link file would ship this source to a
  // different project than the plan named.
  const target = await lookupProject(ctx, inputString(step, "projectId") ?? name, scope);
  if (target.kind !== "found") {
    return fail(target.kind === "error" ? target.message : `Vercel project \`${name}\` was not found.`);
  }

  const res = await ctx.run.run(BIN, ["deploy", "--prod", "--yes", ...scopeArgs(scope)], {
    cwd: ctx.projectRoot,
    env: projectEnv(target.project),
    timeoutMs: DEPLOY_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    return fail(`vercel deploy failed: ${errText(res.stderr, res.stdout)}`);
  }
  const url = parseDeploymentUrl(res.stdout, res.stderr);
  if (!url) return fail("vercel deploy succeeded but printed no deployment URL.");
  const host = url.replace(/^https?:\/\//, "");

  // Poll the deployment until READY/ERROR; exit codes are not verification.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let state = "";
  let deploymentId: string | null = null;
  for (;;) {
    if (ctx.signal.aborted) {
      return fail(`Deploy ${host} was cancelled while ${state || "pending"}.`, "Re-run bahama apply.");
    }
    const polled = await vapi(ctx, `/v13/deployments/${host}`, scope);
    if (polled.kind === "ok") {
      state = String(polled.json["readyState"] ?? polled.json["status"] ?? "");
      const id = polled.json["id"];
      deploymentId = typeof id === "string" ? id : deploymentId;
      // Postcondition includes WHICH project got deployed, not just readiness.
      const polledProject = polled.json["projectId"];
      if (typeof polledProject === "string" && polledProject !== "" && polledProject !== target.project.id) {
        return fail(
          `Deployment ${host} belongs to Vercel project ${polledProject}, not the planned ${target.project.id}.`,
        );
      }
      if (state === "READY") break;
      if (state === "ERROR" || state === "CANCELED") {
        return fail(`Deployment ${deploymentId ?? host} ended in state ${state}.`);
      }
    } else if (polled.kind === "error") {
      return fail(polled.message);
    }
    if (Date.now() >= deadline) {
      return fail(
        `Deployment did not reach READY within ${POLL_TIMEOUT_MS / 1000}s (last state: ${state || "unknown"}).`,
        "Re-run bahama apply to poll again; the deployment may still finish.",
      );
    }
    await sleep(POLL_INTERVAL_MS, ctx.signal);
  }

  // Verify the production alias, not the protected unique deployment URL.
  // The latter can redirect to Vercel SSO and falsely look healthy while the
  // public production alias still returns NOT_FOUND.
  const projectDetail = await vapi(ctx, `/v9/projects/${target.project.id}`, scope);
  const productionUrl = projectDetail.kind === "ok" ? productionUrlOf(projectDetail.json) : null;
  if (!productionUrl) {
    return fail("Vercel reported READY but no production alias was assigned to the planned project.");
  }
  const live = await ctx.http.request({ method: "GET", url: productionUrl });
  const verified = live.status >= 200 && live.status < 400;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    produced: { productionUrl },
    receipt: {
      deploymentId,
      state,
      httpStatus: live.status,
    },
    ...(verified
      ? {}
      : { error: { message: `Production URL responded HTTP ${live.status} after deploy.` } }),
  };
}

async function verify(
  ctx: ProviderContext,
  step: PlannedStep,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const consumed = Object.values(inputs.consumed).find(
    (value) => typeof value === "string" && value.startsWith("https://"),
  );
  let url = typeof consumed === "string" ? consumed : null;
  if (!url) {
    const name = inputString(step, "name");
    const scope = inputString(step, "scope");
    if (name) {
      const looked = await vapi(ctx, `/v9/projects/${encodeURIComponent(name)}`, scope);
      if (looked.kind === "ok") url = productionUrlOf(looked.json);
    }
  }
  if (!url) {
    return fail("No production URL is recorded for this application.", "Deploy the application first.");
  }
  const live = await ctx.http.request({ method: "GET", url });
  const verified = live.status >= 200 && live.status < 400;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    receipt: { httpStatus: live.status },
    ...(verified
      ? {}
      : { error: { message: `Production URL responded HTTP ${live.status}.` } }),
  };
}

/* -------------------------------- driver --------------------------------- */

export const vercelProvider = defineProvider({
  authCommands: {
    executables: [BIN],
    loginArgs: ["login"],
    logoutArgs: ["logout"],
  },
  descriptor: {
    id: PROVIDER_ID,
    name: "Vercel",
    roles: ["environment", "application"],
    description:
      "Deploys applications on the user's own Vercel account through the official vercel CLI: project ensure/adopt, sealed production env transfers, prod deploys with readiness polling.",
    useWhen:
      "The application is Next.js (or a Vite/static frontend) and should run on the user's own Vercel account — the golden path pairs it with Neon Postgres via a sealed DATABASE_URL binding.",
    avoidWhen:
      "The stack should be fully managed Bahama Cloud, or the app is a plain Workers-style API better served elsewhere.",
    requirements: ["Vercel account (https://vercel.com)", `vercel CLI (${INSTALL_HINT})`],
    frameworks: ["nextjs", "vite-spa", "static-site"],
    produces: [
      { capability: "productionUrl", secret: false, description: "Public URL of the production deployment." },
    ],
    consumes: [
      {
        capability: "variables",
        secret: false,
        description: "Production environment variables",
      },
      {
        capability: "productionEnvironment",
        secret: false,
        description: "Legacy spelling for production environment variables",
      },
    ],
    testedVersions: [{ tool: "vercel", range: ">=39" }],
  },

  intentSchema,

  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    const installed = await ctx.run.which(BIN);
    if (!installed) {
      return {
        tool: { installed: false, installHint: INSTALL_HINT },
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
      };
    }

    const versionRes = await ctx.run.run(BIN, ["--version"]);
    const version = extractVersion(versionRes.stdout, versionRes.stderr);
    const compatibility = compatibilityOf(version);
    const tool = {
      installed: true,
      ...(version !== undefined ? { version } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
    };
    const warnings: string[] = [];
    if (compatibility === "untested-newer") {
      warnings.push(`vercel CLI ${version} is newer than the tested v${TESTED_MAJOR} range; proceeding anyway.`);
    }

    const whoami = await ctx.run.run(BIN, ["whoami"]);
    if (whoami.exitCode !== 0) {
      return {
        tool,
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const identityLines = whoami.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const identity = identityLines[identityLines.length - 1] ?? "vercel user";

    const userRes = await vapi(ctx, "/v2/user", null);
    const user = userRes.kind === "ok" ? (userRes.json["user"] as JsonObject | undefined) : undefined;
    const uid = user?.["uid"] ?? user?.["id"];
    const personal: ProviderAccount | undefined =
      typeof uid === "string" && uid !== ""
        ? { id: uid, label: identity, kind: "personal", selector: "personal" }
        : undefined;

    // Prefer structured API output. Human table parsing remains a fallback
    // for CLI/API version skew, but personal is always a first-class choice.
    const teamsApi = await vapi(ctx, "/v2/teams?limit=100", null);
    let teamAccounts = teamsApi.kind === "ok" ? parseTeamsApi(teamsApi.json) : [];
    if (teamsApi.kind !== "ok") {
      const teams = await ctx.run.run(BIN, ["teams", "list"]);
      teamAccounts = teams.exitCode === 0 ? parseTeamsList(teams.stdout) : [];
      warnings.push("Could not read Vercel teams through the structured API; used CLI team discovery instead.");
    }
    // Current Vercel accounts include the Hobby/personal scope in /v2/teams
    // (`createdDirectToHobby`). Only synthesize the legacy personal scope when
    // structured/fallback team discovery returned nothing at all.
    const accounts = teamAccounts.length > 0 ? teamAccounts : personal ? [personal] : [];

    // Select an account explicitly from manifest intent, then from the lock,
    // then auto-select only when exactly one account is available.
    const appIntent = req.intent.find((intent) => intent.role === "environment" || intent.role === "application");
    const scopeConfig = appIntent ? configString(appIntent.config, "scope") : null;
    const lockedAccountId = appIntent ? req.locked.find((entry) => entry.resourceKey === appIntent.resourceKey)?.accountId : undefined;
    const account = scopeConfig
      ? accounts.find((entry) => entry.selector === scopeConfig || entry.id === scopeConfig)
      : lockedAccountId
        ? accounts.find((entry) => entry.id === lockedAccountId)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
    if (scopeConfig && !account) {
      warnings.push(`Configured Vercel scope \`${scopeConfig}\` is not available to the current login.`);
    }

    const mismatch = linkedProjectWarning(ctx.projectRoot, req);
    if (mismatch) warnings.push(mismatch);

    const observed: JsonObject = {};
    for (const intent of req.intent) {
      if (intent.role !== "application" && intent.role !== "environment") continue;
      const scope = configString(intent.config, "scope") ?? account?.selector ?? null;
      const nameOrId = lockedProjectId(req, intent.resourceKey) ?? resolveName(intent);
      if (!nameOrId) {
        observed[intent.resourceKey] = { exists: false };
        continue;
      }
      const looked = await lookupProject(ctx, nameOrId, scope);
      observed[intent.resourceKey] =
        looked.kind === "found"
          ? {
              exists: true,
              projectId: looked.project.id,
              framework: manifestFramework(looked.project.framework),
            }
          : { exists: false };
      if (looked.kind === "error") warnings.push(looked.message);
    }

    return {
      tool,
      auth: { state: "authenticated", identity, ...(account !== undefined ? { account } : {}) },
      accounts,
      observed,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async plan(ctx: ProviderContext, req: PlanRequest): Promise<PlanContribution> {
    const appIntent = req.intent.find((intent) => intent.role === "environment" || intent.role === "application");
    if (!appIntent) return { steps: [] };

    const configuredScope = configString(appIntent.config, "scope");
    const lockedAccountId = req.locked.find((entry) => entry.resourceKey === appIntent.resourceKey)?.accountId;
    const selectedAccount = req.probe.auth.account;
    const scope = configuredScope ?? selectedAccount?.selector ?? null;
    const decisions: Decision[] = [];
    const needsAccountChoice =
      (!configuredScope && !lockedAccountId && req.probe.accounts.length > 1) ||
      ((configuredScope !== null || lockedAccountId !== undefined) && !selectedAccount);
    if (needsAccountChoice) {
      decisions.push({
        kind: "decision",
        id: "vercel-scope",
        providerId: PROVIDER_ID,
        question:
          configuredScope || lockedAccountId
            ? "The previously selected Vercel account is unavailable. Which account should own this application?"
            : "Which Vercel account should own this application?",
        options: req.probe.accounts.map((account) => ({
          id: account.selector ?? account.id,
          label: account.label,
          description: account.kind === "personal" ? "Personal account" : "Team account",
        })),
        writeBack: appIntent.role === "application"
          ? "application.config.scope"
          : `environments.${appIntent.environment ?? "production"}.config.scope`,
      });
      return { steps: [], decisions };
    }

    const warnings: string[] = [];
    const mismatch = linkedProjectWarning(ctx.projectRoot, req);
    if (mismatch) warnings.push(mismatch);

    const name = resolveName(appIntent);
    if (!name) {
      return {
        steps: [],
        warnings: [
          ...warnings,
          "Could not determine the Vercel project name (set project.name in bahama.yaml or application config.name).",
        ],
      };
    }

    const framework = appIntent.framework;
    if (!framework) {
      return {
        steps: [],
        warnings: ["Vercel requires application.framework in bahama.yaml."],
      };
    }
    const key = appIntent.resourceKey;
    const observed = req.probe.observed[key] as JsonObject | undefined;
    const exists = observed?.["exists"] === true;
    const lockedId = lockedProjectId(req, key);
    // A confirmed-missing locked project is replacement intent. Do not carry
    // its stale id into ensure/env/deploy; the replacement is resolved by name.
    const pinnedId = exists ? lockedId : null;
    const locked = pinnedId !== null;
    const observedFramework = observed?.["framework"];
    const frameworkMismatch =
      exists && typeof observedFramework === "string" && observedFramework !== framework;
    // The locked project id rides every step so execution pins the vercel CLI
    // to the planned project (VERCEL_PROJECT_ID) instead of .vercel/project.json.
    const baseInputs = { name, scope, projectId: pinnedId, framework };

    const steps: ContributedStep[] = [];
    steps.push({
      id: "application-ensure",
      action: "vercel.project.ensure",
      summary: ensureSummary(name, exists, locked, frameworkMismatch),
      resourceKey: key,
      effects: ensureEffects(exists, locked, frameworkMismatch),
      inputs: baseInputs,
      postcondition: `Project \`${name}\` exists on Vercel.`,
    });

    const envStepIds: string[] = [];
    for (const edge of req.bindings.filter((binding) => binding.to.resourceKey === key)) {
      const fromAddress = formatCapabilityAddress(edge.from);
      const toAddress = formatCapabilityAddress(edge.to);
      const id = `${key.replaceAll(".", "-")}-env-${edge.name.toLowerCase()}`;
      envStepIds.push(id);
      steps.push({
        id,
        action: "vercel.env.set",
        summary: `Transfer ${edge.name} to the Vercel production environment`,
        resourceKey: key,
        effects: { transfersSecret: edge.secret },
        consumes: [fromAddress],
        dependsOn: [`${key.replaceAll(".", "-")}-ensure`],
        inputs: { ...baseInputs, bindingName: edge.name, bindingTo: toAddress },
        postcondition: `${edge.name} is present for the production target on the Vercel project.`,
      });
    }

    const ensureId = `${key.replaceAll(".", "-")}-ensure`;
    steps[0]!.id = ensureId;
    const operation = req.operation ?? { kind: "deploy" as const, environment: appIntent.environment ?? "production" };
    if (operation.kind === "deploy" && operation.environment === (appIntent.environment ?? "production")) steps.push({
      id: `${key.replaceAll(".", "-")}-deploy`,
      action: "vercel.deploy",
      summary: `Deploy \`${name}\` to Vercel production`,
      resourceKey: key,
      effects: { deploys: true },
      dependsOn: [ensureId, ...envStepIds],
      inputs: baseInputs,
      produces: ["productionUrl"],
      postcondition: "The deployment reaches READY and the production URL responds.",
    });
    if (operation.kind === "deploy" && operation.environment === (appIntent.environment ?? "production")) steps.push({
      id: `${key.replaceAll(".", "-")}-verify`,
      action: "vercel.verify",
      summary: `Verify \`${name}\` responds in production`,
      resourceKey: key,
      effects: { readOnly: true },
      dependsOn: [`${key.replaceAll(".", "-")}-deploy`],
      consumes: [formatCapabilityAddress({ resourceKey: key, capability: "productionUrl" })],
      inputs: baseInputs,
      postcondition: "A production request returns a successful or redirect response.",
    });

    return { steps, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
    const installed = await ctx.run.which(BIN);
    if (!installed) return fail("The vercel CLI is not installed.", INSTALL_HINT);

    switch (step.action) {
      case "vercel.project.ensure":
        return ensureProject(ctx, step);
      case "vercel.env.set":
        return setEnv(ctx, step, inputs);
      case "vercel.deploy":
        return deploy(ctx, step);
      case "vercel.verify":
        return verify(ctx, step, inputs);
      default:
        return fail(`Unknown vercel action ${step.action}`);
    }
  },

  async status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport> {
    const resources: ResourceStatus[] = [];
    const installed = await ctx.run.which(BIN);

    for (const intent of req.intent) {
      if (intent.role !== "application" && intent.role !== "environment") continue;
      if (!installed) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: "vercel CLI not installed",
          drift: [],
        });
        continue;
      }
      const scope = configString(intent.config, "scope");
      const pinnedId = lockedProjectId(req, intent.resourceKey);
      const nameOrId = pinnedId ?? resolveName(intent);
      if (!nameOrId) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: "project name unresolved",
          drift: [],
        });
        continue;
      }
      const looked = await lookupProject(ctx, nameOrId, scope);
      if (looked.kind === "error") {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: "lookup failed (check vercel login)",
          drift: [],
        });
        continue;
      }
      if (looked.kind === "absent") {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: false,
          drift: pinnedId
            ? [
                {
                  severity: "material",
                  resourceKey: intent.resourceKey,
                  message: `Locked Vercel project ${pinnedId} no longer exists.`,
                },
              ]
            : [],
        });
        continue;
      }
      const detailRes = await vapi(ctx, `/v9/projects/${looked.project.id}`, scope);
      const url = detailRes.kind === "ok" ? productionUrlOf(detailRes.json) : null;
      resources.push({
        resourceKey: intent.resourceKey,
        exists: true,
        healthy: url ? true : "unknown",
        ...(url ? { detail: url } : {}),
        drift: [],
      });
    }
    return { resources };
  },
});
