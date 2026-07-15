import { describe, expect, it } from "vitest";
import { InMemorySecretBroker } from "../src/secret-broker.js";
import { Redactor } from "../src/redact.js";
import { SafeRunner } from "../src/runner.js";

function makeRunner(): { runner: SafeRunner; redactor: Redactor; broker: InMemorySecretBroker } {
  const redactor = new Redactor();
  const broker = new InMemorySecretBroker(redactor);
  const runner = new SafeRunner({
    redactor,
    broker,
    signal: new AbortController().signal,
    defaultCwd: process.cwd(),
  });
  return { runner, redactor, broker };
}

describe("SafeRunner captureSecretStdout", () => {
  it("seals stdout at capture: the driver-visible result never carries the raw value", async () => {
    const { runner, redactor, broker } = makeRunner();
    const result = await runner.run("node", ["-e", "console.log('sup3r-s3cret-value')"], {
      captureSecretStdout: { name: "test.connectionUrl" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.secret).toBeDefined();
    // The returned stdout is already redacted — the raw bytes never reach the caller.
    expect(result.stdout).not.toContain("sup3r-s3cret-value");
    // Capture-time registration covers every LATER redaction path too.
    expect(redactor.redact("error: could not connect to sup3r-s3cret-value")).not.toContain(
      "sup3r-s3cret-value",
    );
    // The sealed handle round-trips through the broker (trimmed).
    const length = await broker.use(result.secret!, async (raw) => raw.length);
    expect(length).toBe("sup3r-s3cret-value".length);
    expect(broker.describe(result.secret!).name).toBe("test.connectionUrl");
  });

  it("returns no secret handle for empty stdout", async () => {
    const { runner } = makeRunner();
    const result = await runner.run("node", ["-e", "process.exit(0)"], {
      captureSecretStdout: { name: "test.empty" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.secret).toBeUndefined();
  });
});

describe("SafeRunner captureSecretJson", () => {
  it("seals one JSON field while preserving redacted structured output", async () => {
    const { runner, broker } = makeRunner();
    const result = await runner.run(
      "node",
      [
        "-e",
        `console.log(JSON.stringify({project:{id:"proj-1"},connection_uris:[{connection_uri:"postgres://user:secret@host/db"}]}))`,
      ],
      {
        captureSecretJson: {
          name: "database.connectionUrl",
          path: ["connection_uris", 0, "connection_uri"],
        },
      },
    );

    expect(result.secret).toBeDefined();
    expect(result.stdout).not.toContain("postgres://");
    expect(JSON.parse(result.stdout)).toMatchObject({
      project: { id: "proj-1" },
      connection_uris: [{ connection_uri: "[redacted:database.connectionUrl]" }],
    });
    const rawLength = await broker.use(result.secret!, async (value) => value.length);
    expect(rawLength).toBe("postgres://user:secret@host/db".length);
  });

  it("fails closed when declared secret JSON is malformed", async () => {
    const { runner } = makeRunner();
    const result = await runner.run("node", ["-e", "console.log('not-json secret-value')"], {
      captureSecretJson: { name: "test.secret", path: ["secret"] },
    });
    expect(result.secret).toBeUndefined();
    expect(result.stdout).not.toContain("secret-value");
  });
});
