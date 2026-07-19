# Adding a Provider to Bahama

This is the canonical checklist for adding or materially expanding a provider.
It is for coding agents and the humans reviewing their work.

Use judgment. Providers are different, and not every prompt below applies to
every service. The goal is a small, honest provider that works end to end—not a
large driver that superficially mirrors an upstream API.

> **Keep the public guide synchronized.** When this process changes, update
> `../bahama-cloud/content/reference/provider-authoring.mdx` at the appropriate
> level of detail. User-visible provider changes also require the provider's
> public page to change.

## Before you begin

Read the root `AGENTS.md`, `providers/AGENTS.md`, and the nearest package
instructions.

Keep these boundaries intact:

- The model chooses infrastructure; Bahama executes deterministic operations.
- Providers import no Bahama package except `@bahama/provider-kit`.
- `probe` and `plan` are read-only and non-interactive.
- `execute` performs one planned step and verifies the live result.
- `status` reads authoritative state and reports health and drift.
- Providers declare effects; core decides what needs approval.
- Providers connect through capabilities, never pair-specific code.
- Durable IDs live in `bahama.lock`; secrets live in neither manifest nor state.
- External commands, HTTP, credentials, and secrets stay inside
  `ProviderContext`.
- Official providers are bundled into the CLI's static registry during alpha.

If a provider cannot fit these boundaries, pause and design the shared contract
change first.

## The short version

1. Research the provider's current official CLI and API documentation.
2. Agree with the human on one supported outcome and its non-goals.
3. Design roles, capabilities, auth, identity, steps, and postconditions.
4. Add any genuinely required shared contract change first.
5. Implement descriptor, schema, `probe`, `plan`, `execute`, and `status`.
6. Register the workspace and provider in the CLI.
7. Add focused tests, then update the skill and public docs.
8. Run the full checks and any separately authorized live test.

## 1. Agree on what “support” means

Research primary provider documentation rather than relying on memory or
dashboard behavior. Check the parts that matter to the proposed slice:

- CLI/API and machine-readable output;
- authentication and credential ownership;
- account, organization, project, and resource hierarchy;
- durable IDs, names, exact lookup, and readiness;
- pagination, rate limits, retries, and idempotency;
- regions, plans, quotas, and possible cost;
- secret creation, rotation, and revocation; and
- destructive or externally visible operations.

Then write a short support brief and confirm it with the human:

```md
## Outcome

What should a user be able to ask their agent to do?

## Supported now

- Roles and resource types
- Operations
- Capabilities produced or consumed

## Not supported yet

- Excluded products or operations
- Manual setup that remains

## Safety

- Authentication and account selection
- Cost, destructive actions, and test/live mode
- Live test, if any
```

The human should decide any meaningful ambiguity. “Support Supabase” or
“support Stripe” is not a usable scope by itself. Choose the specific product
and lifecycle Bahama will manage.

## 2. Fit the provider into Bahama

### Roles

| Role          | Use it for                                                  |
| :------------ | :---------------------------------------------------------- |
| `environment` | A local or hosted application environment                   |
| `application` | Application hosting and deployment compatibility            |
| `database`    | A database engine and its lifecycle                         |
| `service`     | Storage, email, payments, auth, queues, and other resources |

New application hosts need `environment` for the current manifest. Existing
hosts also expose `application` for legacy compatibility. A provider may fill
several roles, but advertise only what is fully implemented.

### Capabilities

Capabilities are the only cross-provider connection mechanism.

- Name them by application meaning, not provider name.
- Keep them reusable and reasonably atomic.
- Mark secret outputs accurately.
- Declare only values execution actually produces or consumes.
- Never add provider-to-provider special cases.

Capability names are open strings today, but a new name still deserves review.
For example, object storage might produce a bucket name, endpoint, access-key
ID, and secret access key. Choose names that another compatible storage
provider could also use.

### Authentication

Prefer an official provider CLI with its own secure login and credential store.
Declare `authCommands`, then use `ctx.run` for non-interactive operations.

