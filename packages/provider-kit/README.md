# Provider kit

The provider-authoring contract used by Bahama's bundled infrastructure providers.

A provider teaches Bahama:

- what infrastructure it offers and when an agent should choose it;
- which frameworks, engines, inputs, and outputs it supports;
- how to inspect tools, authentication, accounts, and live resources;
- how to contribute deterministic plan steps;
- how to execute one step and verify the result; and
- how to report normalized status and drift.

Providers remain independent. A Neon provider produces a capability such as `connectionUrl`; a local or hosted environment consumes `variables`. Neither provider imports or contains special logic for the other.

> Provider-kit is public source but is not published as a standalone npm package during the alpha. The current CLI has a static provider registry, so a separately installed provider package could not be discovered or loaded. Contribute providers in this monorepo; an external package will make sense when Bahama has a supported external-provider loading contract.

## Provider shape

```ts
import { defineProvider } from "@bahama-ai/provider-kit";
import { z } from "zod";

export const exampleProvider = defineProvider({
  descriptor: {
    id: "example",
    name: "Example Cloud",
    roles: ["environment"],
    description: "Deploys supported applications to Example Cloud.",
    useWhen: "The application needs Example Cloud's supported runtime.",
    avoidWhen: "The selected framework is not supported.",
    requirements: ["Example Cloud account", "example CLI"],
    frameworks: ["static-site"],
    produces: [
      {
        capability: "productionUrl",
        secret: false,
        description: "Verified public deployment URL.",
      },
    ],
    consumes: [
      {
        capability: "variables",
        secret: false,
        description: "Server-side environment variables.",
      },
    ],
  },

  intentSchema: z.object({
    region: z.string().optional(),
  }).strict(),

  async probe(ctx, request) {
    // Read-only: inspect the CLI/session/accounts/live state.
    return {
      tool: { installed: true },
      auth: { state: "authenticated", identity: "current user" },
      accounts: [],
      observed: {},
    };
  },

  async plan(ctx, request) {
    // Read-only: compare intent, lock, and observations; contribute steps.
    return { steps: [] };
  },

  async execute(ctx, step, inputs) {
    // Perform exactly the planned action, then verify its postcondition.
    return {
      status: "failed",
      postconditionVerified: false,
      error: { message: `Unsupported example action: ${step.action}` },
    };
  },

  async status(ctx, request) {
    return { resources: [] };
  },
});
```

This illustrates the contract shape, not a complete provider. Use the repository's [fake provider](https://github.com/bahamaAI/bahama/tree/main/providers/fake) as the executable reference implementation.

## The four driver verbs

| Verb | May mutate? | Responsibility |
| :-- | :--: | :-- |
| `probe` | No | Inspect installation, version, authentication, accounts, and relevant live state |
| `plan` | No | Compare validated intent, lock identity, bindings, and observations; contribute exact steps or typed requirements/decisions |
| `execute` | Yes | Execute one previously planned step and verify its postcondition before returning success |
| `status` | No | Read authoritative live state and report normalized existence, health, detail, and drift |

Provider methods never prompt. Missing tools, authentication, or account choices are returned as typed workflow data.

## Descriptors are agent-facing

`ProviderDescriptor` is what `bahama providers --format agent` turns into model-readable provider guidance. Keep these fields accurate:

- `roles`: `environment`, `application`, `database`, or `service`.
- `description`: what the provider actually controls.
- `useWhen` and `avoidWhen`: decision-quality prose, not marketing slogans.
- `requirements`: accounts, official CLIs, or other prerequisites.
- `frameworks` and `engines`: compatibility contracts enforced during planning.
- `produces` and `consumes`: provider-neutral capabilities used to wire bindings.
- `testedVersions`: observed external tool compatibility; newer versions may warn rather than silently claim support.

If the implementation changes, the descriptor changes in the same release.

## Planning and effects

A provider contributes serializable `ContributedStep` objects. Each step includes a stable ID, namespaced action, human-readable summary, semantic effects, dependencies, non-secret inputs, produced/consumed capabilities, and a stated postcondition.

Providers declare what a step does—for example `createsResource`, `migratesSchema`, `transfersSecret`, `deploys`, `bindsAccount`, `changesConfiguration`, or `readOnly`. Bahama core owns routine/consequential classification. A provider cannot mark its own work safe to auto-apply.

Step inputs must never contain credentials or produced secret values. A successful execution outcome must be safe to serialize into the operation journal.

## Provider context and secrets

Providers receive all external authority through `ProviderContext`:

- `ctx.run` executes official CLIs with argument arrays, closed stdin by default, timeouts, cancellation, and capture-time redaction.
- `ctx.http` performs cancellable HTTP requests with redacted diagnostics.
- `ctx.secrets` seals raw values and temporarily uses opaque `SecretRef` handles.
- `ctx.credentials` supplies renewable CLI-owned credentials where applicable.
- `ctx.log` emits redacted provider-scoped diagnostics.
- `ctx.signal` supports cooperative cancellation.

Do not import process-spawning libraries or read provider credential files directly. When a command prints an entire credential, declare `captureSecretStdout`; when a JSON field contains one, declare `captureSecretJson`. The runner seals the value before provider or error code sees the captured output.

Secret-producing steps return `SecretRef`, not strings. Secret-consuming steps receive handles through `ExecutionInputs` and use `secretStdin` or a narrow `ctx.secrets.use` callback at the moment of use. Never return a secret in a receipt, error, identity, log, plan input, or capability metadata.

## Requirements and decisions

Use typed requirements when progress needs installation or authentication. Use a `Decision` for a meaningful choice Bahama must not infer, such as which team or organization should own a new resource. Provide all valid options and a non-secret `writeBack` path into `bahama.yaml` when possible.

Do not silently select an account because the provider CLI happens to have a default.

## Distribution status

`defineProvider()` defines and type-checks a driver; it does not dynamically install or register it. The current Bahama CLI bundles a static registry of official providers. During the alpha, a community provider must be integrated into the CLI and contract suite to become selectable. A stable external-provider discovery and distribution mechanism has not yet been released.

## Contributing

Provider-kit development takes place in the [Bahama monorepo](https://github.com/bahamaAI/bahama). Read the root `AGENTS.md` and `packages/provider-kit/AGENTS.md` before changing the contract.

```bash
npm install
npm run build -w @bahama-ai/provider-kit
npm test
npm run lint
```

Contract changes require fake-provider coverage and verification of every affected official provider.

## License

[MIT](https://github.com/bahamaAI/bahama/blob/main/LICENSE)
