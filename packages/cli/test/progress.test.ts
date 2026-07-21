import { describe, expect, it } from "vitest";
import { createApplyProgressReporter } from "../src/progress.js";

describe("interactive apply progress", () => {
  it("replaces an active step with its final status", () => {
    let output = "";
    const reporter = createApplyProgressReporter({ write: (chunk) => (output += chunk) });
    reporter.onProgress({ kind: "step-started", stepId: "deploy", summary: "Vercel building" });
    reporter.onProgress({ kind: "step-finished", stepId: "deploy", summary: "Vercel building", status: "succeeded" });
    expect(output).toBe("\r\x1b[2K  ◌ Vercel building\r\x1b[2K  ✓ Vercel building\n");
  });

  it("renders resumed and failed steps without affecting result output", () => {
    let output = "";
    const reporter = createApplyProgressReporter({ write: (chunk) => (output += chunk) });
    reporter.onProgress({
      kind: "step-finished",
      stepId: "ensure",
      summary: "Neon project ready",
      status: "skipped-verified",
    });
    reporter.onProgress({ kind: "step-started", stepId: "deploy", summary: "Vercel building" });
    reporter.onProgress({ kind: "step-finished", stepId: "deploy", summary: "Vercel building", status: "failed" });
    expect(output).toContain("  ✓ Neon project ready (already complete)\n");
    expect(output).toContain("\r\x1b[2K  ✗ Vercel building\n");
  });

  it("clears an unfinished line when apply exits unexpectedly", () => {
    let output = "";
    const reporter = createApplyProgressReporter({ write: (chunk) => (output += chunk) });
    reporter.onProgress({ kind: "step-started", stepId: "deploy", summary: "Vercel building" });
    reporter.finish();
    expect(output.endsWith("\r\x1b[2K")).toBe(true);
  });
});
