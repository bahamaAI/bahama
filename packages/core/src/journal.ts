import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, ProviderFailureCode } from "@bahama/provider-kit";
import { appendLine } from "./fs-util.js";

export const BAHAMA_DIR = ".bahama";
const JOURNAL_FILE = "operations.ndjson";

/**
 * Append-only receipts. The journal is recovery metadata, not the source of
 * truth — live provider state and verified postconditions always win over a
 * stale local receipt. It must already be redaction-safe when it gets here.
 */
export type JournalEntry =
  | { type: "apply-start"; at: string; opId: string; planId: string }
  | {
      type: "step";
      at: string;
      opId: string;
      planId: string;
      stepId: string;
      providerId: string;
      action: string;
      resourceKey?: string;
      status: "succeeded" | "failed";
      classification: "routine" | "consequential";
      /** True when this run only re-derived a secret from an already-verified step. */
      rederived?: boolean;
      receipt?: JsonObject;
      identity?: JsonObject;
      /** Non-secret produced capability values, keyed by capability name. */
      producedValues?: JsonObject;
      /** Metadata (name + fingerprint) of produced secrets. Never values. */
      producedSecrets?: Array<{ capability: string; name: string; fingerprint: string }>;
      error?: string;
      errorCode?: ProviderFailureCode;
    }
  | { type: "apply-end"; at: string; opId: string; planId: string; status: "succeeded" | "failed" };

function journalPath(projectRoot: string): string {
  return join(projectRoot, BAHAMA_DIR, JOURNAL_FILE);
}

export async function appendJournal(projectRoot: string, entry: JournalEntry): Promise<void> {
  await appendLine(journalPath(projectRoot), JSON.stringify(entry));
}

export async function readJournal(projectRoot: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalPath(projectRoot), "utf8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // A torn tail line (crash mid-append) is expected; ignore it.
    }
  }
  return entries;
}

/**
 * Successful step receipts reusable for RESUMING one plan, newest wins per
 * stepId. Receipts recorded at or before the plan's last successful
 * completion are excluded: a finished apply is done, and re-applying the
 * same plan must re-execute its steps (ensure semantics keep that
 * idempotent) — otherwise a second `bahama deploy` of an unchanged plan
 * would "skip-verified" every step and never actually redeploy.
 */
export function verifiedSteps(entries: JournalEntry[], planId: string): Map<string, JournalEntry & { type: "step" }> {
  const map = new Map<string, JournalEntry & { type: "step" }>();
  for (const entry of entries) {
    if (entry.planId !== planId) continue;
    if (entry.type === "apply-end" && entry.status === "succeeded") {
      map.clear();
    } else if (entry.type === "step" && entry.status === "succeeded" && !entry.rederived) {
      map.set(entry.stepId, entry);
    }
  }
  return map;
}

/**
 * True when the plan's most recent apply never completed successfully —
 * i.e. the next apply of this plan is a resume (after a crash or a failed
 * step), not a fresh run.
 */
export function hasUnfinishedApply(entries: JournalEntry[], planId: string): boolean {
  let unfinished = false;
  for (const entry of entries) {
    if (entry.planId !== planId) continue;
    if (entry.type === "apply-start") unfinished = true;
    else if (entry.type === "apply-end" && entry.status === "succeeded") unfinished = false;
  }
  return unfinished;
}

/**
 * The most recent successful deploy receipt for a resource, across ALL plans.
 * The classifier compares its provider-config fingerprints against the
 * current working tree to catch resource creation smuggled through
 * `vercel.json`/`wrangler.toml` inside a "routine" redeploy.
 */
export function lastSuccessfulDeploy(
  entries: JournalEntry[],
  resourceKey: string,
): (JournalEntry & { type: "step" }) | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (
      entry.type === "step" &&
      entry.status === "succeeded" &&
      entry.resourceKey === resourceKey &&
      entry.receipt &&
      typeof entry.receipt === "object" &&
      "configFingerprints" in entry.receipt
    ) {
      return entry;
    }
  }
  return null;
}
