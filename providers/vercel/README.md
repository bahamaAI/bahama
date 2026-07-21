# Vercel provider

Official bundled provider for deploying a deliberately verified subset of Vercel application shapes into a user's account.

Use Vercel when the application fits this provider's supported shapes and the user wants Vercel to own the project and production environment. Vercel itself supports more frameworks than Bahama currently models; the list below is the lifecycle this driver plans, executes, and verifies.

## What it manages

- Roles: application and environment
- Frameworks: `nextjs`, `vite-spa`, `vite-hono`, `hono-api`, and `static-site`
- Operations: project create or adoption, account selection, production-variable transfer, deployment, and readiness verification
- Output: verified production URL
- Input: production environment variables
- Requirement: a Vercel account and the official `vercel` CLI v51 or newer

The [descriptor](./src/index.ts) is the authoritative agent-facing capability definition.

Bahama keeps the portable application shape separate from Vercel's native project preset. Both `vite-spa` and `vite-hono` use Vercel's `vite` preset; `hono-api` uses `hono`. A Vite + Hono repository must already satisfy Vercel's Hono entry or function-routing conventions. This provider does not generate provider-specific entry files or rewrite source.

`vite-hono` and `hono-api` require `config.healthPath` to name a public backend route that returns HTTP 2xx or 3xx. Other shapes default to `/`. This makes readiness verification prove the server path rather than merely proving that a Vite frontend loaded.

Deployment submission and readiness are separate journaled steps. Once Vercel accepts source, Bahama records the immutable deployment id; if polling or verification fails, rerunning the same apply continues watching that deployment instead of submitting another one.

## Provider documentation

- [Vercel CLI overview](https://vercel.com/docs/cli)
- [Vercel CLI global options](https://vercel.com/docs/cli/global-options)
- [Deploying from the CLI](https://vercel.com/docs/cli/deploying-from-cli)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)
- [Environment variables](https://vercel.com/docs/environment-variables)
- [Vercel REST API](https://vercel.com/docs/rest-api)

## Development

```bash
npx vitest run providers/vercel
npm run build -w @bahama/provider-vercel
npm run lint
```

This provider is bundled with `bahama` and is not published separately.
