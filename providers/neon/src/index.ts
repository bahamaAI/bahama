import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { z } from "zod";
import {
  defineProvider,
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
  type ProviderFailureCode,
  ProviderPlanError,
  type ResourceIntent,
  type ResourceStatus,
  type RunResult,
  type SecretRef,
  type StatusReport,
  type StepOutcome,
  type ToolCompatibility,
} from "@bahama/provider-kit";
import {
  assertNonDestructive,
  checksumOf,
  countApplied,
  pendingMigrations,
  readMigrationLedger,
  runMigrations,
  type AppliedMigration,
  MigrationHistoryError,
  type MigrationFile,
  type QueryExecutor,
} from "./migrations.js";

export {
  assertNonDestructive,
  checksumOf,
  countApplied,
  pendingMigrations,
  readMigrationLedger,
  findDestructiveStatement,
  runMigrations,
  MIGRATIONS_TABLE,
  type MigrationFile,
  type MigrationSummary,
  MigrationHistoryError,
  type AppliedMigration,
  type QueryExecutor,
} from "./migrations.js";

/**
 * Neon driver: serverless Postgres on the user's own Neon account, wrapping
 * the official CLI. `neon` and `neonctl` are the SAME CLI (the npm package
 * `neonctl`, renamed to `neon` in July 2026; `neonctl` remains an alias), so
 * probing accepts either binary and every later call reuses whichever exists.
 */

const PROVIDER_ID = "neon";
const INSTALL_HINT = "npm i -g neonctl";
const LOGIN_HINT = "neon auth (or set NEON_API_KEY — the CLI honors it directly)";
/** Tested against neonctl v2; newer majors warn, never block. */
const TESTED_MAJOR = 2;
const MIGRATIONS_DIR = "migrations";

const intentSchema = z
  .object({
    /** Overrides the manifest's project.name as the Neon project name. */
    name: z.string().min(1).optional(),
    /** Neon region id, e.g. `aws-us-east-1`. */
    region: z.string().min(1).optional(),
    /**
     * Owning organization (id or slug); a decision writes this back when
     * ambiguous. Deliberately NOT named `orgId` — the manifest validator
     * rejects ID-shaped keys so agents never learn to fabricate resolved ids.
     */
    org: z.string().min(1).optional(),
  })
  .passthrough()
  .transform((value) => value as JsonObject);

/* -------------------------------- CLI plumbing --------------------------- */

async function detectBin(ctx: ProviderContext): Promise<string | null> {
  if (await ctx.run.which("neon")) return "neon";
  if (await ctx.run.which("neonctl")) return "neonctl";
  return null;
}

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

interface NeonProject {
  id: string;
  name: string;
}

/** Tolerates both bare-array and `{ projects: [...] }` CLI output shapes. */
function parseProjectList(text: string): NeonProject[] {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { projects?: unknown[] } | null)?.projects)
      ? (parsed as { projects: unknown[] }).projects
      : [];
  const projects: NeonProject[] = [];
  for (const entry of list) {
    const candidate = entry as { id?: unknown; name?: unknown };
    if (typeof candidate.id === "string" && typeof candidate.name === "string") {
      projects.push({ id: candidate.id, name: candidate.name });
    }
  }
  return projects;
}

function hasProjectListShape(text: string): boolean {
  const parsed = parseJson(text);
  return Array.isArray(parsed) || Array.isArray((parsed as { projects?: unknown[] } | null)?.projects);
}

function parseProject(text: string): NeonProject | null {
  const parsed = parseJson(text) as { id?: unknown; name?: unknown; project?: unknown } | null;
  if (!parsed) return null;
  const flat = parsed as { id?: unknown; name?: unknown };
  if (typeof flat.id === "string") return { id: flat.id, name: String(flat.name ?? "") };
  const nested = parsed.project as { id?: unknown; name?: unknown } | undefined;
  if (nested && typeof nested.id === "string") {
    return { id: nested.id, name: String(nested.name ?? "") };
  }
  return null;
}

