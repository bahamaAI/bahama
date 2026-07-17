# Vercel

Vercel is the current Bahama host for Next.js. It can also host Vite SPAs and static sites in a Vercel account owned by the user.

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

Then start the delegated login:

```bash
bahama auth login vercel
```

The user completes Vercel's browser flow. Verify with `bahama auth status vercel`, then retry the plan. Do not ask the user for a Vercel token unless they have independently chosen a token-based CLI setup.

Confirm current Bahama support with:

```bash
bahama providers vercel --format agent
```

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

Keep `application.framework` accurate. Bahama carries it into the Vercel project, and correcting a live mismatch requires approval.

Deployments use the project and account recorded in the plan and lock. A stray `.vercel/project.json` cannot redirect Bahama to a different project, although Bahama may warn about the mismatch.

Vercel-owned configuration such as `vercel.json` can add crons, rewrites, and routing. Bahama does not validate every Vercel feature; it fingerprints the file and requires approval after it changes. Check Vercel's own documentation before adding those features.

If the Vercel project is deleted while other resources remain healthy, keep the lock and re-plan. Bahama can create a replacement project and reconnect the declared variables without replacing the database.
