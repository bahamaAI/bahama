---
name: bahama
description: Build, provision, test, package, and deploy web applications through Bahama, the agent-native infrastructure CLI. Use when creating, updating, or managing web apps whose infrastructure Bahama manages — on the managed Bahama Cloud or on the user's own provider accounts.
---

# Bahama

Bahama is agent-native application infrastructure. The agent writes declarative intent in `bahama.yaml`; the `bahama` CLI compiles that intent into a deterministic, reviewable plan and executes it with verified postconditions. Use the Bahama CLI as the system of action. Do not call infrastructure provider APIs directly for normal Bahama workflows.

## Bahama CLI

The CLI should be installed before going further. Verify with `bahama doctor --json`. If the `bahama` binary is missing, stop and explain that the Bahama CLI is not installed. Do not invent auth, bypass provider login flows, or ask for credentials directly.

| Command | Purpose |
| :-- | :-- |
| `bahama inspect --json` | Report non-secret application facts (framework, scripts, env var names) for provider selection. |
| `bahama providers [id] --format agent` | Describe available providers so the model can choose. Prose written for agents; no hidden ranking. |
| `bahama init --name <n> --application <p> --framework <f> [--database <p>]` | Write a starter `bahama.yaml`. Never contacts providers, never creates a lock. |
| `bahama plan --json` | Reconcile resources and bindings without deploying application code (planning itself is read-only). |
| `bahama apply <plan-id> --approved --json` | Execute a compiled plan. Consequential steps require `--approved`. |
| `bahama deploy [environment] --json` | Explicitly deploy one hosted environment; infer it only when exactly one exists. Stops for approval when needed. |
| `bahama status --json` | Compare `bahama.lock` identity with live provider state and report drift. |
| `bahama doctor --json` | Check the environment, manifest, and selected provider tools/sessions. |
| `bahama auth login\|status\|logout <provider>` | Provider session management through official provider flows. |
| `bahama detach --approved` | Intentionally forget the entire resolved stack without deleting provider resources. Fork/template reset only; never use for ordinary drift recovery. |

Every command emits one typed result envelope; always pass `--json`. The envelope `status` is one of `succeeded`, `decision_required`, `installation_required`, `auth_required`, `approval_required`, `in_progress`, or `failed`. Expected workflow states exit 0 — a non-`succeeded` status is the next step in the workflow, not a crash.

- `decision_required`: a choice is needed before a plan can compile. Each decision includes a `writeBack` path. Answer it by editing `bahama.yaml` at that path, then re-run `bahama plan`.
- `installation_required`: a provider tool is missing; show the exact install, get permission for the machine-level change, install it, and retry.
- `auth_required`: a provider session is missing; follow the auth protocol below.
- `approval_required`: the plan has consequential steps; follow the approval protocol below.

When a provider exposes multiple accounts, `decision_required` is mandatory for a new project. Present every option, including personal and team/organization accounts, and write the user's selection to the supplied manifest path. Never silently choose the provider CLI's current/default account.

### Approval Protocol

Plan steps are classified routine (redeploys, verified reads) or consequential (resource creation, migrations, account changes, secret rewiring). Before running `bahama apply <plan-id> --approved`:

1. Run `bahama plan --json` and read the compiled plan.
2. Present the plan's consequential steps to the user — each step with its reason, and the provider accounts it acts on.
3. Get the user's explicit confirmation.
4. Only then run `bahama apply <plan-id> --approved --json`.

Never pass `--approved` without having shown the plan to the user. Never try to push consequential changes through `bahama deploy` to skip review — it refuses and stops with `approval_required` anyway. `bahama deploy` is for iteration on an already-provisioned stack.

`bahama detach` has its own approval boundary. Explain that it deletes nothing remotely, but removes all provider identities from the committed lock and may cause later plans to adopt or create replacements. Use it only when the user explicitly wants a copied repository/template to become a fresh stack. A missing live resource is handled by `bahama plan`; do not detach healthy resources to repair it.

### Auth Protocol

When a result is `auth_required`, run `bahama auth login <provider> --json`. Bahama launches the official provider login or its own Cloud OAuth flow; tell the user to complete authorization in the browser or device page. The provider owns credential storage. In a headless environment use `--no-browser` and surface the URL/code. After completion, verify with `bahama auth status <provider> --json` or `bahama doctor --json` and continue. Never ask the user to paste a password, API token, or authorization code into chat.

