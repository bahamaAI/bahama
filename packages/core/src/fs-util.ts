import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Write-then-rename so a crash never leaves a half-written state file.
 * Rename is atomic on the same filesystem, which temp-next-to-target ensures.
 */
export async function atomicWriteFile(path: string, contents: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, contents, { mode });
  await rename(temp, path);
}

/** Append one line to an ndjson file, creating it 0600 on first use. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(line.endsWith("\n") ? line : `${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
