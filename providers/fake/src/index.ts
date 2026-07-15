import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  defineProvider,
  formatCapabilityAddress,
  isSecretRef,
  type ContributedStep,
  type JsonObject,
  type PlanContribution,
  type PlannedStep,
  type ProbeRequest,
  type ProbeResult,
  type ProviderContext,
  type StepOutcome,
} from "@bahama-ai/provider-kit";

/**
 * The contract-test provider. It behaves like a real provider — durable
 * "live" state, idempotent ensure semantics, secret production, postcondition
 * verification — but everything observable is driven by the `simulate` block
 * of the resource config, so tests can stage installation gaps, auth gaps,
 * multiple accounts, and mid-apply failures deterministically.
 *
 * "Live provider state" is a JSON file at `.fake-live.json` in the project
 * root (it stands in for the remote provider, so tests can also mutate it to
 * simulate drift). Failure injections are consumed ON USE and persist across
 * processes, which is what makes resume tests honest.
 */

const simulateSchema = z
  .object({
    toolMissing: z.boolean().optional(),
    unauthenticated: z.boolean().optional(),
    /** More than one account forces a decision unless `account` picks one. */
    accounts: z.array(z.string()).optional(),
    /** The chosen account (a decision writeBack target). */
    account: z.string().optional(),
    /** Actions that fail once, then succeed on retry (consumed on use). */
    failOnce: z.array(z.string()).optional(),
  })
  .default({});

const intentSchema = z
  .object({
    simulate: simulateSchema,
  })
  .passthrough()
  .transform((value) => value as JsonObject);

interface LiveState {
  resources: Record<string, { id: string; kind: string; deployments: number; envVars: Record<string, string> }>;
  consumedFailures: string[];
  /** Deterministic per-resource secret material. */
  secrets: Record<string, string>;
}

function statePath(root: string): string {
  return join(root, ".fake-live.json");
}

function loadState(root: string): LiveState {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8")) as LiveState;
  } catch {
    return { resources: {}, consumedFailures: [], secrets: {} };
  }
}

