# Provider agent guide

These instructions apply to every provider in this directory in addition to the repository-root `AGENTS.md`. Each provider is a separate source and test boundary bundled into the published CLI, not an independently installed package.

## Provider contract

- Providers import only `@bahama-ai/provider-kit`, never core, CLI, another provider, or unrestricted process APIs.
- `descriptor` is agent-facing product behavior. Keep roles, compatibility, requirements, capabilities, and use/avoid guidance exact.
- Each provider validates its own intent `config`; core deliberately leaves that block provider-owned.
- `probe` and `plan` are read-only and non-interactive. Return typed requirements or decisions instead of prompting or guessing.
- `execute` performs one planned step and reports success only after its live postcondition is verified.
- `status` reads authoritative provider state and reports normalized existence, health, and drift.
- Providers connect through capabilities and bindings. Never add provider-pair logic.
- External commands, HTTP, credentials, secrets, logging, and cancellation go through `ProviderContext`.
- Secret values must be captured and sealed before ordinary driver code can observe them.

## Change discipline

- Keep implementation, descriptor prose, realistic redacted fixtures, and the `bahama-builder` skill synchronized.
- Preserve durable account and resource IDs. Never depend on a CLI's implicit account or local project link when the plan or lock specifies one.
- Parse external responses in small helpers and add the real redacted shape as a fixture when a provider changes.
- A new action needs semantic effects, deterministic inputs, a stated postcondition, execution coverage, and status behavior.
- Do not add framework, engine, or capability claims until planning, execution, verification, tests, and skill guidance agree.

## Verification

From the repository root:

```bash
npx vitest run providers/<provider>
npm run build -w @bahama-ai/provider-<provider>
npm run lint
```

Run `npm test` when a change affects shared capabilities, step semantics, account selection, secrets, or CLI workflow.
