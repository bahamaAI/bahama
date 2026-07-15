import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshCloudToken } from "../src/cloud-auth.js";

afterEach(() => {
  delete process.env["BAHAMA_CONFIG_DIR"];
  delete process.env["BAHAMA_CLOUD_URL"];
  delete process.env["BAHAMA_TOKEN"];
  vi.unstubAllGlobals();
});

describe("freshCloudToken", () => {
  it("uses a locally-fresh token normally but rotates it when forceRefresh is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "bahama-cloud-auth-test-"));
    process.env["BAHAMA_CONFIG_DIR"] = root;
    process.env["BAHAMA_CLOUD_URL"] = "https://cloud.test";
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({
        "bahama-cloud": {
          accessToken: "server-rejected-but-locally-fresh",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 10 * 60_000,
        },
      }),
    );

    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://cloud.test/oauth/authorize",
            token_endpoint: "https://cloud.test/oauth/token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://cloud.test/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 900 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    expect(await freshCloudToken()).toBe("server-rejected-but-locally-fresh");
    expect(requests).toEqual([]);
    expect(await freshCloudToken({ forceRefresh: true })).toBe("fresh-access");
    expect(requests).toEqual([
      "https://cloud.test/.well-known/oauth-authorization-server",
      "https://cloud.test/oauth/token",
    ]);

    const stored = JSON.parse(await readFile(join(root, "credentials.json"), "utf8")) as {
      "bahama-cloud": { accessToken: string; refreshToken: string };
    };
    expect(stored["bahama-cloud"]).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "refresh-2",
    });
  });
});
