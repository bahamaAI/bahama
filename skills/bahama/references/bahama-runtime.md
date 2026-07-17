# Bahama Runtime

A database bound to a deployed Bahama Cloud application appears directly in server code as `env.DB`. Local Node and Vite processes do not have that native runtime binding. `bahama-runtime` bridges this gap so the same server-side data-access code can work locally and after deployment.

It does not create a project, provision a database, or deploy an application. The `bahama` CLI handles those jobs.

## Use one database interface

Install the runtime in the application:

```bash
npm install bahama-runtime
```

Import its server entry only:

```ts
import {getDb, type BahamaDatabase} from "bahama-runtime/server";

export async function listNotes(env: {DB?: BahamaDatabase}) {
  return getDb(env)
    .prepare("select id, body from notes order by id desc")
    .all();
}
```

On Bahama Cloud, `getDb` returns the native `env.DB`. Locally, it sends the database operation through a project-scoped Bahama development API. Never import this server entry into browser code.

## Use the SQL interface

Bahama Cloud does not currently plan database migrations. Create schema explicitly and use bound parameters for application values:

```ts
const db = getDb(env);
await db.prepare(`
  create table if not exists notes (
    id integer primary key autoincrement,
    body text not null
  )
`).run();

await db.prepare("insert into notes (body) values (?)").bind(body).run();
```

Keep schema setup idempotent. Ask before dropping tables, deleting broad data, or changing existing records in bulk.

## Let Bahama configure local access

The manifest declares three values flowing from the Bahama Cloud environment to the local environment:

```yaml
bindings:
  BAHAMA_API_BASE_URL:
    from: environments.production.developmentApiBaseUrl
    to: environments.local.variables
  BAHAMA_PROJECT_SLUG:
    from: environments.production.developmentProjectSlug
    to: environments.local.variables
  BAHAMA_DEV_TOKEN:
    from: environments.production.developmentToken
    to: environments.local.variables
```

After the plan is approved and applied, Bahama creates scoped development access and the local provider writes those values into the protected env file. Do not create or copy a development token by hand during the normal workflow.

Local access reaches the real Bahama Cloud database. Treat queries as live-data operations and ask before destructive changes or broad test-data writes.

## Keep local Node code separate

The deployable Hono app stays in `server/index.*`. A separate local adapter may load `.env.local` and start the app with `@hono/node-server`:

```ts
import {config} from "dotenv";
import {serve} from "@hono/node-server";
import app from "./index";

config({path: ".env.local"});

serve({
  fetch: (request) => app.fetch(request, {
    BAHAMA_API_BASE_URL: process.env.BAHAMA_API_BASE_URL,
    BAHAMA_PROJECT_SLUG: process.env.BAHAMA_PROJECT_SLUG,
    BAHAMA_DEV_TOKEN: process.env.BAHAMA_DEV_TOKEN,
  }),
  port: 3001,
});
```

A Vite frontend can proxy `/api` to this local server. Keep frontend requests relative so the same application code works after deployment.

## Know the local limits

The local proxy covers ordinary prepared statements, queries, and writes, but it is not a perfect copy of native D1. It rejects binary SQL parameters, does not support `dump()`, does not make proxy `batch()` atomic, and does not preserve D1 session bookmarks. Result metadata may also differ.

Run code that depends on those native-only behaviors in a deployed or dedicated test environment.

`BAHAMA_DEV_TOKEN` is server-side authorization. Never prefix it with `VITE_` or `NEXT_PUBLIC_`, expose it through a route, commit it, or include it in logs, fixtures, screenshots, issues, or chat. Load `.env.local` explicitly rather than assuming a default dotenv import chose the right file.
