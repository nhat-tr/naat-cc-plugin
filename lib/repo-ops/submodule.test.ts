// submodule.test.ts — hermetic tests for the bump-submodule primitive.
//
// Builds real git repos under os.tmpdir() (never touches a real workspace
// repo or the network). Local-path submodule remotes are blocked by git's
// file-transport safety default (protocol.file.allow), so this file sets
// GIT_ALLOW_PROTOCOL=file for the duration of the run and restores it after.
// That env var is inherited by every `git()` call made here AND inside
// submodule.ts (both go through sh.ts's `git()`, which defaults to
// `process.env`), so no test-only flags leak into the implementation.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "./sh.ts";
import { listCommonConsumers, bumpCommonSubmodule } from "./submodule.ts";
import type { ServiceRepo, Topology } from "./types.ts";

const SUBMODULE_PATH = "Hoffmann.Test.Common";
const previousAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
process.env.GIT_ALLOW_PROTOCOL = "file";

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousAllowProtocol === undefined) {
    delete process.env.GIT_ALLOW_PROTOCOL;
  } else {
    process.env.GIT_ALLOW_PROTOCOL = previousAllowProtocol;
  }
});

function configureIdentity(repoPath: string): void {
  git(repoPath, ["config", "user.email", "vuln-autofix-test@example.com"], { throwOnError: true });
  git(repoPath, ["config", "user.name", "vuln-autofix-test"], { throwOnError: true });
}

function commitFile(repoPath: string, relFile: string, content: string, message: string): string {
  writeFileSync(join(repoPath, relFile), content);
  git(repoPath, ["add", relFile], { throwOnError: true });
  git(repoPath, ["commit", "-q", "-m", message], { throwOnError: true });
  return git(repoPath, ["rev-parse", "HEAD"], { throwOnError: true }).stdout.trim();
}

/**
 * Builds: a "common-src" repo with an old + new commit on master, a bare
 * "common-origin" clone of it, and a "consumer" repo with the submodule
 * added at SUBMODULE_PATH and pinned to the OLD commit (matching how the
 * real consumer worktrees are wired, per the design spec's submodule
 * fixture recipe).
 */
function buildFixture(): { consumerPath: string; oldSha: string; newSha: string } {
  const root = mkdtempSync(join(tmpdir(), "submodule-fixture-"));
  tmpDirs.push(root);

  const commonSrc = join(root, "common-src");
  const commonOrigin = join(root, "common-origin");
  const consumer = join(root, "consumer");

  run("git", ["init", "-q", "-b", "master", commonSrc], { throwOnError: true });
  configureIdentity(commonSrc);
  const oldSha = commitFile(commonSrc, "file.txt", "v1\n", "old commit");
  const newSha = commitFile(commonSrc, "file.txt", "v2\n", "new commit");

  run("git", ["clone", "-q", "--bare", commonSrc, commonOrigin], { throwOnError: true });

  run("git", ["init", "-q", "-b", "master", consumer], { throwOnError: true });
  configureIdentity(consumer);
  commitFile(consumer, "readme.txt", "consumer\n", "init consumer");

  git(consumer, ["submodule", "add", "-b", "master", commonOrigin, SUBMODULE_PATH], {
    throwOnError: true,
  });
  git(join(consumer, SUBMODULE_PATH), ["checkout", "-q", oldSha], { throwOnError: true });
  git(consumer, ["add", SUBMODULE_PATH], { throwOnError: true });
  git(consumer, ["commit", "-q", "-m", "pin Common to old commit"], { throwOnError: true });

  return { consumerPath: consumer, oldSha, newSha };
}

test("bumpCommonSubmodule_WhenTargetShaIsNewCommonCommit_ThenStagesOnlyTheGitlink", () => {
  const { consumerPath, oldSha, newSha } = buildFixture();

  const result = bumpCommonSubmodule(consumerPath, SUBMODULE_PATH, newSha);

  assert.equal(result.submodulePath, SUBMODULE_PATH);
  assert.equal(result.fromSha, oldSha);
  assert.equal(result.toSha, newSha);
  assert.equal(result.buildOk, false);

  const staged = git(consumerPath, ["diff", "--cached", "--name-only"], { throwOnError: true })
    .stdout.trim()
    .split("\n")
    .filter((line) => line.length > 0);
  assert.deepEqual(staged, [SUBMODULE_PATH]);

  const submoduleHead = git(join(consumerPath, SUBMODULE_PATH), ["rev-parse", "HEAD"], {
    throwOnError: true,
  }).stdout.trim();
  assert.equal(submoduleHead, newSha);
});

test("bumpCommonSubmodule_WhenUnrelatedFileIsAlreadyStaged_ThenThrows", () => {
  const { consumerPath, newSha } = buildFixture();

  // Simulate "the target sha would alter tracked files outside the gitlink":
  // stage an unrelated change in the consumer worktree before bumping. The
  // verify step must catch this and refuse rather than silently widening
  // the diff beyond the submodule gitlink.
  writeFileSync(join(consumerPath, "readme.txt"), "unexpectedly modified\n");
  git(consumerPath, ["add", "readme.txt"], { throwOnError: true });

  assert.throws(() => bumpCommonSubmodule(consumerPath, SUBMODULE_PATH, newSha), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /readme\.txt/);
    return true;
  });
});

function makeServiceRepo(name: string, group: string, usesCommonSubmodule: boolean): ServiceRepo {
  return {
    name,
    group,
    bareRepoPath: `/fake/workspace/${group}/${name}`,
    remoteUrl: null,
    worktrees: [],
    defaultBranch: "master",
    isDotnet: true,
    usesCommonSubmodule,
    commonSubmodulePath: usesCommonSubmodule ? `Hoffmann.${group}.Common` : null,
    csprojIndex: [],
  };
}

test("listCommonConsumers_WhenGroupHasMixedServices_ThenReturnsOnlySubmoduleConsumers", () => {
  const product = makeServiceRepo("Product", "Calibration", true);
  const calCore = makeServiceRepo("CalCore", "Calibration", false);
  const topology: Topology = {
    workspaceRoot: "/fake/workspace",
    workspaceRepos: [],
    groups: [
      {
        name: "Calibration",
        path: "/fake/workspace/Calibration",
        commonRepo: null,
        services: [product, calCore],
      },
    ],
  };

  const consumers = listCommonConsumers(topology, "Calibration");

  assert.deepEqual(consumers, [product]);
});

test("listCommonConsumers_WhenGroupDoesNotExist_ThenReturnsEmptyArray", () => {
  const topology: Topology = {
    workspaceRoot: "/fake/workspace",
    workspaceRepos: [],
    groups: [
      {
        name: "Calibration",
        path: "/fake/workspace/Calibration",
        commonRepo: null,
        services: [makeServiceRepo("Product", "Calibration", true)],
      },
    ],
  };

  assert.deepEqual(listCommonConsumers(topology, "Regrinding"), []);
});
