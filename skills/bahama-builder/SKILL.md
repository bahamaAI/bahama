---
name: bahama-builder
description: Build, provision, test, package, and deploy web applications through Bahama, the agent-native infrastructure CLI. Use when creating, updating, or managing web apps whose infrastructure Bahama manages — on the managed Bahama Cloud or on the user's own provider accounts.
version: 0.1.0-alpha.1
---

# Bahama Builder

Bahama is agent-native application infrastructure. The agent writes declarative intent in `bahama.yaml`; the `bahama` CLI compiles that intent into a deterministic, reviewable plan and executes it with verified postconditions. Use the Bahama CLI as the system of action. Do not call infrastructure provider APIs directly for normal Bahama workflows.

## Bahama CLI

The CLI should be installed before going further. Verify with `bahama doctor --json`. If the `bahama` binary is missing, stop and explain that the Bahama CLI is not installed. Do not invent auth, bypass provider login flows, or ask for credentials directly.

| Command | Purpose |
| :-- | :-- |
| `bahama inspect --json` | Report non-secret application facts (framework, scripts, env var names) for provider selection. |
| `bahama providers [id] --format agent` | Describe available providers so the model can choose. Prose written for agents; no hidden ranking. |
| `bahama init --name <n> --application <p> --framework <f> [--database <p>]` | Write a starter `bahama.yaml`. Never contacts providers, never creates a lock. |
| `bahama plan --json` | Validate `bahama.yaml` and compile a deterministic executable plan (read-only). |
| `bahama apply <plan-id> --approved --json` | Execute a compiled plan. Consequential steps require `--approved`. |
| `bahama deploy --json` | Fast path: compile and auto-apply only when every step is routine — redeploys of an existing stack. Stops with `approval_required` otherwise. |
| `bahama status --json` | Compare `bahama.lock` identity with live provider state and report drift. |
| `bahama doctor --json` | Check the environment, manifest, and selected provider tools/sessions. |
| `bahama auth login\|status\|logout <provider>` | Provider session management through official provider flows. |
| `bahama detach` | Clear resolved resource identity (`bahama.lock`) but keep intent — for forks and templates. |

Every command emits one typed result envelope; always pass `--json`. The envelope `status` is one of `succeeded`, `decision_required`, `installation_required`, `auth_required`, `approval_required`, `in_progress`, or `failed`. Expected workflow states exit 0 — a non-`succeeded` status is the next step in the workflow, not a crash.

- `decision_required`: a choice is needed before a plan can compile. Each decision includes a `writeBack` path. Answer it by editing `bahama.yaml` at that path, then re-run `bahama plan`.
- `installation_required`: a provider tool is missing; surface the install instructions to the user.
- `auth_required`: a provider session is missing; follow the auth protocol below.
- `approval_required`: the plan has consequential steps; follow the approval protocol below.

### Approval Protocol

Plan steps are classified routine (redeploys, verified reads) or consequential (resource creation, migrations, account changes, secret rewiring). Before running `bahama apply <plan-id> --approved`:

1. Run `bahama plan --json` and read the compiled plan.
2. Present the plan's consequential steps to the user — each step with its reason, and the provider accounts it acts on.
3. Get the user's explicit confirmation.
4. Only then run `bahama apply <plan-id> --approved --json`.

Never pass `--approved` without having shown the plan to the user. Never try to push consequential changes through `bahama deploy` to skip review — it refuses and stops with `approval_required` anyway. `bahama deploy` is for iteration on an already-provisioned stack.

### Auth Protocol

When a result is `auth_required`, it includes a `loginHint` command (usually `bahama auth login <provider>`). Give that command to the human to run in their own terminal. Do not run interactive login flows yourself; that keeps tokens and device codes out of transcripts. After the user says login is done, verify with `bahama auth status <provider> --json` or `bahama doctor --json` and continue.

## Project State

Every Bahama app is described by a repo-root `bahama.yaml` manifest. Alongside it, the CLI maintains resolved state:

