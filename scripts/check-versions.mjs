/* global console, process */

import path from "node:path";
import {
  dependencyFields,
  readJson,
  readWorkspacePackages,
  root,
} from "./workspace-packages.mjs";

const expectedFromTag = process.argv[2]?.replace(/^v/, "");
const rootManifest = await readJson(path.join(root, "package.json"));
const expected = expectedFromTag ?? rootManifest.version;
const workspaces = await readWorkspacePackages();
const workspaceNames = new Set(workspaces.map(({ manifest }) => manifest.name));
const problems = [];

if (rootManifest.version !== expected) {
  problems.push(`root package version is ${rootManifest.version}, expected ${expected}`);
}

for (const { file, manifest } of workspaces) {
  if (manifest.version !== expected) {
    problems.push(`${path.relative(root, file)} is ${manifest.version}, expected ${expected}`);
  }

  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (workspaceNames.has(name) && version !== expected) {
        problems.push(
          `${path.relative(root, file)} has ${field}.${name}=${version}, expected ${expected}`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`Workspace version check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

console.log(`All workspace versions and internal references match ${expected}.`);
