# Bahama Plugin (thin shell)

This directory packages the [`bahama-builder` skill](../../skills/bahama-builder) for agentic coding tools (Claude Code, Cursor, Codex).

It is deliberately thin:

- **No MCP server.** The old plugin registered a hosted MCP endpoint; the open Bahama CLI replaced it as the action layer. Nothing here adds `mcpServers`, `.mcp.json`, or `mcp.json`.
- **No provider logic.** Providers live in the CLI (`@bahama-ai/cli`), versioned together with this skill.

A release step copies `skills/bahama-builder/` next to the manifest so hosts resolve `./skills/`. Host-specific manifests (Cursor, Codex) are added at publish time from this same source of truth — do not fork the skill per host.