| File | Author | Committed | Contents |
| :-- | :-- | :-- | :-- |
| `bahama.yaml` | the agent | yes | intent: project name, providers, framework, resources, bindings |
| `bahama.lock` | the CLI | yes | resolved durable IDs, driver compatibility, repo fingerprint |
| `.bahama/` | the CLI | no (gitignored) | plans, operation receipts, locks |

`bahama.yaml` shape (`version: 1`):

```yaml
version: 1
project:
  name: my-app            # lowercase letters, digits, hyphens

application:
  provider: bahama-cloud  # from `bahama providers`
  framework: vite-hono    # from the provider's supported frameworks

resources:                # optional, keyed by name
  database:
    provider: bahama-cloud   # D1 is bound at runtime as `env.DB`; no bindings entry needed
```

Cross-provider stacks connect resources through `bindings`. Capability names come from `bahama providers <id>` — never invent them. For example, Next.js on Vercel with Neon Postgres:

```yaml
application:
  provider: vercel
  framework: nextjs

resources:
  database:
    provider: neon
    engine: postgres

bindings:
  DATABASE_URL:
    from: resources.database.connectionUrl
    to: application.productionEnvironment
```

Never put resource IDs, account IDs, dev tokens, secrets, upload IDs, or deploy job IDs in `bahama.yaml`. ID-shaped fields such as `projectId` are rejected by the CLI — resolved identity lives in `bahama.lock`, which is CLI-generated and must never be hand-edited.

## Provider Choice Workflow

Before coding, provisioning, local testing, or deploying:

1. Run `bahama inspect --json` to get the app's actual facts (or note the repo is empty/new).
2. Run `bahama providers --format agent` to see what providers exist and what each is for.
3. Choose providers with the user, based on the app's framework and the user's preference: the managed Bahama Cloud, or their own provider accounts (for example `vercel` plus `neon` for a Next.js app). Do not choose silently.
4. Write or edit `bahama.yaml` to match the choice. Use `bahama init` for a fresh project.
5. Run `bahama plan --json`. Resolve `decision_required`, `installation_required`, and `auth_required` results as described above.
6. Present the plan and apply it per the approval protocol.
7. Iterate with `bahama deploy --json` for subsequent code changes.

If `bahama.yaml` already exists, treat it as the intended setup for this folder and confirm it with `bahama status --json` before mutating resources or deploying. Never provision, query databases, create dev tokens, or direct the user to add project secrets until the manifest reflects an agreed provider choice.

## Bahama Cloud Frameworks

The guidance in this skill's reference files is the Bahama Cloud golden path: it applies when `application.provider: bahama-cloud`. Other providers follow the generic inspect → providers → plan → apply workflow above, plus the provider-specific guidance from `bahama providers <id>` (for example, Next.js apps deploy through providers that support Next.js, not through Bahama Cloud).

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

Bahama Cloud local testing can use live managed resources through dev tokens and `@bahama-ai/sdk/server`. Dev tokens and secret values are server-side local configuration only.

If setting up local Hono development, local database access, Vite API proxying, or `.env.local`, read `references/local-development.md`.

## Deployment Workflow

Use this order:

1. Confirm the CLI is installed and healthy (`bahama doctor --json`).
2. Run the provider choice workflow: inspect, providers, choose with the user, write `bahama.yaml`.
3. On Bahama Cloud, choose the framework and read the matching reference file.
4. Declare a database in `resources` only if the app needs persistence.
5. Add secrets through the dashboard path when server-side credentials are needed.
6. Build or adjust the app to the selected contract.
7. Run `bahama plan --json`; present consequential steps and apply per the approval protocol.
8. Iterate with `bahama deploy --json` — the CLI owns packaging, upload, and status polling.

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
- `references/local-development.md`: Read before using dev tokens, `@bahama-ai/sdk`, `.env.local`, or local Hono/Vite API proxying.
- `references/packaging-and-deploy.md`: Read before deploying or troubleshooting deploy failures.
