// types — general repo-ops domain model, shared across skills/tools.
//
// This module is the single source of truth for the workspace/worktree/repo
// topology model and the operation-result shapes used by repo-ops modules
// (discover, worktree, bump, pr, submodule, repo-image-map). Vuln-specific
// types (kube-vuln report shapes, Plan/Lane routing) live in the consuming
// skill's own vuln-types.ts, not here.
//
// Vocabulary (from the approved design spec):
//   domain group   — a plain dir (e.g. Calibration) holding config.sh + one bare
//                    git repo per service, each service repo owning its worktrees.
//   service repo   — a bare git repo (e.g. Product, Common) with worktrees as subdirs.
//   Common         — the per-group shared repo consumed by submodule=true services.
//   worktree       — a checked-out branch subdir: master (base), Work* (in-progress),
//                    Review, or a tool-created SecFix-* (fix) worktree.

// ---------------------------------------------------------------------------
// Topology model (discover)
// ---------------------------------------------------------------------------

export type WorktreeRole = "base" | "work" | "review" | "fix" | "other";

export interface Worktree {
  name: string; // subdir name, e.g. "master", "WorkCalProduct", "SecFix-20260716"
  path: string; // absolute
  branch: string; // checked-out branch (or "detached")
  role: WorktreeRole;
  /** True for base/work/review — fix work must never edit or commit into these. */
  isProtected: boolean;
}

export interface PackageRef {
  package: string; // PackageReference Include=
  version: string; // Version=
  csprojPath: string; // absolute path to the .csproj declaring it
  projectDir: string; // absolute dir of that .csproj
}

export interface ServiceRepo {
  name: string; // service dir name, e.g. "Product" / "Common"
  group: string | null; // domain group name, or null for a workspace-level repo
  bareRepoPath: string; // absolute path to the dir that holds the bare .git
  remoteUrl: string | null; // `git remote get-url origin`, trimmed; null if none/unreadable
  worktrees: Worktree[];
  defaultBranch: string; // "master" | "main" (resolved from origin/HEAD; best-effort)
  isDotnet: boolean; // config.sh dotnet=true, or has *.csproj when unknown
  usesCommonSubmodule: boolean; // config.sh submodule=true OR .gitmodules references Common
  commonSubmodulePath: string | null; // e.g. "Hoffmann.Calibration.Common"
  /** PackageReference index harvested from the repo's base (master) worktree. */
  csprojIndex: PackageRef[];
}

export interface DomainGroup {
  name: string; // "Calibration"
  path: string; // absolute
  commonRepo: ServiceRepo | null; // the group's Common repo, if present
  services: ServiceRepo[]; // all service repos in the group (excludes commonRepo)
}

export interface Topology {
  workspaceRoot: string;
  groups: DomainGroup[];
  workspaceRepos: ServiceRepo[]; // single bare repos directly under the workspace root
}

// ---------------------------------------------------------------------------
// Manual image->repo mapping (authoritative override for the heuristic)
// ---------------------------------------------------------------------------

/** One reviewed mapping row: which cluster image names correspond to a local repo. */
export interface RepoImageMapEntry {
  group: string | null; // domain group name (null for a workspace-level repo)
  repo: string; // local ServiceRepo.name
  images: string[]; // kube-vuln image repository strings (finding.affectedServices[])
}

/**
 * User-maintained image->repo map. `byImage` is the resolved lookup built from
 * `entries` at load time; buildPlan consults it FIRST (authoritative), falling
 * back to the basename heuristic only for image strings absent from the map.
 */
export interface RepoImageMap {
  entries: RepoImageMapEntry[];
  byImage: Record<string, { group: string | null; repo: string }>;
}

// ---------------------------------------------------------------------------
// Operation results (fix-worktree, bump, open-pr, bump-submodule)
// ---------------------------------------------------------------------------

export interface FixWorktreeResult {
  repo: string;
  worktreePath: string;
  branch: string; // e.g. security/CVE-2025-1234 or security/20260716
  baseRef: string; // origin/<default> the branch was cut from (via updated master)
  masterFastForwarded: boolean; // false when we had to branch from origin/<default> directly
  branchedFrom: "master" | "origin"; // provenance of the fix worktree
}

export interface BumpResult {
  csprojPath: string;
  package: string;
  from: string;
  to: string;
  buildOk: boolean;
  buildOutputTail: string; // last lines of dotnet build output for diagnosis
}

export interface PrResult {
  repo: string;
  branch: string;
  targetBranch: string;
  pullRequestId: number | null;
  url: string | null;
  dryRun: boolean;
}

export interface SubmoduleBumpResult {
  consumerRepo: string;
  submodulePath: string;
  fromSha: string;
  toSha: string;
  buildOk: boolean;
}
