import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@bahama-ai/provider-kit";
import { atomicWriteFile } from "./fs-util.js";

/**
 * OS-native global configuration. Non-secret preferences only — credentials
 * have their own storage policy (keyring → 0600 file → env) and never live
 * in this file.
 */
export function configDir(): string {
  const override = process.env["BAHAMA_CONFIG_DIR"];
  if (override) return override;
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "bahama");
    case "win32":
      return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "bahama");
    default:
      return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "bahama");
  }
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function readConfig(): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as JsonObject;
  } catch {
    return {};
  }
}

export async function writeConfig(config: JsonObject): Promise<void> {
  await atomicWriteFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 0o600);
}
