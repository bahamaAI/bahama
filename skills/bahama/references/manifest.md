# Writing `bahama.yaml`

`bahama.yaml` describes the infrastructure this application should have. Add only the environments and resources required by the task. Provider IDs, credentials, and discovered resource identity do not belong here.

The agent may edit this file. Bahama compares it with provider state and `bahama.lock`, then plans the operations needed to make them match.

## Start with the application and its environments

A hosted application without other infrastructure can be this small:

```yaml
version: 1
project:
  name: my-app
application:
  framework: vite-spa
environments:
  production:
    provider: bahama-cloud
```

- `project.name` is the portable stack name and default provider-facing name. Use lowercase letters, numbers, and hyphens. Bahama Cloud uses it as a globally unique public name, so choose a less generic name if the first one is unavailable.
- `application.framework` must be supported by every hosted environment.
- `application.dir` points to the application when it lives below the repository root.
- `environments` are places where the application runs or receives configuration. `local` writes a protected env file; hosted environments can deploy.
- `resources` are optional managed services the application uses.
- `bindings` connect a value produced by one provider to a destination that consumes it.

The top-level structure is strict so misspelled keys fail. Provider `config` blocks are validated by their provider.

## Add resources only when required

This example adds Postgres because the application requires it, makes the connection available locally, and passes it to the hosted environment:

```yaml
environments:
  local:
    provider: local
  production:
    provider: vercel
resources:
  database:
    provider: neon
    engine: postgres
bindings:
  DATABASE_URL:
    from: resources.database.connectionUrl
    to:
      - environments.local.variables
      - environments.production.variables
```

The binding name becomes the destination variable name. Sources and destinations use capabilities reported by `bahama providers <id> --format agent`:

```text
resources.<resource-name>.<capability>
environments.<environment-name>.<capability>
```

The source must produce the capability and every destination must consume it. Send a value only to environments that need it. Let `bahama plan` validate the composition.

## Provider-native resources name their environment

A resource built into a host belongs to an environment on the same provider. Bahama Cloud's native database is one example:

```yaml
resources:
  database:
    provider: bahama-cloud
    engine: d1
    environment: production
```

It is exposed to deployed server code as `env.DB`; it does not produce a connection string. To use it from local server code, add the three development-access bindings shown in [bahama-runtime.md](bahama-runtime.md).

## Keep identity and secrets out

Never write `projectId`, `accountId`, `orgId`, deployment IDs, connection strings, or secret literals into the manifest. Bahama records verified identity in `bahama.lock` and transfers secret capabilities without serializing their values.

Some `config` fields are safe selectors. For example, Vercel `scope` and Neon `org` answer an account decision. Copy the value to the exact `writeBack` path returned by planning; do not invent it. A provider may also support `config.name` when its resource name should differ from `project.name`.

## Current limits

- Environments require an `application` framework.
- Only one environment per provider is currently supported.
- A native resource must name an environment using the same provider.
- The manifest cannot contain raw secrets, request destruction, selectively detach one resource, or attach an arbitrary provider ID.
- Legacy application-provider manifests may still parse, but new manifests should use `environments`.

After each meaningful edit, run `bahama plan`. Never edit `bahama.lock` to make the manifest appear applied.