function parseOrgs(text: string): ProviderAccount[] {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { organizations?: unknown[] } | null)?.organizations)
      ? (parsed as { organizations: unknown[] }).organizations
      : [];
  const accounts: ProviderAccount[] = [];
  for (const entry of list) {
    const candidate = entry as { id?: unknown; name?: unknown };
    if (typeof candidate.id === "string") {
      accounts.push({ id: candidate.id, label: String(candidate.name ?? candidate.id), kind: "org" });
    }
  }
  return accounts;
}

function hasOrgListShape(text: string): boolean {
  const parsed = parseJson(text);
  return Array.isArray(parsed) || Array.isArray((parsed as { organizations?: unknown[] } | null)?.organizations);
}

function parseIdentity(text: string): string {
  const parsed = parseJson(text) as { email?: unknown; name?: unknown; login?: unknown } | null;
  if (typeof parsed?.email === "string" && parsed.email !== "") return parsed.email;
  if (typeof parsed?.name === "string" && parsed.name !== "") return parsed.name;
  if (typeof parsed?.login === "string" && parsed.login !== "") return parsed.login;
  return "neon user";
}

/** Durable user id from `neon me` output, when the CLI provides one. */
function parseUserId(text: string): string | null {
  const parsed = parseJson(text) as { id?: unknown } | null;
  return typeof parsed?.id === "string" && parsed.id !== "" ? parsed.id : null;
}

/**
 * node-postgres currently warns that sslmode=require will change semantics.
 * Bahama already enforces certificate verification explicitly, so remove the
 * ambiguous URL flags before parsing and keep the verified TLS option below.
 */
export function connectionStringForVerifiedTls(raw: string): string {
  const parsed = new URL(raw);
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("uselibpqcompat");
  return parsed.toString();
}

/* -------------------------------- intent helpers ------------------------- */

