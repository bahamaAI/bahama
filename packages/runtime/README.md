# bahama-runtime

Server-side runtime helpers for applications using Bahama Cloud resources.

The runtime package lets server-side application code use the same database API in two environments:

- **Bahama Cloud production:** use the native `env.DB` database binding directly.
- **Local development:** use a project-scoped Bahama development API without copying a database credential or replacing application code.

It is runtime glue, not a general Bahama SDK. It does not provision a database, create a Bahama project, deploy an application, or replace the `bahama` CLI.

> `bahama-runtime` currently supports Bahama Cloud database access through its server-only entry point. Local mode intentionally implements a documented subset of the native database interface.

## Install

```bash
npm install bahama-runtime
```

Import only from the server entry point:

```ts
import {getDb, type BahamaDatabase} from "bahama-runtime/server";
```

Do not import this entry point into browser code.

## Use the database

Write application data access against `getDb`:

```ts
import {getDb, type BahamaDatabase} from "bahama-runtime/server";

type Note = {
  id: number;
  body: string;
};

export async function listNotes(env: {DB?: BahamaDatabase}) {
  const db = getDb(env);
  const result = await db
    .prepare("select id, body from notes order by id desc")
    .all<Note>();

  return result.results ?? [];
}

export async function createNote(env: {DB?: BahamaDatabase}, body: string) {
  const db = getDb(env);
  await db.prepare("insert into notes (body) values (?)").bind(body).run();
}
```

Pass your Worker or Hono environment object to these functions. In production, if `env.DB` exposes `prepare`, `getDb` returns that native binding unchanged. There is no Bahama API request in the production data path.

## Configure local development with Bahama

Declare the local environment and the Bahama Cloud development-access bindings in `bahama.yaml`:

```yaml
version: 1

project:
  name: community-notes

application:
  framework: vite-hono

environments:
  local:
    provider: local
  production:
    provider: bahama-cloud

resources:
  database:
    provider: bahama-cloud
    engine: d1
    environment: production

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

Then reconcile the project:

```bash
bahama plan
bahama apply <plan-id> --approved
```

Review the plan and replace the placeholder with its actual plan ID. Bahama provisions or adopts the project and D1 database, creates project-scoped development access, and writes the declared values into the local provider's protected, gitignored env file. This does not deploy application code.

Run the application with its normal local command, such as `npm run dev`. When no native `env.DB` binding is present, `getDb` reads:

```env
BAHAMA_API_BASE_URL=https://www.bahama.ai
BAHAMA_PROJECT_SLUG=community-notes
BAHAMA_DEV_TOKEN=project-scoped-secret
```

The lookup order in local mode is:

1. Explicit `getDb(env, options)` options.
2. Values on the supplied `env` object.
3. `process.env` values.

Normally, let the Bahama CLI manage these values through manifest bindings rather than copying them manually.

## Explicit configuration

Tests or nonstandard server environments can supply local configuration directly:

```ts
const db = getDb(undefined, {
  apiBaseUrl: process.env.BAHAMA_API_BASE_URL,
  projectSlug: process.env.BAHAMA_PROJECT_SLUG,
  devToken: process.env.BAHAMA_DEV_TOKEN,
});
```

This does not change the security boundary: the development token remains server-side and must not enter source code, logs, browser bundles, public environment variables, or chat.

## Supported database surface

The exported `BahamaDatabase` shape includes familiar D1 operations:

- `prepare(sql)` with `bind`, `all`, `run`, `raw`, and `first`;
- `batch(statements)`;
- `exec(sql)`;
- `dump()`; and
- `withSession()`.

Native production mode returns the real binding and therefore uses its native behavior. Local proxy mode currently has these limitations:

- binary SQL parameters (`ArrayBuffer` and typed-array views) are rejected;
- `dump()` is not supported;
- `batch()` sends statements as individual requests and is not an atomic transaction;
- `withSession()` provides query methods but does not preserve D1 session bookmarks; `getBookmark()` returns `null`;
- local result metadata reflects what the development API returns and should not be assumed identical to every native D1 metadata field.

Code that requires one of those native-only behaviors should run against a deployed or dedicated test environment rather than silently relying on the local proxy.

## Security

`BAHAMA_DEV_TOKEN` authorizes project-scoped development access. Keep it on the server:

- never prefix it with `VITE_`, `NEXT_PUBLIC_`, or another public build prefix;
- never expose it through a browser route or serialized page data;
- never commit it to Git or place it in a test fixture;
- never include it in logs, errors, screenshots, issues, or chat.

Browser code should call your server/Hono route. The server route uses `getDb`.

## API reference

The package exports the following from `bahama-runtime/server`:

- `getDb(env?, options?)`
- `BahamaDatabase`
- `BahamaPreparedStatement`
- `BahamaDatabaseSession`
- `BahamaQueryResult`
- `BahamaExecResult`
- `BahamaSqlParam`
- `BahamaRawOptions`
- `BahamaSessionBookmark`
- `BahamaEnv`
- `BahamaDbOptions`

## Contributing

Runtime development takes place in the [Bahama monorepo](https://github.com/bahamaAI/bahama). Read the root `AGENTS.md` and `packages/runtime/AGENTS.md` before changing runtime behavior.

```bash
npm install
npm run build -w bahama-runtime
npx vitest run packages/runtime
npm run lint
npm pack -w bahama-runtime --dry-run
```

Changes to local-development behavior must remain synchronized with the Bahama Cloud provider and the `bahama` local-development guidance.

## License

[MIT](https://github.com/bahamaAI/bahama/blob/main/LICENSE)
