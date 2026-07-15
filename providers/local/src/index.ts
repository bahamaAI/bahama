import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  defineProvider,
  formatCapabilityAddress,
  isSecretRef,
  type ExecutionInputs,
  type JsonObject,
  type PlanContribution,
  type PlannedStep,
  type ProbeRequest,
  type ProbeResult,
  type ProviderContext,
  type StatusReport,
  type StepOutcome,
} from "@bahama/provider-kit";

const intentSchema = z.object({ envFile: z.string().min(1).default(".env.local") }).passthrough()
  .transform((value) => value as JsonObject);

function envPath(root: string, configured: unknown): string {
  const name = typeof configured === "string" ? configured : ".env.local";
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "" || resolve(dirname(target)) === resolve("/")) {
    throw new Error(`Local env file must be a file inside the project (got \`${name}\`).`);
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}

function setLine(text: string, name: string, value: string): string {
  const escaped = JSON.stringify(value);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=`);
  const index = lines.findIndex((line) => pattern.test(line));
  const next = `${name}=${escaped}`;
  if (index >= 0) lines[index] = next; else lines.push(next);
  return `${lines.join("\n")}\n`;
}

async function ensureIgnored(root: string, configured: unknown): Promise<void> {
  const path = join(root, ".gitignore");
  const entry = relative(root, envPath(root, configured));
  let current = "";
  try { current = await readFile(path, "utf8"); } catch { /* create below */ }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

async function materialize(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
  const name = step.inputs?.["bindingName"];
  if (typeof name !== "string") return { status: "failed", postconditionVerified: false, error: { message: "Missing binding name." } };
  const value = Object.values(inputs.consumed)[0];
  if (value === undefined) return { status: "failed", postconditionVerified: false, error: { message: `Missing value for ${name}.` } };
  const path = envPath(ctx.projectRoot, step.inputs?.["envFile"]);
  const write = async (raw: string) => {
    let current = "";
    try { current = await readFile(path, "utf8"); } catch { /* new file */ }
    const next = setLine(current, name, raw);
    const temporary = `${path}.bahama-tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    await ensureIgnored(ctx.projectRoot, step.inputs?.["envFile"]);
    const verified = (await readFile(path, "utf8")).split(/\r?\n/).some((line) => line.startsWith(`${name}=`));
    return {
      status: verified ? "succeeded" as const : "failed" as const,
      postconditionVerified: verified,
      receipt: { envFile: relative(ctx.projectRoot, path), name },
      ...(verified ? {} : { error: { message: `${name} was not present after writing the local env file.` } }),
    };
  };
  if (isSecretRef(value)) return ctx.secrets.use(value, write);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { status: "failed", postconditionVerified: false, error: { message: `${name} is not a scalar environment value.` } };
  }
  return write(String(value));
}

export const localProvider = defineProvider({
  descriptor: {
    id: "local",
    name: "Local development",
    roles: ["environment"],
    description: "Materializes declared resource bindings into a gitignored local environment file for npm run dev and other local workflows.",
    useWhen: "The application is developed and tested locally before or alongside deployment.",
    avoidWhen: "A value belongs only in a hosted runtime and must never be available to local development.",
    requirements: [],
    produces: [],
    consumes: [{ capability: "variables", secret: false, description: "Local environment variables." }],
  },
  intentSchema,
  async probe(ctx: ProviderContext, req: ProbeRequest): Promise<ProbeResult> {
    const observed: JsonObject = {};
    for (const intent of req.intent) observed[intent.resourceKey] = { exists: await exists(envPath(ctx.projectRoot, intent.config["envFile"])) };
    return { tool: { installed: true }, auth: { state: "authenticated", identity: "this project" }, accounts: [], observed };
  },
  async plan(_ctx: ProviderContext, req): Promise<PlanContribution> {
    if (req.operation?.kind === "deploy") return { steps: [] };
    const steps = [];
    for (const intent of req.intent) {
      for (const edge of req.bindings.filter((binding) => binding.to.resourceKey === intent.resourceKey)) {
        const from = formatCapabilityAddress(edge.from);
        const to = formatCapabilityAddress(edge.to);
        const alreadyApplied = (req.appliedBindings ?? []).some(
          (known) => known.name === edge.name && known.from === from && known.to === to,
        );
        if (alreadyApplied && edge.from.resourceKey.startsWith("environment.") && edge.from.capability.startsWith("development")) continue;
        steps.push({
          id: `${intent.resourceKey.replaceAll(".", "-")}-variable-${edge.name.toLowerCase()}`,
          action: "local.env.set",
          summary: `Write ${edge.name} to the local development environment`,
          resourceKey: intent.resourceKey,
          effects: { transfersSecret: true },
          consumes: [from],
          inputs: { bindingName: edge.name, bindingTo: to, envFile: intent.config["envFile"] ?? ".env.local" },
          postcondition: `${edge.name} is present in the gitignored local environment file.`,
        });
      }
    }
    return { steps };
  },
  async execute(ctx: ProviderContext, step: PlannedStep, inputs: ExecutionInputs): Promise<StepOutcome> {
    return step.action === "local.env.set"
      ? materialize(ctx, step, inputs)
      : { status: "failed", postconditionVerified: false, error: { message: `Unknown local action ${step.action}` } };
  },
  async status(ctx: ProviderContext, req: ProbeRequest): Promise<StatusReport> {
    const resources = [];
    for (const intent of req.intent) {
      const path = envPath(ctx.projectRoot, intent.config["envFile"]);
      const present = await exists(path);
      resources.push({ resourceKey: intent.resourceKey, exists: present, healthy: present, detail: relative(ctx.projectRoot, path), drift: [] });
    }
    return { resources };
  },
});
