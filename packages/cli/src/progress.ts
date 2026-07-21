import type { ApplyProgressEvent } from "@bahama/core";

interface ProgressStream {
  write(chunk: string): unknown;
}

export interface ApplyProgressReporter {
  onProgress(event: ApplyProgressEvent): void;
  finish(): void;
}

/** One restrained, replace-in-place status line for interactive terminals. */
export function createApplyProgressReporter(stream: ProgressStream = process.stderr): ApplyProgressReporter {
  let activeStepId: string | null = null;

  return {
    onProgress(event) {
      if (event.kind === "step-started") {
        stream.write(`\r\x1b[2K  ◌ ${event.summary}`);
        activeStepId = event.stepId;
        return;
      }

      const marker = event.status === "failed" ? "✗" : "✓";
      const suffix = event.status === "skipped-verified" ? " (already complete)" : "";
      if (activeStepId !== null) stream.write("\r\x1b[2K");
      stream.write(`  ${marker} ${event.summary}${suffix}\n`);
      activeStepId = null;
    },
    finish() {
      if (activeStepId === null) return;
      stream.write("\r\x1b[2K");
      activeStepId = null;
    },
  };
}
