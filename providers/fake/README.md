# Fake provider

Deterministic in-repository provider used to specify and test Bahama's provider, planning, execution, binding, and status contracts.

Use it only for development and tests. It is never an infrastructure choice for a real project and appears in the CLI only when `BAHAMA_ENABLE_FAKE=1`.

## What it exercises

- Roles: application, environment, and database
- Simulated installation, authentication, account decisions, resources, bindings, deployments, failures, and drift
- Secret and non-secret capability wiring
- End-to-end planning, approval, apply, resume, detach, and status behavior

The [descriptor](./src/index.ts) and [contract suite](./test/contract.test.ts) together form the executable reference.

## Documentation

- [Provider kit](../../packages/provider-kit/README.md)
- [Provider authoring guide](https://www.bahama.ai/docs/reference/provider-authoring)

## Development

```bash
npx vitest run providers/fake
npm run build -w @bahama-ai/provider-fake
npm run lint
```

This provider is bundled with `@bahama-ai/cli` and is not published separately.