function configString(config: JsonObject, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Name resolution order: explicit config.name, then the manifest project name. */
function resolveName(intent: ResourceIntent): string | null {
  return configString(intent.config, "name") ?? intent.projectName ?? null;
}

function lockedProjectId(req: Pick<ProbeRequest, "locked">, resourceKey: string): string | null {
  const locked = req.locked.find((entry) => entry.resourceKey === resourceKey);
  const id = locked?.identity["projectId"];
  return typeof id === "string" && id !== "" ? id : null;
}

function readMigrationFiles(projectRoot: string): MigrationFile[] {
  const dir = join(projectRoot, MIGRATIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  } catch {
    // No migrations directory is a valid state: the step is simply not planned.
    return [];
  }
  names.sort();
  return names.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

async function inspectMigrationLedger(
  ctx: ProviderContext,
  bin: string,
  projectId: string,
  resourceKey: string,
): Promise<JsonObject> {
  const connection = await ctx.run.run(bin, ["connection-string", "--project-id", projectId], {
    captureSecretStdout: { name: `${resourceKey}.connectionUrl` },
  });
  if (connection.exitCode !== 0 || !connection.secret) return { migrationLedger: "unavailable" };

  try {
    const applied = await ctx.secrets.use(connection.secret, async (raw) => {
      const client = new pg.Client({
        connectionString: connectionStringForVerifiedTls(raw),
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      try {
        const exec: QueryExecutor = (sql, params) => client.query(sql, params as unknown[]);
        return readMigrationLedger(exec);
      } finally {
        await client.end();
      }
    });
    return {
      migrationLedger: "read",
      appliedMigrations: applied.map((entry) => ({ name: entry.name, checksum: entry.checksum })),
    };
  } catch {
    return { migrationLedger: "unavailable" };
  }
}

function appliedMigrationsFrom(observed: JsonObject | undefined): AppliedMigration[] | null {
  if (observed?.["migrationLedger"] !== "read" || !Array.isArray(observed["appliedMigrations"])) return null;
  return observed["appliedMigrations"].flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const name = entry["name"];
    const checksum = entry["checksum"];
    if (typeof name !== "string" || (typeof checksum !== "string" && checksum !== null)) return [];
    return [{ name, checksum }];
  });
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

function ensureSummary(name: string, exists: boolean, locked: boolean): string {
  if (!exists) return `Create the Neon project \`${name}\``;
  if (!locked) return `Adopt the existing Neon project \`${name}\``;
  return `Verify the Neon project \`${name}\` still exists`;
}

function fail(message: string, recovery?: string, code?: ProviderFailureCode): StepOutcome {
  return {
    status: "failed",
    postconditionVerified: false,
    error: {
      message,
      ...(recovery !== undefined ? { recovery } : {}),
      ...(code !== undefined ? { code } : {}),
    },
  };
}

function errText(stderr: string, stdout: string): string {
  const text = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-3).join(" ");
  return text === "" ? "(no output)" : text;
}

function isNotFoundError(stderr: string, stdout: string): boolean {
  return /\b(404|not found|does not exist)\b/i.test(`${stderr}\n${stdout}`);
}

function diagnosticCode(text: string, timedOut = false): ProviderFailureCode {
  if (timedOut) return "timeout";
  if (/\b(401|unauthori[sz]ed|not authenticated|not logged in|logged out|authentication (?:expired|required|failed)|invalid[_ -]?(api[_ -]?)?key|login required|log in)\b/i.test(text)) {
    return "authentication";
  }
  if (/\b(403|forbidden|permission denied|insufficient permissions?)\b/i.test(text)) return "permission";
  if (/\b(404|not found|does not exist)\b/i.test(text)) return "not-found";
  if (/\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket hang up)\b/i.test(text)) {
    return "network";
  }
  return "provider-api";
}

function runFailure(result: RunResult, operation: string): { code: ProviderFailureCode; message: string } {
  const diagnostic = errText(result.stderr, result.stdout);
  return {
    code: diagnosticCode(`${result.stdout}\n${result.stderr}`, result.timedOut),
    message: `${operation} failed: ${diagnostic}`,
  };
}

/* -------------------------------- step execution ------------------------- */

async function ensureProject(ctx: ProviderContext, step: PlannedStep): Promise<StepOutcome> {
  const bin = await detectBin(ctx);
  if (!bin) return fail("The neon CLI is not installed.", INSTALL_HINT);

  const name = typeof step.inputs?.["name"] === "string" ? step.inputs["name"] : null;
  if (!name) return fail(`Step ${step.id} is missing its project name input.`);
  const region = typeof step.inputs?.["region"] === "string" ? step.inputs["region"] : null;
  const orgId = typeof step.inputs?.["orgId"] === "string" ? step.inputs["orgId"] : null;
  const pinnedId = typeof step.inputs?.["projectId"] === "string" ? step.inputs["projectId"] : null;
  const orgArgs = orgId ? ["--org-id", orgId] : [];
  const resourceKey = step.resourceKey ?? "database";

  let projectId: string | null = pinnedId;
  let existed = true;
  let connectionFromCreate: SecretRef | null = null;

  if (projectId) {
    const got = await ctx.run.run(bin, ["projects", "get", projectId, "--output", "json"]);
    if (got.exitCode !== 0) {
      const failure = runFailure(got, `Fetching locked Neon project ${projectId}`);
      return fail(
        failure.message,
        "If the project was deleted, remove it from bahama.lock and re-plan.",
        failure.code,
      );
    }
    if (!parseProject(got.stdout)) {
      return fail("Neon project lookup returned no parsable project id.", undefined, "incompatible-output");
    }
  } else {
    const listed = await ctx.run.run(bin, ["projects", "list", ...orgArgs, "--output", "json"]);
    if (listed.exitCode !== 0) {
      const failure = runFailure(listed, "Listing Neon projects");
      return fail(failure.message, failure.code === "authentication" ? LOGIN_HINT : undefined, failure.code);
    }
    if (!hasProjectListShape(listed.stdout)) {
      return fail("Listing Neon projects returned incompatible JSON.", undefined, "incompatible-output");
    }
    projectId = parseProjectList(listed.stdout).find((p) => p.name === name)?.id ?? null;
    if (!projectId) {
      const created = await ctx.run.run(
        bin,
        [
          "projects",
          "create",
          "--name",
          name,
          ...(region ? ["--region-id", region] : []),
          ...orgArgs,
          "--output",
          "json",
        ],
        {
          captureSecretJson: {
            name: `${resourceKey}.connectionUrl`,
            path: ["connection_uris", 0, "connection_uri"],
          },
        },
      );
      if (created.exitCode !== 0) {
        const failure = runFailure(created, `Creating Neon project \`${name}\``);
        return fail(failure.message, undefined, failure.code);
      }
      const project = parseProject(created.stdout);
      if (!project) return fail("Neon project creation returned no parsable project id.", undefined, "incompatible-output");
      projectId = project.id;
      existed = false;
      // The runner extracts and redacts connection_uris before this driver
      // receives the otherwise-useful project metadata.
      connectionFromCreate = created.secret ?? null;
    }
  }

  // The connection string is THE secret: seal it the moment it exists and
  // never place it in receipts, logs, or identity.
  let connectionRef: SecretRef;
  if (connectionFromCreate) {
    connectionRef = connectionFromCreate;
  } else {
    // captureSecretStdout seals INSIDE the runner, so the raw string never
    // reaches this driver — cs.stdout arrives already redacted.
    const cs = await ctx.run.run(bin, ["connection-string", "--project-id", projectId], {
      captureSecretStdout: { name: `${resourceKey}.connectionUrl` },
    });
    if (cs.exitCode !== 0 || !cs.secret) {
      if (cs.exitCode !== 0) {
        const failure = runFailure(cs, "Fetching the Neon connection string");
        return fail(failure.message, undefined, failure.code);
      }
      return fail("Neon returned no connection string.", undefined, "incompatible-output");
    }
    connectionRef = cs.secret;
  }

  const check = await ctx.run.run(bin, ["projects", "get", projectId, "--output", "json"]);
  const verifiedProject = check.exitCode === 0 ? parseProject(check.stdout) : null;
  const verified = verifiedProject !== null;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    produced: { connectionUrl: connectionRef },
    identity: { projectId, name: verifiedProject?.name || name },
    receipt: { projectId, existed },
    ...(verified
      ? {}
      : {
          error:
            check.exitCode === 0
              ? { code: "incompatible-output", message: `Verifying Neon project ${projectId} returned incompatible JSON.` }
              : runFailure(check, `Verifying Neon project ${projectId}`),
        }),
  };
}