## Project State

Every Bahama app is described by a repo-root `bahama.yaml` manifest. Alongside it, the CLI maintains resolved state:

| File | Author | Committed | Contents |
| :-- | :-- | :-- | :-- |
| `bahama.yaml` | the agent | yes | intent: project name, providers, framework, resources, bindings |
| `bahama.lock` | the CLI | yes | resolved durable IDs, driver compatibility, repo fingerprint |
| `.bahama/` | the CLI | no (gitignored) | plans, operation receipts, locks |

Separate application code, environments, resources, and bindings. `bahama plan` can add infrastructure for local development without publishing the application:

```yaml
version: 1
project:
  name: my-app            # lowercase letters, digits, hyphens

application:
  framework: vite-hono

environments:
  local:
    provider: local
  production:
    provider: bahama-cloud

resources:                # optional, keyed by name
  database:
    provider: bahama-cloud
    engine: d1
    environment: production

bindings:
  BAHAMA_API_BASE_URL:
    from: environments.production.developmentApiBaseUrl
    to: environments.local.variables
  BAHAMA_PROJECT_SLUG:
    from: environments.production.developmentProjectSlug
    to: environments.local.variables
  BAHAMA_DEV_TOKEN:
    from: environments.production.developmentToken
    to: environments.local.variables
```

Cross-provider stacks connect resources through `bindings`. Capability names come from `bahama providers <id>` — never invent them. For example, Next.js on Vercel with Neon Postgres:

```yaml
application:
  framework: nextjs

environments:
  local:
    provider: local
  production:
    provider: vercel

resources:
  database:
    provider: neon
    engine: postgres

bindings:
  DATABASE_URL:
    from: resources.database.connectionUrl
    to:
      - environments.local.variables
      - environments.production.variables
```

Never put resource IDs, account IDs, dev tokens, secrets, upload IDs, or deploy job IDs in `bahama.yaml`. ID-shaped fields such as `projectId` are rejected by the CLI — resolved identity lives in `bahama.lock`, which is CLI-generated and must never be hand-edited.

The lock's durable IDs are authoritative. Provider-facing names may also be recorded for readable status and diagnostics, but agents must never use a display name in place of a locked ID. If a locked resource is confirmed missing, re-plan: Bahama creates or adopts its replacement and updates only that resource's identity while leaving healthy locked resources intact.

## Provider Choice Workflow

Before coding, provisioning, local testing, or deploying:

1. Run `bahama inspect --json` to get the app's actual facts (or note the repo is empty/new).
2. Run `bahama providers --format agent` to see what providers exist and what each is for.
3. Treat each provider's reported `frameworks` list as the compatibility contract. Never pair a framework with a provider that does not list it. If the user's requested pair is unsupported, explain the mismatch and offer either a provider that lists the framework or a deliberate conversion to a listed framework.
4. Choose providers with the user, based on that compatibility matrix and the user's preference: the managed Bahama Cloud, or their own provider accounts (for example `vercel` plus `neon` for a Next.js app). Do not choose silently.
5. Write or edit `bahama.yaml` to match the choice. Use `bahama init` for a fresh project. `bahama plan` enforces the same compatibility contract and returns the provider's allowed frameworks if the pair is invalid.
6. Run `bahama plan --json`. Resolve `decision_required`, `installation_required`, and `auth_required` results as described above.
7. Present the plan and apply it per the approval protocol.
8. Keep developing locally. Run `bahama deploy production --json` only when the user wants to publish.

If `bahama.yaml` already exists, treat it as the intended setup for this folder and confirm it with `bahama status --json` before mutating resources or deploying. Never provision, query databases, create dev tokens, or direct the user to add project secrets until the manifest reflects an agreed provider choice.

## Bahama Cloud Frameworks

The guidance in this skill's reference files is the Bahama Cloud golden path: it applies when a hosted environment uses `provider: bahama-cloud`. Other providers follow the generic inspect → providers → plan → apply workflow above, plus the provider-specific guidance from `bahama providers <id>`.

On Bahama Cloud, choose one supported framework before coding.

