# Secrets

Use this file before adding provider keys, OAuth client secrets, webhook signing secrets, Stripe keys, OpenAI keys, or local secret values.

This guidance applies when `application.provider: bahama-cloud`. Bahama Cloud project secrets are write-only runtime values for third-party credentials. The agent must never ask the user to paste raw secret values into chat.

## Product Rule

When code needs a credential:

1. Choose the exact secret name, such as `OPENAI_API_KEY` or `STRIPE_SECRET_KEY`.
2. Tell the user to add it at `https://www.bahama.ai/dashboard/projects/:slug/secrets`.
3. Read it only from server-side Worker/Hono code as `env.SECRET_NAME`.
4. Return only safe application data to browser code.

Bahama stores only secret metadata such as name, masked suffix, status, and timestamps. Raw values are written to the tenant Worker runtime secret store and are not returned through the CLI, browser APIs, or the database.

If the project has not deployed yet, Bahama may create a placeholder tenant Worker so secrets have a runtime target. This does not mean the app is deployed; the real app deployment replaces that placeholder later.

Updating a secret is runtime configuration. The user does not need to redeploy source code just to add, replace, or delete a secret.

## Server-Side Only

Secret-backed behavior must live in Hono or Worker server code.

Good pattern:

```ts
app.post("/api/generate", async (c) => {
  const apiKey = c.env.OPENAI_API_KEY;

  if (!apiKey) {
    return c.json({error: "OPENAI_API_KEY is not configured."}, 500);
  }

  // Call the provider here. Return only safe data.
  return c.json({ok: true});
});
```

Do not:

- put secret values in React/browser code
- put secret values in `VITE_*` variables
- return secret values from API routes
- log secret values
- include secret values in tool output or transcripts
- commit `.env.local` or any file containing secrets
- put secret values in `bahama.yaml` or `bahama.lock`

Create provider clients inside request handling when key rotation should take effect quickly. Avoid module-scope clients built from secrets unless stale secret values are acceptable.

## Local Testing With Secrets

For local server-side testing, tell the user to add values directly to their local `.env.local` (create this file if needed); do not ask them to paste values into chat. Always exclude this from any git commits or uploads.

Example:

```env
OPENAI_API_KEY=...
STRIPE_SECRET_KEY=...
```

If local code also needs the live Bahama-managed database, `.env.local` may include Bahama dev-token values. Dev tokens are obtained through the Bahama Cloud dashboard or a `bahama auth`-authenticated flow (TODO: exact command pending the bahama-cloud driver).

See `local-development.md` for details.

```env
BAHAMA_API_BASE_URL=...
BAHAMA_PROJECT_SLUG=...
BAHAMA_DEV_TOKEN=...
OPENAI_API_KEY=...
```

Load `.env.local` explicitly in local Node adapters. Do not rely on `import "dotenv/config"` for Bahama local dev because it may load `.env` instead of `.env.local`.

Never include `.env.local` in deploy archives.
