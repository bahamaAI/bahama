# @bahama/core

Bahama's internal deterministic engine for intent validation, planning, approval, execution, verification, state, resume, and secret-safe provider orchestration.

> **This is an internal workspace, not a published package or supported public API.** Its code is bundled into [`bahama`](https://www.npmjs.com/package/bahama), while the workspace stays separate to preserve the engine boundary and focused tests.

Use:

- [`bahama`](https://www.npmjs.com/package/bahama) to operate Bahama.
- [`bahama-runtime`](https://www.npmjs.com/package/bahama-runtime) inside an application using Bahama Cloud resources.
- [`packages/provider-kit`](../provider-kit) when contributing a provider inside this monorepo.

Do not install or build an external integration directly on `@bahama/core`.

## What core does

```text
bahama.yaml + provider registry
              │
              ▼
        validate intent
              │
              ▼
      probe live providers       read-only
              │
              ▼
       compile exact plan        deterministic + content-addressed
              │
              ▼
 classify routine/consequential  centralized + default-deny
              │
              ▼
       execute approved plan     locked + resumable
              │
              ▼
     verify every postcondition
              │
              ▼
   journal receipts + update lock
```

Core gives every provider a constrained `ProviderContext` containing:

- an argument-array subprocess runner with capture-time redaction;
- a redacting HTTP client;
- an in-memory secret broker that passes opaque handles;
- optional renewable credential supply;
- redacted logging and cooperative cancellation.

Providers declare capabilities, steps, dependencies, postconditions, and semantic effects. Core wires cross-provider edges and decides whether those effects are routine or consequential. Core never imports or knows about a specific provider.

## State model

- `bahama.yaml` contains user intent only.
- `bahama.lock` contains durable resolved identities and applied binding edges.
- `.bahama/plans` contains immutable content-addressed plans.
- `.bahama/operations.ndjson` contains redaction-safe execution receipts and resume evidence.

These boundaries are intentionally separate. In particular, the lock is not a general provider state file and none of these files may contain secret values.

## Safety properties

- Probe and plan are read-only.
- Approval covers the exact validated plan document.
- Unknown mutations require approval.
- Process success is not operation success; the provider must verify its postcondition.
- Interrupted work can resume without treating an earlier completed deployment as permanent cache.
- Repository identity prevents a copied lock from silently controlling the original stack.
- Secret values are sealed and registered with redaction before ordinary driver and error paths can observe them.

These properties are specified by core tests and the test provider's end-to-end contract suite.

## Contributing

Core changes can affect every provider and every CLI workflow. Work in the [Bahama monorepo](https://github.com/bahamaAI/bahama), and read the root `AGENTS.md` plus `packages/core/AGENTS.md` first.

```bash
npm install
npm run build -w @bahama/core
npx vitest run packages/core providers/test
npm run lint
```

Run the complete suite for any change to schemas, planning, classification, execution, provider context, or secrets.

## License

[MIT](https://github.com/bahamaAI/bahama/blob/main/LICENSE)
