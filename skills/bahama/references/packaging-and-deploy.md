# Packaging And Deploy

Use this file before deploying or troubleshooting deployment failures.

This guidance applies when the target environment uses `provider: bahama-cloud`. The CLI owns packaging, upload, and status polling — do not build archives, request upload URLs, or PUT files by hand.

## Deploy Flow

1. Confirm `bahama.yaml` names the intended project and framework.
2. Confirm the project tree matches the framework contract in the selected reference file.
3. Reconcile infrastructure with `bahama plan --json`, present consequential steps and accounts, then apply the approved plan. This does not deploy code.
4. Deploy explicitly with `bahama deploy <environment> --json`. The first deploy requires approval; later code-only deploys can use the routine fast path.
5. Check the result envelope. `succeeded` means postconditions were verified against live provider state. Use `bahama status --json` to re-check afterwards.

## Source Hygiene

The CLI packages from the project tree, so keep the tree clean. The archive should contain the project root contents, not a wrapper directory — work from the repo root.

**Deploy only what the site needs to work.** For `static-site` and `static-bundle`, everything in the archive becomes a public URL — docs, notes, configs, and source files included by accident are published to the internet. Before deploying, look at what is in the tree and make sure only the files the running site actually needs will ship, plus anything unusual the app requires to work. When the deployable assets live next to other repo files, put them in a dedicated directory and set `application.dir` in `bahama.yaml` so only that directory is packaged.

The CLI always refuses to package `bahama.yaml`, `bahama.lock`, `.bahama/`, `.env*`, `.npmrc`, `node_modules/`, and `.git/` — but that denylist is a backstop, not a substitute for keeping the archive minimal.

Never part of the deployable app:

- `node_modules/`
- `.git/`
- `.env*`
- `.npmrc` or other credential-carrying dotfiles
- `.bahama/`
- `coverage/`
- logs
- `.DS_Store`
- `__MACOSX/`
- editor temp files
- screenshots, recordings, exports, notes, or local experiments that are not part of the app
- large unreferenced local assets

Never include dev tokens or raw secrets in the project tree.

## Framework-Specific Packaging

`static-site`:

- root `index.html` and referenced assets ship directly, and every archived file is served publicly
- keep assets in a dedicated directory and set `application.config.dir` to it whenever the repo contains anything else
- no install or build step
- no `server/index.*`

`static-bundle`:

- already-built deployable output ships directly
- `index.html` must be at root, `dist/`, `build/`, or `public/`
- no install or build step
- no `server/index.*`

`vite-spa`:

- source and build config ship: `package.json`, one lockfile, root `index.html`, `src/`, and Vite config when used
- local `dist/` is not deployed
- Bahama builds to `dist/index.html`

`vite-hono`:

- Vite frontend source and `server/index.*` ship: `package.json`, one lockfile, root `index.html`, `src/`, and server modules
- local `dist/` is not deployed
- Bahama builds frontend assets and bundles Hono

`hono-api`:

- `package.json`, one lockfile, `server/index.*`, and server modules ship
- no static frontend assets required
- Bahama bundles Hono

## Status And Troubleshooting

`bahama deploy` polls until the deploy is terminal when possible. If polling misses the final update, do not assume the deploy failed; run `bahama status --json` again later.

Common failure meanings:

- `invalid_upload`: archive shape is wrong, missing required files, unsafe paths, or wrong framework
- `unsupported_framework`: unsupported dependency or backend shape, such as `server/index.*` in a static deployment
- `unsupported_package_manager`: missing supported lockfile
- `dependency_install_failed`: package install failed in the sandbox
- `build_failed`: Vite build or Hono bundle failed
- `deploy_failed`: publish failed inside Bahama deployer
- `smoke_test_failed`: deploy published but live route did not pass readiness checks

When a deploy fails, inspect the failure details in the result envelope and fix the source contract first. Do not switch frameworks casually to bypass a contract error.
