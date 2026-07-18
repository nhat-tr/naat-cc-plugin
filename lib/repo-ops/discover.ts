// discover — walks the workspace root and builds the Topology model.
//
// Two topology shapes (per the design spec):
//   - workspace-level repo: a bare git repo directly under workspaceRoot.
//   - domain group: a plain dir (config.sh and/or bare-repo children) holding
//     one bare service repo per child dir; a dir literally named "Common"
//     becomes the group's shared commonRepo.
//
// This module only reads (git plumbing + filesystem); it never mutates a repo.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { git } from "./sh.ts";
import type {
  DomainGroup,
  PackageRef,
  ServiceRepo,
  Topology,
  Worktree,
  WorktreeRole,
} from "./types.ts";

/** Per-repo flags parsed out of a domain group's config.sh. */
interface ConfigEntry {
  dotnet: boolean;
  submodule: boolean;
}

const SKIP_DIRS = new Set([".git", "bin", "obj", "node_modules"]);

// ---------------------------------------------------------------------------
// Worktree classification
// ---------------------------------------------------------------------------

/**
 * Maps a worktree's dir name (and, for future rules, its checked-out branch)
 * to a role + protection flag. Base/Work/Review are protected from fix work;
 * SecFix-* fix worktrees are the only place bump/build/PR work may happen.
 */
export function classifyWorktree(
  name: string,
  _branch: string,
): { role: WorktreeRole; isProtected: boolean } {
  if (name === "master" || name === "main") {
    return { role: "base", isProtected: true };
  }
  if (/^Work/.test(name)) {
    return { role: "work", isProtected: true };
  }
  if (name === "Review") {
    return { role: "review", isProtected: true };
  }
  if (/^SecFix/.test(name)) {
    return { role: "fix", isProtected: false };
  }
  return { role: "other", isProtected: false };
}

// ---------------------------------------------------------------------------
// git plumbing helpers
// ---------------------------------------------------------------------------

function isBareRepo(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  const res = git(dirPath, ["rev-parse", "--is-bare-repository"]);
  return res.ok && res.stdout.trim() === "true";
}

/** Parse `git worktree list --porcelain`, dropping the bare pseudo-entry. */
function parseWorktreePorcelain(output: string): Array<{ path: string; branch: string }> {
  const blocks = output
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const results: Array<{ path: string; branch: string }> = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.some((l) => l.trim() === "bare")) continue; // the bare container itself
    let path = "";
    let branch = "detached";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
    }
    if (path) results.push({ path, branch });
  }
  return results;
}

function getWorktrees(bareRepoPath: string): Worktree[] {
  const res = git(bareRepoPath, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  return parseWorktreePorcelain(res.stdout).map(({ path, branch }) => {
    const name = basename(path);
    const { role, isProtected } = classifyWorktree(name, branch);
    return { name, path, branch, role, isProtected };
  });
}

/** `git remote get-url origin`, trimmed; null when there's no `origin` remote
 * (or the read otherwise fails) rather than throwing. */
function getRemoteUrl(bareRepoPath: string): string | null {
  const res = git(bareRepoPath, ["remote", "get-url", "origin"]);
  if (!res.ok) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDefaultBranch(bareRepoPath: string): string {
  const symref = git(bareRepoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symref.ok) {
    const val = symref.stdout.trim();
    return val.startsWith("origin/") ? val.slice("origin/".length) : val;
  }
  for (const candidate of ["master", "main"]) {
    const verify = git(bareRepoPath, ["rev-parse", "--verify", `origin/${candidate}`]);
    if (verify.ok) return candidate;
  }
  return "master";
}

// ---------------------------------------------------------------------------
// Filesystem helpers (base worktree contents: .gitmodules, *.csproj)
// ---------------------------------------------------------------------------

function readCommonSubmodulePath(baseWorktreeDir: string): string | null {
  const gmPath = join(baseWorktreeDir, ".gitmodules");
  if (!existsSync(gmPath)) return null;
  const content = readFileSync(gmPath, "utf8");
  const pathRe = /^\s*path\s*=\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(content)) !== null) {
    const p = m[1].trim();
    if (p.includes("Common")) return p;
  }
  return null;
}

function findCsprojFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(d, e.name));
      } else if (e.isFile() && e.name.endsWith(".csproj")) {
        results.push(join(d, e.name));
      }
    }
  };
  walk(dir);
  return results;
}

/** Handles both `<PackageReference Include="X" Version="Y" />` and the
 * child-element `<PackageReference Include="X"><Version>Y</Version></PackageReference>` form. */
