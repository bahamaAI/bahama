import type { CredentialSource, JsonObject, Logger, ProviderContext } from "@bahama/provider-kit";
import { RedactingHttpClient } from "./http.js";
import { Redactor } from "./redact.js";
import { SafeRunner } from "./runner.js";
import { InMemorySecretBroker } from "./secret-broker.js";

export interface EngineOptions {
  projectRoot: string;
  signal?: AbortSignal;
  /** Where diagnostic lines go; defaults to stderr. Always redacted. */
  logSink?: (line: string) => void;
  verbose?: boolean;
  /**
   * Per-provider raw-token suppliers for CLI-managed auth (e.g. the Bahama
   * Cloud OAuth store). Each call must return a token valid right now —
   * refreshing if needed — or null when logged out. The engine seals the
   * value before any driver sees it.
   */
  tokenSuppliers?: Record<
    string,
    (options?: { forceRefresh?: boolean }) => Promise<string | null>
  >;
}

/**
 * One Engine per CLI invocation: a shared redactor and secret broker, and a
 * ProviderContext factory so every driver runs inside the same safety
 * envelope. Also the seam tests use to point drivers at a sandbox.
 */
export class Engine {
  readonly redactor = new Redactor();
  readonly broker = new InMemorySecretBroker(this.redactor);
  readonly signal: AbortSignal;
  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
    this.signal = options.signal ?? new AbortController().signal;
  }

  contextFor(providerId: string): ProviderContext {
    const supplier = this.options.tokenSuppliers?.[providerId];
    const credentials: CredentialSource | undefined = supplier
      ? {
          freshToken: async (options) => {
            const raw = await supplier(options);
            return raw === null ? null : this.broker.seal(`${providerId}.accessToken`, raw);
          },
        }
      : undefined;
    return {
      projectRoot: this.options.projectRoot,
      run: new SafeRunner({
        redactor: this.redactor,
        broker: this.broker,
        signal: this.signal,
        defaultCwd: this.options.projectRoot,
      }),
      http: new RedactingHttpClient({ redactor: this.redactor, signal: this.signal }),
      secrets: this.broker,
      ...(credentials !== undefined ? { credentials } : {}),
      log: this.loggerFor(providerId),
      signal: this.signal,
      interactive: false,
    };
  }

  private loggerFor(providerId: string): Logger {
    const sink = this.options.logSink ?? ((line: string) => process.stderr.write(`${line}\n`));
    const emit = (level: string, message: string, fields?: JsonObject) => {
      const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
      sink(this.redactor.redact(`[${level}] ${providerId}: ${message}${suffix}`));
    };
    return {
      debug: (message, fields) => {
        if (this.options.verbose) emit("debug", message, fields);
      },
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
    };
  }
}
