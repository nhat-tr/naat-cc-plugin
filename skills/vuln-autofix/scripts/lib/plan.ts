// plan — the CVE -> source bridge (design spec §Design "3 joins", D3, D10).
//
// buildPlan() joins each kube-vuln HIGH/CRITICAL finding to the local repo
// topology and decides Lane A (mechanical bump) vs Lane B (research +
// propose). It never touches the filesystem or git — pure data in, data out.

import type { RepoImageMap, ServiceRepo, Topology } from "../../../../lib/repo-ops/types.ts";
import type {
  DirectRef,
  KubeVulnFinding,
  KubeVulnReport,
  Lane,
  LaneBReason,
  MappedService,
  Plan,
  PlanRow,
} from "./vuln-types.ts";
import { resolveImage } from "../../../../lib/repo-ops/repo-image-map.ts";
import type { VulnPolicy } from "./policy.ts";
import { isHeld } from "./policy.ts";

// ---------------------------------------------------------------------------
// Repo collection helpers
// ---------------------------------------------------------------------------

/** Flattens the topology into every ServiceRepo (workspace-level + group members). */
function allRepos(topology: Topology): ServiceRepo[] {
  const fromGroups = topology.groups.flatMap((g) => [
    ...(g.commonRepo ? [g.commonRepo] : []),
    ...g.services,
  ]);
  return [...topology.workspaceRepos, ...fromGroups];
}

// ---------------------------------------------------------------------------
// Ownership scope (join iii feeds join i + ii)
// ---------------------------------------------------------------------------

/**
 * The set of repos ownership may be computed over, plus the resolved group.
 * `commonRepo` is that group's Common (for the inCommon test); it is null for
 * workspace-level repos and when the group cannot be determined.
 */
interface OwnershipScope {
  group: string | null;
  repos: ServiceRepo[];
  commonRepo: ServiceRepo | null;
}

const EMPTY_SCOPE: OwnershipScope = { group: null, repos: [], commonRepo: null };

/**
 * Determine which repos own this finding's fix, derived from its successfully
 * mapped services (join iii). Spec D4 + the "never guess a mapping" safety
 * invariant:
 *  - scope to the single domain group all successful mappings agree on;
 *  - if nothing maps, or the successful mappings span more than one group,
 *    the group is undetermined -> empty scope (rely on the ambiguous flag).
 */
function resolveOwnershipScope(
  mappedServices: MappedService[],
  topology: Topology,
  repos: ServiceRepo[],
): OwnershipScope {
  const resolved: ServiceRepo[] = [];
  for (const m of mappedServices) {
    if (m.ambiguous || m.localRepo === null) continue;
    const hit = repos.find((r) => r.name === m.localRepo && r.group === m.group);
    if (hit) resolved.push(hit);
  }
  if (resolved.length === 0) return EMPTY_SCOPE;

  const distinctGroups = [...new Set(resolved.map((r) => r.group))];
  if (distinctGroups.length !== 1) return EMPTY_SCOPE; // spans groups -> don't guess

  const group = distinctGroups[0];
  if (group === null) {
    // Workspace-level repo(s): no domain group, no Common. Scope to them.
    return { group: null, repos: [...new Set(resolved)], commonRepo: null };
  }

  const domainGroup = topology.groups.find((g) => g.name === group);
  if (!domainGroup) return EMPTY_SCOPE;
  const groupRepos = [
    ...(domainGroup.commonRepo ? [domainGroup.commonRepo] : []),
    ...domainGroup.services,
  ];
  return { group, repos: groupRepos, commonRepo: domainGroup.commonRepo };
}

// ---------------------------------------------------------------------------
// Owner / direct-ref join (join i + ii), scoped to the target group
// ---------------------------------------------------------------------------

function buildOwner(resource: string, scope: OwnershipScope): PlanRow["owner"] {
  const lower = resource.toLowerCase();
  const directRefs: DirectRef[] = [];
  let inCommon = false;

  for (const repo of scope.repos) {
    const matches = repo.csprojIndex.filter((p) => p.package.toLowerCase() === lower);
    if (matches.length === 0) continue;

    const csprojPaths = [...new Set(matches.map((m) => m.csprojPath))];
    directRefs.push({ repo: repo.name, group: repo.group, csprojPaths });

    if (scope.commonRepo && repo.bareRepoPath === scope.commonRepo.bareRepoPath) {
      inCommon = true;
    }
  }

  return { inCommon, group: scope.group, directRefs };
}

// ---------------------------------------------------------------------------
// affectedServices -> local service mapping (join iii)
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function identityTokens(repo: ServiceRepo): Set<string> {
  const tokens = new Set<string>();
  if (repo.group) for (const t of tokenize(repo.group)) tokens.add(t);
  for (const t of tokenize(repo.name)) tokens.add(t);
  return tokens;
}

/**
 * Basename heuristic: take the segment after the last "/", tokenize on
 * non-alphanumerics, and require every image token to appear in the
 * candidate's identity tokens (group name + service dir name). Zero or
 * multiple candidates -> ambiguous, stop and ask (D4).
 */
function mapImageToService(imageRepo: string, repos: ServiceRepo[]): MappedService {
  const base = imageRepo.split("/").pop() ?? imageRepo;
  const imageTokens = tokenize(base);

  const matches =
    imageTokens.length === 0
      ? []
      : repos.filter((repo) => {
          const candidate = identityTokens(repo);
          return imageTokens.every((t) => candidate.has(t));
        });

  if (matches.length === 1) {
    const repo = matches[0];
    return { imageRepo, localRepo: repo.name, group: repo.group, ambiguous: false };
  }
  return { imageRepo, localRepo: null, group: null, ambiguous: true };
}

