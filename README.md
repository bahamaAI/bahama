# Bahama

**Agent-native application infrastructure.** Your coding agent writes the app; Bahama gives it one coherent, safe way to choose providers, provision resources, connect them, deploy, and operate — through provider accounts you already own, or through the managed [Bahama Cloud](https://www.bahama.ai).

```text
bahama.yaml (declarative intent, written by the model)
        │
        ▼
bahama plan   →  deterministic, reviewable plan (routine vs consequential steps)
        │
        ▼
bahama apply  →  verified execution: postconditions, receipts, resume
bahama deploy →  the iteration loop: auto-applies when every step is routine
```

## How it works

- **The model decides.** `bahama inspect` and `bahama providers` give the agent accurate ingredients — detected framework, provider capabilities, use/avoid guidance. The agent writes `bahama.yaml`. The CLI contains no LLM and no hidden ranking.
- **The CLI executes deterministically.** `bahama plan` compiles intent into an immutable plan with a content-derived id. Steps are classified **routine** (redeploys, verified reads, unchanged-edge secret rotation) or **consequential** (resource creation, migrations, account changes, secret rewiring) — consequential plans require explicit approval.
- **Secrets stay sealed.** Values like connection strings move between providers inside the execution engine as opaque handles. They never appear in plans, receipts, logs, agent output, or committed files, and resume re-derives them from the provider instead of persisting them.
- **Everything is verified.** A step succeeds when its postcondition is verified against live provider state — never because a command exited 0. Receipts land in an append-only journal; an interrupted apply resumes without recreating resources.

## State model

| File | Author | Committed | Contents |
| :-- | :-- | :-- | :-- |
| `bahama.yaml` | you / your agent | yes | intent: providers, frameworks, resources, bindings |
| `bahama.lock` | the CLI | yes | resolved durable IDs, driver compatibility, repo fingerprint |
| `.bahama/` | the CLI | no | plans, operation receipts, locks |
| credentials | provider CLIs / OS keyring | never | sessions and tokens |

## Packages

| Package | What it is |
| :-- | :-- |
| [`@bahama-ai/cli`](packages/cli) | the `bahama` binary |
| [`@bahama-ai/provider-kit`](packages/provider-kit) | the public contract for authoring providers |
| [`@bahama-ai/core`](packages/core) | plan/execution/state/secret engine (internal) |
| [`providers/*`](providers) | official provider drivers, including the contract-test `fake` provider |
| [`skills/bahama-builder`](skills) | the operating guide installed into coding agents |

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

The contract test suite runs every provider through the same safety envelope: typed installation/auth requirements, deterministic plan ids, sealed secret transfer, mid-apply failure and fresh-process resume, idempotent creation, drift detection, and no-secret-anywhere scans.

## License

MIT
