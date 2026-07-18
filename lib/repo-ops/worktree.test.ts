// worktree.test.ts — hermetic tests for the git worktree-discipline module.
//
// Every test builds a REAL git repo tree under os.tmpdir(): a non-bare
// "seed" repo -> a bare "origin" (mirrors what a team's actual remote would
// look like) -> a bare `bareRepoPath/.git` cloned from origin, with worktree
// subdirs added exactly as setup-worktree.sh would. Nothing here touches the
// real workspace or any network remote. All fixtures are removed in the
// top-level `after()`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, run, assertNotProtected } from "./sh.ts";
import type { ServiceRepo, Worktree } from "./types.ts";
import {
  resolveDefaultBranch,
  fetchOrigin,
  fastForwardMaster,
  createFixWorktree,
} from "./worktree.ts";

let ROOT: string;
let dirCounter = 0;

before(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "vuln-autofix-worktree-"));
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function nextDir(label: string): string {
  dirCounter += 1;
  const dir = path.join(ROOT, `${dirCounter}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `git -C <cwd> <args>`, throwing (with stderr) on non-zero exit. */
function sh(cwd: string, args: string[]): string {
  return git(cwd, args, { throwOnError: true }).stdout.trim();
}

function configureIdentity(repoDir: string): void {
  sh(repoDir, ["config", "user.email", "vuln-autofix-test@example.com"]);
  sh(repoDir, ["config", "user.name", "vuln-autofix test"]);
}

function commitFile(repoDir: string, filename: string, content: string, message: string): void {
  writeFileSync(path.join(repoDir, filename), content);
  sh(repoDir, ["add", filename]);
  sh(repoDir, ["commit", "-m", message]);
}

interface Fixture {
  seedDir: string;
  originDir: string;
  bareRepoPath: string;
  masterPath: string;
  defaultBranch: string;
  repo: ServiceRepo;
}

/**
 * Build: seed (non-bare, commit on `defaultBranch`) -> origin.git (bare
 * clone of seed, stands in for the team's real remote) -> bareRepoPath/.git
 * (bare clone of origin.git, mirroring setup-worktree.sh) -> a `master`
 * worktree checked out inside bareRepoPath. Deliberately does NOT run
 * `git fetch` — callers opt into that via fetchOrigin/fastForwardMaster so
 * tests can observe the pre-fetch state too.
 */
function buildFixture(label: string, defaultBranch = "master"): Fixture {
  const base = nextDir(label);

  const seedDir = path.join(base, "seed");
  mkdirSync(seedDir, { recursive: true });
  run("git", ["init", "-q", "-b", defaultBranch, seedDir], { throwOnError: true });
  configureIdentity(seedDir);
  commitFile(seedDir, "README.md", "hello\n", "initial commit");

  const originDir = path.join(base, "origin.git");
  run("git", ["clone", "-q", "--bare", seedDir, originDir], { throwOnError: true });

  const bareRepoPath = path.join(base, "svc");
  mkdirSync(bareRepoPath, { recursive: true });
  run("git", ["clone", "-q", "--bare", originDir, path.join(bareRepoPath, ".git")], {
    throwOnError: true,
  });
  sh(bareRepoPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  configureIdentity(bareRepoPath);

  sh(bareRepoPath, ["worktree", "add", "master", defaultBranch]);
  const masterPath = path.join(bareRepoPath, "master");

  const masterWorktree: Worktree = {
    name: "master",
    path: masterPath,
    branch: defaultBranch,
    role: "base",
    isProtected: true,
  };

  const repo: ServiceRepo = {
    name: "TestSvc",
    group: null,
    bareRepoPath,
    remoteUrl: null,
    worktrees: [masterWorktree],
    defaultBranch,
    isDotnet: true,
    usesCommonSubmodule: false,
    commonSubmodulePath: null,
    csprojIndex: [],
  };

  return { seedDir, originDir, bareRepoPath, masterPath, defaultBranch, repo };
}

/** Simulate someone else advancing the remote: commit in `seed`, land it on `origin.git`. */
function advanceOrigin(fx: Fixture, filename: string, content: string, message: string): void {
  writeFileSync(path.join(fx.seedDir, filename), content);
  sh(fx.seedDir, ["add", filename]);
  sh(fx.seedDir, ["commit", "-m", message]);
  sh(fx.originDir, ["fetch", fx.seedDir, `${fx.defaultBranch}:${fx.defaultBranch}`]);
}

/** Add a protected (or fix) worktree branched from `baseRef`, tracked on `fx.repo`. */
function addWorktree(
  fx: Fixture,
  dirName: string,
  branch: string,
  baseRef: string,
  role: Worktree["role"],
): Worktree {
  sh(fx.bareRepoPath, ["worktree", "add", dirName, "-b", branch, baseRef]);
  const wtPath = path.join(fx.bareRepoPath, dirName);
  const wt: Worktree = {
    name: dirName,
    path: wtPath,
    branch,
    role,
    isProtected: role === "base" || role === "work" || role === "review",
  };
  fx.repo.worktrees.push(wt);
  return wt;
}

// ---------------------------------------------------------------------------
// resolveDefaultBranch
// ---------------------------------------------------------------------------

describe("resolveDefaultBranch", () => {
  test("resolves via symbolic-ref origin/HEAD after a fetch", () => {
    const fx = buildFixture("resolve-symbolic", "master");
    fetchOrigin(fx.bareRepoPath);
    assert.equal(resolveDefaultBranch(fx.bareRepoPath), "master");
  });

  test("resolves 'main' via symbolic-ref when that is the remote default", () => {
    const fx = buildFixture("resolve-symbolic-main", "main");
    fetchOrigin(fx.bareRepoPath);
    assert.equal(resolveDefaultBranch(fx.bareRepoPath), "main");
  });

  test("falls back to verifying origin/<candidate> when origin/HEAD isn't a symbolic ref", () => {
    const fx = buildFixture("resolve-fallback-verify", "main");
    fetchOrigin(fx.bareRepoPath);
    // Remove just the symbolic HEAD pointer; refs/remotes/origin/main remains.
    sh(fx.bareRepoPath, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    assert.equal(resolveDefaultBranch(fx.bareRepoPath), "main");
  });

  test("falls back to the literal 'master' when no remote-tracking refs exist yet", () => {
    // Real default is "main", but we deliberately never fetch: no
    // refs/remotes/origin/* exist, so neither symbolic-ref nor show-ref can
    // resolve anything, proving the final fallback is the literal "master".
    const fx = buildFixture("resolve-final-fallback", "main");
    assert.equal(resolveDefaultBranch(fx.bareRepoPath), "master");
  });
});

// ---------------------------------------------------------------------------
// fetchOrigin
// ---------------------------------------------------------------------------

describe("fetchOrigin", () => {
  test("populates remote-tracking refs and touches no worktree", () => {
    const fx = buildFixture("fetch-updates-refs", "master");
    const masterHeadBefore = sh(fx.masterPath, ["rev-parse", "HEAD"]);

    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");
    fetchOrigin(fx.bareRepoPath);

    const originTip = sh(fx.bareRepoPath, ["rev-parse", "refs/remotes/origin/master"]);
    const seedTip = sh(fx.seedDir, ["rev-parse", "HEAD"]);
    assert.equal(originTip, seedTip, "remote-tracking ref should match the advanced origin tip");

    const masterHeadAfter = sh(fx.masterPath, ["rev-parse", "HEAD"]);
    assert.equal(masterHeadAfter, masterHeadBefore, "fetch alone must not move the master worktree");
  });

  test("throws on failure", () => {
    const fx = buildFixture("fetch-throws", "master");
    sh(fx.bareRepoPath, ["config", "remote.origin.url", "/nonexistent/path/does-not-exist.git"]);
    assert.throws(() => fetchOrigin(fx.bareRepoPath));
  });
});

// ---------------------------------------------------------------------------
// fastForwardMaster
// ---------------------------------------------------------------------------

describe("fastForwardMaster", () => {
  test("fast-forwards master when origin has advanced", () => {
    const fx = buildFixture("ff-success", "master");
    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");

    const result = fastForwardMaster(fx.repo);

    assert.equal(result.fastForwarded, true);
    assert.equal(result.defaultBranch, "master");

    const masterHead = sh(fx.masterPath, ["rev-parse", "HEAD"]);
    const seedTip = sh(fx.seedDir, ["rev-parse", "HEAD"]);
    assert.equal(masterHead, seedTip, "master should now equal origin's tip");
  });

  test("does not force and leaves master untouched when it has diverged", () => {
    const fx = buildFixture("ff-diverged", "master");

    // Simulate an out-of-band commit directly on master (never done by this
    // tool in real use, but exercises the "cannot fast-forward" path).
    commitFile(fx.masterPath, "local-only.txt", "local\n", "diverging local commit");
    const divergedHead = sh(fx.masterPath, ["rev-parse", "HEAD"]);

    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");

    const result = fastForwardMaster(fx.repo);

    assert.equal(result.fastForwarded, false);
    const masterHeadAfter = sh(fx.masterPath, ["rev-parse", "HEAD"]);
    assert.equal(masterHeadAfter, divergedHead, "master must be left exactly as it was");
  });
});

// ---------------------------------------------------------------------------
// createFixWorktree — AC-2 (clean fast-forward path)
// ---------------------------------------------------------------------------

describe("createFixWorktree — AC-2 (fast-forward path)", () => {
  test("fast-forwards master with no tool-authored commit and cuts the fix worktree from it", () => {
    const fx = buildFixture("ac2-ff", "master");
    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");

    const beforeCommitCount = Number(
      sh(fx.masterPath, ["rev-list", "--count", "HEAD"]),
    );

    const result = createFixWorktree(fx.repo, "security/CVE-2025-1111");

    assert.equal(result.masterFastForwarded, true);
    assert.equal(result.branchedFrom, "master");
    assert.equal(result.baseRef, "origin/master");
    assert.equal(result.branch, "security/CVE-2025-1111");
    assert.equal(
      result.worktreePath,
      path.join(fx.bareRepoPath, "SecFix-security-CVE-2025-1111"),
    );

    // (a) master === origin/<default> tip, no extra tool-authored commit.
    const masterHead = sh(fx.bareRepoPath, ["rev-parse", "master"]);
    const originHead = sh(fx.bareRepoPath, ["rev-parse", "origin/master"]);
    assert.equal(masterHead, originHead);
    const afterCommitCount = Number(sh(fx.masterPath, ["rev-list", "--count", "HEAD"]));
    assert.equal(afterCommitCount, beforeCommitCount + 1, "only the one origin commit landed, ff-only");

    // (b) the new fix worktree exists on the new branch, cut from master.
    assert.equal(existsSync(result.worktreePath), true);
    const fixBranch = sh(result.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(fixBranch, "security/CVE-2025-1111");
    const fixHead = sh(result.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(fixHead, masterHead);

    // (c) git worktree list shows it.
    const list = sh(fx.bareRepoPath, ["worktree", "list"]);
    assert.match(list, /SecFix-security-CVE-2025-1111/);
  });

  test("honors an explicit dirName", () => {
    const fx = buildFixture("ac2-dirname", "master");
    const result = createFixWorktree(fx.repo, "security/custom", { dirName: "CustomFixDir" });
    assert.equal(result.worktreePath, path.join(fx.bareRepoPath, "CustomFixDir"));
    assert.equal(existsSync(result.worktreePath), true);
  });
});

// ---------------------------------------------------------------------------
// createFixWorktree — divergence fallback path
// ---------------------------------------------------------------------------

describe("createFixWorktree — fallback path when master has diverged", () => {
  test("branches from origin/<default> instead, and never touches diverged master", () => {
    const fx = buildFixture("fallback-diverged", "master");

    commitFile(fx.masterPath, "local-only.txt", "local\n", "diverging local commit");
    const divergedHead = sh(fx.masterPath, ["rev-parse", "HEAD"]);

    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");

    const result = createFixWorktree(fx.repo, "security/CVE-2025-2222");

    assert.equal(result.masterFastForwarded, false);
    assert.equal(result.branchedFrom, "origin");
    assert.equal(result.baseRef, "origin/master");

    const masterHeadAfter = sh(fx.masterPath, ["rev-parse", "HEAD"]);
    assert.equal(masterHeadAfter, divergedHead, "diverged master must be left untouched");

    const originHead = sh(fx.bareRepoPath, ["rev-parse", "origin/master"]);
    const fixHead = sh(result.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(fixHead, originHead, "fix worktree must be cut from origin/<default>, not from diverged master");

    const fixLog = sh(result.worktreePath, ["log", "--oneline"]);
    assert.doesNotMatch(fixLog, /diverging local commit/);
  });
});

// ---------------------------------------------------------------------------
// createFixWorktree — re-run (existing branch gets rebased)
// ---------------------------------------------------------------------------

describe("createFixWorktree — re-run", () => {
  test("rebases the existing fix worktree onto the newly ff'd master (dir still registered)", () => {
    const fx = buildFixture("rerun-in-place", "master");
    advanceOrigin(fx, "first.txt", "first\n", "advance origin #1");

    const first = createFixWorktree(fx.repo, "security/rerun-a");
    assert.equal(first.masterFastForwarded, true);

    advanceOrigin(fx, "second.txt", "second\n", "advance origin #2");

    const second = createFixWorktree(fx.repo, "security/rerun-a");
    assert.equal(second.masterFastForwarded, true);
    assert.equal(second.worktreePath, first.worktreePath);

    const masterHead = sh(fx.bareRepoPath, ["rev-parse", "master"]);
    const fixHead = sh(second.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(fixHead, masterHead, "re-run should rebase the fix branch onto the updated master");
  });

  test("re-adds the worktree when its directory was removed but the branch persisted", () => {
    const fx = buildFixture("rerun-removed-dir", "master");
    advanceOrigin(fx, "first.txt", "first\n", "advance origin #1");

    const first = createFixWorktree(fx.repo, "security/rerun-b");
    sh(fx.bareRepoPath, ["worktree", "remove", "SecFix-security-rerun-b", "--force"]);
    assert.equal(existsSync(first.worktreePath), false);

    advanceOrigin(fx, "second.txt", "second\n", "advance origin #2");

    const second = createFixWorktree(fx.repo, "security/rerun-b");
    assert.equal(existsSync(second.worktreePath), true);

    const masterHead = sh(fx.bareRepoPath, ["rev-parse", "master"]);
    const fixHead = sh(second.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(fixHead, masterHead);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — protected worktrees (Work*/Review) are byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe("createFixWorktree — AC-6 (protected worktrees untouched)", () => {
  test("Work* and Review worktrees are unchanged across a full run; only master fast-forwards", () => {
    const fx = buildFixture("ac6-protected", "master");

    const work = addWorktree(fx, "Work1", "Work1", "master", "work");
    commitFile(work.path, "wip.txt", "wip commit content\n", "distinct wip commit");
    // Leave a pending (dirty) change on top of the commit.
    writeFileSync(path.join(work.path, "pending.txt"), "not yet committed\n");

    const review = addWorktree(fx, "Review", "Review", "master", "review");

    const workHeadBefore = sh(work.path, ["rev-parse", "HEAD"]);
    const workStatusBefore = git(work.path, ["status", "--porcelain"], { throwOnError: true }).stdout;
    const reviewHeadBefore = sh(review.path, ["rev-parse", "HEAD"]);
    const reviewStatusBefore = git(review.path, ["status", "--porcelain"], { throwOnError: true }).stdout;

    advanceOrigin(fx, "new.txt", "new content\n", "advance origin");
    const result = createFixWorktree(fx.repo, "security/CVE-2025-3333");
    assert.equal(result.masterFastForwarded, true);

    const workHeadAfter = sh(work.path, ["rev-parse", "HEAD"]);
    const workStatusAfter = git(work.path, ["status", "--porcelain"], { throwOnError: true }).stdout;
    const reviewHeadAfter = sh(review.path, ["rev-parse", "HEAD"]);
    const reviewStatusAfter = git(review.path, ["status", "--porcelain"], { throwOnError: true }).stdout;

    assert.equal(workHeadAfter, workHeadBefore, "Work* HEAD must be byte-for-byte unchanged");
    assert.equal(workStatusAfter, workStatusBefore, "Work* working-tree status must be byte-for-byte unchanged");
    assert.equal(reviewHeadAfter, reviewHeadBefore, "Review HEAD must be unchanged");
    assert.equal(reviewStatusAfter, reviewStatusBefore, "Review working-tree status must be unchanged");

    // master only moved by fast-forward, matching origin exactly.
    const masterHead = sh(fx.bareRepoPath, ["rev-parse", "master"]);
    const originHead = sh(fx.bareRepoPath, ["rev-parse", "origin/master"]);
    assert.equal(masterHead, originHead);
  });

  test("assertNotProtected throws for base/work/review worktrees and passes for a fix worktree", () => {
    const fx = buildFixture("ac6-assert-not-protected", "master");
    const work = addWorktree(fx, "Work1", "Work1", "master", "work");
    const review = addWorktree(fx, "Review", "Review", "master", "review");
    const masterWt = fx.repo.worktrees.find((w) => w.role === "base") as Worktree;

    assert.throws(() => assertNotProtected(masterWt));
    assert.throws(() => assertNotProtected(work));
    assert.throws(() => assertNotProtected(review));

    const fixWt: Worktree = {
      name: "SecFix-example",
      path: path.join(fx.bareRepoPath, "SecFix-example"),
      branch: "security/example",
      role: "fix",
      isProtected: false,
    };
    assert.doesNotThrow(() => assertNotProtected(fixWt));
  });

  test("refuses to target the name or branch of an existing protected worktree", () => {
    const fx = buildFixture("ac6-guard-collision", "master");
    addWorktree(fx, "Work1", "Work1", "master", "work");

    // Branch name collides with the protected Work1 worktree's branch.
    assert.throws(() => createFixWorktree(fx.repo, "Work1"));

    // dirName collides with the protected master worktree's name.
    assert.throws(() => createFixWorktree(fx.repo, "security/safe-branch", { dirName: "master" }));

    // No stray SecFix-* worktree should have been created by either attempt.
    const list = sh(fx.bareRepoPath, ["worktree", "list"]);
    assert.doesNotMatch(list, /SecFix-/);
  });
});
