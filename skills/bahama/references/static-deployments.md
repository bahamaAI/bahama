# Static Deployments

Use this file for `static-site`, `static-bundle`, and `vite-spa`.

This guidance applies when `application.provider: bahama-cloud`. These frameworks serve static assets through Bahama. They do not run user-authored backend code. If the app needs a database, server-side secret, webhook, provider API call, or custom `/api/*` route, use `vite-hono` or `hono-api` instead.

## Choose The Framework

- `static-site`: Use for raw browser-ready HTML/CSS/JS with no install and no build step.
- `static-bundle`: Use for already-built deployable assets, usually with `index.html` at root, `dist/`, `build/`, or `public/`.
- `vite-spa`: Use for Vite-built frontend apps that run entirely in the browser.

Use `vite-spa` for React, Vue, Svelte, Preact, Solid, or vanilla Vite apps when no backend is needed. For React, use Vite.

## Static Site

Use `static-site` when the source is already deployable as plain files.

Required:

- root `index.html`
- any referenced CSS, JS, images, fonts, and assets

Do not include:

- `package.json` only for a build step
- `node_modules/`
- `dist/` as generated clutter
- `server/index.*`
- private env files or credentials

Routing is normal static-site routing. Missing paths should not be treated as app routes.

## Static Bundle

Use `static-bundle` when another tool already produced non-SPA deployable output and Bahama should not install dependencies or run a build.

Acceptable asset roots:

- root `index.html`
- `dist/index.html`
- `build/index.html`
- `public/index.html`

Deploy the built output, not the source-only project. Do not include source directories unless they are part of the deployed asset output.

Use this when a build has already run locally or in another tool and the user wants to deploy that exact output. For client-routed SPA output, prefer deploying source as `vite-spa` unless Bahama adds a dedicated static SPA bundle framework.

## Vite SPA

Use `vite-spa` for frontend-only Vite apps.

Required:

- `package.json`
- one lockfile: `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`
- root `index.html`
- `src/`
- Vite dependency
- build script

Bahama installs dependencies and runs the build. The build must produce `dist/index.html`.

Rules:

- Keep the app entry in `src/`.
- Keep browser routing inside the Vite app.
- Do not add `server/index.*`; use `vite-hono` if backend routes are needed.
- Do not import server-only runtime packages from frontend files.
- Do not put provider keys, database values, Bahama dev tokens, or secrets in `VITE_*` variables.
- Use browser-safe public config only.

## SPA Behavior

An SPA is a browser app that serves one `index.html` and lets client-side JavaScript handle routes such as `/settings` or `/notes/123`.

Use `vite-spa` when the app needs this client-side route fallback. Do not use SPA fallback for normal `static-site` or `static-bundle` deployments.

## Packaging Notes

`bahama deploy` packages the project for you. For `static-site` and `static-bundle`, the deployable files ship directly. For `vite-spa`, source and build configuration ship and Bahama builds; do not prebuild.

Never part of the deployable app:

- `node_modules/`
- `.git/`
- `.env*`
- `.bahama/`
- `coverage/`
- logs
- OS metadata such as `.DS_Store` and `__MACOSX/`
- any other files that are not part of the source
