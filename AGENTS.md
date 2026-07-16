# AGENTS.md

Coding guide for the Bahama monorepo. `README.md` explains the product and contribution workflow. Nested `AGENTS.md` files add package-specific rules.

## Product boundary

Bahama turns a project's declarative intent (`bahama.yaml`) into deterministic, approved, verified provider operations; `README.md` tells the full product story.

**The model decides; Bahama executes.** Do not add an LLM, hidden provider ranking, or autonomous product choices to the CLI. Bahama Cloud is first-party, but it uses the same orchestration contract as every other provider.

This public repository must work without private sibling repositories. The Bahama Cloud control plane and deployer are separate systems.

## Monorepo map

- `packages/provider-kit` — provider contract and injected execution context.
- `packages/core` — internal planning, approval, execution, state, and secret engine.
- `packages/cli` — the published `bahama` binary, provider registry, auth, and rendering.
- `packages/runtime` — published server-side runtime bridge for native and local Bahama Cloud resources.
- `providers/bahama-cloud` — managed static, Vite, Hono, and D1 support.
- `providers/vercel` — Vercel application environments through its official CLI.
- `providers/neon` — Neon Postgres and checked-in SQL migrations.
- `providers/local` — protected local environment-file bindings.
- `providers/test` — deterministic contract-test provider; enabled only by `BAHAMA_ENABLE_TEST=1`.
- `skills/bahama` — operating guide for user-facing coding agents; its prose is product behavior.

## Architecture rules

- Dependency direction is `cli -> core -> provider-kit`.
- Providers import only `provider-kit`, never core, CLI, or another provider.
- Providers connect through capabilities and bindings, never pairwise integration code.
- Core contains no provider-specific behavior. Official providers are registered statically in CLI.
- The runtime package is a leaf: no dependency on CLI, core, provider-kit, or providers.

The npm surface is intentionally small: `bahama` and `bahama-runtime`. Internal workspaces use the private `@bahama/*` namespace for source composition only. The CLI artifact bundles core, provider-kit, and the official providers; do not make an internal workspace publishable merely to satisfy a build import.

## Project state

- `bahama.yaml` — committed user intent; never resolved IDs or secrets.
- `bahama.lock` — committed CLI-owned identities and binding edges; never hand-edited.
- `.bahama/` — gitignored plans, receipts, and operation locks.
- Credentials — never in the repo; provider-owned stores or Bahama's protected store only. Local secret values exist only through an explicit `local` binding.

## Safety invariants

- `probe` and `plan` are read-only and non-interactive.
- Plans are deterministic, content-addressed, and revalidated before apply.
- Providers declare effects; core classifies them. Unknown mutations require approval.
- A step succeeds only after its live postcondition is verified.
- Resume applies only to unfinished work; a completed plan is not a permanent cache.
- Never bypass approval, account choice, repository identity, plan integrity, operation locking, redaction, or verification.
- Every command returns one `ResultEnvelope`; human and JSON output render the same result.

## Security for contributors

- Never commit credentials, private keys, tokens, connection strings, real user data, or unredacted provider responses.
- Authorized live tests may use existing sessions or protected secrets. Keep values out of output, argv, chat, issues, and fixtures.
- Providers use `ProviderContext` for external CLIs, HTTP, secrets, and credentials. They do not read credential files or spawn processes directly.
- Secret values are sealed at capture and never enter manifests, plans, locks, receipts, journals, logs, errors, or status output.
- Keep database access, provider credentials, development tokens, and native bindings server-side.
- Treat manifests, provider responses, archives, paths, and repository contents as untrusted input.
- Preserve schema checks, path containment, size limits, archive exclusions, and argument-array subprocesses.

## Engineering conventions

- TypeScript strict mode, ESM, npm workspaces, and project references.
- Use Zod for untrusted input and serialized documents. Core leaves provider `config` open; each provider validates its own block.
- Persisted and returned data must be JSON-compatible. Secret values travel only as non-serializable `SecretRef` handles at runtime.
- Provider subprocesses go through `ctx.run`; never import `node:child_process` or `execa` in a provider.
- Errors say what failed and give a real recovery action when one exists. Never invent commands.
- Preserve unrelated user changes and avoid generated-file or formatting churn.
- Do not hardcode test counts, dated readiness claims, or local machine paths in committed guidance.

## Change checklist

- `provider-kit` changes require contract review, test coverage, and affected-provider tests.
- Behavior changes require a regression test; behavior-preserving refactors do not need ceremonial tests.
- Provider changes keep tests, descriptor prose, capabilities, and the skill synchronized.
- CLI workflow changes cover both JSON envelopes and human rendering, and update the skill when agent behavior changes.
- New frameworks and capabilities must work end to end: validation, planning, execution, verification, tests, provider prose, and skill guidance.
- Do not edit generated `dist/`; builds recreate it and Git ignores it.

## Verification

Node.js `20.19+`.

```bash
npm install
npm run build        # focused: npm run build -w <package>
npm test             # focused: npx vitest run <path>
npm run typecheck
npm run lint
npm run version:check
```

Use focused tests while iterating, then run the full relevant suite. For end-to-end checks without live accounts, use the internal test provider (`BAHAMA_ENABLE_TEST=1`; see `providers/test/README.md`). Live-provider tests may create billable resources and require explicit authorization.

GitHub CI runs the clean install, version check, build, tests, typecheck, lint,
and public-package previews on pull requests and pushes to `main`. Do not weaken
CI to make a change pass. npm publishing is a separate, release-only workflow:
set versions with `npm run version:set -- <version>`, verify them, and publish a
matching GitHub Release. Only `bahama` and `bahama-runtime` are published.
