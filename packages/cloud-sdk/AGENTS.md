# SDK agent guide

These instructions apply to `packages/cloud-sdk` in addition to the repository-root `AGENTS.md`. `@bahama-ai/cloud-sdk` is an application-facing npm package and a runtime leaf. Its exported server API, behavior, errors, and README are public compatibility commitments.

## Purpose and boundary

The SDK gives server-side application code one database interface across two Bahama Cloud modes:

- In production, `getDb(env)` returns the native `env.DB` binding unchanged.
- In local development, it returns a project-scoped HTTP adapter using `BAHAMA_API_BASE_URL`, `BAHAMA_PROJECT_SLUG`, and `BAHAMA_DEV_TOKEN`.

The SDK does not provision resources, authenticate the Bahama CLI, read `bahama.yaml` or `bahama.lock`, plan, deploy, or choose providers. It must not depend on CLI, core, provider-kit, or a provider implementation.

## Runtime and security rules

- The only public export path is `@bahama-ai/cloud-sdk/server`. Do not add a browser entry point for database or secret-bearing APIs.
- Native runtime bindings take precedence over local configuration. Do not proxy production D1 access through the Bahama control plane.
- `BAHAMA_DEV_TOKEN` is a server-side, project-scoped credential. Never log it, include it in errors, expose it through `VITE_*`/public variables, or return it to browser code.
- Explicit options, supplied env bindings, and `process.env` are configuration inputs in that order for local mode. Preserve clear missing-config errors without including values.
- Keep the local adapter behaviorally aligned with the documented subset of Bahama Cloud's native database interface. Do not claim parity for unsupported operations.
- Validate or reject values before a request when the local proxy cannot safely serialize them. Binary SQL parameters currently fail locally.
- Remote error messages may be surfaced only when they do not include credentials or raw sensitive responses.

## Public API discipline

- Changes to exported types or `getDb` behavior are semver-relevant.
- Prefer backward-compatible additions. Do not silently change result normalization, configuration precedence, or production/native detection.
- Document differences between native D1 and the local adapter in the package README.
- Keep runtime dependencies at zero unless a small dependency is genuinely necessary in both Node-compatible local development and the supported Worker runtime.
- Do not import Node-only modules into the server entry point unless the supported Bahama Cloud production build proves compatibility.

## Verification

From the repository root:

```bash
npm run build -w @bahama-ai/cloud-sdk
npx vitest run packages/cloud-sdk
npm run lint
npm pack -w @bahama-ai/cloud-sdk --dry-run
```

When changing the local development contract, also verify the Bahama Cloud provider bindings and `skills/bahama-builder/references/local-development.md` remain accurate.
