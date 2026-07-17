# Bahama Cloud

Bahama Cloud is the managed, first-party provider. It gives a project an application host, server-side configuration, an optional native SQL database, and a verified deployment path without requiring the user to assemble separate cloud services.

Choose it when the application fits one of its supported shapes. Choose another provider when the framework or database access model does not fit.

## Sign in

Bahama Cloud needs no provider-specific CLI beyond `bahama`. Check the current session with:

```bash
bahama auth status bahama-cloud
```

If authentication is required, run:

```bash
bahama auth login bahama-cloud
```

Bahama opens its browser login. In a headless environment, add `--no-browser` and give the user the displayed URL and code. Verify the session afterward, then retry the blocked command.

See the current provider contract with:

```bash
bahama providers bahama-cloud --format agent
```

## Applications

Bahama Cloud currently supports static sites and bundles, Vite SPAs, Vite with Hono, and Hono APIs. Use only a framework identifier returned by the live provider contract. Do not convert an existing application merely to fit Bahama Cloud without explaining the work and getting agreement.

Before creating or changing application code, read [bahama-cloud-deployment.md](bahama-cloud-deployment.md). It contains the exact framework, routing, packaging, and deployment rules enforced by Bahama Cloud.

Bahama Cloud does not currently declare scheduled jobs or crons as a capability. Do not promise them simply because the underlying infrastructure might make them possible later.

## Use the native database

Bahama Cloud can provision D1 for an application hosted in the same environment:

```yaml
resources:
  database:
    provider: bahama-cloud
    engine: d1
    environment: production
```

Deployed server code receives the database as `env.DB`. It is a runtime binding, not a host, password, or connection string. Browser code calls a server route and never sees the binding.

Bahama provisions and verifies the database, but it does not currently turn a Cloud `migrations/` directory into planned migration steps. Read [bahama-runtime.md](bahama-runtime.md) before writing schema or query code.

The runtime guide also explains how the same database code works locally and after deployment.

## Add project secrets

Use project secrets for third-party credentials such as API keys, OAuth client secrets, and webhook signing secrets.

Choose the exact server-side variable name, then have the user enter the value at:

```text
https://www.bahama.ai/dashboard/projects/<slug>/secrets
```

Use uppercase names that start with a letter or underscore and contain only letters, numbers, and underscores. Names beginning with `BAHAMA_` and other platform-reserved names are rejected. A value must be no larger than 5 KB.

Server code reads the value from `env.SECRET_NAME`. Never ask for the raw value in chat or put it in `bahama.yaml`, `bahama.lock`, source, logs, browser variables, or deployment files. For local testing, use the same name in the protected local env file via the placeholder flow in [local.md](local.md).

A secret can be added before the first source deployment; Bahama prepares the project runtime for it. Adding, replacing, or deleting a secret takes effect without redeploying source, and later deployments preserve project secrets.
