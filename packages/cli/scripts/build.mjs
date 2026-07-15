import { build } from "esbuild";

const external = ["commander", "execa", "fflate", "pg", "semver", "yaml", "zod"];

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/bin.js",
  external: external.flatMap((name) => [name, `${name}/*`]),
  legalComments: "external",
  logLevel: "info",
});
