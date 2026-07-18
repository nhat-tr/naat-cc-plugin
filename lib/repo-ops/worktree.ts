// worktree — git worktree discipline for the vuln-autofix skill.
//
// This is the highest-risk module: it is the only place allowed to move the
// local `master` ref (via fast-forward only) and the only place allowed to
// create a new worktree. It must NEVER add, modify, or commit inside any
// worktree whose role is "base" (master), "work" (Work*), or "review"
// (Rejection Criterion 1 / spec D5 / AC-2 / AC-6). The only writes performed
// here are:
//   1. `git merge --ff-only` inside the base (master) worktree — explicitly
//      allowed and expected by the design spec.
//   2. `git worktree add` for a fresh `SecFix-*` (fix) worktree, and (on a
//      re-run) `git rebase` inside that same fix worktree.
//
// Every git invocation is routed through `git()`/`run()` from `sh.ts` (no
// shell interpolation), and any accidental targeting of a protected worktree
// is refused via `assertNotProtected()`.

import path from "node:path";
import { git, assertNotProtected } from "./sh.ts";
import type { FixWorktreeResult, ServiceRepo, Worktree } from "./types.ts";

/**
 * Resolve the remote's default branch name (short form, e.g. "master" or
 * "main"). Order of resolution (per spec D5):
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD`, stripped of the
 *      leading "origin/".
 *   2. Whichever of `origin/master` / `origin/main` verifies as an existing
 *      remote-tracking ref.
 *   3. Final fallback: "master".
 *
 * Never throws — this is a best-effort resolution, not a hard git operation.
 */
export function resolveDefaultBranch(bareRepoPath: string): string {
  const symbolic = git(bareRepoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  }

  for (const candidate of ["master", "main"]) {
    const verified = git(bareRepoPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${candidate}`,
    ]);
    if (verified.ok) return candidate;
  }

  return "master";
}

/**
 * `git fetch origin` against the bare repo. Moves remote-tracking refs
 * (`refs/remotes/origin/*`) only — touches no worktree. Throws on failure.
 */
export function fetchOrigin(bareRepoPath: string): void {
  git(bareRepoPath, ["fetch", "origin"], { throwOnError: true });
}

function findBaseWorktree(repo: ServiceRepo): Worktree {
  const base = repo.worktrees.find((w) => w.role === "base");
  if (!base) {
    throw new Error(
      `ServiceRepo '${repo.name}' has no base (master) worktree in its worktree list.`,
    );
  }
  return base;
}

/**
 * Fetch origin, resolve the default branch, then attempt to fast-forward the
 * local base (master) worktree onto `origin/<default>`. Never forces: if the
 * base worktree is dirty or has diverged, `git merge --ff-only` aborts
 * cleanly on its own and master is left exactly as it was.
 */
export function fastForwardMaster(
  repo: ServiceRepo,
): { fastForwarded: boolean; defaultBranch: string } {
  fetchOrigin(repo.bareRepoPath);
  const defaultBranch = resolveDefaultBranch(repo.bareRepoPath);
  const baseWorktree = findBaseWorktree(repo);

  const merge = git(baseWorktree.path, ["merge", "--ff-only", `origin/${defaultBranch}`]);
  return { fastForwarded: merge.ok, defaultBranch };
}

/** "security/CVE-2025-1234" -> "security-CVE-2025-1234" for use as a dir name. */
function sanitizeForDirName(branch: string): string {
  return branch.replace(/\//g, "-");
}

function branchExists(bareRepoPath: string, branch: string): boolean {
  return git(bareRepoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

/**
 * Directory basenames of worktrees currently registered against the bare
 * repo. Compared by basename rather than full path: `git worktree list`
 * reports canonicalized (symlink-resolved) paths, which can differ textually
 * from a path built by joining `bareRepoPath` (e.g. under a tmp dir that is
 * itself a symlink) even though it is the same directory on disk. Dir names
 * are unique per bare repo, so this side-steps the mismatch entirely.
 */
function registeredWorktreeDirNames(bareRepoPath: string): Set<string> {
  const list = git(bareRepoPath, ["worktree", "list", "--porcelain"], { throwOnError: true });
  const names = new Set<string>();
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      names.add(path.basename(line.slice("worktree ".length).trim()));
    }
  }
  return names;
}

/**
 * Refuse to let fix-worktree creation target the name or branch of any
 * existing protected (base/work/review) worktree — defense in depth on top
 * of the fact that we otherwise only ever run git against the bare repo
 * path, the base worktree path, and the new fix worktree path.
 */
function guardAgainstProtectedCollision(repo: ServiceRepo, dirName: string, branch: string): void {
  const collision = repo.worktrees.find(
    (w) => w.isProtected && (w.name === dirName || w.branch === branch),
  );
  if (collision) assertNotProtected(collision);
}

/**
 * Create (or resume) a fix worktree for `branch`, cut from the up-to-date
 * base. Always ensures `fastForwardMaster` first (spec D5 / AC-2):
 *   - ff succeeded  -> branch from the local `master` branch ref;
 *                      branchedFrom: "master", masterFastForwarded: true.
 *   - ff failed     -> branch from `origin/<default>` directly instead;
 *                      branchedFrom: "origin", masterFastForwarded: false.
 *                      master is left completely untouched.
 * On a re-run (the branch already exists), the existing branch is checked
 * out into the fix worktree (creating it if the dir isn't already
 * registered) and rebased onto the same base ref used above.
 */
export function createFixWorktree(
  repo: ServiceRepo,
  branch: string,
  opts: { dirName?: string } = {},
): FixWorktreeResult {
  const { fastForwarded, defaultBranch } = fastForwardMaster(repo);
  const baseWorktree = findBaseWorktree(repo);

  const baseRef = `origin/${defaultBranch}`;
  const branchedFrom: "master" | "origin" = fastForwarded ? "master" : "origin";
  const checkoutBase = fastForwarded ? baseWorktree.branch : baseRef;

  const dirName = opts.dirName ?? `SecFix-${sanitizeForDirName(branch)}`;
  const worktreePath = path.join(repo.bareRepoPath, dirName);

  guardAgainstProtectedCollision(repo, dirName, branch);

  const alreadyRegistered = registeredWorktreeDirNames(repo.bareRepoPath).has(dirName);
  const isRerun = branchExists(repo.bareRepoPath, branch);

  if (!alreadyRegistered) {
    const addArgs = isRerun
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", worktreePath, "-b", branch, checkoutBase];
    git(repo.bareRepoPath, addArgs, { throwOnError: true });
  }

  if (isRerun) {
    git(worktreePath, ["rebase", checkoutBase], { throwOnError: true });
  }

  return {
    repo: repo.name,
    worktreePath,
    branch,
    baseRef,
    masterFastForwarded: fastForwarded,
    branchedFrom,
  };
}
