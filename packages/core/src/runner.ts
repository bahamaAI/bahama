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
        return {
          exitCode: result.exitCode ?? 1,
          stdout: this.deps.redactor.redact(result.stdout ?? ""),
          stderr: this.deps.redactor.redact(result.stderr ?? ""),
          timedOut: result.timedOut ?? false,
        };
      } catch (error) {
        if (error instanceof ExecaError) {
          return {
            exitCode: error.exitCode ?? 1,
            stdout: this.deps.redactor.redact(String(error.stdout ?? "")),
            stderr: this.deps.redactor.redact(String(error.stderr ?? error.message)),
            timedOut: error.timedOut ?? false,
          };
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
