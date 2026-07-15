# Test provider guide

This file adds contract-test rules to `providers/AGENTS.md`.

- The test provider is an executable specification for core and provider behavior, not a real project option.
- Keep it deterministic, filesystem-contained, credential-free, and enabled in the CLI only through `BAHAMA_ENABLE_TEST=1`.
- Model installation, authentication, decisions, account changes, failures, bindings, deploys, receipts, and status well enough to exercise shared contracts.
- When a shared provider contract changes, update the test provider and its end-to-end suite before treating the change as complete.

Verify with:

```bash
npx vitest run providers/test
npm run build -w @bahama/provider-test
```
