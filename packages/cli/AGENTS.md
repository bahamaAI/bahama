# CLI agent guide

These instructions apply to `packages/cli` in addition to the repository-root `AGENTS.md`. This package owns the public `bahama` command-line experience; its supported interface is the binary and its result envelopes, not the exports in `src/index.ts`. `README.md` documents the public contract (commands, envelope statuses, exit codes); this file governs how to change it.

## Responsibilities

- `src/bin.ts` defines commands, arguments, and options.
- `src/runtime.ts` owns the static official-provider registry, engine construction, result emission, and exit-code mapping.
- `src/render.ts` renders human output from the same `ResultEnvelope` emitted by `--json`.
- `src/plan-shared.ts` converts planner outcomes into CLI workflow states.
- `src/cloud-auth.ts` owns the protected Bahama Cloud OAuth credential store, refresh locking, and token rotation.
- `src/commands/*` implements command workflows. Keep Commander registration thin and put behavior here.

The CLI orchestrates core and providers; it does not duplicate their validation, planning, classification, execution, or status logic. Official providers are registered statically. Do not add provider-specific branches outside registry, auth delegation, or genuinely provider-owned credential supply.

## Request flow

```text
src/bin.ts
  → src/commands/*
  → core planner/executor
  → selected provider drivers
  → ResultEnvelope
  → renderHuman or JSON
```

Start at `bin.ts` for the public command, follow the matching command workflow, then cross into core or a provider only where that workflow delegates. The published CLI bundles core, provider-kit, and official providers into `dist/bin.js`; their separate workspaces are source and test boundaries, not additional runtime packages.

Adding or changing a command: register in `src/bin.ts` → workflow in `src/commands/*` → one `ResultEnvelope` rendered by `src/render.ts` → golden-path test in `test/cli.test.ts` → update `skills/bahama` if agent-visible behavior changed.

## Command contracts

- Every completed command emits exactly one `ResultEnvelope`. Human and JSON modes consume the same object; never build a second result in the renderer.
- `succeeded`, `decision_required`, `installation_required`, `auth_required`, `approval_required`, and `in_progress` are workflow states. Only `failed` is an operational failure.
- Exit codes are part of the interface: workflow states `0`, provider/operation failure `1`, invalid invocation or manifest `2`, internal failure `3`.
- Stdout is the result channel. Verbose, redacted diagnostics belong on stderr.
- Result messages are agent UX. Include the concrete next action in the envelope instead of relying on prose printed elsewhere.
- Provider discovery is progressive: the unfiltered agent view stays compact; `providers <id>` carries the descriptor's complete use/avoid, requirements, and capability guidance.
- `plan` is read-only and always stops for review. `deploy` may auto-apply only when core classifies every compiled step as routine.
- Never accept a flag that turns `deploy` into an approval bypass.

## Authentication boundary

Normal commands never wait on a TTY or start a login. `bahama auth login|logout` is the deliberate exception: it may delegate to an official provider-owned interactive flow and must verify the resulting session afterward. Preserve `--no-browser` behavior for headless agents.

Third-party credentials remain in their official CLI stores. Bahama Cloud credentials are CLI-owned, mode-`0600`, refreshed behind a file lock, and supplied to core as raw values only long enough for immediate sealing. Never expose tokens through command output or provider inputs.

## Change rules

- A command, status, envelope, or exit-code change requires CLI golden-path tests (`test/cli.test.ts`).
- A human-output change requires `test/render.test.ts`; a JSON-contract change requires CLI assertions against the envelope.
- An OAuth/storage/refresh change requires `test/cloud-auth.test.ts` and must preserve concurrent refresh safety.
- A provider registration change must update setup/provider output and the `bahama` skill.
- Do not describe internal exports as a supported embedding API.

## Verification

From the repository root:

```bash
npm run build -w bahama
node packages/cli/dist/bin.js --help
npx vitest run packages/cli
npm run lint
```

For workflow changes, also run the complete test suite because CLI behavior spans core and every bundled provider:

```bash
npm test
```
