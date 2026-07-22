import type { ApplyProgressEvent } from "@bahama/core";

interface ProgressStream {
  write(chunk: string): unknown;
}

export interface ApplyProgressReporter {
  onProgress(event: ApplyProgressEvent): void;
  finish(): void;
}

export interface StatusProgressReporter {
  start(providerName: string): void;
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

/** Show status work only when it lasts long enough to otherwise feel stuck. */
export function createStatusProgressReporter(
  stream: ProgressStream = process.stderr,
  delayMs = 250,
): StatusProgressReporter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let visible = false;

  const finish = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (visible) stream.write("\r\x1b[2K");
    visible = false;
  };

  return {
    start(providerName) {
      finish();
      timer = setTimeout(() => {
        stream.write(`\r\x1b[2K  ◌ Checking ${providerName}…`);
        visible = true;
        timer = null;
      }, delayMs);
    },
    finish,
  };
}
