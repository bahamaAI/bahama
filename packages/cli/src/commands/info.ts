import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@bahama-ai/provider-kit";
import {
  LOCK_FILENAME,
  configPath,
  inspectProject,
  loadLock,
  loadManifest,
  readConfig,
  writeConfig,
} from "@bahama-ai/core";
import { UsageError, buildEngine, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

export async function runInspect(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const report = await inspectProject(projectRoot);
  emit(
    envelope(
      "inspect",
      "succeeded",
      report.framework.detected
        ? `Detected ${report.framework.detected} (${report.framework.signals.join("; ")}).`
        : "No framework detected — see the report for raw facts.",
      report,
      { warnings: report.warnings },
    ),
    emitOptions,
  );
}

/** Environment and project health checks; each check is pass/fail with a fix hint. */
export async function runDoctor(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major! > 20 || (major === 20 && minor! >= 19);
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: nodeOk ? `v${process.versions.node}` : `v${process.versions.node} — Bahama needs Node >= 20.19`,
  });

  const report = await inspectProject(projectRoot);
  checks.push({
    name: "manifest",
    ok: report.bahama.manifestPresent ? report.bahama.manifestValid === true : true,
    detail: report.bahama.manifestPresent
      ? (report.bahama.error ?? "bahama.yaml is valid")
      : "no bahama.yaml (run `bahama init` when ready)",
  });

  const registry = buildRegistry();
  if (report.bahama.manifestPresent && report.bahama.manifestValid) {
    const manifest = await loadManifest(projectRoot);
    const engine = buildEngine(projectRoot);
    const providers = new Set([
      manifest.application.provider,
      ...Object.values(manifest.resources).map((r) => r.provider),
    ]);
    for (const providerId of providers) {
      const driver = registry.get(providerId);
      if (!driver) {
        checks.push({ name: `provider:${providerId}`, ok: false, detail: "not registered in this CLI build" });
        continue;
      }
      const probe = await driver.probe(engine.contextFor(providerId), { intent: [], locked: [] });
      checks.push({
        name: `provider:${providerId}`,
        ok: probe.tool.installed && probe.auth.state === "authenticated",
        detail: !probe.tool.installed
          ? (probe.tool.installHint ?? "tool missing")
          : probe.auth.state === "authenticated"
            ? `authenticated as ${probe.auth.identity ?? "unknown"}`
            : (probe.auth.loginHint ?? "not authenticated"),
      });
    }
  }

  const failing = checks.filter((check) => !check.ok);
  emit(
    envelope(
      "doctor",
      failing.length === 0 ? "succeeded" : "failed",
      failing.length === 0 ? "All checks passed." : `${failing.length} check(s) failing.`,
      { checks },
    ),
    emitOptions,
  );
}

/**
 * Provider descriptions for the MODEL. `--format agent` is prose the agent
 * reads to choose; there are no hidden ranking heuristics and no
 * natural-language query — choosing is the model's job.
 */