function saveState(root: string, state: LiveState): void {
  mkdirSync(dirname(statePath(root)), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}

function simulateOf(req: ProbeRequest): z.infer<typeof simulateSchema> {
  const first = req.intent[0];
  return simulateSchema.parse((first?.config["simulate"] as JsonObject | undefined) ?? {});
}

function deterministicSecret(root: string, resourceKey: string): string {
  const seed = createHash("sha256").update(`${root}:${resourceKey}`).digest("hex").slice(0, 24);
  return `fakedb://user:${seed}@db.fake.internal/${resourceKey}`;
}

export const fakeProvider = defineProvider({
  descriptor: {
    id: "fake",
    name: "Fake Provider",
    roles: ["environment", "application", "database"],
    description: "Deterministic in-repo provider used by the contract test suite.",
    useWhen: "Never in real projects; contract tests only.",
    avoidWhen: "Always, outside tests.",
    requirements: [],
    frameworks: ["fake-framework"],
    engines: ["fakedb"],
    produces: [
      { capability: "connectionUrl", secret: true, description: "Fake database connection string." },
      { capability: "productionUrl", secret: false, description: "Fake deployed application URL." },
    ],
    consumes: [
      { capability: "variables", secret: false, description: "Environment variables of the fake app." },
      { capability: "productionEnvironment", secret: false, description: "Legacy app environment variables." },
    ],
  },

  intentSchema,

  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    const simulate = simulateOf(req);
    if (simulate.toolMissing) {
      return {
        tool: { installed: false, installHint: "npm i -g fake-cli" },
        auth: { state: "unauthenticated", loginHint: "bahama auth login fake" },
        accounts: [],
        observed: {},
      };
    }
    if (simulate.unauthenticated) {
      return {
        tool: { installed: true, version: "1.0.0", compatibility: "tested" },
        auth: { state: "unauthenticated", loginHint: "bahama auth login fake" },
        accounts: [],
        observed: {},
      };
    }
    const accounts = simulate.accounts ?? ["default-account"];
    const state = loadState(ctx.projectRoot);
    const observed: JsonObject = {};
    for (const intent of req.intent) {
      const live = state.resources[intent.resourceKey];
      observed[intent.resourceKey] = live ? { exists: true, id: live.id } : { exists: false };
    }
    const active = simulate.account ?? accounts[0]!;
    return {
      tool: { installed: true, version: "1.0.0", compatibility: "tested" },
      auth: { state: "authenticated", identity: active, account: { id: active, label: active } },
      accounts: accounts.map((id) => ({ id, label: id })),
      observed,
    };
  },

  async plan(ctx: ProviderContext, req): Promise<PlanContribution> {
    const operation = req.operation ?? { kind: "deploy" as const, environment: "production" };
    const simulate = simulateOf(req);
    const accounts = simulate.accounts ?? ["default-account"];
    if (accounts.length > 1 && !simulate.account) {
      return {
        steps: [],
        decisions: [
          {
            kind: "decision",
            id: "fake-account",
            providerId: "fake",
            question: "Multiple fake accounts are available. Which one should own these resources?",
            options: accounts.map((id) => ({ id, label: id })),
            writeBack: "application.config.simulate.account",
          },
        ],
      };
    }

    const state = loadState(ctx.projectRoot);
    const steps: ContributedStep[] = [];
    const failOnce = simulate.failOnce ?? [];

    for (const intent of req.intent) {
      const exists = Boolean(state.resources[intent.resourceKey]);
      if (intent.role === "database") {
        steps.push({
          id: `${intent.resourceKey}-ensure`,
          action: "fake.database.ensure",
          summary: ensureSummary("database", intent.resourceKey, exists, lockHasIdentity(req, intent.resourceKey)),
          resourceKey: intent.resourceKey,
          effects: ensureEffects(exists, lockHasIdentity(req, intent.resourceKey)),
          produces: ["connectionUrl"],
          postcondition: "The database exists and its connection string resolves.",
        });
      } else {
        steps.push({
          id: `${intent.resourceKey}-ensure`,
          action: "fake.app.ensure",
          summary: ensureSummary("app", intent.resourceKey, exists, lockHasIdentity(req, intent.resourceKey)),
          resourceKey: intent.resourceKey,
          effects: ensureEffects(exists, lockHasIdentity(req, intent.resourceKey)),
          postcondition: "The application project exists.",
        });

        // One env-transfer step per binding that lands on this application.
        for (const edge of req.bindings.filter((b) => b.to.resourceKey === intent.resourceKey)) {
          const fromAddress = formatCapabilityAddress(edge.from);
          const toAddress = formatCapabilityAddress(edge.to);
          steps.push({
            id: `${intent.resourceKey}-env-${edge.name.toLowerCase()}`,
            action: "fake.env.set",
            summary: `Transfer ${edge.name} to the fake app environment`,
            resourceKey: intent.resourceKey,
            effects: { transfersSecret: edge.secret },
            consumes: [fromAddress],
            dependsOn: [`${intent.resourceKey}-ensure`],
            inputs: { bindingName: edge.name, bindingTo: toAddress },
            postcondition: `${edge.name} is present in the app environment.`,
          });
        }

        const envSteps = req.bindings
          .filter((b) => b.to.resourceKey === intent.resourceKey)
          .map((b) => `${intent.resourceKey}-env-${b.name.toLowerCase()}`);
        if (operation.kind === "deploy" && operation.environment === (intent.environment ?? "production")) steps.push({
          id: `${intent.resourceKey}-deploy`,
          action: "fake.app.deploy",
          summary: `Deploy \`${intent.resourceKey}\` to fake production`,
          resourceKey: intent.resourceKey,
          effects: { deploys: true },
          dependsOn: [`${intent.resourceKey}-ensure`, ...envSteps],
          produces: ["productionUrl"],
          postcondition: "The deployment is live and serving.",
        });
        if (operation.kind === "deploy" && operation.environment === (intent.environment ?? "production")) steps.push({
          id: `${intent.resourceKey}-verify`,
          action: "fake.app.verify",
          summary: `Verify \`${intent.resourceKey}\` responds in production`,
          resourceKey: intent.resourceKey,
          effects: { readOnly: true },
          dependsOn: [`${intent.resourceKey}-deploy`],
          postcondition: "A production request succeeds.",
        });
      }
    }

    // Attach the injection list to affected steps so execute() sees it in a
    // fresh process (that persistence is what makes resume tests honest).
    return {
      steps: steps.map((step) =>
        failOnce.includes(step.action) ? { ...step, inputs: { ...step.inputs, failOnce } } : step,
      ),
    };
  },

  async execute(ctx: ProviderContext, step: PlannedStep, inputs): Promise<StepOutcome> {
    const state = loadState(ctx.projectRoot);

    // Injected failure: fails once, then succeeds on retry — across processes.
    const failKey = `${step.action}:${step.id}`;
    const failOnce = collectFailOnce(step);
    if (failOnce.includes(step.action) && !state.consumedFailures.includes(failKey)) {
      state.consumedFailures.push(failKey);
      saveState(ctx.projectRoot, state);
      return {
        status: "failed",
        postconditionVerified: false,
        error: { message: `Injected failure for ${step.action}`, recovery: "Re-run bahama apply to resume." },
      };
    }

    const resourceKey = step.resourceKey ?? "application";

    switch (step.action) {
      case "fake.database.ensure": {
        const existing = state.resources[resourceKey];
        const resource = existing ?? {
          id: `fakedb_${resourceKey}`,
          kind: "database",
          deployments: 0,
          envVars: {},
        };
        state.resources[resourceKey] = resource;
        state.secrets[resourceKey] ??= deterministicSecret(ctx.projectRoot, resourceKey);
        saveState(ctx.projectRoot, state);
        const connection = ctx.secrets.seal(`${resourceKey}.connectionUrl`, state.secrets[resourceKey]!);
        return {
          status: "succeeded",
          postconditionVerified: true,
          produced: { connectionUrl: connection },
          identity: { resourceId: resource.id },
          receipt: { existed: Boolean(existing) },
        };
      }
      case "fake.app.ensure": {
        const existing = state.resources[resourceKey];
        const resource = existing ?? { id: `fakeapp_${resourceKey}`, kind: "app", deployments: 0, envVars: {} };
        state.resources[resourceKey] = resource;
        saveState(ctx.projectRoot, state);
        return {
          status: "succeeded",
          postconditionVerified: true,
          identity: { resourceId: resource.id },
          receipt: { existed: Boolean(existing) },
        };
      }
      case "fake.env.set": {
        const resource = state.resources[resourceKey];
        if (!resource) {
          return { status: "failed", postconditionVerified: false, error: { message: "App does not exist." } };
        }
        const name = step.inputs?.["bindingName"] as string;
        const consumed = Object.values(inputs.consumed)[0];
        if (consumed === undefined) {
          return { status: "failed", postconditionVerified: false, error: { message: "No value to transfer." } };
        }
        if (isSecretRef(consumed)) {
          // Sealed secret: store only material derived via broker use.
          await ctx.secrets.use(consumed, async (raw) => {
            resource.envVars[name] = raw; // the fake "remote" side; never journaled
            return null;
          });
        } else {
          resource.envVars[name] = String(consumed);
        }
        saveState(ctx.projectRoot, state);
        return {
          status: "succeeded",
          postconditionVerified: resource.envVars[name] !== undefined,
          receipt: { name, destination: step.inputs?.["bindingTo"] ?? null },
        };
      }
      case "fake.app.deploy": {
        const resource = state.resources[resourceKey];
        if (!resource) {
          return { status: "failed", postconditionVerified: false, error: { message: "App does not exist." } };
        }
        resource.deployments += 1;
        saveState(ctx.projectRoot, state);
        return {
          status: "succeeded",
          postconditionVerified: true,
          produced: { productionUrl: `https://${resource.id}.fake.app` },
          receipt: { deployment: resource.deployments },
        };
      }
      case "fake.app.verify": {
        const resource = state.resources[resourceKey];
        const healthy = Boolean(resource && resource.deployments > 0);
        return {
          status: healthy ? "succeeded" : "failed",
          postconditionVerified: healthy,
          receipt: { deployments: resource?.deployments ?? 0 },
        };
      }
      default:
        return {
          status: "failed",
          postconditionVerified: false,
          error: { message: `Unknown fake action ${step.action}` },
        };
    }
  },

  async status(ctx: ProviderContext, req) {
    const state = loadState(ctx.projectRoot);
    return {
      resources: req.intent.map((intent) => {
        const live = state.resources[intent.resourceKey];
        const locked = req.locked.find((l) => l.resourceKey === intent.resourceKey);
        const drift =
          locked && live && locked.identity["resourceId"] !== live.id
            ? [
                {
                  severity: "material" as const,
                  resourceKey: intent.resourceKey,
                  message: "Locked resource id does not match live state.",
                },
              ]
            : [];
        return {
          resourceKey: intent.resourceKey,
          exists: Boolean(live),
          healthy: live ? live.deployments > 0 || live.kind === "database" : false,
          ...(live ? { detail: live.id } : {}),
          drift,
        };
      }),
    };
  },
});

function lockHasIdentity(req: { locked: Array<{ resourceKey: string }> }, resourceKey: string): boolean {
  return req.locked.some((entry) => entry.resourceKey === resourceKey);
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

function ensureSummary(kind: string, resourceKey: string, exists: boolean, locked: boolean): string {
  if (!exists) return `Create the fake ${kind} \`${resourceKey}\``;
  if (!locked) return `Adopt the existing fake ${kind} \`${resourceKey}\``;
  return `Verify the fake ${kind} \`${resourceKey}\` still exists`;
}

/** failOnce lives in the step's own resource config, carried via inputs at plan time. */
function collectFailOnce(step: PlannedStep): string[] {
  const fromInputs = step.inputs?.["failOnce"];
  return Array.isArray(fromInputs) ? (fromInputs as string[]) : [];
}
