import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { JsonObject } from "@bahama/provider-kit";
import { sha256Hex } from "./hash.js";
import { LOCK_FILENAME, loadLock } from "./lockfile.js";
import { MANIFEST_FILENAME, loadManifest } from "./manifest.js";

/**
 * Non-secret application facts for the MODEL. `bahama inspect` exists so the
 * model chooses providers from accurate ingredients instead of guessing; it
 * makes no choices itself and never mutates anything.
 */
export interface InspectReport extends JsonObject {
  projectRoot: string;
  framework: {
    detected: string | null;
    /** Evidence lines, e.g. `next in dependencies`. */
    signals: string[];
  };
  packageManager: { name: string; lockfile: string } | null;
  scripts: Record<string, string>;
  /** Environment variable names referenced by source (never values). */
  envVarNames: string[];
  providerMetadata: { vercelLinked: boolean };
  migrationsDir: string | null;
  bahama: {
    manifestPresent: boolean;
    manifestValid: boolean | null;
    lockPresent: boolean;
    error: string | null;
  };
  sourceFingerprint: string;
  warnings: string[];
}

/** Directories that never count as project source. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".bahama", "dist", "build", ".next", ".vercel", "coverage"]);
const IGNORED_SOURCE_FILES = new Set([MANIFEST_FILENAME, LOCK_FILENAME]);

const LOCKFILES: Array<[string, string]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

export async function inspectProject(projectRoot: string): Promise<InspectReport> {
  const warnings: string[] = [];
  const pkg = await readJson(join(projectRoot, "package.json"));

  const dependencies: Record<string, string> = {
    ...(pkg?.dependencies as Record<string, string> | undefined),
    ...(pkg?.devDependencies as Record<string, string> | undefined),
  };

  const signals: string[] = [];
  let detected: string | null = null;
  const has = (dep: string) => dep in dependencies;

  if (has("next")) {
    detected = "nextjs";
    signals.push("next in dependencies");
  } else if (has("vite") && has("hono")) {
    detected = "vite-hono";
    signals.push("vite and hono in dependencies");
  } else if (has("vite")) {
    detected = "vite-spa";
    signals.push("vite in dependencies");
  } else if (has("hono")) {
    detected = "hono-api";
    signals.push("hono in dependencies");
  } else if (pkg === null && (await exists(join(projectRoot, "index.html")))) {
    detected = "static-site";
    signals.push("index.html without package.json");
  }

  let packageManager: InspectReport["packageManager"] = null;
  for (const [file, name] of LOCKFILES) {
    if (await exists(join(projectRoot, file))) {
      if (packageManager) warnings.push(`Multiple package-manager lockfiles found (${packageManager.lockfile}, ${file}).`);
      packageManager ??= { name, lockfile: file };
    }
  }

  const bahama: InspectReport["bahama"] = {
    manifestPresent: await exists(join(projectRoot, MANIFEST_FILENAME)),
    manifestValid: null,
    lockPresent: await exists(join(projectRoot, LOCK_FILENAME)),
    error: null,
  };
  if (bahama.manifestPresent) {
    try {
      await loadManifest(projectRoot);
      await loadLock(projectRoot);
      bahama.manifestValid = true;
    } catch (error) {
      bahama.manifestValid = false;
      bahama.error = error instanceof Error ? error.message : String(error);
    }
  }

  const files = await collectSourceFiles(projectRoot);
  const envVarNames = await scanEnvVarNames(projectRoot, files);
  const sourceFingerprint = await fingerprintFiles(projectRoot, files);

  return {
    projectRoot,
    framework: { detected, signals },
    packageManager,
    scripts: (pkg?.scripts as Record<string, string> | undefined) ?? {},
    envVarNames,
    providerMetadata: { vercelLinked: await exists(join(projectRoot, ".vercel", "project.json")) },
    migrationsDir: (await exists(join(projectRoot, "migrations"))) ? "migrations" : null,
    bahama,
    sourceFingerprint,
    warnings,
  };
}

/**
 * Provider config files that can create resources or change routing through
 * an otherwise-routine redeploy (`vercel.json` crons/rewrites, wrangler
 * config). The classifier compares these hashes against the last successful
 * deploy's receipt; a change downgrades the deploy to consequential.
 */
export const PROVIDER_CONFIG_FILES = ["vercel.json", "wrangler.toml", "wrangler.jsonc", "netlify.toml"];

export async function providerConfigFingerprints(projectRoot: string): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const file of PROVIDER_CONFIG_FILES) {
    try {
      const contents = await readFile(join(projectRoot, file));
      fingerprints[file] = `sha256:${sha256Hex(contents).slice(0, 16)}`;
    } catch {
      // absent is a valid state; absence vs presence is itself a change
    }
  }
  return fingerprints;
}

async function collectSourceFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (IGNORED_SOURCE_FILES.has(entry.name) && dir === projectRoot) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        files.push(relative(projectRoot, full));
      }
    }
  }
  await walk(projectRoot);
  return files.sort();
}

async function scanEnvVarNames(projectRoot: string, files: string[]): Promise<string[]> {
  const names = new Set<string>();
  const pattern = /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)/g;
  const sourceExts = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  for (const file of files) {
    if (!sourceExts.test(file)) continue;
    try {
      const text = await readFile(join(projectRoot, file), "utf8");
      for (const match of text.matchAll(pattern)) names.add(match[1]!);
    } catch {
      // unreadable file: skip
    }
  }
  return [...names].sort();
}

async function fingerprintFiles(projectRoot: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(join(projectRoot, file));
      parts.push(`${file.split(sep).join("/")}:${info.size}:${Math.floor(info.mtimeMs)}`);
    } catch {
      // raced deletion: skip
    }
  }
  return `sha256:${sha256Hex(parts.join("\n")).slice(0, 16)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
