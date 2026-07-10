import type { CommandStatus, JsonObject, ProviderDriver, ResultEnvelope } from "@bahama-ai/provider-kit";
import { Engine } from "@bahama-ai/core";
import { bahamaCloudProvider } from "@bahama-ai/provider-bahama-cloud";
import { fakeProvider } from "@bahama-ai/provider-fake";
import { renderHuman } from "./render.js";

/**
 * Static provider registry. Official providers are bundled with the CLI —
 * there is no runtime provider discovery or download. The fake provider is
 * the contract-test reference and only appears with BAHAMA_ENABLE_FAKE=1.
 */
export function buildRegistry(): ReadonlyMap<string, ProviderDriver> {
  const registry = new Map<string, ProviderDriver>();
  registry.set("bahama-cloud", bahamaCloudProvider);
  // vercel and neon drivers register here as they land.
  if (process.env["BAHAMA_ENABLE_FAKE"] === "1") {
    registry.set("fake", fakeProvider);
  }
  return registry;
}

export function buildEngine(projectRoot: string): Engine {
  return new Engine({ projectRoot, verbose: process.env["BAHAMA_VERBOSE"] === "1" });
}

/** Exit-code policy: expected workflow states are 0; only real failures are 1+. */
export function exitCodeFor(status: CommandStatus): number {
  return status === "failed" ? 1 : 0;
}

export interface EmitOptions {
  json: boolean;
}

/**
 * Every command produces exactly one ResultEnvelope. JSON mode writes it to
 * stdout verbatim; human mode renders the SAME object, so the two outputs
 * cannot drift. Diagnostics always go to stderr.
 */
export function emit(envelope: ResultEnvelope, options: EmitOptions): never {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(envelope));
  }
  process.exit(exitCodeFor(envelope.status));
}

export function envelope(
  command: string,
  status: CommandStatus,
  message: string,
  data: JsonObject = {},
  extras: Partial<Pick<ResultEnvelope, "requirements" | "decisions" | "warnings">> = {},
): ResultEnvelope {
  return {
    protocolVersion: 1,
    command,
    status,
    message,
    data,
    ...(extras.requirements && extras.requirements.length > 0 ? { requirements: extras.requirements } : {}),
    ...(extras.decisions && extras.decisions.length > 0 ? { decisions: extras.decisions } : {}),
    warnings: extras.warnings ?? [],
  };
}

/** Invalid invocation or manifest: exit 2. Internal bug: exit 3. */
export function fail(command: string, options: EmitOptions, error: unknown): never {
  const isUsage = error instanceof UsageError || (error instanceof Error && error.name === "ManifestError");
  const message = error instanceof Error ? error.message : String(error);
  const env = envelope(command, "failed", message, {});
  if (options.json) {
    process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(env));
  }
  process.exit(isUsage ? 2 : 3);
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
