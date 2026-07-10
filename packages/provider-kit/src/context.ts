import type { JsonObject } from "./json.js";
import type { SecretBroker, SecretRef } from "./secrets.js";

/**
 * Everything a driver may touch is injected. Drivers never instantiate their
 * own process runner, HTTP client, or credential handling — that is what
 * keeps every provider inside the same safety envelope (argument-array
 * subprocesses, capture-time redaction, sealed secrets, cancellation).
 */

export interface RunOptions {
  /** Working directory; defaults to the project root. */
  cwd?: string;
  /** Extra environment variables (values are redaction-scanned). */
  env?: Record<string, string>;
  /**
   * Pipe a sealed secret to the child's stdin — the ONLY way a secret
   * reaches a subprocess (e.g. `vercel env add` reads its value there).
   * Stdin is closed otherwise; interactive prompts fail fast by design.
   */
  secretStdin?: SecretRef;
  /**
   * Treat the child's ENTIRE (trimmed) stdout as one secret value — the way
   * to run commands that print a credential (e.g. `neon connection-string`).
   * The runner registers and seals the value AT CAPTURE, before the driver or
   * any error path can observe the raw bytes: the result's `stdout` arrives
   * already redacted and `secret` carries the sealed handle.
   */
  captureSecretStdout?: { name: string };
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  /** Captured and redacted before the driver sees them. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Sealed stdout, present when `captureSecretStdout` was set and stdout was non-empty. */
  secret?: SecretRef;
}

export interface SubprocessRunner {
  /** Run `command` with an argument ARRAY. There is no shell-string variant. */
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** Resolve a binary on PATH; null when not installed. */
  which(command: string): Promise<string | null>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** JSON body. To send a secret, use `secretBody` from the broker-aware client. */
  body?: JsonObject;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw text body; redacted diagnostics only ever see a truncated copy. */
  body: string;
  json<T = unknown>(): T;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Logger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
}

/**
 * CLI-managed credentials for providers whose auth the CLI itself owns
 * (Bahama Cloud). `freshToken` returns a sealed access token that is valid
 * RIGHT NOW — refreshing behind the scenes when the stored one is stale — or
 * null when not logged in. Drivers call it per request (it is cheap when the
 * token is still fresh) instead of caching a token across a long operation.
 */
export interface CredentialSource {
  freshToken(): Promise<SecretRef | null>;
}

/** The injected execution context handed to every driver method. */
export interface ProviderContext {
  projectRoot: string;
  run: SubprocessRunner;
  http: HttpClient;
  secrets: SecretBroker;
  /** Present only for providers the CLI authenticates itself (e.g. bahama-cloud). */
  credentials?: CredentialSource;
  log: Logger;
  /** Cooperative cancellation; long polls must respect it. */
  signal: AbortSignal;
  /**
   * Non-interactive mode is the default and only mode: drivers must never
   * wait on a TTY. This flag exists so a driver can tailor `loginHint`s.
   */
  interactive: false;
}
