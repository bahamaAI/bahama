import type { CommandStatus, JsonObject, ProviderDriver, ResultEnvelope } from "@bahama/provider-kit";
import { Engine } from "@bahama/core";
import { bahamaCloudProvider } from "@bahama/provider-bahama-cloud";
import { testProvider } from "@bahama/provider-test";
import { neonProvider } from "@bahama/provider-neon";
import { localProvider } from "@bahama/provider-local";
import { vercelProvider } from "@bahama/provider-vercel";
import { freshCloudToken } from "./cloud-auth.js";
import { renderHuman } from "./render.js";

/**
 * Static provider registry. Official providers are bundled with the CLI —
 * there is no runtime provider discovery or download. The test provider is
 * the contract-test reference and only appears with BAHAMA_ENABLE_TEST=1.
 */
export function buildRegistry(): ReadonlyMap<string, ProviderDriver> {
  const registry = new Map<string, ProviderDriver>();
  registry.set("bahama-cloud", bahamaCloudProvider);
  registry.set("vercel", vercelProvider);
  registry.set("neon", neonProvider);
  registry.set("local", localProvider);
  if (process.env["BAHAMA_ENABLE_TEST"] === "1") {
    registry.set("test", testProvider);
  }
  return registry;
}

export function buildEngine(projectRoot: string): Engine {
  return new Engine({
    projectRoot,
    verbose: process.env["BAHAMA_VERBOSE"] === "1",
    // The Cloud driver asks this for a token per request; freshCloudToken
    // refreshes (behind a file lock) when the stored one is stale, so a long
    // apply never dies on an expired 15-minute access token.
    tokenSuppliers: { "bahama-cloud": freshCloudToken },
  });
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
