// Tests for discover.ts. classifyWorktree is a pure function; discover()
// needs real dirs/git repos, so we build minimal fixtures under os.tmpdir()
// and clean them up in after(). Never touches the real workspace.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./sh.ts";
import { classifyWorktree, discover } from "./discover.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vuln-autofix-discover-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `git init --bare -b master <repoDir>/.git`, per the workspace's worktree layout convention. */
function initBareRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  const res = git(repoDir, ["init", "--bare", "-b", "master", ".git"]);
  assert.ok(res.ok, `git init --bare failed: ${res.stderr}`);
}

function addWorktree(repoDir: string, worktreeDirName: string, branch: string): string {
  const wtPath = join(repoDir, worktreeDirName);
  const res = git(repoDir, ["worktree", "add", wtPath, "-b", branch]);
  assert.ok(res.ok, `git worktree add ${worktreeDirName} failed: ${res.stderr}`);
  return wtPath;
}

function commitAll(worktreePath: string, message: string): void {
  git(worktreePath, ["add", "-A"]);
  const res = git(worktreePath, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    message,
    "--allow-empty",
  ]);
  assert.ok(res.ok, `git commit failed: ${res.stderr}`);
}

/** Fakes a resolved `origin/HEAD` -> `origin/master` without a real remote,
 * by writing the ref files directly (exercises discover's primary defaultBranch path). */
function pointOriginAtMaster(repoDir: string): void {
  const rev = git(repoDir, ["rev-parse", "refs/heads/master"]);
  assert.ok(rev.ok, `rev-parse refs/heads/master failed: ${rev.stderr}`);
  const sha = rev.stdout.trim();
  const originDir = join(repoDir, ".git", "refs", "remotes", "origin");
  mkdirSync(originDir, { recursive: true });
  writeFileSync(join(originDir, "master"), `${sha}\n`);
  writeFileSync(join(originDir, "HEAD"), "ref: refs/remotes/origin/master\n");
}

// ---------------------------------------------------------------------------
// classifyWorktree — pure function, no filesystem needed
// ---------------------------------------------------------------------------

test("classifyWorktree_WhenNameIsMasterOrMain_ThenBaseAndProtected", () => {
  assert.deepEqual(classifyWorktree("master", "master"), { role: "base", isProtected: true });
  assert.deepEqual(classifyWorktree("main", "main"), { role: "base", isProtected: true });
});

test("classifyWorktree_WhenNameStartsWithWork_ThenWorkAndProtected", () => {
  assert.deepEqual(classifyWorktree("WorkFoo", "WorkFoo"), { role: "work", isProtected: true });
  assert.deepEqual(classifyWorktree("Work", "Work"), { role: "work", isProtected: true });
});

test("classifyWorktree_WhenNameIsReview_ThenReviewAndProtected", () => {
  assert.deepEqual(classifyWorktree("Review", "release/review"), {
    role: "review",
    isProtected: true,
  });
});

test("classifyWorktree_WhenNameStartsWithSecFix_ThenFixAndNotProtected", () => {
  assert.deepEqual(classifyWorktree("SecFix-20260716", "security/CVE-2026-0001"), {
    role: "fix",
    isProtected: false,
  });
});

test("classifyWorktree_WhenNameIsUnrecognized_ThenOtherAndNotProtected", () => {
  assert.deepEqual(classifyWorktree("scratchpad", "some-branch"), {
    role: "other",
    isProtected: false,
  });
});

// ---------------------------------------------------------------------------
// discover — real fixture covering both topology shapes
// ---------------------------------------------------------------------------

