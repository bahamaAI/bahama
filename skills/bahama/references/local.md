# Local Development

The `local` provider makes provisioned resource values available to the application's normal development command. It does not create infrastructure or run a server. It writes declared values into a protected env file inside the repository.

There is no separate CLI to install and no account to log into.

By default, local values go to `.env.local`. A project can choose another repository-contained file:

```yaml
environments:
  local:
    provider: local
    config:
      envFile: .env.development.local
```

The provider preserves unrelated entries, adds the file to `.gitignore`, and applies restrictive file permissions. It rejects paths outside the project.

Local receives values through explicit bindings. For example:

```yaml
bindings:
  DATABASE_URL:
    from: resources.database.connectionUrl
    to: environments.local.variables
```

When the source is secret, Bahama keeps it sealed until the local provider writes it. Do not read or echo the value merely to populate the file.

Bahama cannot place an arbitrary secret literal in the manifest. If the application needs a secret that no provider produces — a third-party API key, for example — write `NAME=replace-with-your-key` into the env file yourself and tell the user exactly how to open the file and replace the placeholder. Never ask for the value in chat. If the user pastes a value into chat anyway, write it to the env file without echoing it and suggest rotating the key later; the transcript is not a secret store.

A project can use `local` before it has any hosted environment, or alongside production. After applying the resource bindings, start the app with its normal command such as `npm run dev`. `bahama deploy local` is never valid.
