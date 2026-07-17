# Provider-kit agent guide

These instructions apply to `packages/provider-kit` in addition to the repository-root `AGENTS.md`. This workspace defines Bahama's provider-authoring contract. It is public source but is not published separately while the CLI supports only a static bundled provider registry. Treat changes as high-impact because every provider and the engine depend on the contract.

## Responsibilities

- `descriptor.ts` describes roles, compatibility, requirements, capabilities, and model-facing provider guidance.
- `capabilities.ts` defines provider-neutral outputs, inputs, binding edges, and canonical addresses.
- `driver.ts` defines resource intent, live probes, provider accounts, the four driver verbs, status, and the `defineProvider` helper.
- `steps.ts` defines provider-contributed steps, semantic effects, compiled steps, execution inputs, and verified outcomes.
- `context.ts` defines the complete authority injected into providers: subprocess, HTTP, secrets, credentials, logging, and cancellation.
- `secrets.ts` defines opaque `SecretRef` handles and the broker contract.
- `results.ts` defines typed CLI workflow states, requirements, decisions, and result envelopes.
- `json.ts` defines the serialized data vocabulary.

Provider-kit contains contracts only. It must not import core, CLI, a provider implementation, Node process-spawning APIs, or a provider SDK. Keep its runtime dependency surface small and environment-neutral.

## Contract rules

- Descriptor prose is machine-facing product behavior. `description`, `useWhen`, `avoidWhen`, requirements, frameworks, engines, and capabilities must be precise enough for a model to choose correctly.
- Capabilities are provider-neutral. Do not name another provider in a capability or add pairwise integration types.
- Providers declare semantic effects; they never declare routine/consequential classification.
- `probe` and `plan` are read-only. `execute` performs one planned step and verifies its postcondition. `status` reports authoritative live state, normalized health with a reason, and drift.
- Persisted and returned provider data is JSON-compatible. `SecretRef` is the explicit opaque exception for secret capability values.
- `ProviderContext` is the complete provider authority boundary. Additions are security- and compatibility-sensitive.
- Decisions describe a meaningful unresolved choice and, when possible, provide a manifest `writeBack` path. Requirements describe installation or authentication work; neither is an exception.
- `ProviderPlanError` is only for an expected provider-owned condition that prevents compilation. Do not wrap programming errors or unexpected exceptions in it.
- A successful `StepOutcome` must be safe to journal and must set `postconditionVerified` only after a live check.
- `defineProvider` is a type-shaping helper, not registration. The current CLI bundles a static official-provider registry.

## Contract discipline

- Avoid unnecessary renames or removals. When a breaking change is necessary, update core, the test contract suite, every official provider, and the skill in the same change.
- Prefer adding optional fields with explicit semantics over widening objects to untyped data.
- Do not expose core implementation types through this package.
- Comments on exported types are public documentation and should explain security and lifecycle consequences, not restate TypeScript syntax.
- A new effect, status, role, context capability, or secret operation requires test-provider contract coverage and review of all official providers.

## Verification

From the repository root:

```bash
npm run build -w @bahama/provider-kit
npx vitest run providers/test providers/vercel providers/neon providers/bahama-cloud
npm run lint
```

Run the complete suite for any contract or behavioral semantics change:

```bash
npm test
```