An API-only provider needs an explicit protected credential or OAuth design in
the CLI. `ctx.credentials` is currently specialized for reviewed CLI-owned
credentials; it is not generic token storage. Never put tokens in
`bahama.yaml`, provider config, argv, environment conventions, or plaintext
files.

### Shared contract changes

Stop and change the shared contract first if the provider truly needs a new:

- role, effect, secret shape, or context authority;
- manifest or lockfile concept;
- generic credential flow;
- deletion lifecycle; or
- dynamic provider-loading mechanism.

Update provider-kit, core, the test provider, affected official providers, the
skill, and docs together. Do not hide a missing primitive inside one driver.

## 3. Design the lifecycle

Before implementation, answer these questions for each resource:

1. How does Bahama identify the account and resource?
2. How does it distinguish missing, forbidden, and failed lookup?
3. Can it adopt an exact existing resource when the lock is absent?
4. What durable IDs must enter the lock?
5. What steps reconcile intent with live state?
6. What observable fact verifies each step?
7. How does retry avoid creating duplicates?
8. What should status report when the resource is missing or drifted?

Locked IDs are authoritative. Names and slugs are selectors or labels, not
identity. When several accounts are valid, return a `Decision` with a safe
manifest `writeBack` path instead of choosing the CLI's ambient default.

The manifest rejects ID-shaped config such as `projectId`, `accountId`, and
`orgId`. Use a human-readable selector such as `scope` or `org`; resolve the
durable ID into the plan and lock.

Bahama currently has no destroy command. Removing intent does not authorize
remote deletion.

## 4. Implement the driver in order

### Descriptor

Write the descriptor first. Agents read it through
`bahama providers <id> --format agent`.

Keep roles, frameworks, engines, requirements, capabilities, tested tool
versions, `useWhen`, and `avoidWhen` exact. Describe what Bahama manages, not
everything the upstream provider offers.

### Intent schema

Validate provider config with Zod. Prefer strict schemas, deliberate defaults,
validated regions/enums/paths, and JSON-compatible output. Do not accept
secrets or resolved IDs.

### Probe

Probe should report tool installation and compatibility, auth state, available
accounts, and the live fields needed for planning. Parse provider responses in
small validated helpers. It must not mutate, prompt, or start login.

### Plan

Plan from validated intent, lock, probe observations, bindings, and operation
type. Produce deterministic steps with stable IDs, namespaced actions, truthful
effects, non-secret inputs, dependencies, capabilities, and postconditions.

`bahama plan` reconciles infrastructure and must not deploy source. Add deploy
steps only for a matching `bahama deploy <environment>` operation.

Use `ProviderPlanError` only for expected provider-owned conditions. Unexpected
bugs should remain internal failures.

### Execute

Execute one known action and fail closed on unknown actions. Target the exact
account and resource from the plan, use argument arrays and bounded timeouts,
respect cancellation, and retry only documented idempotent operations.

After an ambiguous create timeout, discover before creating again. A successful
exit code or HTTP response is not enough: re-read the provider and verify the
postcondition before returning `postconditionVerified: true`.

### Status

Report every requested resource as `ready`, `not_ready`, `unhealthy`, or
`unknown`, with a reason when it is not ready. Report identity/configuration
drift separately. Keep detail safe to serialize and display.

## 5. Keep steps and secrets safe

Every planned step needs:

- stable ID and namespaced action;
- clear summary and `resourceKey`;
- truthful effects;
- deterministic dependencies;
- JSON-safe, non-secret inputs;
- produced/consumed capabilities; and
- an observable postcondition.

Use existing effects precisely: `createsResource`, `adoptsResource`,
`destructive`, `migratesSchema`, `transfersSecret`, `deploys`, `bindsAccount`,
`changesConfiguration`, and `readOnly`. Core deliberately treats an unknown
mutation as consequential.

For secrets:

- capture CLI output with `captureSecretStdout` or `captureSecretJson`;
- return secret capabilities as `SecretRef`;
- consume them with `secretStdin` or a narrow `ctx.secrets.use` callback;
- never put secrets in argv, plans, identity, receipts, logs, errors, or
  fixtures; and
