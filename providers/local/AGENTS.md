# Local provider guide

This file adds local-development rules to `providers/AGENTS.md`.

- This provider materializes declared bindings only; it does not provision remote resources or publish application code.
- Write only to the validated, repository-contained environment file declared by the local environment.
- Preserve unrelated variables, gitignore protection, restrictive file permissions, and secret redaction.
- Never materialize a value unless a manifest binding explicitly targets the local environment.

Verify with:

```bash
npx vitest run providers/local packages/cli
npm run build -w @bahama-ai/provider-local
```
