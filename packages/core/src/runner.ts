import { execa, ExecaError } from "execa";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { RunOptions, RunResult, SecretRef, SubprocessRunner } from "@bahama-ai/provider-kit";
import type { InMemorySecretBroker } from "./secret-broker.js";
import type { Redactor } from "./redact.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The only way a driver runs a subprocess. Argument arrays (no shell), stdin
 * closed unless a sealed secret is being piped, output captured and redacted
 * before the driver sees it, cooperative cancellation, non-interactive env.
 */
export class SafeRunner implements SubprocessRunner {
  constructor(
    private readonly deps: {
      redactor: Redactor;
      broker: InMemorySecretBroker;
      signal: AbortSignal;
      defaultCwd: string;
    },
  ) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const secretRef: SecretRef | undefined = options.secretStdin;

    const execute = async (input?: string): Promise<RunResult> => {
      try {
        const result = await execa(command, args, {
          cwd: options.cwd ?? this.deps.defaultCwd,
          env: {
            ...options.env,
            // Providers' CLIs honor these to suppress prompts and color codes.
            CI: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          ...(input === undefined ? { stdin: "ignore" as const } : { input }),
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          cancelSignal: this.deps.signal,
          reject: false,
          all: false,
        });
        return this.capture(
          result.exitCode ?? 1,
          result.stdout ?? "",
          result.stderr ?? "",
          result.timedOut ?? false,
          options,
        );
      } catch (error) {
        if (error instanceof ExecaError) {
          return this.capture(
            error.exitCode ?? 1,
            String(error.stdout ?? ""),
            String(error.stderr ?? error.message),
            error.timedOut ?? false,
            options,
          );
        }
        throw error;
      }
    };

    if (secretRef) {
      // The raw value exists only inside this closure; output is redacted anyway.
      return this.deps.broker.use(secretRef, async (raw) => execute(raw));
    }
    return execute();
  }

  /**
   * Capture-time boundary: when the caller declared stdout secret, seal it
   * (which registers it with the redactor) BEFORE either stream is redacted —
   * so the returned stdout/stderr, and every later log or error message that
   * passes through the redactor, can only ever contain the placeholder.
   */
  private capture(
    exitCode: number,
    rawStdout: string,
    rawStderr: string,
    timedOut: boolean,
    options: RunOptions,
  ): RunResult {
    let secret: SecretRef | undefined;
    if (options.captureSecretStdout && rawStdout.trim() !== "") {
      secret = this.deps.broker.seal(options.captureSecretStdout.name, rawStdout.trim());
    }
    return {
      exitCode,
      stdout: this.deps.redactor.redact(rawStdout),
      stderr: this.deps.redactor.redact(rawStderr),
      timedOut,
      ...(secret !== undefined ? { secret } : {}),
    };
  }

  async which(command: string): Promise<string | null> {
    const pathEnv = process.env.PATH ?? "";
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = join(dir, command + ext);
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // keep looking
        }
      }
    }
    return null;
  }
}
