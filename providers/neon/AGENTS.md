# Neon provider guide

This file adds Neon-specific rules to `providers/AGENTS.md`.

- Use the official Neon CLI for authentication, account discovery, projects, and connection strings. Do not read its credential files.
- Never infer an organization when multiple valid accounts exist; return a decision with the manifest write-back path.
- Locked organization and project IDs are authoritative. Name-based adoption is only an unlocked recovery path and must be exact.
- Capture connection strings as secrets inside the runner before driver code can observe raw output.
- Migration plans include ordered file checksums. Applied migrations are immutable and `_bahama_migrations` remains the authoritative name/checksum ledger.
- Migration execution is additive and in process; do not hide destructive schema behavior or silently rewrite applied files.

Verify with:

```bash
npx vitest run providers/neon
npm run build -w @bahama/provider-neon
```
