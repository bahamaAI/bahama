---
name: bahama
description: Use Bahama to manage application infrastructure for this project. Use when choosing providers, creating databases, connecting resources to local or hosted environments, deploying an application, or troubleshooting a project that uses bahama.yaml.
---

# Bahama

Bahama is a command-line tool that creates and connects the infrastructure an application needs: databases, hosting, and the variables that link them. You decide the architecture; Bahama performs the provider operations, stops for user approval before anything consequential, and verifies each result.

The project states what it wants in `bahama.yaml`. Bahama compares that with the real provider availability and plans the work needed to close the gap.

First check that `bahama --version` works. If the command is missing, ask before installing it with `npm install -g bahama`.

When Bahama supports an operation, use it instead of calling provider tools directly — it keeps account choice, approval, saved identity, and verification in one workflow. If Bahama does not support something, explain the gap before working around it.

## Commands

Use the concise default output for normal work. Use `--json` only when this guide calls for structured details—currently `inspect` and `status`—or when diagnosing information the readable output does not include. Expected workflow states may exit 0, so always read the reported status (the first line in concise output).

| Command                                                                                              | Purpose                                                                                 |
| :--------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `bahama inspect`                                                                                     | Report project facts (framework, scripts, env-var names). Reads no secret values.       |
| `bahama providers [id] --format agent`                                                               | List provider compatibility; pass an id for detailed selection guidance.                |
| `bahama init --name <name> --application <provider> --framework <framework> [--database <provider>]` | Write a starter `bahama.yaml`. Refuses if one exists — edit that file instead.          |
| `bahama plan`                                                                                        | Read-only: compute the operations needed to match the manifest.                         |
| `bahama apply <plan-id> [--approved]`                                                                | Execute a plan.                                                                         |
| `bahama deploy [environment]`                                                                        | Publish application code to a hosted environment.                                       |
| `bahama status`                                                                                      | Compare saved identities with live provider state.                                      |
| `bahama doctor`                                                                                      | Check the manifest, provider tools, and login sessions.                                 |
| `bahama auth login\|status\|logout <provider>`                                                       | Manage provider sessions. `--no-browser` prints headless instructions.                  |
| `bahama detach --approved`                                                                           | Forget all saved identities without deleting anything remote. Forks and templates only. |

## The workflow

1. **Inspect.** `bahama inspect --json` reports the framework, scripts, env-var names, and existing Bahama files.

2. **Choose providers.** Run `bahama providers --format agent` for the compact live catalog and match the application's needs using [provider-selection.md](references/provider-selection.md). For each serious candidate, run `bahama providers <id> --format agent` to read its use/avoid guidance, requirements, and capabilities. Then open only that provider's reference file. Discuss the choice with the user before writing it. Bahama Cloud is the default when it fully fits; never force it onto an unsupported framework.

3. **Write `bahama.yaml`.** Read [manifest.md](references/manifest.md) first. `bahama init` starts a new project; otherwise edit the file directly, changing only what the task requires.

4. **Plan.** `bahama plan` is read-only. If the result asks for a tool install, login, or account decision, follow its instructions instead of guessing. A converged manifest may still produce routine reconciliation steps (all `·`); `ok` means no step needs approval, not necessarily an empty plan.

5. **Approve, then apply.** Show the user every step and the accounts it touches. Steps marked `!` require approval and say why. After approval, run `bahama apply <plan-id> --approved`. If the plan contains only `·` steps and the task includes execution, apply without `--approved`. Approval covers only the plan the user just saw.

6. **Deploy when asked.** A plan from `bahama plan` sets up infrastructure only; it never publishes application code, so local development works without deploying. Publishing is `bahama deploy <environment>`. The first or infrastructure-changing deploy stops with a plan id to approve and apply; a code-only redeploy applies itself. Run `bahama status --json` when live state is unclear. Read [workflow.md](references/workflow.md) for new projects, adding resources later, and local-first development.

## Reading results

The first status line tells you the next move:

| Status                  | What to do                                                                       |
| :---------------------- | :------------------------------------------------------------------------------- |
| `ok` (`succeeded` in JSON) | The command completed. Read its warnings before reporting the result.         |
| `decision required`     | Present the choices, write the selected value to the stated path, and re-plan.   |
| `installation required` | Ask before installing the returned provider tool, then retry.                    |
| `auth required`         | Run `bahama auth login <provider>`; the user completes the provider's own flow.  |
| `approval required`     | Show the plan, accounts, and consequential reasons before applying.              |
| `in progress`           | Continue only as directed by the result.                                         |
| `failed`                | Read the error and recovery guidance; see [recovery.md](references/recovery.md). |

## Project state

You may edit `bahama.yaml`. The CLI owns everything else:

- `bahama.lock` — real provider accounts, resource IDs, and completed connections. Commit it; never hand-edit it.
- `.bahama/` — local plans, receipts, and operation locks. Keep it gitignored and leave it alone.
- Secret values never belong in source, the manifest, the lock, plans, logs, chat, or browser-visible variables. Never ask the user for connection strings, database credentials, or tokens — Bahama provisions and wires those values.

`bahama detach` forgets the entire lock but deletes nothing remotely. Use it only for an intentional fork or template reset, after explaining the risks. Read [recovery.md](references/recovery.md) before any detach or provider cleanup.

## References

Open these only when the task calls for them:

- [provider-selection.md](references/provider-selection.md) — choose, add, or replace a provider.
- [workflow.md](references/workflow.md) — start a stack, add infrastructure later, work locally, or deploy updates.
- [manifest.md](references/manifest.md) — create or change `bahama.yaml` and its bindings.
- [recovery.md](references/recovery.md) — handle failures, drift, missing resources, stale plans, repository mismatch, or detach.
- [bahama-cloud.md](references/bahama-cloud.md) — authenticate and use Bahama Cloud resources.
- [bahama-cloud-deployment.md](references/bahama-cloud-deployment.md) — build, package, or deploy a Bahama Cloud application.
- [bahama-runtime.md](references/bahama-runtime.md) — use a Bahama Cloud database from local server code.
- [vercel.md](references/vercel.md) — use Vercel for application hosting.
- [neon.md](references/neon.md) — use Neon Postgres or checked-in SQL migrations.
- [local.md](references/local.md) — write resource values into a protected local env file.