/**
 * Resolve one `affectedServices` image string to a local service. A manual
 * `imageMap` entry is authoritative and skips the heuristic entirely for that
 * image; only images absent from the map fall back to `mapImageToService`.
 */
function resolveMappedService(
  imageRepo: string,
  repos: ServiceRepo[],
  imageMap: RepoImageMap | undefined,
): MappedService {
  const pinned = imageMap ? resolveImage(imageMap, imageRepo) : undefined;
  if (pinned) {
    return { imageRepo, localRepo: pinned.repo, group: pinned.group, ambiguous: false };
  }
  return mapImageToService(imageRepo, repos);
}

// ---------------------------------------------------------------------------
// major-version parsing (D9 breaking-major guard)
// ---------------------------------------------------------------------------

/** First integer segment of a version string; parses defensively (NaN on failure). */
function major(version: string): number {
  const m = /(\d+)/.exec(version);
  return m ? Number.parseInt(m[1], 10) : Number.NaN;
}

/** Does `resource` match a direct PackageReference anywhere in the topology
 * (case-insensitive)? Used only to tell a recognized-but-unplaceable NuGet
 * package (ambiguous-mapping) apart from a genuine OS/base-image resource. */
function matchesAnyPackageRef(resource: string, repos: ServiceRepo[]): boolean {
  const lower = resource.toLowerCase();
  return repos.some((r) => r.csprojIndex.some((p) => p.package.toLowerCase() === lower));
}

// ---------------------------------------------------------------------------
// Lane decision (D3)
// ---------------------------------------------------------------------------

/**
 * @param heldByPolicy  true when the resource is on the neverUpgrade policy
 *   list — never auto-bump, research/propose only (checked right after no-fix).
 * @param scopeResolved  true when the image->group mapping pinned a single
 *   ownership scope; false when the mapping is ambiguous/unmapped (never guess).
 * @param scopedDirectRefCount  direct refs within the resolved scope only.
 * @param knownPackageAnywhere  resource matches a PackageReference somewhere in
 *   the whole topology — distinguishes ambiguous-mapping from a real OS resource.
 */
function decideLane(
  finding: KubeVulnFinding,
  heldByPolicy: boolean,
  scopeResolved: boolean,
  scopedDirectRefCount: number,
  knownPackageAnywhere: boolean,
): { lane: Lane; laneBReason: LaneBReason | null; bump: PlanRow["bump"] } {
  // no-fix always wins first (empty fixedVersion), regardless of mapping.
  if (finding.fixedVersion === "") {
    return { lane: "B", laneBReason: "no-fix", bump: null };
  }

  // never-auto-upgrade policy: a held package is research/propose only, even
  // when it would otherwise be a clean Lane A bump.
  if (heldByPolicy) {
    return { lane: "B", laneBReason: "policy-hold", bump: null };
  }

  if (!scopeResolved) {
    // The image->repo mapping is ambiguous or unmapped: we must not guess a
    // repo to bump. A package we recognize elsewhere is fixable-but-unplaceable
    // (ask the user); otherwise it is a genuine OS/base-image resource.
    return {
      lane: "B",
      laneBReason: knownPackageAnywhere ? "ambiguous-mapping" : "not-a-packageref",
      bump: null,
    };
  }

  if (scopedDirectRefCount === 0) {
    // Mapped to a group, but the package is not referenced there (OS/base-image,
    // transitive-only, or referenced only in a different group).
    return { lane: "B", laneBReason: "not-a-packageref", bump: null };
  }
  if (major(finding.fixedVersion) > major(finding.installedVersion)) {
    return { lane: "B", laneBReason: "breaking-major", bump: null };
  }
  return {
    lane: "A",
    laneBReason: null,
    bump: { package: finding.resource, from: finding.installedVersion, to: finding.fixedVersion },
  };
}

// ---------------------------------------------------------------------------
// buildPlan
// ---------------------------------------------------------------------------

export function buildPlan(
  report: KubeVulnReport,
  topology: Topology,
  imageMap?: RepoImageMap,
  policy?: VulnPolicy,
): Plan {
  const repos = allRepos(topology);

  const laneA: PlanRow[] = [];
  const laneB: PlanRow[] = [];

  for (const finding of report.highAndCritical) {
    // join iii first: the mapped image decides which domain group owns the fix.
    // A manual imageMap entry is authoritative and bypasses the heuristic.
    const mappedServices = finding.affectedServices.map((img) =>
      resolveMappedService(img, repos, imageMap),
    );
    const scope = resolveOwnershipScope(mappedServices, topology, repos);

    // joins i + ii, scoped to that group only (never leak cross-group repos).
    const owner = buildOwner(finding.resource, scope);
    const scopeResolved = scope.repos.length > 0;
    const { lane, laneBReason, bump } = decideLane(
      finding,
      isHeld(policy, finding.resource),
      scopeResolved,
      owner.directRefs.length,
      matchesAnyPackageRef(finding.resource, repos),
    );

    const row: PlanRow = { finding, lane, laneBReason, owner, bump, mappedServices };
    (lane === "A" ? laneA : laneB).push(row);
  }

  return { report, laneA, laneB };
}
