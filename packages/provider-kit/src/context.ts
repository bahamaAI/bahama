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
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  /** Captured and redacted before the driver sees them. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

/** The injected execution context handed to every driver method. */
export interface ProviderContext {
  projectRoot: string;
  run: SubprocessRunner;
  http: HttpClient;
  secrets: SecretBroker;
  log: Logger;
  /** Cooperative cancellation; long polls must respect it. */
  signal: AbortSignal;
  /**
   * Non-interactive mode is the default and only mode: drivers must never
   * wait on a TTY. This flag exists so a driver can tailor `loginHint`s.
   */
  interactive: false;
}
