# Building and deploying on Bahama Cloud

Read this file only when a Bahama Cloud environment is selected and the task creates, changes, packages, or deploys its application.

## Choose a supported shape

Use the framework identifier returned by `bahama providers bahama-cloud --format agent`.

| Framework | Contract |
| :-- | :-- |
| `static-site` | Browser-ready files with `index.html` at the archive root. No install, build, backend, or SPA fallback. |
| `static-bundle` | Prebuilt files with `index.html` at the root or in `dist/`, `build/`, or `public/`. No install, build, backend, or SPA fallback. |
| `vite-spa` | Browser-only Vite app. Bahama installs, builds to `dist/index.html`, and enables SPA fallback. |
| `vite-hono` | Vite frontend plus a Hono backend for `/api/*`. Bahama builds both and enables SPA fallback. |
| `hono-api` | Hono backend without frontend assets. Bahama installs dependencies and bundles the backend. |

Vite deployments require `package.json`, a `vite` dependency, a build script, and a supported lockfile: `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`. The source layout may vary, but the build must produce `dist/index.html`.

Hono deployments require `package.json`, a `hono` dependency, one supported lockfile, and `server/index.ts`, `.tsx`, `.mts`, `.js`, or `.mjs`. `hono-api` does not require frontend files or an application build script.

Anything in `VITE_*` is browser-visible. Keep credentials, database access, project secrets, and development tokens in server code.

## Write a deployable Hono entry

Export the Hono app; do not start a Node server:

```ts
import {Hono} from "hono";

const app = new Hono();
app.get("/api/status", (c) => c.json({ok: true}));

export default app;
```

Bahama reserves `/api/health` for deployment verification. In `vite-hono`, other `/api/*` requests reach the Hono app and all other requests use the frontend. In `hono-api`, requests go directly to the Hono app.

Do not import `@hono/node-server`, call `serve`, use `serveStatic`, depend on the production filesystem, or assume a long-running process in `server/index.*`. Put any Node-only local adapter in a separate file.

## Let Bahama package the source

Run deployments through the CLI; do not create a ZIP or call upload endpoints directly:

```bash
bahama deploy production
```

The CLI packages the application directory, uploads it, waits for the deployment, and verifies the live result. Set `application.dir` when the deployable app is only one directory in a larger repository.

Bahama excludes its manifest, lock, local operation state, env files, package-manager credentials, dependencies, and Git metadata. Symlinks are not packaged. Local `dist/` is ignored except for `static-bundle`, which intentionally deploys prebuilt output. The final archive must be 25 MB or smaller.

For `static-site`, every packaged file is public. The same is true for a `static-bundle` whose asset root is the archive root. Keep unrelated files outside the application directory.

Deployment errors identify whether archive validation, framework or package-manager support, dependency installation, build, publication, or the live smoke test failed. Bahama records the accepted job before polling. If polling times out or is interrupted, keep the source unchanged and rerun the returned `bahama apply <plan-id>` command; it continues watching that job without uploading again. If the job reports a terminal source failure, fix the source first—the changed source makes the resumed plan submit a new job. Run `bahama status --json` whenever live state remains unclear.
