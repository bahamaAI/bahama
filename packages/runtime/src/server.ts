declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

export type BahamaSqlParam =
  | string
  | number
  | boolean
  | null
  | ArrayBuffer
  | ArrayBufferView;
export type BahamaRawOptions = {
  columnNames?: boolean;
};

export type BahamaQueryResult<Row = Record<string, unknown>> = {
  results?: Row[];
  success?: boolean;
  meta?: Record<string, unknown>;
  error?: string;
};

export type BahamaExecResult = {
  count: number;
  duration: number;
};

export type BahamaPreparedStatement<Row = Record<string, unknown>> = {
  bind(...params: BahamaSqlParam[]): BahamaPreparedStatement<Row>;
  all<T = Row>(): Promise<BahamaQueryResult<T>>;
  run<T = Row>(): Promise<BahamaQueryResult<T>>;
  raw<T = unknown[]>(options?: BahamaRawOptions): Promise<T[]>;
  first<T = Row>(columnName?: string): Promise<T | null>;
};

export type BahamaSessionBookmark =
  | "first-primary"
  | "first-unconstrained"
  | string;

export type BahamaDatabaseSession<Row = Record<string, unknown>> = {
  prepare(sql: string): BahamaPreparedStatement<Row>;
  batch<T = Row>(
    statements: BahamaPreparedStatement[],
  ): Promise<BahamaQueryResult<T>[]>;
  getBookmark(): string | null;
};

export type BahamaDatabase<Row = Record<string, unknown>> = {
  prepare(sql: string): BahamaPreparedStatement<Row>;
  batch<T = Row>(
    statements: BahamaPreparedStatement[],
  ): Promise<BahamaQueryResult<T>[]>;
  exec(sql: string): Promise<BahamaExecResult>;
  dump(): Promise<ArrayBuffer>;
  withSession(firstQuery?: BahamaSessionBookmark): BahamaDatabaseSession<Row>;
};

export type BahamaEnv = {
  DB?: BahamaDatabase;
  BAHAMA_API_BASE_URL?: string;
  BAHAMA_PROJECT_SLUG?: string;
  BAHAMA_DEV_TOKEN?: string;
};

export type BahamaDbOptions = {
  apiBaseUrl?: string;
  projectSlug?: string;
  devToken?: string;
};

type DevQueryResponse = {
  ok: true;
  result: unknown;
};

function getProcessEnv() {
  return typeof process === "undefined" ? {} : process.env ?? {};
}

function readConfig(env?: BahamaEnv, options: BahamaDbOptions = {}) {
  const processEnv = getProcessEnv();
  const apiBaseUrl =
    options.apiBaseUrl ??
    env?.BAHAMA_API_BASE_URL ??
    processEnv.BAHAMA_API_BASE_URL;
  const projectSlug =
    options.projectSlug ??
    env?.BAHAMA_PROJECT_SLUG ??
    processEnv.BAHAMA_PROJECT_SLUG;
  const devToken =
    options.devToken ??
    env?.BAHAMA_DEV_TOKEN ??
    processEnv.BAHAMA_DEV_TOKEN;

  if (!apiBaseUrl || !projectSlug || !devToken) {
    throw new Error(
      "Bahama local database access requires BAHAMA_API_BASE_URL, BAHAMA_PROJECT_SLUG, and BAHAMA_DEV_TOKEN. Keep BAHAMA_DEV_TOKEN server-side only.",
    );
  }

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
    projectSlug,
    devToken,
  };
}

function normalizeResult<Row>(result: unknown): BahamaQueryResult<Row> {
  const firstResult = Array.isArray(result) ? result[0] : result;

  if (
    firstResult &&
    typeof firstResult === "object" &&
    ("results" in firstResult || "success" in firstResult || "meta" in firstResult)
  ) {
    return firstResult as BahamaQueryResult<Row>;
  }

  return {
    results: Array.isArray(firstResult) ? (firstResult as Row[]) : [],
    success: true,
    meta: {},
  };
}

function serializeLocalParam(param: BahamaSqlParam) {
  if (param instanceof ArrayBuffer || ArrayBuffer.isView(param)) {
    throw new Error(
      "Bahama local database proxy does not support binary SQL parameters yet.",
    );
  }

  return param;
}

class BahamaDevPreparedStatement<Row = Record<string, unknown>> {
  private params: BahamaSqlParam[] = [];

  constructor(
    private readonly config: ReturnType<typeof readConfig>,
    private readonly sql: string,
  ) {}

  bind(...params: BahamaSqlParam[]) {
    this.params = params;
    return this;
  }

  async all<T = Row>() {
    return this.query<T>();
  }

  async run<T = Row>() {
    return this.query<T>();
  }

  async raw<T = unknown[]>(options: BahamaRawOptions = {}) {
    const result = await this.query<Record<string, unknown>>();
    const rows = result.results ?? [];
    const rawRows = rows.map((row) => Object.values(row));

    if (!options.columnNames) {
      return rawRows as T[];
    }

    const columnNames = rows[0] ? Object.keys(rows[0]) : [];
    return [columnNames, ...rawRows] as T[];
  }

  async first<T = Row>(columnName?: string) {
    const result = await this.query<Record<string, unknown>>();
    const row = result.results?.[0] ?? null;

    if (!row || !columnName) {
      return row as T | null;
    }

    return (row[columnName] ?? null) as T | null;
  }

  private async query<T>() {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/dev/projects/${encodeURIComponent(
        this.config.projectSlug,
      )}/d1/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.devToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sql: this.sql,
          params: this.params.map(serializeLocalParam),
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | DevQueryResponse
      | { ok: false; error?: string }
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload && "error" in payload && payload.error
          ? payload.error
          : `Bahama dev database query failed with status ${response.status}.`,
      );
    }

    return normalizeResult<T>(payload.result);
  }
}

class BahamaDevDatabase {
  private readonly config: ReturnType<typeof readConfig>;

  constructor(env?: BahamaEnv, options?: BahamaDbOptions) {
    this.config = readConfig(env, options);
  }

  prepare(sql: string) {
    return new BahamaDevPreparedStatement(this.config, sql);
  }

  async batch<T = Record<string, unknown>>(statements: BahamaPreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  async exec(sql: string) {
    const start = Date.now();
    const result = await new BahamaDevPreparedStatement(this.config, sql).run();
    return {
      count: result.success === false ? 0 : 1,
      duration: Date.now() - start,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("Bahama local database proxy does not support dump().");
  }

  withSession(): BahamaDatabaseSession {
    return {
      prepare: (sql) => this.prepare(sql),
      batch: (statements) => this.batch(statements),
      getBookmark: () => null,
    };
  }
}

export function getDb(env?: BahamaEnv, options?: BahamaDbOptions) {
  if (env?.DB?.prepare) {
    return env.DB;
  }

  return new BahamaDevDatabase(env, options);
}
