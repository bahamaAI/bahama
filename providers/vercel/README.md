# Vercel provider

Official bundled provider for deploying Next.js, Vite, and static applications into a user's Vercel account.

Use Vercel when the application fits its supported frontend frameworks and the user wants Vercel to own the project and production environment. Choose another provider for unsupported runtimes or a fully managed Bahama Cloud stack.

## What it manages

- Roles: application and environment
- Frameworks: `nextjs`, `vite-spa`, and `static-site`
- Operations: project create or adoption, account selection, production-variable transfer, deployment, and readiness verification
- Output: verified production URL
- Input: production environment variables
- Requirement: a Vercel account and the official `vercel` CLI

The [descriptor](./src/index.ts) is the authoritative agent-facing capability definition.

## Provider documentation

- [Vercel CLI overview](https://vercel.com/docs/cli)
- [Vercel CLI global options](https://vercel.com/docs/cli/global-options)
- [Deploying from the CLI](https://vercel.com/docs/cli/deploying-from-cli)
- [Environment variables](https://vercel.com/docs/environment-variables)
- [Vercel REST API](https://vercel.com/docs/rest-api)

## Development

```bash
npx vitest run providers/vercel
npm run build -w @bahama/provider-vercel
npm run lint
```

This provider is bundled with `bahama` and is not published separately.
