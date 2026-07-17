import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const external = ["commander", "execa", "fflate", "pg", "semver", "yaml", "zod"];
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/bin.js",
  define: { __BAHAMA_VERSION__: JSON.stringify(manifest.version) },
  external: external.flatMap((name) => [name, `${name}/*`]),
  legalComments: "external",
  logLevel: "info",
});
