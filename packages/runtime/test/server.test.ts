import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, type BahamaDatabase } from "../src/server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getDb", () => {
  it("returns the native production binding unchanged", () => {
    const native = { prepare: vi.fn() } as unknown as BahamaDatabase;
    expect(getDb({ DB: native })).toBe(native);
  });

  it("uses project-scoped development access locally", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { results: [{ id: 1, body: "hello" }], success: true, meta: {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = getDb({
      BAHAMA_API_BASE_URL: "https://cloud.test/",
      BAHAMA_PROJECT_SLUG: "notes app",
      BAHAMA_DEV_TOKEN: "dev-secret",
    });
    const result = await db.prepare("select * from notes where id = ?").bind(1).all();

    expect(result.results).toEqual([{ id: 1, body: "hello" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cloud.test/api/dev/projects/notes%20app/d1/query");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer dev-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: "select * from notes where id = ?", params: [1] }),
    });
  });

  it("fails clearly when local development bindings are incomplete", () => {
    expect(() => getDb({ BAHAMA_PROJECT_SLUG: "notes" })).toThrow(
      /BAHAMA_API_BASE_URL, BAHAMA_PROJECT_SLUG, and BAHAMA_DEV_TOKEN/,
    );
  });

  it("rejects binary parameters before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = getDb({
      BAHAMA_API_BASE_URL: "https://cloud.test",
      BAHAMA_PROJECT_SLUG: "notes",
      BAHAMA_DEV_TOKEN: "dev-secret",
    });

    await expect(db.prepare("select ?").bind(new Uint8Array([1])).all()).rejects.toThrow(
      /does not support binary SQL parameters/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the control-plane error without including credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: "Database is not provisioned." }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const db = getDb({
      BAHAMA_API_BASE_URL: "https://cloud.test",
      BAHAMA_PROJECT_SLUG: "notes",
      BAHAMA_DEV_TOKEN: "dev-secret",
    });

    await expect(db.prepare("select 1").all()).rejects.toThrow("Database is not provisioned.");
    await expect(db.prepare("select 1").all()).rejects.not.toThrow("dev-secret");
  });
});
