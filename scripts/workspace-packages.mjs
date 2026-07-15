import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const workspaceRoots = ["packages", "providers"];
export const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readWorkspacePackages() {
  const packages = [];

  for (const directory of workspaceRoots) {
    const parent = path.join(root, directory);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(parent, entry.name, "package.json");
      const manifest = await readJson(file);
      packages.push({ file, manifest });
    }
  }

  return packages;
}
