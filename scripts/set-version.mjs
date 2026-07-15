/* global console, process */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  dependencyFields,
  readJson,
  readWorkspacePackages,
  root,
} from "./workspace-packages.mjs";

const version = process.argv[2]?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run version:set -- <version>");
  process.exit(1);
}

const rootFile = path.join(root, "package.json");
const rootManifest = await readJson(rootFile);
const workspaces = await readWorkspacePackages();
const workspaceNames = new Set(workspaces.map(({ manifest }) => manifest.name));

async function updateManifest(file, manifest) {
  let source = await readFile(file, "utf8");
  source = source.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  );

  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!workspaceNames.has(name)) continue;
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      source = source.replace(
        new RegExp(`("${escapedName}"\\s*:\\s*")[^"]+(")`),
        `$1${version}$2`,
      );
    }
  }

  await writeFile(file, source);
}

await updateManifest(rootFile, rootManifest);
for (const { file, manifest } of workspaces) {
  await updateManifest(file, manifest);
}

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--package-lock-only", "--ignore-scripts"],
  { cwd: root, stdio: "inherit" },
);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Set every workspace and internal reference to ${version}.`);
