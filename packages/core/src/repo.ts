import { execa } from "execa";
import type { Lockfile } from "./lockfile.js";

/**
 * Identify the repository this lock is bound to. Used to catch the
 * template-copy trap: someone copies a repo (lock included), has access to
 * the original's provider org, and would otherwise silently deploy over the
 * original's production. A mismatch is a `decision_required`, not a hard
 * block — remotes get renamed and mirrored legitimately.
 */
export async function currentRepoIdentity(projectRoot: string): Promise<Lockfile["repo"]> {
  const origin = await git(projectRoot, ["config", "--get", "remote.origin.url"]);
  if (origin) return { kind: "git-origin", value: normalizeGitUrl(origin) };

  const rootCommit = await git(projectRoot, ["rev-list", "--max-parents=0", "--first-parent", "HEAD"]);
  if (rootCommit) return { kind: "git-root-commit", value: rootCommit.split("\n")[0]!.trim() };

  return { kind: "path", value: projectRoot };
}

export function repoIdentityMatches(locked: Lockfile["repo"], current: Lockfile["repo"]): boolean {
  if (locked.kind !== current.kind) {
    // A repo that gained a remote after binding is still the same repo when
    // bound by path/root-commit; treat cross-kind as a mismatch to surface.
    return false;
  }
  return locked.value === current.value;
}

/** Normalize ssh/https remote spellings of the same repository. */
function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .toLowerCase();
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execa("git", args, { cwd, reject: false, timeout: 10_000 });
    if (result.exitCode !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
