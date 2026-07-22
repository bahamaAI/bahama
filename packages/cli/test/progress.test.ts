import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplyProgressReporter, createStatusProgressReporter } from "../src/progress.js";

afterEach(() => {
  vi.useRealTimers();
});

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

describe("interactive status progress", () => {
  it("stays quiet for fast checks and shows the provider after a short delay", () => {
    vi.useFakeTimers();
    let output = "";
    const reporter = createStatusProgressReporter({ write: (chunk) => (output += chunk) });

    reporter.start("Bahama Cloud");
    vi.advanceTimersByTime(249);
    expect(output).toBe("");
    vi.advanceTimersByTime(1);
    expect(output).toBe("\r\x1b[2K  ◌ Checking Bahama Cloud…");
    reporter.finish();
    expect(output.endsWith("\r\x1b[2K")).toBe(true);
  });

  it("cancels the delayed line when a status check finishes quickly", () => {
    vi.useFakeTimers();
    let output = "";
    const reporter = createStatusProgressReporter({ write: (chunk) => (output += chunk) });
    reporter.start("Local development");
    reporter.finish();
    vi.runAllTimers();
    expect(output).toBe("");
  });
});
