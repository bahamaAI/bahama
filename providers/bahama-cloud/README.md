# Bahama Cloud provider

Official bundled provider for managed static, Vite, and Hono applications, with an optional native SQL database.

Use Bahama Cloud for the managed Bahama path. Choose another provider when the application uses an unsupported framework such as Next.js or requires a directly addressable database connection string.

## What it manages

- Roles: application, environment, and database
- Frameworks: `static-site`, `static-bundle`, `vite-spa`, `vite-hono`, and `hono-api`
- Database engine: `d1`
- Outputs: verified production URL and optional local-development access
- Inputs: server-side application variables
- Requirement: a Bahama account; no additional provider CLI

Deployment acceptance and readiness are separate steps. The accepted job ID is
journaled before polling so an interrupted apply resumes the same job instead
of uploading and submitting another deployment.

The [descriptor](./src/index.ts) is the authoritative agent-facing capability definition.

## Documentation

- [Bahama Cloud provider guide](https://www.bahama.ai/docs/providers/bahama-cloud)
- [Local development](https://www.bahama.ai/docs/guides/local-development)
- [Bahama Runtime](../../packages/runtime/README.md)

## Development

```bash
npx vitest run providers/bahama-cloud
npm run build -w @bahama/provider-bahama-cloud
npm run lint
```

This provider is bundled with `bahama` and is not published separately.
