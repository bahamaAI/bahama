# Neon provider

Official bundled provider for provisioning Postgres in a user's Neon account and applying checked-in SQL migrations.

Use Neon when the application needs a standard Postgres connection string. Choose another provider when the project requires a different database engine or uses the native database included with Bahama Cloud.

## What it manages

- Role: database
- Engine: `postgres`
- Operations: organization selection, project create or adoption, sealed connection-string capture, and ordered SQL migrations
- Output: secret `connectionUrl`
- Requirement: a Neon account and the official `neon` CLI

The [descriptor](./src/index.ts) is the authoritative agent-facing capability definition.

## Provider documentation

- [Neon provider guide](https://www.bahama.ai/docs/providers/neon)
- [Neon CLI overview](https://neon.com/docs/reference/neon-cli)
- [Neon CLI authentication](https://neon.com/docs/reference/cli-auth)
- [Managing organizations with the Neon CLI](https://neon.com/docs/manage/orgs-cli)
- [Neon CLI project commands](https://neon.com/docs/reference/cli-projects)

## Development

```bash
npx vitest run providers/neon
npm run build -w @bahama/provider-neon
npm run lint
```

This provider is bundled with `bahama` and is not published separately.
