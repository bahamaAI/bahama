import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BAHAMA_DIR } from "./journal.js";

/**
 * One mutating operation per project at a time. `mkdir` is atomic, which
 * makes the lock race-free; a lock whose recorded pid is dead is stale and
 * gets reclaimed (crashed applies must not wedge the project).
 */
export class OperationLock {
  private readonly dir: string;
  private held = false;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, BAHAMA_DIR, "op.lock");
  }

  async acquire(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: false });
    } catch {
      const pidText = await readFile(join(this.dir, "pid"), "utf8").catch(() => "");
      const pid = Number.parseInt(pidText, 10);
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
        throw new Error(
          `Another Bahama operation (pid ${pid}) is running against this project. ` +
            `Wait for it to finish, or remove .bahama/op.lock if it crashed.`,
        );
      }
      // Stale lock from a dead process: reclaim.
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir, { recursive: false });
    }
    await writeFile(join(this.dir, "pid"), String(process.pid), { mode: 0o600 });
    this.held = true;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await rm(this.dir, { recursive: true, force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
