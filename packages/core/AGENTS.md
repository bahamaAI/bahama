# Core agent guide

These instructions apply to `packages/core` in addition to the repository-root `AGENTS.md`. Core is Bahama's internal safety and execution engine. It remains a separate workspace for architectural clarity and tests, but is bundled into the published CLI rather than released as its own npm package. See the `README.md` for more details.

## Responsibilities

- `manifest.ts`, `lockfile.ts`, and `plan-store.ts` validate and persist the three different state classes. Do not merge their responsibilities.
- `planner.ts` probes providers, validates capabilities, wires cross-provider dependencies, and compiles the deterministic plan.
- `classify.ts` is the only authority for routine versus consequential classification.
- `executor.ts` enforces approval, locking, plan/repository validity, ordered execution, postconditions, receipts, resume, and lock updates.
- `journal.ts` stores redaction-safe operation evidence and deploy baselines.
- `context.ts` creates the constrained `ProviderContext` shared by all drivers.
- `runner.ts`, `http.ts`, `secret-broker.ts`, and `redact.ts` form one secret/redaction boundary.
- `repo.ts`, `inspect.ts`, and `oplock.ts` protect repository identity, provider-config baselines, and concurrent operations.

Core imports `provider-kit` but never a provider or the CLI. Do not add provider IDs, framework-specific behavior, provider commands, or UI rendering here.

## Behavioral invariants

- Planning and probing remain read-only.
- Plan IDs cover the complete plan document; loading revalidates schema and content identity.
- Unknown effects classify as consequential. Providers never choose their own classification.
- An executor success requires `postconditionVerified: true`.
- Receipts from completed applies never suppress a future apply. Resume applies only to an unfinished operation.
- Durable identities enter the lock only after successful verification.
- Secret values are sealed and registered with the shared redactor before driver or error code can observe them.
- Nothing secret may enter a serialized document, logger field, thrown message, or returned receipt.
- Repository mismatch, stale plan, approval requirement, and live operation failure remain distinguishable outcomes.

Do not weaken one invariant to repair another. For example, do not make resume convenient by accepting an unverifiable receipt, and do not make a provider easier to implement by moving provider-specific logic into core.

## Change rules

- Behavioral changes require an executable regression in the relevant core test or `providers/test/test/contract.test.ts`.
- Changes to manifest, lock, plan, journal, or result shapes require deliberate compatibility review. Never silently reinterpret an existing committed file.
- Changes to runner or broker capture order require tests proving that raw secret bytes cannot reach stdout, stderr, errors, logs, or receipts.
- Classification changes require tests for both the newly routine/consequential case and its nearest unsafe counterpart.
- Preserve deterministic ordering and canonical serialization. Equivalent intent and observations must compile to the same plan ID.
- Export additions in `src/index.ts` are internal monorepo composition, not a supported third-party API.

## Verification

From the repository root:

```bash
npm run build -w @bahama/core
npx vitest run packages/core providers/test
npm run lint
```

Run the complete suite for changes to schemas, planner/executor behavior, provider context, classification, or secrets:

```bash
npm test
```
