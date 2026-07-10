import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_FILENAME, validateManifest } from "@bahama-ai/core";
import { UsageError, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

export interface InitOptions {
  name: string;
  application: string;
  framework: string;
  database?: string;
}

/**
 * Write a starter bahama.yaml. `init` never contacts a provider and never
 * creates a lock — identity resolution belongs to `bahama plan`.
 */
export async function runInit(projectRoot: string, options: InitOptions, emitOptions: EmitOptions): Promise<never> {
  const manifestPath = join(projectRoot, MANIFEST_FILENAME);
  if (await exists(manifestPath)) {
    throw new UsageError(`${MANIFEST_FILENAME} already exists. Edit it directly, or remove it to re-init.`);
  }

  const registry = buildRegistry();
  const application = registry.get(options.application);
  if (!application) {
    throw new UsageError(
      `Unknown application provider \`${options.application}\`. Available: ${[...registry.keys()].join(", ") || "(none registered)"}.`,
    );
  }
  if (options.database && !registry.get(options.database)) {
    throw new UsageError(`Unknown database provider \`${options.database}\`.`);
  }

  const lines: string[] = [
    "version: 1",
    "project:",
    `  name: ${options.name}`,
    "",
    "application:",
    `  provider: ${options.application}`,
    `  framework: ${options.framework}`,
  ];
  if (options.database) {
    const engine = registry.get(options.database)!.descriptor.engines?.[0];
    lines.push("", "resources:", "  database:", `    provider: ${options.database}`);
    if (engine) lines.push(`    engine: ${engine}`);
    const produces = registry.get(options.database)!.descriptor.produces.find((c) => c.secret);
    if (produces) {
      lines.push(
        "",
        "bindings:",
        "  DATABASE_URL:",
        `    from: resources.database.${produces.capability}`,
        "    to: application.productionEnvironment",
      );
    }
  }
  lines.push("");
  const text = lines.join("\n");

  // Validate what we are about to write — init must never produce a manifest
  // that `plan` immediately rejects.
  const { parse } = await import("yaml");
  validateManifest(parse(text));
  await writeFile(manifestPath, text);
  await ensureGitignore(projectRoot);

  emit(
    envelope("init", "succeeded", `Wrote ${MANIFEST_FILENAME}. Next: review it, then run \`bahama plan\`.`, {
      manifest: text,
    }),
    emitOptions,
  );
}

/** `.bahama/` is local operational state and must never be committed. */
async function ensureGitignore(projectRoot: string): Promise<void> {
  const path = join(projectRoot, ".gitignore");
  const entry = ".bahama/";
  try {
    const current = await readFile(path, "utf8");
    if (current.split("\n").some((line) => line.trim() === entry)) return;
    await appendFile(path, `${current.endsWith("\n") ? "" : "\n"}${entry}\n`);
  } catch {
    await writeFile(path, `${entry}\n`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
