# Local development provider

Official bundled provider for materializing declared resource bindings into a protected local environment file.

Use it when an application should access provisioned resources during normal local development. Do not target it with values that must exist only in a hosted environment.

## What it manages

- Role: environment
- Operation: write explicitly bound scalar values into a repository-contained environment file
- Input: environment variables
- Safety: preserves unrelated values, adds the file to `.gitignore`, and applies restrictive permissions
- Requirements: none

The [descriptor](./src/index.ts) is the authoritative agent-facing capability definition.

## Documentation

- [Local development guide](https://www.bahama.ai/docs/guides/local-development)
- [Bahama Runtime](../../packages/runtime/README.md)

## Development

```bash
npx vitest run providers/local packages/cli
npm run build -w @bahama/provider-local
npm run lint
```

This provider is bundled with `bahama` and is not published separately.
