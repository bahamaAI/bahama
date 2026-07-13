# AGENTS

Concise coding guide for agents working in this repo. `README.md` has the product narrative; the wider Bahama ecosystem (control plane, deployer, SDK, business context) is mapped in `../bahama/PROJECT.md`.

## What this repo is

The open-source (MIT) Bahama monorepo: the `bahama` CLI and its plan/apply engine. Declarative intent in (`bahama.yaml`, written by the user's coding agent), deterministic verified provider operations out. The CLI contains no LLM and no provider ranking — **the model decides, the CLI executes.**

Related but *not* in this repo: the Bahama Cloud control plane (`../bahama`, Next.js — OAuth issuer, project APIs, deploy jobs), the sandbox build pipeline (`../sandbox-deployer`), and the runtime SDK (`../bahama-sdk`). The `bahama-cloud` provider here talks to the control plane over REST + OAuth only.

## Layout and dependency rules

```text
packages/provider-kit   @bahama-ai/provider-kit — the PUBLIC provider contract
packages/core           @bahama-ai/core — plan/execution/state/secret engine (published but internal; no API guarantee)
packages/cli            @bahama-ai/cli — the `bahama` binary; owns the static provider registry
providers/{fake,bahama-cloud,vercel,neon}   official drivers
skills/bahama-builder   the operating guide installed into coding agents — treat its prose as code
plugins/bahama          thin skill-delivery shell; registers NO MCP
```

Hard rules: CLI → core → provider-kit; providers import provider-kit **only**. Core never imports a provider; providers never import each other. No dynamic provider loading. The `fake` provider only appears with `BAHAMA_ENABLE_FAKE=1`.

## State model (one home per fact)

- `bahama.yaml` — intent only. The validator is strict (unknown keys are errors) and **rejects ID-shaped keys** (`projectId:` → error pointing at the lock). Never write doc/test examples showing IDs or secrets in the manifest; agents pattern-match examples.
- `bahama.lock` — committed; durable IDs, account ids, binding edges, repo fingerprint, driver-compat ranges. Schema forbids keys matching `url|token|secret|password|key|connection|credential` (the anti-tfstate guard). Never attributes, outputs, or labels.
- `.bahama/` — gitignored; immutable plans (`plans/<id>.json`), the `operations.ndjson` receipt journal, the op lock.
- Credentials — Vercel/Neon sessions live in *their own CLIs'* stores; Bahama Cloud tokens in a 0600 file in the OS config dir (or `BAHAMA_TOKEN`). Never in argv, never in any output.

## Invariants — do not weaken these

1. **Secrets are sealed at capture.** `SecretBroker.seal` registers the value with the redactor in the same act; `SafeRunner` seals captured stdout (`captureSecretStdout`) *before* any success/error path can observe it. No window where a raw secret exists unregistered.
2. **Postcondition verification.** A step succeeds only when the driver verifies live state (`postconditionVerified`), never on exit code. Resume soundness depends on this.
3. **Plans are content-addressed and re-verified.** `planContentId` hashes the whole document; `loadPlan` re-validates schema + hash. Approval covers bytes.
4. **Classification is default-deny and centralized** (`core/src/classify.ts`). Routine = mutates no node/edge of the resource/binding graph and is reversible by a routine step. Unknown effects, effect-less mutations, first-time or rewired secret bindings, changed provider-config fingerprints → consequential. Providers declare effects; they don't classify. No "user asked for this" provenance flags — an agent would set them.
5. **Probes never mutate; nothing ever waits on a TTY.** Missing tool/auth/decision → typed result envelope, exit 0. Interactive prompts break every agent host.
6. **Drivers only get injected capabilities** (`ProviderContext`: runner, secret broker, optional `credentials.freshToken`). Never let a driver spawn processes or read token files directly.
7. **One `ResultEnvelope` per command**; human and `--json` output render the same object. Exit codes: workflow states 0, provider failure 1, invalid invocation 2, internal 3.

## Coding rules

- TypeScript strict, ESM, npm workspaces, tsc project references. Zod for all schemas (structural schemas `.strict()`), commander for the CLI, execa via `SafeRunner` only.
- Everything crossing a contract boundary is plain JSON (`JsonValue`/`JsonObject`).
- Error messages are agent UX: state what happened, then a concrete recovery command. Include validation issues in the message string (agents often read only `message`).
- provider-kit is the public API — changes there are semver-relevant; core is published but explicitly guarantee-free.
- New provider support = descriptor + intentSchema + four verbs + a driver test file mirroring the fake provider's contract properties. Update the skill's guidance in the same change.
- If a behavior guarantee changes, `providers/fake/test/contract.test.ts` is the spec that must say so.

## Verification

```bash
npm run build    # tsc -b across workspaces
npm test         # vitest — 102 tests, keep it green
npm run lint
```

For hands-on end-to-end checks, drive the built binary against the fake provider in a scratch dir:

```bash
alias bahama='node <this-repo>/packages/cli/dist/bin.js'
export BAHAMA_ENABLE_FAKE=1
bahama init --name lab --application fake --framework fake-framework --database fake
bahama plan && bahama apply <plan-id> --approved && bahama deploy
```

`.fake-live.json` is the simulated remote provider; the `simulate:` config block stages tool-missing/unauthenticated/multi-account/fail-once scenarios (see `providers/fake/src/index.ts`).

## Status caveats (July 2026)

The Vercel, Neon, and Bahama Cloud drivers pass their test suites against recorded response shapes but have **never been run against live accounts**. If a task involves those drivers, assume parse helpers may not match reality; fixes should land with a new recorded fixture in the driver's test file. The repo has no CI and is not yet published to npm or pushed to GitHub.