function extractPackageRefs(content: string, csprojPath: string): PackageRef[] {
  const refs: PackageRef[] = [];
  const tagRe = /<PackageReference\b([^>]*?)(\/>|>([\s\S]*?)<\/PackageReference>)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content)) !== null) {
    const attrs = m[1];
    const inner = m[3] ?? "";
    const includeMatch = /Include\s*=\s*"([^"]+)"/.exec(attrs);
    if (!includeMatch) continue;
    const versionAttrMatch = /Version\s*=\s*"([^"]+)"/.exec(attrs);
    const versionElMatch = versionAttrMatch ? null : /<Version>([^<]+)<\/Version>/.exec(inner);
    const version = versionAttrMatch?.[1] ?? versionElMatch?.[1];
    if (!version) continue;
    refs.push({
      package: includeMatch[1],
      version,
      csprojPath,
      projectDir: dirname(csprojPath),
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// config.sh parsing
// ---------------------------------------------------------------------------

/** Maps a config.sh `name=` value (e.g. "Hoffmann.Calibration.Product") to the
 * service dir it names (e.g. "Product") — the last dot-segment. */
function dirNameForConfigName(name: string): string {
  const segs = name.split(".");
  return segs[segs.length - 1];
}

/** Parses `REPOS[n]="{name=X, dotnet=true, submodule=false}",`-style lines. */
function parseConfigSh(content: string): Map<string, ConfigEntry> {
  const map = new Map<string, ConfigEntry>();
  const braceRe = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = braceRe.exec(content)) !== null) {
    const kv: Record<string, string> = {};
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      kv[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    if (!kv.name) continue;
    map.set(dirNameForConfigName(kv.name), {
      dotnet: kv.dotnet === "true",
      submodule: kv.submodule === "true",
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// ServiceRepo construction
// ---------------------------------------------------------------------------

function buildServiceRepo(
  dirPath: string,
  name: string,
  group: string | null,
  cfgEntry: ConfigEntry | undefined,
): ServiceRepo {
  const worktrees = getWorktrees(dirPath);
  const baseWorktree = worktrees.find((w) => w.role === "base") ?? null;
  const defaultBranch = getDefaultBranch(dirPath);
  const remoteUrl = getRemoteUrl(dirPath);

  const csprojFiles = baseWorktree ? findCsprojFiles(baseWorktree.path) : [];
  const csprojIndex = csprojFiles.flatMap((f) => extractPackageRefs(readFileSync(f, "utf8"), f));

  const isDotnet = cfgEntry?.dotnet === true || csprojFiles.length > 0;

  const commonSubmodulePath = baseWorktree ? readCommonSubmodulePath(baseWorktree.path) : null;
  const usesCommonSubmodule = commonSubmodulePath !== null || cfgEntry?.submodule === true;

  return {
    name,
    group,
    bareRepoPath: dirPath,
    remoteUrl,
    worktrees,
    defaultBranch,
    isDotnet,
    usesCommonSubmodule,
    commonSubmodulePath,
    csprojIndex,
  };
}

// ---------------------------------------------------------------------------
// Top-level discover
// ---------------------------------------------------------------------------

function listChildDirs(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function discover(workspaceRoot: string): Topology {
  const root = resolve(workspaceRoot);
  const groups: DomainGroup[] = [];
  const workspaceRepos: ServiceRepo[] = [];

  for (const entryName of listChildDirs(root)) {
    const dirPath = join(root, entryName);

    if (isBareRepo(dirPath)) {
      workspaceRepos.push(buildServiceRepo(dirPath, entryName, null, undefined));
      continue;
    }

    const configPath = join(dirPath, "config.sh");
    const hasConfig = existsSync(configPath);
    const childNames = listChildDirs(dirPath);
    const childBareNames = childNames.filter((c) => isBareRepo(join(dirPath, c)));

    if (!hasConfig && childBareNames.length === 0) continue; // not a group; ignore

    const configMap = hasConfig ? parseConfigSh(readFileSync(configPath, "utf8")) : new Map();
    let commonRepo: ServiceRepo | null = null;
    const services: ServiceRepo[] = [];

    for (const childName of childBareNames) {
      const childPath = join(dirPath, childName);
      const repo = buildServiceRepo(childPath, childName, entryName, configMap.get(childName));
      if (childName === "Common") {
        commonRepo = repo;
      } else {
        services.push(repo);
      }
    }

    groups.push({ name: entryName, path: dirPath, commonRepo, services });
  }

  return { workspaceRoot: root, groups, workspaceRepos };
}