async function applyMigrations(
  ctx: ProviderContext,
  step: PlannedStep,
  inputs: ExecutionInputs,
): Promise<StepOutcome> {
  const files = readMigrationFiles(ctx.projectRoot);
  if (files.length === 0) {
    return { status: "succeeded", postconditionVerified: true, receipt: { total: 0, applied: 0 } };
  }

  // Approval covers CONTENT, not filenames: the plan recorded a checksum per
  // migration, and SQL that changed (or appeared) since the plan was compiled
  // is not what the user approved.
  const planned = new Map<string, string>();
  for (const entry of (step.inputs?.["files"] as Array<{ name?: unknown; checksum?: unknown }> | undefined) ?? []) {
    if (typeof entry?.name === "string" && typeof entry?.checksum === "string") {
      planned.set(entry.name, entry.checksum);
    }
  }
  const drifted = files.filter((file) => planned.get(file.name) !== checksumOf(file.sql));
  if (drifted.length > 0 || planned.size !== files.length) {
    return fail(
      `The checked-in migrations changed after this plan was compiled` +
        (drifted.length > 0 ? ` (${drifted.map((file) => file.name).join(", ")})` : "") +
        ".",
      "Re-run bahama plan so the approved plan covers the current SQL.",
    );
  }

  // Reject destructive SQL before touching the database or the secret.
  try {
    assertNonDestructive(files);
  } catch (error) {
    return fail((error as Error).message);
  }

  const ref = Object.values(inputs.consumed).find(isSecretRef);
  if (!ref) {
    return fail(
      `Step ${step.id} received no sealed connection string.`,
      "Re-run bahama apply so the ensure step re-produces resources.<key>.connectionUrl.",
    );
  }

  let summary: { total: number; applied: number; alreadyApplied: number; verified: boolean };
  try {
    summary = await ctx.secrets.use(ref, async (raw) => {
      // Neon requires TLS. Enforce verified TLS explicitly instead of relying
      // on node-postgres' changing sslmode=require compatibility semantics.
      const client = new pg.Client({
        connectionString: connectionStringForVerifiedTls(raw),
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      try {
        const exec: QueryExecutor = (sql, params) => client.query(sql, params as unknown[]);
        const run = await runMigrations(files, exec);
        const count = await countApplied(
          files.map((file) => file.name),
          exec,
        );
        return {
          total: run.total,
          applied: run.applied.length,
          alreadyApplied: run.alreadyApplied.length,
          verified: count === files.length,
        };
      } finally {
        await client.end();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      `Applying migrations failed: ${message}`,
      "Fix the failing migration and re-run bahama apply; applied migrations are recorded and will be skipped.",
      diagnosticCode(message),
    );
  }

  return {
    status: summary.verified ? "succeeded" : "failed",
    postconditionVerified: summary.verified,
    receipt: { total: summary.total, applied: summary.applied, alreadyApplied: summary.alreadyApplied },
    ...(summary.verified
      ? {}
      : {
          error: {
            code: "provider-api",
            message: "The migration ledger does not record every checked-in migration after apply.",
          },
        }),
  };
}

/* -------------------------------- driver --------------------------------- */

export const neonProvider = defineProvider({
  authCommands: {
    executables: ["neon", "neonctl"],
    loginArgs: ["auth"],
  },
  descriptor: {
    id: PROVIDER_ID,
    name: "Neon",
    roles: ["database"],
    description:
      "Serverless Postgres on the user's own Neon account, driven through the official neon CLI. Produces a sealed Postgres connection string and applies checked-in SQL migrations.",
    useWhen:
      "The application needs Postgres through a standard connection string, including for local development or an external host, and may use checked-in SQL migrations.",
    avoidWhen:
      "The application needs a different data model or engine, or it needs a provider-native runtime binding instead of a connection string.",
    requirements: ["Neon account (https://neon.tech)", `neon CLI (${INSTALL_HINT})`],
    engines: ["postgres"],
    produces: [
      { capability: "connectionUrl", secret: true, description: "Postgres connection string" },
    ],
    consumes: [],
    testedVersions: [{ tool: "neon", range: ">=2.0.0" }],
  },

  intentSchema,

  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    const bin = await detectBin(ctx);
    if (!bin) {
      return {
        tool: { installed: false, installHint: INSTALL_HINT },
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
      };
    }

    const versionRes = await ctx.run.run(bin, ["--version"]);
    const version = extractVersion(versionRes.stdout, versionRes.stderr);
    const compatibility = compatibilityOf(version);
    const tool = {
      installed: true,
      ...(version !== undefined ? { version } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
    };
    const warnings: string[] = [];
    if (compatibility === "untested-newer") {
      warnings.push(`neon CLI ${version} is newer than the tested v${TESTED_MAJOR} range; proceeding anyway.`);
    }

    const me = await ctx.run.run(bin, ["me", "--output", "json"]);
    if (me.exitCode !== 0) {
      const failure = runFailure(me, "Checking the Neon session");
      const authenticationFailure = failure.code === "authentication";
      return {
        tool,
        auth: authenticationFailure
          ? { state: "unauthenticated", loginHint: LOGIN_HINT }
          : { state: "unknown", code: failure.code, reason: failure.message },
        accounts: [],
        observed: {},
        ...(!authenticationFailure ? { failure } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const meDocument = parseJson(me.stdout);
    if (!meDocument || typeof meDocument !== "object" || Array.isArray(meDocument)) {
      return {
        tool,
        auth: {
          state: "unknown",
          code: "incompatible-output",
          reason: "Neon session check returned incompatible JSON.",
        },
        accounts: [],
        observed: {},
        failure: { code: "incompatible-output", message: "Neon session check returned incompatible JSON." },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const identity = parseIdentity(me.stdout);

    const orgsRes = await ctx.run.run(bin, ["orgs", "list", "--output", "json"]);
    if (orgsRes.exitCode !== 0) {
      const failure = runFailure(orgsRes, "Discovering Neon organizations");
      return {
        tool,
        auth: { state: "authenticated", identity },
        accounts: [],
        observed: {},
        failure,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    if (!hasOrgListShape(orgsRes.stdout)) {
      return {
        tool,
        auth: { state: "authenticated", identity },
        accounts: [],
        observed: {},
        failure: { code: "incompatible-output", message: "Neon organization discovery returned incompatible JSON." },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const accounts = parseOrgs(orgsRes.stdout);

    // Neon project operations require an org id in current CLIs. An explicit
    // config wins; a sole available org is deterministic and auto-selected;
    // multiple orgs are resolved by the plan decision below.
    const orgConfig =
      req.intent
        .filter((intent) => intent.role === "database")
        .map((intent) => configString(intent.config, "org"))
        .find((value) => value !== null) ?? null;
    const selectedOrg = orgConfig
      ? (accounts.find((entry) => entry.id === orgConfig) ?? {
          id: orgConfig,
          label: orgConfig,
          kind: "org" as const,
        })
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    let account: ProviderAccount | undefined = selectedOrg;
    if (!account && accounts.length === 0) {
      const userId = parseUserId(me.stdout);
      if (userId) account = { id: userId, label: identity, kind: "personal" };
    }

    const observed: JsonObject = {};
    let probeFailure: { code: ProviderFailureCode; message: string } | undefined;
    const migrationFiles = readMigrationFiles(ctx.projectRoot);
    for (const intent of req.intent) {
      if (intent.role !== "database") continue;
      const pinnedId = lockedProjectId(req, intent.resourceKey);
      if (pinnedId) {
        const got = await ctx.run.run(bin, ["projects", "get", pinnedId, "--output", "json"]);
        if (got.exitCode !== 0 && !isNotFoundError(got.stderr, got.stdout)) {
          const failure = runFailure(got, `Fetching Neon project ${pinnedId}`);
          observed[intent.resourceKey] = { inspection: "unavailable" };
          probeFailure ??= failure;
        } else if (got.exitCode === 0 && !parseProject(got.stdout)) {
          observed[intent.resourceKey] = { inspection: "unavailable" };
          probeFailure ??= {
            code: "incompatible-output",
            message: `Fetching Neon project ${pinnedId} returned incompatible JSON.`,
          };
        } else {
          observed[intent.resourceKey] =
            got.exitCode === 0
              ? {
                  exists: true,
                  projectId: pinnedId,
                  ...(migrationFiles.length > 0
                    ? await inspectMigrationLedger(ctx, bin, pinnedId, intent.resourceKey)
                    : {}),
                }
              : { exists: false };
        }
        continue;
      }
      const name = resolveName(intent);
      const orgId = configString(intent.config, "org") ?? selectedOrg?.id ?? null;
      const listed = await ctx.run.run(bin, [
        "projects",
        "list",
        ...(orgId ? ["--org-id", orgId] : []),
        "--output",
        "json",
      ]);
      if (listed.exitCode !== 0) {
        const failure = runFailure(listed, "Listing Neon projects");
        observed[intent.resourceKey] = { inspection: "unavailable" };
        probeFailure ??= failure;
        continue;
      }
      if (!hasProjectListShape(listed.stdout)) {
        observed[intent.resourceKey] = { inspection: "unavailable" };
        probeFailure ??= { code: "incompatible-output", message: "Listing Neon projects returned incompatible JSON." };
        continue;
      }
      const match =
        name ? (parseProjectList(listed.stdout).find((p) => p.name === name) ?? null) : null;
      observed[intent.resourceKey] = match
        ? {
            exists: true,
            projectId: match.id,
            ...(migrationFiles.length > 0
              ? await inspectMigrationLedger(ctx, bin, match.id, intent.resourceKey)
              : {}),
          }
        : { exists: false };
    }

    return {
      tool,
      auth: { state: "authenticated", identity, ...(account !== undefined ? { account } : {}) },
      accounts,
      observed,
      ...(probeFailure !== undefined ? { failure: probeFailure } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async plan(ctx: ProviderContext, req: PlanRequest): Promise<PlanContribution> {
    const steps: ContributedStep[] = [];
    const decisions: Decision[] = [];
    const warnings: string[] = [];

    for (const intent of req.intent) {
      if (intent.role !== "database") continue;
      const orgId =
        configString(intent.config, "org") ??
        (req.probe.auth.account?.kind === "org" ? req.probe.auth.account.id : null);

      if (req.probe.accounts.length > 1 && !orgId) {
        decisions.push({
          kind: "decision",
          id: `neon-org-${intent.resourceKey}`,
          providerId: PROVIDER_ID,
          question: "Multiple Neon organizations are available. Which one should own this database?",
          options: req.probe.accounts.map((account) => ({ id: account.id, label: account.label })),
          // `org`, not `orgId`: the manifest validator rejects ID-shaped keys.
          writeBack: `resources.${intent.resourceKey}.config.org`,
        });
        continue;
      }

      const name = resolveName(intent);
      if (!name) {
        warnings.push(
          `Could not determine a Neon project name for \`${intent.resourceKey}\` (set project.name in bahama.yaml or config.name).`,
        );
        continue;
      }

      const observed = req.probe.observed[intent.resourceKey] as JsonObject | undefined;
      const exists = observed?.["exists"] === true;
      const lockedId = lockedProjectId(req, intent.resourceKey);
      // If probe confirmed the locked resource is gone, plan a replacement
      // without leaking the stale id into execution.
      const pinnedId = exists ? lockedId : null;
      const region = configString(intent.config, "region");
      const ensureId = `${intent.resourceKey}-ensure`;

      steps.push({
        id: ensureId,
        action: "neon.project.ensure",
        summary: ensureSummary(name, exists, pinnedId !== null),
        resourceKey: intent.resourceKey,
        effects: ensureEffects(exists, pinnedId !== null),
        inputs: { name, region, orgId, projectId: pinnedId },
        produces: ["connectionUrl"],
        postcondition: "The Neon project exists and its connection string resolves.",
      });

      const migrations = readMigrationFiles(ctx.projectRoot);
      const applied = appliedMigrationsFrom(observed);
      let pending: MigrationFile[];
      try {
        pending = applied === null ? migrations : pendingMigrations(migrations, applied);
      } catch (error) {
        if (error instanceof MigrationHistoryError) throw new ProviderPlanError(error.message);
        throw error;
      }
      const ledgerCheckDeferred = migrations.length > 0 && applied === null && exists;
      if (ledgerCheckDeferred) {
        warnings.push(
          `Migration ledger unavailable for \`${intent.resourceKey}\`; checked-in migrations will be checked during apply.`,
        );
      }
      if (pending.length > 0) {
        steps.push({
          id: `${intent.resourceKey}-migrate`,
          action: "neon.migrations.apply",
          summary: ledgerCheckDeferred
            ? `Check ${migrations.length} SQL migration(s) and apply any missing to \`${name}\``
            : `Apply ${pending.length} pending SQL migration(s) to \`${name}\``,
          resourceKey: intent.resourceKey,
          effects: { migratesSchema: true },
          dependsOn: [ensureId],
          consumes: [`resources.${intent.resourceKey}.connectionUrl`],
          // Name AND content hash: approving this plan approves this exact
          // SQL, and execution rejects files that changed afterwards.
          inputs: {
            files: migrations.map((file) => ({ name: file.name, checksum: checksumOf(file.sql) })),
            pending: ledgerCheckDeferred ? null : pending.map((file) => file.name),
          },
          postcondition: "All checked-in migrations are recorded as applied in _bahama_migrations.",
        });
      }
    }

    return {
      steps,
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
    switch (step.action) {
      case "neon.project.ensure":
        return ensureProject(ctx, step);
      case "neon.migrations.apply":
        return applyMigrations(ctx, step, inputs);
      default:
        return fail(`Unknown neon action ${step.action}`);
    }
  },

  async status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport> {
    const resources: ResourceStatus[] = [];
    const bin = await detectBin(ctx);

    for (const intent of req.intent) {
      if (intent.role !== "database") continue;
      if (!bin) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          health: { state: "unknown", reason: "Neon CLI is not installed." },
          detail: "neon CLI not installed",
          drift: [],
        });
        continue;
      }
      const pinnedId = lockedProjectId(req, intent.resourceKey);
      if (pinnedId) {
        const got = await ctx.run.run(bin, ["projects", "get", pinnedId, "--output", "json"]);
        const exists = got.exitCode === 0;
        if (!exists && !isNotFoundError(got.stderr, got.stdout)) {
          const failure = runFailure(got, `Fetching Neon project ${pinnedId}`);
          resources.push({
            resourceKey: intent.resourceKey,
            exists: false,
            health: { state: "unknown", code: failure.code, reason: failure.message },
            detail: `lookup failed (${failure.code})`,
            drift: [],
          });
          continue;
        }
        const project = exists ? parseProject(got.stdout) : null;
        if (exists && !project) {
          resources.push({
            resourceKey: intent.resourceKey,
            exists: true,
            health: {
              state: "unknown",
              code: "incompatible-output",
              reason: `Fetching Neon project ${pinnedId} returned incompatible JSON.`,
            },
            detail: "lookup failed (incompatible-output)",
            drift: [],
          });
          continue;
        }
        resources.push({
          resourceKey: intent.resourceKey,
          exists,
          health: exists
            ? { state: "ready" }
            : { state: "unhealthy", code: "not-found", reason: "Locked Neon project no longer exists." },
          ...(project?.name ? { detail: project.name } : {}),
          drift: exists
            ? []
            : [
                {
                  severity: "material",
                  resourceKey: intent.resourceKey,
                  message: `Locked Neon project ${pinnedId} no longer exists.`,
                },
              ],
        });
        continue;
      }
      const name = resolveName(intent);
      const orgId = configString(intent.config, "org");
      const listed = await ctx.run.run(bin, [
        "projects",
        "list",
        ...(orgId ? ["--org-id", orgId] : []),
        "--output",
        "json",
      ]);
      if (listed.exitCode !== 0) {
        const failure = runFailure(listed, "Listing Neon projects");
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          health: { state: "unknown", code: failure.code, reason: failure.message },
          detail: `lookup failed (${failure.code})`,
          drift: [],
        });
        continue;
      }
      if (!hasProjectListShape(listed.stdout)) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          health: {
            state: "unknown",
            code: "incompatible-output",
            reason: "Listing Neon projects returned incompatible JSON.",
          },
          detail: "lookup failed (incompatible-output)",
          drift: [],
        });
        continue;
      }
      const match = name ? (parseProjectList(listed.stdout).find((p) => p.name === name) ?? null) : null;
      resources.push({
        resourceKey: intent.resourceKey,
        exists: match !== null,
        health: match
          ? { state: "ready" }
          : { state: "not_ready", reason: "Neon project has not been provisioned." },
        ...(match ? { detail: match.name } : {}),
        drift: [],
      });
    }
    return { resources };
  },
});
