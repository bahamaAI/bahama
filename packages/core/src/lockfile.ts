import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@bahama/provider-kit";
import { atomicWriteFile } from "./fs-util.js";
import { hashJson } from "./hash.js";

export const LOCK_FILENAME = "bahama.lock";

/**
 * The lock's schema is deliberately narrow — identities, version ranges, and
 * fingerprints ONLY. Terraform's tfstate shows where a committed state file
 * ends up if attributes, outputs, or anything secret-adjacent creep in; this
 * schema is the guard rail against that.
 */

const identityValue = z.union([z.string(), z.number()]);

/** Keys that would smuggle state or secrets into the lock. */
const FORBIDDEN_IDENTITY_KEYS = /(url|token|secret|password|key|connection|credential)/i;

const identitySchema = z.record(z.string(), identityValue).superRefine((identity, ctx) => {
  for (const key of Object.keys(identity)) {
    if (FORBIDDEN_IDENTITY_KEYS.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `identity key \`${key}\` looks like state or a secret; the lock records durable IDs only`,
      });
    }
  }
});

const lockedResourceSchema = z.object({
  provider: z.string(),
  /** Provider account/team/org id the resource was bound under. */
  accountId: z.string().optional(),
  identity: identitySchema,
});

/**
 * A binding edge that has been applied at least once. Lets the classifier
 * tell "rotation of the same edge" (routine) from "same destination name,
 * different source" (consequential rewiring).
 */
const appliedBindingSchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
});

export const lockSchema = z.object({
  lockVersion: z.literal(1),
  /** Where this lock was bound; guards template-copies from adopting foreign prod. */
  repo: z.object({
    kind: z.enum(["git-origin", "git-root-commit", "path"]),
    value: z.string(),
  }),
  manifestHash: z.string(),
  drivers: z.record(z.string(), z.object({ testedRange: z.string() })).default({}),
  resources: z.record(z.string(), lockedResourceSchema).default({}),
  bindings: z.array(appliedBindingSchema).default([]),
});

export type Lockfile = z.infer<typeof lockSchema>;
export type LockedResource = z.infer<typeof lockedResourceSchema>;

export function emptyLock(repo: Lockfile["repo"], manifestHashValue: string): Lockfile {
  return {
    lockVersion: 1,
    repo,
    manifestHash: manifestHashValue,
    drivers: {},
    resources: {},
    bindings: [],
  };
}

export async function loadLock(projectRoot: string): Promise<Lockfile | null> {
  let text: string;
  try {
    text = await readFile(join(projectRoot, LOCK_FILENAME), "utf8");
  } catch {
    return null;
  }
  const parsed = lockSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`${LOCK_FILENAME} is invalid (${issues}). It is CLI-generated — do not hand-edit it.`);
  }
  return parsed.data;
}

export async function saveLock(projectRoot: string, lock: Lockfile): Promise<void> {
  // Validate on the way out too: no code path may write a non-conforming lock.
  const checked = lockSchema.parse(lock);
  await atomicWriteFile(join(projectRoot, LOCK_FILENAME), `${JSON.stringify(checked, null, 2)}\n`);
}

export function lockHash(lock: Lockfile | null): string {
  return hashJson((lock ?? {}) as unknown as JsonValue);
}
