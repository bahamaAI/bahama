# Hono API

Use `hono-api` for backend-only Bahama Cloud projects with no frontend assets.

This guidance applies when `application.provider: bahama-cloud`. Read this file when building JSON APIs, webhooks, automation endpoints, service backends, or any project where the live app is only server-side routes.

## Required Shape

The project must include:

- `package.json`
- one lockfile: `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`
- Hono dependency
- `bahama-runtime` dependency when using Bahama database types, `getDb`, or local database testing
- deployable backend entry at `server/index.ts`, `server/index.js`, `server/index.mts`, or `server/index.tsx`

No `index.html`, `src/`, or static frontend assets are required.

## Hono Rules

The deployable backend entry must be Workers-compatible.

Allowed in `server/index.*`:

- `import {Hono} from "hono"`
- `export default app`
- route handlers for API paths
- Bahama database access through `c.env.DB` or `getDb(c.env)`
- secret access through `c.env.SECRET_NAME`

Not allowed in `server/index.*`:

- `@hono/node-server`
- `serve(...)`
- `serveStatic(...)`
- Express
- Node HTTP server setup
- filesystem-dependent production routing
- long-running Node server assumptions

Use a separate local adapter such as `server/dev.ts` for Node local development. Keep Node adapters out of the deployable entry.

## Health Route

Bahama wraps deployments with `/api/health`, but user code should still expose a useful health or status route when the app naturally needs one.

Minimal API:

```ts
import {Hono} from "hono";
import type {BahamaDatabase} from "bahama-runtime/server";

type Env = {
  Bindings: {
    DB?: BahamaDatabase;
    OPENAI_API_KEY?: string;
  };
};

const app = new Hono<Env>();

app.get("/api/status", (c) => {
  return c.json({ok: true});
});

export default app;
```

## Data And Secrets

If the API uses SQL tables, migrations, seed data, or persistent CRUD, read `database-and-sql.md`.

If the API uses provider keys, webhook signing secrets, OAuth client secrets, or local secret values, read `secrets.md`.

If testing locally with live Bahama-managed resources, read `local-development.md`.

## Packaging Notes

`bahama deploy` packages source and dependency metadata; Bahama installs dependencies and bundles the Hono backend. Keep the project tree clean so the archive contains the right files.

Part of the deployable app:

- `package.json`
- one lockfile
- `server/index.*`
- any server-side modules imported by `server/index.*`
- TypeScript config when needed

Not part of the deployable app:

- `node_modules/`
- `.git/`
- `.env*`
- `.bahama/`
- frontend build output
- logs
- OS metadata
