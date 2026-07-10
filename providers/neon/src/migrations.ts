/**
 * The in-process migration executor, isolated from `pg` behind a tiny
 * query-executor callback so tests can inject a recording stub and the driver
 * can hand in a live client. No file here ever sees a connection string.
 */

export interface MigrationFile {
  /** File name, e.g. `0001_init.sql`. Ordering is lexicographic by name. */
  name: string;
  sql: string;
}

/** Minimal query surface: `pg.Client#query` satisfies it directly. */
export type QueryExecutor = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface MigrationSummary {
  total: number;
  applied: string[];
  alreadyApplied: string[];
}

export const MIGRATIONS_TABLE = "_bahama_migrations";

/**
 * v0.1 refuses destructive DDL/DML outright. A regex approximation is the
 * documented contract: statements inside quoted strings can false-positive,
 * and that is an acceptable failure direction for a guard rail.
 */
const DESTRUCTIVE_PATTERN =
  /\b(drop\s+table|drop\s+column|drop\s+database|drop\s+schema|truncate)\b/i;

/** Returns the offending phrase when the SQL contains destructive statements. */
export function findDestructiveStatement(sql: string): string | null {
  const match = DESTRUCTIVE_PATTERN.exec(sql);
  return match ? match[1]!.replace(/\s+/g, " ").toUpperCase() : null;
}

/** Throws before ANY database work when a checked-in migration is destructive. */
export function assertNonDestructive(files: MigrationFile[]): void {
  for (const file of files) {
    const phrase = findDestructiveStatement(file.sql);
    if (phrase) {
      throw new Error(
        `destructive migrations are rejected in v0.1: ${file.name} contains ${phrase}. ` +
          "Write an additive migration instead, or run destructive changes manually.",
      );
    }
  }
}

/**
 * Applies every unapplied migration in name order, each inside its own
 * transaction that also records the ledger row — a migration and its
 * bookkeeping commit or roll back together.
 */
export async function runMigrations(
  files: MigrationFile[],
  exec: QueryExecutor,
): Promise<MigrationSummary> {
  assertNonDestructive(files);

  await exec(
    `create table if not exists ${MIGRATIONS_TABLE} (` +
      "name text primary key, applied_at timestamptz not null default now())",
  );
  const recorded = await exec(`select name from ${MIGRATIONS_TABLE}`);
  const done = new Set(recorded.rows.map((row) => String(row["name"])));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const file of files) {
    if (done.has(file.name)) {
      alreadyApplied.push(file.name);
      continue;
    }
    await exec("begin");
    try {
      await exec(file.sql);
      await exec(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [file.name]);
      await exec("commit");
    } catch (error) {
      try {
        await exec("rollback");
      } catch {
        // the connection may already be unusable; the original error matters
      }
      throw new Error(`migration ${file.name} failed: ${(error as Error).message}`);
    }
    applied.push(file.name);
  }
  return { total: files.length, applied, alreadyApplied };
}

/** Postcondition probe: how many of the given migration names the ledger records. */
export async function countApplied(names: string[], exec: QueryExecutor): Promise<number> {
  const result = await exec(
    `select count(*)::int as count from ${MIGRATIONS_TABLE} where name = any($1)`,
    [names],
  );
  const raw = result.rows[0]?.["count"];
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}