test("discover_WhenWorkspaceHasDomainGroupWorkspaceRepoAndUnrelatedDir_ThenTopologyReflectsEachShape", () => {
  const root = makeTmpRoot();

  // --- Domain group "TestGroup": config.sh + Common (bare) + Product (bare) ---
  const groupDir = join(root, "TestGroup");
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(
    join(groupDir, "config.sh"),
    [
      'REPOS[1]="{name=Hoffmann.TestGroup.Common, dotnet=true, submodule=false}",',
      'REPOS[2]="{name=Hoffmann.TestGroup.Product, dotnet=true, submodule=true}",',
    ].join("\n"),
  );

  const commonDir = join(groupDir, "Common");
  initBareRepo(commonDir);
  const commonMaster = addWorktree(commonDir, "master", "master");
  writeFileSync(
    join(commonMaster, "Common.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />
  </ItemGroup>
</Project>`,
  );
  commitAll(commonMaster, "init common");
  pointOriginAtMaster(commonDir); // exercise the primary origin/HEAD resolution path

  const productDir = join(groupDir, "Product");
  initBareRepo(productDir);
  const productMaster = addWorktree(productDir, "master", "master");
  writeFileSync(
    join(productMaster, "Product.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Http" Version="6.0.0" />
  </ItemGroup>
</Project>`,
  );
  writeFileSync(
    join(productMaster, ".gitmodules"),
    `[submodule "TestGroup.Common"]\n\tpath = TestGroup.Common\n\turl = ../Common\n\tbranch = master\n`,
  );
  commitAll(productMaster, "init product");
  addWorktree(productDir, "WorkFoo", "WorkFoo");
  addWorktree(productDir, "SecFix-20260716", "security/CVE-2026-0001");
  // No origin ref set up for Product -> exercises the final "master" fallback path.

  // --- Workspace-level repo directly under root (no config.sh applies) ---
  const workspaceRepoDir = join(root, "WorkspaceRepo");
  initBareRepo(workspaceRepoDir);
  const wsMaster = addWorktree(workspaceRepoDir, "master", "master");
  writeFileSync(join(wsMaster, "README.md"), "not a dotnet repo\n");
  commitAll(wsMaster, "init workspace repo");

  // --- Unrelated plain dir: no config.sh, no bare children -> must be ignored ---
  const notARepoDir = join(root, "NotARepo");
  mkdirSync(notARepoDir, { recursive: true });
  writeFileSync(join(notARepoDir, "notes.txt"), "just a folder\n");

  // --- Run discover ---
  const topo = discover(root);

  // workspaceRoot
  assert.equal(topo.workspaceRoot, root);

  // Unrelated dir must not surface anywhere.
  assert.equal(topo.groups.some((g) => g.name === "NotARepo"), false);
  assert.equal(topo.workspaceRepos.some((r) => r.name === "NotARepo"), false);

  // workspaceRepos: exactly the bare repo directly under root.
  assert.equal(topo.workspaceRepos.length, 1);
  const wsRepo = topo.workspaceRepos[0];
  assert.equal(wsRepo.name, "WorkspaceRepo");
  assert.equal(wsRepo.group, null);
  assert.equal(wsRepo.isDotnet, false, "no config.sh and no *.csproj -> not dotnet");
  assert.deepEqual(wsRepo.csprojIndex, []);
  assert.equal(wsRepo.defaultBranch, "master", "falls back to master with no origin configured");
  assert.equal(wsRepo.worktrees.length, 1);
  assert.equal(wsRepo.worktrees[0].role, "base");
  assert.equal(wsRepo.worktrees[0].isProtected, true);

  // groups: exactly TestGroup.
  assert.equal(topo.groups.length, 1);
  const group = topo.groups.find((g) => g.name === "TestGroup");
  assert.ok(group, "TestGroup domain group must be discovered");
  assert.equal(group!.path, groupDir);

  // commonRepo
  const common = group!.commonRepo;
  assert.ok(common, "Common repo must be discovered as commonRepo");
  assert.equal(common!.name, "Common");
  assert.equal(common!.group, "TestGroup");
  assert.equal(common!.isDotnet, true, "config.sh dotnet=true");
  assert.equal(
    common!.defaultBranch,
    "master",
    "resolved via origin/HEAD symbolic ref (primary path)",
  );
  assert.equal(common!.csprojIndex.length, 1);
  assert.equal(common!.csprojIndex[0].package, "Newtonsoft.Json");
  assert.equal(common!.csprojIndex[0].version, "12.0.1");

  // services: exactly Product (Common is excluded from services[]).
  assert.equal(group!.services.length, 1);
  const product = group!.services[0];
  assert.equal(product.name, "Product");
  assert.equal(product.group, "TestGroup");
  assert.equal(product.isDotnet, true);
  assert.equal(product.usesCommonSubmodule, true);
  assert.equal(product.commonSubmodulePath, "TestGroup.Common");
  assert.equal(product.defaultBranch, "master", "falls back to master with no origin configured");
  assert.equal(product.csprojIndex.length, 1);
  assert.equal(product.csprojIndex[0].package, "Microsoft.Extensions.Http");
  assert.equal(product.csprojIndex[0].version, "6.0.0");

  // Product's worktrees: base + work + fix, correctly classified end-to-end.
  assert.equal(product.worktrees.length, 3);
  const base = product.worktrees.find((w) => w.name === "master");
  const work = product.worktrees.find((w) => w.name === "WorkFoo");
  const fix = product.worktrees.find((w) => w.name === "SecFix-20260716");
  assert.ok(base && work && fix);
  assert.equal(base!.role, "base");
  assert.equal(base!.isProtected, true);
  assert.equal(work!.role, "work");
  assert.equal(work!.isProtected, true);
  assert.equal(fix!.role, "fix");
  assert.equal(fix!.isProtected, false);
  assert.equal(fix!.branch, "security/CVE-2026-0001");
});

test("discover_WhenDomainGroupHasNoConfigShButHasBareRepoChildren_ThenStillDetectedAsGroup", () => {
  const root = makeTmpRoot();

  const groupDir = join(root, "NoConfigGroup");
  mkdirSync(groupDir, { recursive: true });
  const soloDir = join(groupDir, "Solo");
  initBareRepo(soloDir);
  const soloMaster = addWorktree(soloDir, "master", "master");
  writeFileSync(join(soloMaster, "Solo.csproj"), `<Project><ItemGroup /></Project>`);
  commitAll(soloMaster, "init solo");

  const topo = discover(root);

  assert.equal(topo.groups.length, 1);
  const group = topo.groups[0];
  assert.equal(group.name, "NoConfigGroup");
  assert.equal(group.commonRepo, null, "no dir literally named Common");
  assert.equal(group.services.length, 1);
  assert.equal(group.services[0].name, "Solo");
  // No config.sh entry and an (essentially empty) csproj with no PackageReference
  // -> isDotnet still true because a *.csproj file exists under the base worktree.
  assert.equal(group.services[0].isDotnet, true);
});

// ---------------------------------------------------------------------------
// remoteUrl — captured from `git remote get-url origin` on the bare repo
// ---------------------------------------------------------------------------

test("discover_WhenBareRepoHasOriginRemote_ThenServiceRepoCapturesRemoteUrl", () => {
  const root = makeTmpRoot();

  const repoDir = join(root, "WithRemote");
  initBareRepo(repoDir);
  const master = addWorktree(repoDir, "master", "master");
  writeFileSync(join(master, "file.txt"), "content\n");
  commitAll(master, "init");

  const remoteUrl =
    "dev-hoffmann-group-digital@vs-ssh.visualstudio.com:v3/dev-hoffmann-group-digital/Digital%20Twin/Hoffmann.DigitalTwin.AppHost";
  const remoteRes = git(repoDir, ["remote", "add", "origin", remoteUrl]);
  assert.ok(remoteRes.ok, `git remote add failed: ${remoteRes.stderr}`);

  const topo = discover(root);

  const repo = topo.workspaceRepos.find((r) => r.name === "WithRemote");
  assert.ok(repo, "WithRemote repo must be discovered");
  assert.equal(repo!.remoteUrl, remoteUrl);
});

test("discover_WhenBareRepoHasNoOriginRemote_ThenRemoteUrlIsNull", () => {
  const root = makeTmpRoot();

  const repoDir = join(root, "NoRemote");
  initBareRepo(repoDir);
  const master = addWorktree(repoDir, "master", "master");
  writeFileSync(join(master, "file.txt"), "content\n");
  commitAll(master, "init");

  const topo = discover(root);

  const repo = topo.workspaceRepos.find((r) => r.name === "NoRemote");
  assert.ok(repo, "NoRemote repo must be discovered");
  assert.equal(repo!.remoteUrl, null);
});
