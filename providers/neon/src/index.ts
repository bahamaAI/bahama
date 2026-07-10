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
  type ResourceIntent,
  type ResourceStatus,
  type SecretRef,
  type StatusReport,
  type StepOutcome,
  type ToolCompatibility,
} from "@bahama-ai/provider-kit";
import {
  assertNonDestructive,
  countApplied,
  runMigrations,
  type MigrationFile,
  type QueryExecutor,
} from "./migrations.js";

export {
  assertNonDestructive,
  countApplied,
  findDestructiveStatement,
  runMigrations,
  MIGRATIONS_TABLE,
  type MigrationFile,
  type MigrationSummary,
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
    /** Owning organization; a decision writes this back when ambiguous. */
    orgId: z.string().min(1).optional(),
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

function parseIdentity(text: string): string {
  const parsed = parseJson(text) as { email?: unknown; name?: unknown; login?: unknown } | null;
  if (typeof parsed?.email === "string" && parsed.email !== "") return parsed.email;
  if (typeof parsed?.name === "string" && parsed.name !== "") return parsed.name;
  if (typeof parsed?.login === "string" && parsed.login !== "") return parsed.login;
  return "neon user";
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
  let connectionFromCreate: string | null = null;

  if (projectId) {
    const got = await ctx.run.run(bin, ["projects", "get", projectId, "--output", "json"]);
    if (got.exitCode !== 0) {
      return fail(
        `The locked Neon project ${projectId} could not be fetched: ${errText(got.stderr, got.stdout)}`,
        "If the project was deleted, remove it from bahama.lock and re-plan.",
      );
    }
  } else {
    const listed = await ctx.run.run(bin, ["projects", "list", ...orgArgs, "--output", "json"]);
    if (listed.exitCode !== 0) {
      return fail(`Listing Neon projects failed: ${errText(listed.stderr, listed.stdout)}`, LOGIN_HINT);
    }
    projectId = parseProjectList(listed.stdout).find((p) => p.name === name)?.id ?? null;
    if (!projectId) {
      const created = await ctx.run.run(bin, [
        "projects",
        "create",
        "--name",
        name,
        ...(region ? ["--region-id", region] : []),
        ...orgArgs,
        "--output",
        "json",
      ]);
      if (created.exitCode !== 0) {
        return fail(`Creating Neon project \`${name}\` failed: ${errText(created.stderr, created.stdout)}`);
      }
      const project = parseProject(created.stdout);
      if (!project) return fail("Neon project creation returned no parsable project id.");
      projectId = project.id;
      existed = false;
      // `projects create --output json` already carries the connection URI;
      // seal it immediately so no later diagnostics can echo it.
      const uris = (parseJson(created.stdout) as { connection_uris?: Array<{ connection_uri?: unknown }> } | null)
        ?.connection_uris;
      const uri = uris?.[0]?.connection_uri;
      if (typeof uri === "string" && uri !== "") connectionFromCreate = uri;
    }
  }

  // The connection string is THE secret: seal it the moment it exists and
  // never place it in receipts, logs, or identity.
  let connectionRef: SecretRef;
  if (connectionFromCreate) {
    connectionRef = ctx.secrets.seal(`${resourceKey}.connectionUrl`, connectionFromCreate.trim());
  } else {
    const cs = await ctx.run.run(bin, ["connection-string", "--project-id", projectId]);
    const value = cs.stdout.trim();
    if (cs.exitCode !== 0 || value === "") {
      return fail(`Fetching the Neon connection string failed: ${errText(cs.stderr, cs.stdout)}`);
    }
    connectionRef = ctx.secrets.seal(`${resourceKey}.connectionUrl`, value);
  }

  const check = await ctx.run.run(bin, ["projects", "get", projectId, "--output", "json"]);
  const verified = check.exitCode === 0;
  return {
    status: verified ? "succeeded" : "failed",
    postconditionVerified: verified,
    produced: { connectionUrl: connectionRef },
    identity: { projectId },
    receipt: { projectId, existed },
    ...(verified
      ? {}
      : { error: { message: `Verifying Neon project ${projectId} failed: ${errText(check.stderr, check.stdout)}` } }),
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
      // Neon requires TLS; an explicit ssl option also covers URLs that lost
      // their ?sslmode=require along the way.
      const client = new pg.Client({ connectionString: raw, ssl: { rejectUnauthorized: true } });
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
    return fail(
      `Applying migrations failed: ${(error as Error).message}`,
      "Fix the failing migration and re-run bahama apply; applied migrations are recorded and will be skipped.",
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
            message: "The migration ledger does not record every checked-in migration after apply.",
          },
        }),
  };
}

/* -------------------------------- driver --------------------------------- */

