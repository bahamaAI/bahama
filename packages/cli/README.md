# bahama

**The Cloud Toolkit Built for Agents.** The `bahama` CLI gives coding agents a safe, structured way to provision cloud resources, wire secrets, and deploy — on provider accounts you already have (Vercel, Neon) or the managed [Bahama Cloud](https://www.bahama.ai). Your agent writes the intent and runs the commands; you approve the plans; Bahama executes and verifies.

Full repository, demo, and architecture: the [Bahama repository](https://github.com/bahamaAI/bahama).

> **Alpha** — commands and provider contracts may change before v0.1.

## Install

The easiest path is to let your coding agent do it. Prompt Claude Code, Codex, Cursor, or any major coding agent with:

```text
Read https://bahama.ai/install.md and install Bahama for this workspace.
```

Or install both pieces directly (Node.js `20.19+`):

```bash
npx -y skills add bahamaAI/bahama --skill bahama --yes
```

```bash
npm install -g bahama
```

The skill teaches your agent how to operate Bahama; this package supplies the CLI that orchestrates the magic.

## Commands

Run `bahama <command> --help` for arguments and options. Most of the time, your agent runs these for you and surfaces the decisions that matter: which account, which plan, yes or no.

| Command                                        | Purpose                                                                     |
| :--------------------------------------------- | :-------------------------------------------------------------------------- |
| `bahama inspect`                               | Report non-secret application facts (framework, scripts, env names)         |
| `bahama providers [id]`                        | List compatibility; pass an id for detailed selection guidance              |
| `bahama init`                                  | Create a starter `bahama.yaml` — touches nothing remote                     |
| `bahama plan`                                  | Compile intent into a reviewable plan — always read-only                    |
| `bahama apply <plan-id> --approved`            | Execute a compiled plan, verifying every step                               |
| `bahama deploy [environment]`                  | Ship the application; stops for approval on consequential changes           |
| `bahama status`                                | Compare committed identities with live provider state                       |
| `bahama doctor`                                | Check the manifest, provider tools, sessions, and environment               |
| `bahama auth login\|status\|logout <provider>` | Manage provider sessions via official provider flows                        |
| `bahama config path\|get\|set`                 | Manage non-secret global CLI preferences                                    |
| `bahama detach --approved`                     | Forget resolved identities without deleting resources (template/fork reset) |

## For agents

The default output is the concise agent and human interface. It shows plans, accounts, decisions, requirements, recovery guidance, and the exact next command without exposing the full execution document. Use it for normal `plan`, `apply`, `deploy`, `doctor`, and authentication workflows.

Pass `--json` when structured details are needed, particularly for `inspect`, `status`, integrations, or diagnostics. It returns one complete typed result envelope:

```json
{
  "protocolVersion": 1,
  "command": "plan",
  "status": "approval_required",
  "message": "Plan plan_example includes steps requiring approval.",
  "data": {},
  "warnings": []
}
```

`status` states:

- `succeeded` — the command completed; `status` reports each resource as `ready`, `not_ready`, `unhealthy`, or `unknown`
- `decision_required` — edit `bahama.yaml` at the returned `writeBack` path, then re-plan
- `installation_required` — a provider tool is missing; follow the returned instruction
- `auth_required` — run the returned provider login action
- `approval_required` — show the plan and accounts to the user before applying with `--approved`
- `in_progress` — the remote operation hasn't reached a terminal state
- `failed` — execution or validation failed; the message includes recovery guidance

Workflow states exit `0`. Operational failure exits `1`, invalid invocation or manifest exits `2`, internal failure exits `3`.

Provider discovery is progressive: `bahama providers --format agent` returns a compact compatibility index. After shortlisting, run `bahama providers <id> --format agent` for that provider's use/avoid guidance, requirements, and capabilities.

The `bahama` skill is the complete operating manual for agents.

## Project state

Bahama's memory lives in three files at the root of your project. Your agent (or `bahama init`) writes `bahama.yaml`; Bahama creates the other two as it plans and applies. The committed files travel with the repo, so any machine — and any agent — can pick up exactly where the last one left off:

| Path          | Committed | Purpose                                                          |
| :------------ | :-------- | :--------------------------------------------------------------- |
| `bahama.yaml` | yes       | Declarative intent, written by you and your agent                |
| `bahama.lock` | yes       | Resolved durable identities and binding edges, written by Bahama |
| `.bahama/`    | no        | Immutable plans, operation receipts, and local operation locks   |

## Supported interface

The supported surface of this package is the `bahama` binary and its versioned JSON result protocol. The artifact bundles Bahama's core engine, provider contract, and official providers into one executable — it is not a JavaScript library and exposes no embedding API.

## Contributing

Development happens in the [Bahama monorepo](https://github.com/bahamaAI/bahama). Start with the root `README.md` and `AGENTS.md` there.

## License

[MIT](https://github.com/bahamaAI/bahama/blob/main/LICENSE)
