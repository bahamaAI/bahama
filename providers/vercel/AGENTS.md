# Vercel provider guide

This file adds Vercel-specific rules to `providers/AGENTS.md`.

- Use the official `vercel` CLI and its authenticated API command. Do not read Vercel credential files or introduce a second token store.
- Require an explicit scope decision when more than one personal or team account is available.
- Locked account and project IDs are authoritative over `.vercel/project.json`; every mutation must target the planned IDs.
- Send secret environment values through sealed stdin, never command arguments or ordinary captured output.
- A deployment succeeds only after its returned deployment belongs to the planned project and the production URL is ready.
- Keep external-response parsers small and cover CLI/API shape changes with realistic redacted fixtures.

Verify with:

```bash
npx vitest run providers/vercel
npm run build -w @bahama-ai/provider-vercel
```
