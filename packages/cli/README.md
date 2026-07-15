# @bahama-ai/cli

**The Cloud Toolkit Built for Agents.** The `bahama` CLI gives coding agents a safe, structured way to provision cloud resources, wire secrets, and deploy — on provider accounts you already have (Vercel, Neon) or the managed [Bahama Cloud](https://www.bahama.ai). Your agent writes the intent and runs the commands; you approve the plans; Bahama executes and verifies.

Full repository, demo, and architecture: the [Bahama repository](https://github.com/bahamaAI/bahama).

> **Alpha** — commands and provider contracts may change before v0.1.

## Install

The easiest path is to let your coding agent do it. Prompt Claude Code, Codex, Cursor, or any major coding agent with:

```text
Read https://bahama.ai/install.md and install Bahama for this workspace.
```

Or install manually (Node.js `20.19+`):

```bash
npm install -g @bahama-ai/cli
bahama setup --host auto   # installs the bahama-builder skill for your agent
bahama doctor              # verify the environment
```

Bahama Cloud needs no extra tooling. Third-party providers use their official CLIs; `bahama doctor` and `bahama plan` report exactly what's missing when something is.

## Commands

Run `bahama <command> --help` for arguments and options. Most of the time, your agent runs these for you and surfaces the decisions that matter: which account, which plan, yes or no.

| Command                                        | Purpose                                                                     |
| :--------------------------------------------- | :-------------------------------------------------------------------------- |
| `bahama inspect`                               | Report non-secret application facts (framework, scripts, env names)         |
| `bahama providers [id]`                        | Describe available providers and their capabilities                         |
| `bahama init`                                  | Create a starter `bahama.yaml` — touches nothing remote                     |
| `bahama plan`                                  | Compile intent into a reviewable plan — always read-only                    |
| `bahama apply <plan-id> --approved`            | Execute a compiled plan, verifying every step                               |
| `bahama deploy [environment]`                  | Ship the application; stops for approval on consequential changes           |
| `bahama status`                                | Compare committed identities with live provider state                       |
| `bahama doctor`                                | Check the manifest, provider tools, sessions, and environment               |
| `bahama auth login\|status\|logout <provider>` | Manage provider sessions via official provider flows                        |
| `bahama config path\|get\|set`                 | Manage non-secret global CLI preferences                                    |
| `bahama detach --approved`                     | Forget resolved identities without deleting resources (template/fork reset) |
| `bahama setup`                                 | Install or verify the agent-host integration                                |

## For agents

Pass `--json` to receive one typed result envelope per command:

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

- `succeeded` — completed and verified
- `decision_required` — edit `bahama.yaml` at the returned `writeBack` path, then re-plan
- `installation_required` — a provider tool is missing; follow the returned instruction
- `auth_required` — run the returned provider login action
- `approval_required` — show the plan and accounts to the user before applying with `--approved`
- `in_progress` — the remote operation hasn't reached a terminal state
- `failed` — execution or validation failed; the message includes recovery guidance

Workflow states exit `0`. Operational failure exits `1`, invalid invocation or manifest exits `2`, internal failure exits `3`.

The `bahama-builder` skill (installed by `bahama setup`) is the complete operating manual for agents.

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
