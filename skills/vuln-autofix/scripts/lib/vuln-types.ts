// vuln-types — vulnerability/remediation-specific domain model for the
// vuln-autofix skill (kube-vuln input contract and the plan/lane routing
// model). General repo topology and operation-result types live in
// lib/repo-ops/types.ts, not here.
//
// Vocabulary (from the approved design spec):
//   Lane A         — mechanical, build-verified direct PackageReference bump -> PR.
//   Lane B         — researched + proposed remediation (no auto-edit).

// ---------------------------------------------------------------------------
// kube-vuln input contract (mirrors get-vulns.ts output; do not diverge)
// ---------------------------------------------------------------------------

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

/** One entry of kube-vuln `highAndCritical[]`. */
export interface KubeVulnFinding {
  id: string; // CVE / advisory id
  severity: Severity;
  resource: string; // package name (NuGet id for .NET, OS package otherwise)
  installedVersion: string;
  fixedVersion: string; // "" when no fix is available yet
  title: string;
  links: string[];
  affectedServices: string[]; // container image repository names
}

/** Full kube-vuln `get-vulns.ts` JSON document. */
export interface KubeVulnReport {
  context: { cluster: string; namespace: string };
  services: Array<{
    name: string;
    repository: string;
    tag: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  }>;
  highAndCritical: KubeVulnFinding[];
  meta: {
    totalServices: number;
    totalUniqueCves: number;
    fixable: number;
    noFixYet: number;
  };
}

// ---------------------------------------------------------------------------
// Plan model (plan — the CVE -> source bridge)
// ---------------------------------------------------------------------------

export type Lane = "A" | "B";

/** Why a finding is routed to Lane B (research + propose) instead of auto-bump. */
export type LaneBReason =
  | "no-fix" // fixedVersion is empty
  | "not-a-packageref" // resource matches no direct PackageReference anywhere (OS/base-image)
  | "transitive-only" // package present only transitively, not a direct reference
  | "breaking-major" // fixedVersion is a major-version jump from installedVersion
  | "ambiguous-mapping" // fixable NuGet package, but the image->repo mapping is ambiguous/unresolved — ask the user which repo (never guess)
  | "policy-hold"; // package is on the neverUpgrade policy list — never auto-bump; research/propose only

/** One image repo mapped (or not) to a local service repo. */
export interface MappedService {
  imageRepo: string; // from finding.affectedServices[]
  localRepo: string | null; // resolved ServiceRepo.name, or null if unresolved
  group: string | null;
  ambiguous: boolean; // true when more than one candidate matched -> ask the user
}

export interface DirectRef {
  repo: string; // ServiceRepo.name that directly references the vulnerable package
  group: string | null;
  csprojPaths: string[];
}

export interface PlanRow {
  finding: KubeVulnFinding;
  lane: Lane;
  laneBReason: LaneBReason | null;
  /** Where the vulnerable package is referenced. */
  owner: {
    inCommon: boolean; // referenced in a group's Common repo
    group: string | null;
    directRefs: DirectRef[];
  };
  /** Present only for Lane A rows. */
  bump: { package: string; from: string; to: string } | null;
  mappedServices: MappedService[];
}

export interface Plan {
  report: KubeVulnReport;
  laneA: PlanRow[]; // mechanical bumps
  laneB: PlanRow[]; // research + propose (nothing dropped: laneA + laneB cover every HIGH/CRITICAL)
}
