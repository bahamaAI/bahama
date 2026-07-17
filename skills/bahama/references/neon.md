# Neon

Neon gives a Bahama project a standard Postgres database. Select it when the application actually needs Postgres through a connection string, not because of its framework or host.

Bahama uses Neon's official CLI to choose the organization, create or adopt a project, capture its connection string without exposing it, and apply checked-in SQL migrations.

## Check installation and login

Ask Bahama to inspect the Neon setup:

```bash
bahama auth status neon
```

If the CLI is missing, ask permission and follow the returned installation instruction, currently:

```bash
npm install -g neonctl
```

The installed command may be named `neon` or `neonctl`; Bahama detects either one. Start the official authentication flow through Bahama:

```bash
bahama auth login neon
```

After the user finishes authentication, verify with `bahama auth status neon` and retry the plan. Confirm the current provider contract with `bahama providers neon --format agent`.

## Describe the database

The smallest declaration is:

```yaml
resources:
  database:
    provider: neon
    engine: postgres
```

Neon also accepts optional provider configuration:

```yaml
config:
  region: aws-us-east-1
  org: organization-selector
  name: provider-facing-project-name
```

`region` chooses a Neon region. `name` overrides the default `project.name`. `org` identifies the selected organization without pretending it is a resource ID.

When the login can access several organizations, planning returns their real labels and selectors. Present the choices and write the selected value to `resources.<name>.config.org`. A single organization is selected automatically.

## Connect Postgres to the application

Neon produces `connectionUrl` as a secret capability. Bind it to every environment that needs Postgres:

```yaml
bindings:
  DATABASE_URL:
    from: resources.database.connectionUrl
    to:
      - environments.local.variables
      - environments.production.variables
```

Bahama captures the raw value inside its protected runner and keeps it sealed while passing it between providers. Do not print or manually copy it during the normal workflow.

## Manage migrations

Place ordered `.sql` files in the repository-root `migrations/` directory:

```text
migrations/
  0001_create_notes.sql
  0002_add_author.sql
```

During planning, Bahama reads `_bahama_migrations` and includes only pending files. If the ledger cannot be read, the plan warns and safely includes every checked-in migration; apply skips those already recorded. The plan always records every filename and checksum so apply rejects any file changed after planning. Never edit a recorded migration; add a new one.

The current provider rejects recognized destructive migration statements. Keep migrations additive and review them as consequential. A project without a `migrations/` directory simply has no migration step.

The project ID stored in `bahama.lock` remains authoritative even if Neon's generated ID looks unrelated to the project name. Without the lock, adoption falls back to an exact name inside the selected organization; it is not fuzzy.
