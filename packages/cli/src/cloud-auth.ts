import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "@bahama/core";

/**
 * Bahama Cloud OAuth (Authorization Code + PKCE) for the CLI, against the
 * control plane's seeded public client. Two flows:
 *
 * - loopback: local HTTP server on an ephemeral 127.0.0.1 port (the server
 *   registers loopback redirects with RFC 8252 any-port matching);
 * - display-code: redirect to the hosted /cli/code page, which shows a
 *   single-use code the user pastes back. Works over SSH and in containers.
 *
 * Storage: 0600 credentials file in the OS config dir (BAHAMA_TOKEN env
 * overrides). Refresh tokens ROTATE ON USE server-side with reuse detection
 * that revokes the whole family, so refreshes are serialized behind a file
 * lock — two concurrent CLI processes must never race a refresh.
 */

const CLIENT_ID = process.env["BAHAMA_CLI_OAUTH_CLIENT_ID"] ?? "bahama-cli";
const SCOPES = "openid profile email offline_access bahama:projects";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function cloudBaseUrl(): string {
  return (process.env["BAHAMA_CLOUD_URL"] ?? "https://www.bahama.ai").replace(/\/$/, "");
}

function apiAudience(): string {
  return process.env["BAHAMA_API_AUDIENCE"] ?? `${cloudBaseUrl()}/api`;
}

interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

async function readStore(): Promise<Record<string, StoredCredentials>> {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8")) as Record<string, StoredCredentials>;
  } catch {
    return {};
  }
}

async function writeStore(store: Record<string, StoredCredentials>): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(credentialsPath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export async function storedCloudToken(): Promise<StoredCredentials | null> {
  const env = process.env["BAHAMA_TOKEN"];
  if (env) return { accessToken: env, expiresAt: Number.MAX_SAFE_INTEGER };
  const store = await readStore();
  return store["bahama-cloud"] ?? null;
}

export async function clearCloudToken(): Promise<boolean> {
  const store = await readStore();
  if (!store["bahama-cloud"]) return false;
  delete store["bahama-cloud"];
  await writeStore(store);
  return true;
}

/**
 * Access token for control-plane calls, refreshing when within a minute of
 * expiry. The refresh path holds an exclusive lock because the server
 * rotates refresh tokens on use.
 */
export async function freshCloudToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
  const current = await storedCloudToken();
  if (!current) return null;
  if (!options.forceRefresh && Date.now() < current.expiresAt - 60_000) return current.accessToken;
  if (!current.refreshToken) return current.accessToken; // env token or non-refreshable

  return withRefreshLock(async () => {
    // Another process may have refreshed while we waited on the lock.
    const latest = await storedCloudToken();
    if (!latest) return null;
    if (!latest.refreshToken) return latest.accessToken;
    // A concurrent process may have refreshed while this caller waited. Its
    // new access token already satisfies a forced refresh; do not rotate the
    // newly-issued refresh token a second time.
    if (options.forceRefresh && latest.accessToken !== current.accessToken) return latest.accessToken;
    if (!options.forceRefresh && Date.now() < latest.expiresAt - 60_000) return latest.accessToken;

    const endpoints = await discover();
    const response = await fetch(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: latest.refreshToken,
        client_id: CLIENT_ID,
        resource: apiAudience(),
      }),
    });
    if (!response.ok) return null; // caller reports auth_required
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    await saveTokens(tokens);
    return tokens.access_token;
  });
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = join(configDir(), "credentials.lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch {
      if (Date.now() > deadline) {
        // A crashed process can leave the lock behind; 30s of contention on a
        // sub-second operation means it's stale.
        await rm(lockDir, { recursive: true, force: true });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

interface Endpoints {
  authorization: string;
  token: string;
}

async function discover(): Promise<Endpoints> {
  const response = await fetch(`${cloudBaseUrl()}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`OAuth discovery failed against ${cloudBaseUrl()} (HTTP ${response.status}).`);
  }
  const metadata = (await response.json()) as { authorization_endpoint: string; token_endpoint: string };
  return { authorization: metadata.authorization_endpoint, token: metadata.token_endpoint };
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

export async function cloudLogin(options: { noBrowser: boolean }): Promise<LoginResult> {
  const endpoints = await discover();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const headless =
    options.noBrowser ||
    Boolean(process.env["SSH_CONNECTION"]) ||
    (process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]);

  const authorizeUrl = (redirectUri: string) => {
    const url = new URL(endpoints.authorization);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  };

  const exchange = async (code: string, redirectUri: string): Promise<LoginResult> => {
    const response = await fetch(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: apiAudience(),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, message: `Token exchange failed (HTTP ${response.status}): ${body.slice(0, 300)}` };
    }
    await saveTokens((await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number });
    return { ok: true, message: "Logged in to Bahama Cloud." };
  };

  if (headless) {
    const redirectUri = `${cloudBaseUrl()}/cli/code`;
    process.stderr.write(
      `\nOpen this URL in any browser (any machine), sign in, and paste the code shown:\n\n  ${authorizeUrl(redirectUri)}\n\n`,
    );
    const code = await promptLine("Code: ", LOGIN_TIMEOUT_MS);
    if (!code) return { ok: false, message: "No code entered before the timeout. Re-run `bahama auth login bahama-cloud`." };
    return exchange(code.trim(), redirectUri);
  }

  // Loopback flow: ephemeral port; the server matches loopback redirects on
  // any port per RFC 8252.
  return new Promise<LoginResult>((resolve) => {
    const server = createServer();
    const timer = setTimeout(() => {
      server.close();
      resolve({
        ok: false,
        message: "Login timed out after 5 minutes. Re-run with --no-browser for the paste-a-code flow.",
      });
    }, LOGIN_TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      const url = authorizeUrl(redirectUri);

      server.on("request", (req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (requestUrl.pathname !== "/oauth/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = requestUrl.searchParams.get("code");
        const returnedState = requestUrl.searchParams.get("state");
        const finish = (ok: boolean, text: string) => {
          res.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
          res.end(`<html><body style="font-family:system-ui"><p>${text}</p></body></html>`);
        };
        if (!code || returnedState !== state) {
          finish(false, "Sign-in failed: missing code or state mismatch. Return to your terminal.");
          return;
        }
        finish(true, "Signed in — you can close this tab and return to your terminal.");
        clearTimeout(timer);
        server.close();
        void exchange(code, redirectUri).then(resolve);
      });

      process.stderr.write(`\nOpening your browser to sign in. If nothing opens, visit:\n\n  ${url}\n\n`);
      openBrowser(url);
    });
  });
}

async function saveTokens(tokens: { access_token: string; refresh_token?: string; expires_in?: number }): Promise<void> {
  const store = await readStore();
  store["bahama-cloud"] = {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: Date.now() + (tokens.expires_in ?? 900) * 1000,
  };
  await writeStore(store);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Printing the URL is the fallback; nothing to do.
  }
}

function promptLine(prompt: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const timer = setTimeout(() => {
      rl.close();
      resolve(null);
    }, timeoutMs);
    rl.question(prompt, (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    });
  });
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
