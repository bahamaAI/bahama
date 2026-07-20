import { spawn } from "node:child_process";
import { clearCloudToken, cloudLogin, freshCloudToken } from "../cloud-auth.js";
import { UsageError, buildEngine, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

/**
 * Auth is provider-owned. For CLI-backed providers (vercel, neon) `login`
 * hands off to the official tool's own flow; Bahama never sees or stores
 * those credentials. The bahama-cloud OAuth flow lands with its driver.
 *
 * Bahama launches official provider authentication interactively. The
 * provider owns the browser/device flow and credential store; after it exits,
 * Bahama probes again and reports the authenticated identity.
 */
export async function runAuth(
  action: "login" | "status" | "logout",
  providerId: string,
  options: { noBrowser: boolean },
  emitOptions: EmitOptions,
): Promise<never> {
  // Bahama Cloud has no external CLI: this binary IS the OAuth client.
  if (providerId === "bahama-cloud") {
    return runCloudAuth(action, options, emitOptions);
  }

  const registry = buildRegistry();
  const driver = registry.get(providerId);
  if (!driver) {
    throw new UsageError(`Unknown provider \`${providerId}\`. Available: ${[...registry.keys()].join(", ") || "(none)"}.`);
  }

  const engine = buildEngine(process.cwd());
  const probe = await driver.probe(engine.contextFor(providerId), { intent: [], locked: [] });

  if (!probe.tool.installed) {
    emit(
      envelope(
        "auth",
        "installation_required",
        `The ${providerId} provider CLI is not installed.`,
        { provider: providerId, state: "missing-tool" },
        {
          requirements: [
            {
              kind: "installation",
              providerId,
              tool: providerId,
              installHint: probe.tool.installHint ?? `Install the ${providerId} CLI`,
            },
          ],
        },
      ),
      emitOptions,
    );
  }

  if (action === "status") {
    const authenticated = probe.auth.state === "authenticated";
    emit(
      envelope(
        "auth",
        authenticated ? "succeeded" : "auth_required",
        authenticated
          ? `Authenticated with ${providerId} as ${probe.auth.identity ?? "unknown"}.`
          : `Not authenticated with ${providerId}.`,
        { provider: providerId, state: probe.auth.state, identity: probe.auth.identity ?? null },
        authenticated
          ? {}
          : {
              requirements: [
                {
                  kind: "auth",
                  providerId,
                  loginHint: probe.auth.loginHint ?? `bahama auth login ${providerId}`,
                  reason: probe.auth.state === "expired" ? "expired" : "missing",
                },
              ],
            },
      ),
      emitOptions,
    );
  }

  if (action === "login" && probe.auth.state === "authenticated") {
    emit(
      envelope("auth", "succeeded", `Already authenticated with ${providerId} as ${probe.auth.identity ?? "unknown"}.`, {
        provider: providerId,
        state: probe.auth.state,
        identity: probe.auth.identity ?? null,
      }),
      emitOptions,
    );
  }

  const args = action === "login" ? driver.authCommands?.loginArgs : driver.authCommands?.logoutArgs;
  if (!args) {
    const hint =
      action === "login"
        ? (probe.auth.loginHint ?? `Use the ${providerId} provider's official login`)
        : `The ${providerId} CLI does not expose a supported logout command.`;
    emit(
      envelope(
        "auth",
        "decision_required",
        hint,
        { provider: providerId, state: probe.auth.state },
      ),
      emitOptions,
    );
  }

  const context = engine.contextFor(providerId);
  let executable: string | null = null;
  for (const candidate of driver.authCommands?.executables ?? []) {
    executable = await context.run.which(candidate);
    if (executable) break;
  }
  if (!executable) {
    emit(
      envelope("auth", "installation_required", `The ${providerId} authentication command is not available.`, {
        provider: providerId,
      }),
      emitOptions,
    );
  }

  const exitCode = await runInteractiveAuth(executable, args, options, emitOptions);
  if (exitCode !== 0) {
    emit(
      envelope(
        "auth",
        action === "login" ? "auth_required" : "failed",
        `${providerId} ${action} exited with code ${exitCode}.`,
        { provider: providerId, exitCode },
      ),
      emitOptions,
    );
  }

  const verifiedEngine = buildEngine(process.cwd());
  const verified = await driver.probe(verifiedEngine.contextFor(providerId), { intent: [], locked: [] });
  const authenticated = verified.auth.state === "authenticated";
  const succeeded = action === "login" ? authenticated : !authenticated;
  emit(
    envelope(
      "auth",
      succeeded ? "succeeded" : action === "login" ? "auth_required" : "failed",
      succeeded
        ? action === "login"
          ? `Authenticated with ${providerId} as ${verified.auth.identity ?? "unknown"}.`
          : `Logged out of ${providerId}.`
        : action === "login"
          ? `${providerId} login completed, but no authenticated session was detected.`
          : `${providerId} logout completed, but the session is still authenticated.`,
      {
        provider: providerId,
        state: verified.auth.state,
        identity: verified.auth.identity ?? null,
      },
    ),
    emitOptions,
  );
}

function runInteractiveAuth(
  executable: string,
  args: string[],
  options: { noBrowser: boolean },
  emitOptions: EmitOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Provider auth must stay interactive even when Bahama was launched by an
    // agent or CI-like shell. --no-browser leaves URL/device output visible.
    delete env["CI"];
    if (options.noBrowser) env["BROWSER"] = "echo";
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env,
      stdio: emitOptions.json ? ["inherit", 2, 2] : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${executable} ${args.join(" ")} was terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function runCloudAuth(
  action: "login" | "status" | "logout",
  options: { noBrowser: boolean },
  emitOptions: EmitOptions,
): Promise<never> {
  if (action === "login") {
    const result = await cloudLogin({ noBrowser: options.noBrowser });
    emit(
      envelope("auth", result.ok ? "succeeded" : "auth_required", result.message, { provider: "bahama-cloud" }),
      emitOptions,
    );
  }
  if (action === "logout") {
    const removed = await clearCloudToken();
    emit(
      envelope("auth", "succeeded", removed ? "Logged out of Bahama Cloud." : "No Bahama Cloud session to remove.", {
        provider: "bahama-cloud",
      }),
      emitOptions,
    );
  }
  const token = await freshCloudToken();
  emit(
    envelope(
      "auth",
      token ? "succeeded" : "auth_required",
      token ? "Authenticated with Bahama Cloud." : "Not authenticated with Bahama Cloud.",
      { provider: "bahama-cloud", state: token ? "authenticated" : "unauthenticated" },
      token
        ? {}
        : {
            requirements: [
              { kind: "auth", providerId: "bahama-cloud", loginHint: "bahama auth login bahama-cloud", reason: "missing" },
            ],
          },
    ),
    emitOptions,
  );
}

/**
 * Host integration status. The skill and plugin shells are distributed with
 * the monorepo; setup verifies the CLI is reachable and reports what the
 * chosen host needs. Deliberately conservative: it does not write into
 * editor/agent config directories it does not own.
 */
export async function runSetup(host: string, cliVersion: string, emitOptions: EmitOptions): Promise<never> {
  const registry = buildRegistry();
  emit(
    envelope(
      "setup",
      "succeeded",
      `Bahama CLI is installed and executable. Host \`${host}\`: distribute the bahama skill via your agent's plugin/skill mechanism; no MCP server is required or registered.`,
      {
        host,
        cliVersion,
        providers: [...registry.keys()],
      },
    ),
    emitOptions,
  );
}
