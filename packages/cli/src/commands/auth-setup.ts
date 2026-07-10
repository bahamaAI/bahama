import { clearCloudToken, cloudLogin, freshCloudToken } from "../cloud-auth.js";
import { UsageError, buildEngine, buildRegistry, emit, envelope, type EmitOptions } from "../runtime.js";

/**
 * Auth is provider-owned. For CLI-backed providers (vercel, neon) `login`
 * hands off to the official tool's own flow; Bahama never sees or stores
 * those credentials. The bahama-cloud OAuth flow lands with its driver.
 *
 * Agents should not run `login` themselves: the agent contract says surface
 * `auth_required` to the human and let them log in from their own terminal —
 * that keeps codes and tokens out of agent transcripts.
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

  // login / logout delegate to the provider's official flow. Drivers that
  // wrap external CLIs report the exact command; interactive flows are never
  // started from here (this process may be agent-driven and headless).
  const hint =
    action === "login"
      ? (probe.auth.loginHint ?? `Use the ${providerId} provider's official login`)
      : `Use the ${providerId} provider's official logout`;
  emit(
    envelope(
      "auth",
      probe.auth.state === "authenticated" && action === "login" ? "succeeded" : "auth_required",
      probe.auth.state === "authenticated" && action === "login"
        ? `Already authenticated with ${providerId} as ${probe.auth.identity ?? "unknown"}.`
        : `Run this in your own terminal: ${hint}`,
      { provider: providerId, hint },
    ),
    emitOptions,
  );
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
export async function runSetup(host: string, emitOptions: EmitOptions): Promise<never> {
  const registry = buildRegistry();
  emit(
    envelope(
      "setup",
      "succeeded",
      `Bahama CLI is installed and executable. Host \`${host}\`: distribute the bahama-builder skill via your agent's plugin/skill mechanism; no MCP server is required or registered.`,
      {
        host,
        cliVersion: "0.1.0-alpha.1",
        providers: [...registry.keys()],
      },
    ),
    emitOptions,
  );
}