- make secret-producing steps able to re-derive the value after a fresh-process
  resume.

If provider configuration files can create resources or change routing during
deploy, add them to `PROVIDER_CONFIG_FILES` in
`packages/core/src/inspect.ts` with classification tests.

## 6. Add the workspace and registry entry

A normal provider includes:

```text
providers/<id>/
  AGENTS.md
  README.md
  package.json
  tsconfig.json
  src/index.ts
  test/driver.test.ts
  test/fixtures/       # when external response shapes warrant them
```

Keep modules focused when the driver grows. The workspace remains private and
is bundled into the published `bahama` CLI.

Update:

1. Root `tsconfig.json` references.
2. `packages/cli/package.json` development dependencies.
3. `packages/cli/tsconfig.json` references.
4. `packages/cli/src/runtime.ts` imports and static registry.
5. `package-lock.json` through npm, not by hand.
6. CLI assumptions or tests for provider listing, setup, doctor, auth, and
   `init` when applicable.

Registry order is user-facing. `bahama init` is a generic shortcut, not a place
for provider-specific service flags.

## 7. Test the behavior that matters

Use a fake `ProviderContext` and realistic, manually redacted fixtures. Tests
should cover the applicable cases—not every item ceremonially.

- Descriptor and config validation
- Missing tool and authentication
- Tool-version compatibility
- One or several accounts and locked-account behavior
- Missing, existing, adopted, and mismatched resources
- Deterministic reconcile and deploy plans
- Effects, dependencies, and capability wiring
- Execution failure and live postcondition verification
- Idempotent retry and fresh-process resume
- Secret capture with no raw value in persisted/output state
- Ready, incomplete, unhealthy, unknown, and drifted status
- Registry, provider catalog, doctor, auth, and setup integration

If a shared role, effect, context, secret, or lifecycle changes, update
`providers/test` and the affected core/provider suites.

Live tests require explicit human authorization. Confirm the exact account,
test/live mode, resources, region, possible cost, and cleanup plan first. Never
send real email, move money, modify production data, or delete existing
resources as a generic smoke test. Report every remote resource left behind.

## 8. Update the skill and docs

Provider behavior is not complete until an agent can select and operate it
without reading source code.

Update as applicable:

- Provider descriptor
- `skills/bahama/references/provider-selection.md`
- New `skills/bahama/references/<id>.md`
- Reference list in `skills/bahama/SKILL.md`
- Shared `manifest.md`, `workflow.md`, or `recovery.md` only when the pattern is
  reusable
- Provider `README.md` and `AGENTS.md`
- Root README provider table
- `../bahama-cloud/content/providers/_meta.ts`
- `../bahama-cloud/content/providers/index.mdx`
- New public `content/providers/<id>.mdx`
- Related public framework/data/secret/troubleshooting pages
- `../bahama-cloud/public/llms.txt`

The provider reference should explain when to choose it, setup/auth, account
decisions, manifest config, capabilities, limits, recovery, and dangerous
actions. Keep changing facts in the live descriptor where possible.

## Verification

During implementation:

```bash
npm run build -w @bahama/provider-<id>
npx vitest run providers/<id>
```

After registry integration:

```bash
npm run build -w bahama
node packages/cli/dist/bin.js providers <id> --format agent
npx vitest run packages/cli providers/<id>
```

Before handoff:

```bash
npm run version:check
npm run build
npm test
npm run typecheck
npm run lint
npm pack -w bahama --dry-run
```

Build the public docs from `../bahama-cloud` with `npm run build`.

## Definition of done

The provider is ready when:

- the human approved its supported slice and important non-goals;
- official docs support each external operation;
- auth, account identity, secrets, and retries respect Bahama's boundaries;
- descriptor, schema, four verbs, capabilities, and effects agree;
- creation/adoption is idempotent and every success is verified;
- focused and full checks pass;
- registry, skill, README, and public docs are synchronized; and
- any authorized live resources and cleanup status were reported.

If something is intentionally deferred, say so in the descriptor and docs.
Do not call it supported yet.