export async function runProviders(
  providerId: string | undefined,
  format: "agent" | "json",
  emitOptions: EmitOptions,
): Promise<never> {
  const registry = buildRegistry();
  const descriptors = [...registry.values()]
    .map((driver) => driver.descriptor)
    .filter((d) => !providerId || d.id === providerId);
  if (providerId && descriptors.length === 0) {
    throw new UsageError(`Unknown provider \`${providerId}\`. Available: ${[...registry.keys()].join(", ") || "(none)"}.`);
  }

  if (format === "agent" && !emitOptions.json) {
    const sections = descriptors.map((d) =>
      [
        `## ${d.name} (\`${d.id}\`)`,
        ``,
        `roles: ${d.roles.join(", ")}`,
        d.frameworks ? `frameworks: ${d.frameworks.join(", ")}` : null,
        d.engines ? `engines: ${d.engines.join(", ")}` : null,
        ``,
        d.description,
        ``,
        `Use when: ${d.useWhen}`,
        `Avoid when: ${d.avoidWhen}`,
        d.requirements.length > 0 ? `Requires: ${d.requirements.join("; ")}` : null,
        ``,
        `Produces: ${d.produces.map((c) => `${c.capability}${c.secret ? " (secret)" : ""}`).join(", ") || "nothing"}`,
        `Consumes: ${d.consumes.map((c) => c.capability).join(", ") || "nothing"}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
    process.stdout.write(`${sections.join("\n\n")}\n`);
    process.exit(0);
  }

  emit(
    envelope("providers", "succeeded", `${descriptors.length} provider(s) available.`, {
      providers: descriptors as unknown as JsonObject[],
    }),
    emitOptions,
  );
}

/** Clear resolved resource identity but keep intent — the fork/template escape hatch. */
export async function runDetach(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const lock = await loadLock(projectRoot);
  if (!lock) {
    emit(envelope("detach", "succeeded", "No bahama.lock present; nothing to detach.", {}), emitOptions);
  }
  await rm(join(projectRoot, LOCK_FILENAME));
  emit(
    envelope(
      "detach",
      "succeeded",
      "Removed bahama.lock. The manifest is unchanged; the next `bahama plan` resolves fresh resources under your accounts.",
      { removedResources: Object.keys(lock!.resources) },
    ),
    emitOptions,
  );
}

export async function runStatus(projectRoot: string, emitOptions: EmitOptions): Promise<never> {
  const manifest = await loadManifest(projectRoot);
  const lock = await loadLock(projectRoot);
  const registry = buildRegistry();
  const engine = buildEngine(projectRoot);

  const resources: JsonObject[] = [];
  let materialDrift = 0;
  const providers = new Map<string, string[]>();
  providers.set(manifest.application.provider, ["application"]);
  for (const [key, resource] of Object.entries(manifest.resources)) {
    providers.set(resource.provider, [...(providers.get(resource.provider) ?? []), key]);
  }

  for (const [providerId, resourceKeys] of providers) {
    const driver = registry.get(providerId);
    if (!driver) {
      resources.push({ provider: providerId, error: "not registered in this CLI build" });
      continue;
    }
    const report = await driver.status(engine.contextFor(providerId), {
      intent: resourceKeys.map((resourceKey) => ({
        resourceKey,
        role: resourceKey === "application" ? "application" : "database",
        config: {},
      })),
      locked: resourceKeys.flatMap((resourceKey) => {
        const locked = lock?.resources[resourceKey];
        return locked ? [{ resourceKey, identity: locked.identity }] : [];
      }),
    });
    for (const resource of report.resources) {
      materialDrift += resource.drift.filter((d) => d.severity === "material").length;
      resources.push(resource as unknown as JsonObject);
    }
  }

  emit(
    envelope(
      "status",
      materialDrift > 0 ? "decision_required" : "succeeded",
      materialDrift > 0
        ? `${materialDrift} material drift finding(s) — resolve before mutating.`
        : "Live state matches the lock.",
      { resources },
    ),
    emitOptions,
  );
}

export async function runConfig(
  action: "path" | "get" | "set",
  key: string | undefined,
  value: string | undefined,
  emitOptions: EmitOptions,
): Promise<never> {
  if (action === "path") {
    emit(envelope("config", "succeeded", configPath(), { path: configPath() }), emitOptions);
  }
  const config = await readConfig();
  if (action === "get") {
    if (!key) throw new UsageError("Usage: bahama config get <key>");
    emit(envelope("config", "succeeded", `${key}=${JSON.stringify(config[key] ?? null)}`, { [key]: config[key] ?? null }), emitOptions);
  }
  if (!key || value === undefined) throw new UsageError("Usage: bahama config set <key> <value>");
  config[key] = value;
  await writeConfig(config);
  emit(envelope("config", "succeeded", `Set ${key}.`, { [key]: value }), emitOptions);
}
