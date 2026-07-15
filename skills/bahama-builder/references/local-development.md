# Local Development

Use this file before setting up local Hono development, live Bahama-managed database access, dev tokens, `.env.local`, or Vite-to-Hono API proxying.

This guidance applies when `environments` contains both `local` and a Bahama Cloud environment. Local development is a first-class target, not a post-deploy workaround.

## Why The SDK Exists

Bahama-managed runtime resources are Worker bindings. In production, deployed Worker/Hono code can read bindings such as `env.DB` directly. In local Node or Vite development, those bindings do not exist, so code cannot directly access the Bahama-managed database the same way it does after deployment.

The Bahama SDK bridges that gap for local server-side code. It uses a project-scoped dev token to proxy local database calls through Bahama to the live Bahama-managed resource. This means local testing can touch live project data. Avoid destructive operations and test-data pollution unless the user explicitly approves them.

## Dev Tokens

Declare the three development bindings shown in `SKILL.md`, then run `bahama plan` and apply the reviewed plan. Bahama creates scoped project access and writes the values to the local environment file. Do not create or copy a token by hand during the normal workflow.

The resulting gitignored `.env.local` contains:

```env
BAHAMA_API_BASE_URL=...
BAHAMA_PROJECT_SLUG=...
BAHAMA_DEV_TOKEN=...
```

Keep `BAHAMA_DEV_TOKEN` server-side only.

Do not:

- expose it in browser code
- prefix it with `VITE_`
- commit it
- include it in deploy archives
- paste it into user-facing UI

## SDK

Install the Bahama SDK when local server-side code needs Bahama-managed resources:

```bash
npm install @bahama-ai/cloud-sdk
```

Use `@bahama-ai/cloud-sdk/server` from server-side code only.

```ts
import {getDb} from "@bahama-ai/cloud-sdk/server";
```

In deployed Bahama app code, the SDK can use `env.DB`. In local code, it uses the Bahama dev proxy values from `.env.local`.

## Local Hono Adapter

The deployable backend entry is `server/index.*`. Keep it Workers-compatible.

For local Node serving, create a separate adapter such as `server/dev.ts`:

```ts
import {config} from "dotenv";
config({path: ".env.local"});

import {serve} from "@hono/node-server";
import app from "./index";

serve(
  {
    fetch: (req) =>
      app.fetch(req, {
        BAHAMA_API_BASE_URL: process.env.BAHAMA_API_BASE_URL,
        BAHAMA_PROJECT_SLUG: process.env.BAHAMA_PROJECT_SLUG,
        BAHAMA_DEV_TOKEN: process.env.BAHAMA_DEV_TOKEN,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      }),
    port: 3001,
  },
  () => console.log("API server -> http://localhost:3001"),
);
```

Install local-only adapter dependencies only when needed:

```bash
npm install -D dotenv tsx @hono/node-server
```

Never import `@hono/node-server` from `server/index.*`.

## Vite Proxy

When running Vite frontend and local Hono separately, proxy `/api` to the local Hono server.

Framework-neutral `vite.config.ts` proxy shape:

```ts
import {defineConfig} from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
```

Use relative frontend API calls such as `/api/notes` so the same code works locally and after Bahama deployment.

## Local Secrets

For local provider testing, add development secret values to `.env.local` with the same names expected in production, such as `OPENAI_API_KEY`.

Read `secrets.md` before handling provider credentials.