- `vite-hono`: Vite frontend plus Workers-compatible Hono backend on `/api/*`. Default for full-stack apps, CRUD apps, database-backed apps, webhooks, AI/provider calls, and apps needing server-side secrets. Read `references/vite-hono.md`.
- `vite-spa`: Vite frontend only. Use for browser-only React, Vue, Svelte, Preact, Solid, or vanilla Vite apps with no DB, no server-side secrets, and no backend routes. Read `references/static-deployments.md`.
- `static-site`: Raw HTML/CSS/JS with no package install and no build step. Use for simple browser-only sites. Read `references/static-deployments.md`.
- `static-bundle`: Already-built static assets with `index.html` at root, `dist/`, `build/`, or `public/`. Use when another tool already produced deployable output. Read `references/static-deployments.md`.
- `hono-api`: Backend-only Hono Worker API with no frontend assets. Use for JSON APIs, webhooks, automation endpoints, and service backends. Read `references/hono-api.md`.

For React on Bahama Cloud, use Vite. Do not use Next.js, Remix, Nuxt, custom Webpack, Express, Node HTTP servers, or SSR framework adapters on Bahama Cloud — those belong on providers that support them. For existing projects that don't fit any provider cleanly, assess whether they can be converted to a supported shape and discuss the conversion before rewriting.

## Data Rule

Bahama Cloud managed databases are available only to server-side Worker/Hono code. Browser code must call backend routes. Never ask the user for a database URL, host, password, or connection string.

If adding SQL tables, migrations, seed data, or persistent CRUD behavior, read `references/database-and-sql.md` before writing code.

## Secrets Rule

Bahama Cloud project secrets are write-only runtime values for third-party credentials. Do not ask the user to paste raw secret values into chat. Instead, choose the exact secret name, tell the user to add it at `/dashboard/projects/:slug/secrets`, and read it only from server-side Worker/Hono code as `env.SECRET_NAME`.

If adding provider keys, OAuth client secrets, webhook signing secrets, or local testing with secrets, read `references/secrets.md`.

## Local Testing Rule

Bahama Cloud local testing can use live managed resources through dev tokens and `bahama-runtime/server`. Dev tokens and secret values are server-side local configuration only.

If setting up local Hono development, local database access, Vite API proxying, or `.env.local`, read `references/local-development.md`.

## Deployment Workflow

Use this order:

1. Confirm the CLI is installed and healthy (`bahama doctor --json`).
2. Run the provider choice workflow: inspect, providers, choose with the user, write `bahama.yaml`.
3. On Bahama Cloud, choose the framework and read the matching reference file.
4. Declare a database in `resources` only if the app needs persistence.
5. Add secrets through the dashboard path when server-side credentials are needed.
6. Build or adjust the app to the selected contract.
7. Run `bahama plan --json`; present consequential resource and binding steps and apply them. This prepares local development without deploying.
8. Develop and test locally with the project's normal dev command.
9. When publication is requested, run `bahama deploy <environment> --json`; the CLI owns packaging, upload, and status polling.

Read `references/packaging-and-deploy.md` before deploying or troubleshooting deploy failures.

## General Build Rules

- Keep generated apps within the selected provider and framework contract.
- Keep frontend code separate from server-only resource access.
- Use relative frontend API paths like `/api/notes` for Bahama Cloud backend routes.
- Do not expose databases, dev tokens, project secrets, provider keys, or credentials to browser code.
- Do not add provider-specific deployment config to the app unless the selected provider calls for it.
- Do not rely on unsupported backend formats or long-running Node server processes on Bahama Cloud.
- Prefer this skill's contract and the selected reference file over stale local assumptions.

## Reference Files

- `references/vite-hono.md`: Read for Vite frontend plus Hono backend apps.
- `references/static-deployments.md`: Read for `static-site`, `static-bundle`, and `vite-spa`.
- `references/hono-api.md`: Read for backend-only Hono API deployments.
- `references/database-and-sql.md`: Read before adding SQL, migrations, seed data, or persistent CRUD.
- `references/secrets.md`: Read before using server-side provider credentials or local secret values.
- `references/local-development.md`: Read before using dev tokens, `bahama-runtime`, `.env.local`, or local Hono/Vite API proxying.
- `references/packaging-and-deploy.md`: Read before deploying or troubleshooting deploy failures.