export const neonProvider = defineProvider({
  descriptor: {
    id: PROVIDER_ID,
    name: "Neon",
    roles: ["database"],
    description:
      "Serverless Postgres on the user's own Neon account, driven through the official neon CLI. Produces a sealed Postgres connection string and applies checked-in SQL migrations.",
    useWhen:
      "The project needs real Postgres (a connection string the app consumes) on the user's own Neon account — e.g. Next.js on Vercel with Neon as the database.",
    avoidWhen:
      "The stack is fully managed Bahama Cloud (use its built-in D1), or the project needs a non-Postgres engine.",
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
      return {
        tool,
        auth: { state: "unauthenticated", loginHint: LOGIN_HINT },
        accounts: [],
        observed: {},
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const identity = parseIdentity(me.stdout);

    const orgsRes = await ctx.run.run(bin, ["orgs", "list", "--output", "json"]);
    const accounts = orgsRes.exitCode === 0 ? parseOrgs(orgsRes.stdout) : [];

    const observed: JsonObject = {};
    for (const intent of req.intent) {
      if (intent.role !== "database") continue;
      const pinnedId = lockedProjectId(req, intent.resourceKey);
      if (pinnedId) {
        const got = await ctx.run.run(bin, ["projects", "get", pinnedId, "--output", "json"]);
        observed[intent.resourceKey] =
          got.exitCode === 0 ? { exists: true, projectId: pinnedId } : { exists: false };
        continue;
      }
      const name = resolveName(intent);
      const orgId = configString(intent.config, "orgId");
      const listed = await ctx.run.run(bin, [
        "projects",
        "list",
        ...(orgId ? ["--org-id", orgId] : []),
        "--output",
        "json",
      ]);
      const match =
        listed.exitCode === 0 && name
          ? (parseProjectList(listed.stdout).find((p) => p.name === name) ?? null)
          : null;
      observed[intent.resourceKey] = match ? { exists: true, projectId: match.id } : { exists: false };
    }

    return {
      tool,
      auth: { state: "authenticated", identity },
      accounts,
      observed,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async plan(ctx: ProviderContext, req: PlanRequest): Promise<PlanContribution> {
    const steps: ContributedStep[] = [];
    const decisions: Decision[] = [];
    const warnings: string[] = [];

    for (const intent of req.intent) {
      if (intent.role !== "database") continue;
      const orgId = configString(intent.config, "orgId");

      if (req.probe.accounts.length > 1 && !orgId) {
        decisions.push({
          kind: "decision",
          id: `neon-org-${intent.resourceKey}`,
          providerId: PROVIDER_ID,
          question: "Multiple Neon organizations are available. Which one should own this database?",
          options: req.probe.accounts.map((account) => ({ id: account.id, label: account.label })),
          writeBack: `resources.${intent.resourceKey}.config.orgId`,
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
      const pinnedId = lockedProjectId(req, intent.resourceKey);
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
      if (migrations.length > 0) {
        steps.push({
          id: `${intent.resourceKey}-migrate`,
          action: "neon.migrations.apply",
          summary: `Apply ${migrations.length} checked-in SQL migration(s) to \`${name}\``,
          resourceKey: intent.resourceKey,
          effects: { migratesSchema: true },
          dependsOn: [ensureId],
          consumes: [`resources.${intent.resourceKey}.connectionUrl`],
          inputs: { files: migrations.map((file) => file.name) },
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
          healthy: "unknown",
          detail: "neon CLI not installed",
          drift: [],
        });
        continue;
      }
      const pinnedId = lockedProjectId(req, intent.resourceKey);
      if (pinnedId) {
        const got = await ctx.run.run(bin, ["projects", "get", pinnedId, "--output", "json"]);
        const exists = got.exitCode === 0;
        const project = exists ? parseProject(got.stdout) : null;
        resources.push({
          resourceKey: intent.resourceKey,
          exists,
          healthy: exists ? true : false,
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
      const orgId = configString(intent.config, "orgId");
      const listed = await ctx.run.run(bin, [
        "projects",
        "list",
        ...(orgId ? ["--org-id", orgId] : []),
        "--output",
        "json",
      ]);
      if (listed.exitCode !== 0) {
        resources.push({
          resourceKey: intent.resourceKey,
          exists: false,
          healthy: "unknown",
          detail: "not authenticated",
          drift: [],
        });
        continue;
      }
      const match = name ? (parseProjectList(listed.stdout).find((p) => p.name === name) ?? null) : null;
      resources.push({
        resourceKey: intent.resourceKey,
        exists: match !== null,
        healthy: match !== null,
        ...(match ? { detail: match.name } : {}),
        drift: [],
      });
    }
    return { resources };
  },
});
