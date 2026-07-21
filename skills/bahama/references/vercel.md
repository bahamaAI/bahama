# Vercel

Vercel is the current Bahama host for Next.js. Bahama's verified Vercel subset also includes Vite SPAs, Vite frontends with Hono APIs, standalone Hono APIs, and static sites in an account owned by the user.

Bahama uses Vercel's official CLI to choose the account, create or adopt the project, transfer production environment variables, deploy local source, and verify the production URL.

## Check installation and login

Ask Bahama to inspect the Vercel setup:

```bash
bahama auth status vercel
```

If the result is `installation_required`, ask permission and install the official CLI using the returned instruction, currently:

```bash
npm install -g vercel
```

Bahama requires Vercel CLI v51 or newer because resumable deployments depend on its structured deployment ID output.

Then start the delegated login:

```bash
bahama auth login vercel
```

The user completes Vercel's browser flow. Verify with `bahama auth status vercel`, then retry the plan. Do not ask the user for a Vercel token unless they have independently chosen a token-based CLI setup.

Confirm current Bahama support with:

```bash
bahama providers vercel --format agent
```

## Match the application shape

Use the application's real composition in `application.framework`:

| Shape         | Vercel project preset |
| :------------ | :-------------------- |
| `nextjs`      | `nextjs`              |
| `vite-spa`    | `vite`                |
| `vite-hono`   | `vite`                |
| `hono-api`    | `hono`                |
| `static-site` | Other                 |

For `vite-hono`, the repository must already satisfy Vercel's Hono entry or function-routing conventions. Bahama does not generate provider-specific entry files or rewrite source.

For `vite-hono` and `hono-api`, set `config.healthPath` on the Vercel application or environment to a public backend route that returns HTTP 2xx or 3xx, for example:

```yaml
environments:
  production:
    provider: vercel
    config:
      healthPath: /api/health
```

Do not use the SPA root as the Hono health path. Bahama requires this value so a working frontend cannot hide a missing backend. Other Vercel shapes use `/` unless `healthPath` is set explicitly.

## Choose the Vercel account

A Vercel login may have a personal account and several teams. Bahama does not silently use whichever account the Vercel CLI currently prefers.

When more than one account is available, planning returns a decision. Present the options and write the chosen selector to the returned path, normally:

```yaml
environments:
  production:
    provider: vercel
    config:
      scope: team-slug
```

Set `config.name` only when the Vercel project should have a different name from `project.name`. Do not place Vercel project, team, or deployment IDs in the manifest; Bahama records durable identity in the lock.

## Connect resources

Vercel consumes values through `environments.<name>.variables`. The binding name becomes the production environment-variable name. Bind only capabilities the application actually uses; [manifest.md](manifest.md) describes the syntax.

Bahama keeps secret values sealed until they are handed to the Vercel CLI. They never belong in the manifest, plan, lock, receipt, or agent output.

## Deploy safely

Keep `application.framework` accurate. Bahama translates it to the compatible Vercel project preset, and correcting a live mismatch requires approval.

Deployments use the project and account recorded in the plan and lock. A stray `.vercel/project.json` cannot redirect Bahama to a different project, although Bahama may warn about the mismatch.

Bahama records Vercel's immutable deployment id as soon as submission is accepted. If readiness polling stops or fails, follow the returned recovery instruction and rerun the same apply; it resumes that deployment instead of publishing a duplicate. Use `bahama status --json` to inspect live state, not as a substitute for resuming the unfinished apply.

Vercel-owned configuration such as `vercel.json` can add crons, rewrites, and routing. Bahama does not validate every Vercel feature; it fingerprints the file and requires approval after it changes. Check Vercel's own documentation before adding those features.

If the Vercel project is deleted while other resources remain healthy, keep the lock and re-plan. Bahama can create a replacement project and reconnect the declared variables without replacing the database.
