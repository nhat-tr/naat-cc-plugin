// Tests for plan.ts — the CVE -> source bridge. Pure data-in/data-out, so
// fixtures are plain object literals typed as Topology; no git/filesystem
// needed (per the harness's test conventions for plan tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "./plan.ts";
import type {
  DomainGroup,
  PackageRef,
  RepoImageMap,
  ServiceRepo,
  Topology,
} from "../../../../lib/repo-ops/types.ts";
import type { KubeVulnFinding, KubeVulnReport } from "./vuln-types.ts";
import type { VulnPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function pkgRef(pkg: string, version: string, csprojPath: string): PackageRef {
  return { package: pkg, version, csprojPath, projectDir: csprojPath.replace(/\/[^/]+$/, "") };
}

function repo(name: string, group: string | null, csprojIndex: PackageRef[]): ServiceRepo {
  return {
    name,
    group,
    bareRepoPath: `/fake/${group ?? "workspace"}/${name}`,
    remoteUrl: null,
    worktrees: [],
    defaultBranch: "master",
    isDotnet: true,
    usesCommonSubmodule: false,
    commonSubmodulePath: null,
    csprojIndex,
  };
}

function finding(overrides: Partial<KubeVulnFinding>): KubeVulnFinding {
  return {
    id: "CVE-0000-0000",
    severity: "HIGH",
    resource: "Some.Package",
    installedVersion: "1.0.0",
    fixedVersion: "1.0.1",
    title: "test finding",
    links: [],
    affectedServices: [],
    ...overrides,
  };
}

function report(findings: KubeVulnFinding[]): KubeVulnReport {
  return {
    context: { cluster: "test", namespace: "test" },
    services: [],
    highAndCritical: findings,
    meta: {
      totalServices: 0,
      totalUniqueCves: findings.length,
      fixable: findings.filter((f) => f.fixedVersion).length,
      noFixYet: findings.filter((f) => !f.fixedVersion).length,
    },
  };
}

/** Calibration (Common + Product + CalCore) and Regrinding (Common + Product)
 * so a bare "product" image name is genuinely ambiguous across groups, while
 * "calibration-product" resolves uniquely — mirrors the real workspace shape. */
function buildTopology(): Topology {
  const calCommon = repo("Common", "Calibration", [
    pkgRef("Newtonsoft.Json", "12.0.1", "/fake/Calibration/Common/Common.csproj"),
  ]);
  const calProduct = repo("Product", "Calibration", [
    pkgRef("Microsoft.Extensions.Http", "6.0.0", "/fake/Calibration/Product/Product.csproj"),
  ]);
  const calCore = repo("CalCore", "Calibration", []);

  const regrindingCommon = repo("Common", "Regrinding", [
    pkgRef("Serilog", "2.10.0", "/fake/Regrinding/Common/Common.csproj"),
  ]);
  const regrindingProduct = repo("Product", "Regrinding", []);

  const groups: DomainGroup[] = [
    {
      name: "Calibration",
      path: "/fake/Calibration",
      commonRepo: calCommon,
      services: [calProduct, calCore],
    },
    {
      name: "Regrinding",
      path: "/fake/Regrinding",
      commonRepo: regrindingCommon,
      services: [regrindingProduct],
    },
  ];

  const workspaceRepos: ServiceRepo[] = [repo("LocalDevInfra", null, [])];

  return { workspaceRoot: "/fake", groups, workspaceRepos };
}

// ---------------------------------------------------------------------------
// AC-1: Lane A rows are tagged with owning repo (Common vs specific service) + group
// ---------------------------------------------------------------------------

test("buildPlan_WhenMinorBumpOfPackageReferencedInCommon_ThenLaneAWithCommonOwnership", () => {
  const topo = buildTopology();
  const f = finding({
    id: "CVE-COMMON-1",
    resource: "Newtonsoft.Json",
    installedVersion: "12.0.1",
    fixedVersion: "12.0.2",
    affectedServices: ["registry.example.com/calibration-product"],
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 1);
  assert.equal(plan.laneB.length, 0);
  const row = plan.laneA[0];
  assert.equal(row.lane, "A");
  assert.equal(row.laneBReason, null);
  assert.deepEqual(row.bump, { package: "Newtonsoft.Json", from: "12.0.1", to: "12.0.2" });
  assert.equal(row.owner.inCommon, true, "package is referenced in Calibration's Common repo");
  assert.equal(row.owner.group, "Calibration");
  assert.equal(row.owner.directRefs.length, 1);
  assert.equal(row.owner.directRefs[0].repo, "Common");
});

test("buildPlan_WhenMinorBumpOfPackageReferencedInSpecificService_ThenOwnerIsNotCommon", () => {
  const topo = buildTopology();
  const f = finding({
    id: "CVE-SERVICE-1",
    resource: "Microsoft.Extensions.Http",
    installedVersion: "6.0.0",
    fixedVersion: "6.0.1",
    affectedServices: ["calibration-product"], // maps unambiguously to Calibration
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 1);
  const row = plan.laneA[0];
  assert.equal(row.owner.inCommon, false);
  assert.equal(row.owner.group, "Calibration");
  assert.equal(row.owner.directRefs.length, 1);
  assert.equal(row.owner.directRefs[0].repo, "Product");
});

test("buildPlan_WhenResourceMatchesPackageReferenceCaseInsensitively_ThenStillJoinsToLaneA", () => {
  const topo = buildTopology();
  const f = finding({
    resource: "newtonsoft.json", // differs in case from the csproj's "Newtonsoft.Json"
    installedVersion: "12.0.1",
    fixedVersion: "12.0.2",
    affectedServices: ["calibration-product"], // scopes ownership to the Calibration group
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 1);
  assert.equal(plan.laneA[0].owner.inCommon, true);
});

// ---------------------------------------------------------------------------
// AC-5 / D3: Lane B — no-fix and not-a-packageref, never given a bump
// ---------------------------------------------------------------------------

test("buildPlan_WhenFixedVersionIsEmpty_ThenLaneBReasonNoFixAndNoBump", () => {
  const topo = buildTopology();
  const f = finding({
    id: "CVE-NOFIX-1",
    resource: "openssl",
    installedVersion: "1.1.1",
    fixedVersion: "",
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 0);
  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.lane, "B");
  assert.equal(row.laneBReason, "no-fix");
  assert.equal(row.bump, null);
});

test("buildPlan_WhenResourceMatchesNoPackageReference_ThenLaneBReasonNotAPackageRefAndNoBump", () => {
  const topo = buildTopology();
  const f = finding({
    id: "CVE-NOTPKG-1",
    resource: "libcurl", // an OS package; not any PackageReference anywhere in the topology
    installedVersion: "7.68.0",
    fixedVersion: "7.88.0",
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 0);
  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "not-a-packageref");
  assert.equal(row.bump, null);
  assert.equal(row.owner.directRefs.length, 0);
  assert.equal(row.owner.inCommon, false);
});

test("buildPlan_WhenFixedVersionEmptyEvenIfPackageHasDirectRef_ThenNoFixWinsOverNotAPackageRef", () => {
  // Ordering per D3 step 1: empty fixedVersion is checked before the
  // PackageReference join, regardless of whether a direct ref exists.
  const topo = buildTopology();
  const f = finding({
    resource: "Microsoft.Extensions.Http", // has a direct ref in Product
    installedVersion: "6.0.0",
    fixedVersion: "",
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneB.length, 1);
  assert.equal(plan.laneB[0].laneBReason, "no-fix");
});

// ---------------------------------------------------------------------------
// AC-7: major-version jump routes to Lane B, never auto-bumped
// ---------------------------------------------------------------------------

test("buildPlan_WhenFixedVersionIsMajorJumpFromInstalled_ThenLaneBReasonBreakingMajor", () => {
  const topo = buildTopology();
  const f = finding({
    id: "CVE-MAJOR-1",
    resource: "Microsoft.Extensions.Http",
    installedVersion: "6.0.0",
    fixedVersion: "9.0.0",
    affectedServices: ["calibration-product"], // maps to Calibration so a direct ref is in scope
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 0);
  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "breaking-major");
  assert.equal(row.bump, null);
  // Owner info is still populated even though it routed to Lane B.
  assert.equal(row.owner.directRefs.length, 1);
});

test("buildPlan_WhenFixedVersionIsSameMajorAsInstalled_ThenLaneA", () => {
  const topo = buildTopology();
  const f = finding({
    resource: "Microsoft.Extensions.Http",
    installedVersion: "6.0.0",
    fixedVersion: "6.5.2",
    affectedServices: ["calibration-product"],
  });
  const plan = buildPlan(report([f]), topo);
  assert.equal(plan.laneA.length, 1);
});

// ---------------------------------------------------------------------------
// Coverage invariant: every finding lands in exactly one lane
// ---------------------------------------------------------------------------

test("buildPlan_AcrossMixedFindings_ThenLaneACountPlusLaneBCountEqualsTotalFindings", () => {
  const topo = buildTopology();
  const findings = [
    finding({ id: "CVE-1", resource: "Newtonsoft.Json", installedVersion: "12.0.1", fixedVersion: "12.0.2" }),
    finding({ id: "CVE-2", resource: "openssl", installedVersion: "1.1.1", fixedVersion: "" }),
    finding({ id: "CVE-3", resource: "libcurl", installedVersion: "7.68.0", fixedVersion: "7.88.0" }),
    finding({ id: "CVE-4", resource: "Microsoft.Extensions.Http", installedVersion: "6.0.0", fixedVersion: "9.0.0" }),
    finding({ id: "CVE-5", resource: "Microsoft.Extensions.Http", installedVersion: "6.0.0", fixedVersion: "6.0.9" }),
  ];
  const plan = buildPlan(report(findings), topo);

  assert.equal(plan.laneA.length + plan.laneB.length, findings.length);
  // Sanity: none of the findings were dropped or duplicated.
  const seenIds = [...plan.laneA, ...plan.laneB].map((r) => r.finding.id).sort();
  assert.deepEqual(seenIds, findings.map((f) => f.id).sort());
});

// ---------------------------------------------------------------------------
// affectedServices -> local service mapping (join iii)
// ---------------------------------------------------------------------------

test("buildPlan_WhenImageBasenameIncludesGroupAndService_ThenMapsUnambiguouslyToLocalRepo", () => {
  const topo = buildTopology();
  const f = finding({ affectedServices: ["myregistry.azurecr.io/calibration-product"] });
  const plan = buildPlan(report([f]), topo);

  const row = [...plan.laneA, ...plan.laneB][0];
  assert.equal(row.mappedServices.length, 1);
  const mapped = row.mappedServices[0];
  assert.equal(mapped.ambiguous, false);
  assert.equal(mapped.localRepo, "Product");
  assert.equal(mapped.group, "Calibration");
});

test("buildPlan_WhenImageBasenameMatchesServiceInMultipleGroups_ThenAmbiguousWithNullLocalRepo", () => {
  const topo = buildTopology();
  // "product" alone matches both Calibration/Product and Regrinding/Product.
  const f = finding({ affectedServices: ["product"] });
  const plan = buildPlan(report([f]), topo);

  const row = [...plan.laneA, ...plan.laneB][0];
  const mapped = row.mappedServices[0];
  assert.equal(mapped.ambiguous, true);
  assert.equal(mapped.localRepo, null);
});

test("buildPlan_WhenImageBasenameMatchesNoCandidate_ThenAmbiguousWithNullLocalRepo", () => {
  const topo = buildTopology();
  const f = finding({ affectedServices: ["totally-unrelated-image"] });
  const plan = buildPlan(report([f]), topo);

  const row = [...plan.laneA, ...plan.laneB][0];
  const mapped = row.mappedServices[0];
  assert.equal(mapped.ambiguous, true);
  assert.equal(mapped.localRepo, null);
});

// ---------------------------------------------------------------------------
// Regression: ownership join must be scoped to the mapped domain group only.
// (A live dry-run against both Calibration and Regrinding leaked cross-group
// repos into owner.directRefs and mis-resolved owner.group. Spec D4: "the
// group's Common"; submodule urls are relative and stay in-group.)
// ---------------------------------------------------------------------------

/** Two groups that BOTH directly reference the same packages, mirroring the
 * real workspace where Microsoft.AspNetCore.Authentication / EntityFrameworkCore
 * appear in Calibration and Regrinding repos alike. */
function buildTwoGroupSharedPackageTopology(): Topology {
  const AUTH = "Microsoft.AspNetCore.Authentication";
  const EF = "Microsoft.EntityFrameworkCore";

  // Calibration
  const calCommon = repo("Common", "Calibration", [
    pkgRef(AUTH, "6.0.0", "/fake/Calibration/Common/Common.csproj"),
    pkgRef(EF, "6.0.0", "/fake/Calibration/Common/Common.csproj"),
  ]);
  const calCore = repo("CalCore", "Calibration", [
    pkgRef(AUTH, "6.0.0", "/fake/Calibration/CalCore/CalCore.csproj"),
  ]);
  const calProduct = repo("Product", "Calibration", [
    pkgRef(AUTH, "6.0.0", "/fake/Calibration/Product/Product.csproj"),
    pkgRef(EF, "6.0.0", "/fake/Calibration/Product/Product.csproj"),
  ]);

  // Regrinding — same packages, different repos. Must never leak into a
  // Calibration-owned finding.
  const regCommon = repo("Common", "Regrinding", [
    pkgRef(AUTH, "6.0.0", "/fake/Regrinding/Common/Common.csproj"),
    pkgRef(EF, "6.0.0", "/fake/Regrinding/Common/Common.csproj"),
  ]);
  const regProduct = repo("Product", "Regrinding", [
    pkgRef(AUTH, "6.0.0", "/fake/Regrinding/Product/Product.csproj"),
  ]);
  const regHofflog = repo("Hofflog", "Regrinding", [
    pkgRef(AUTH, "6.0.0", "/fake/Regrinding/Hofflog/Hofflog.csproj"),
    pkgRef(EF, "6.0.0", "/fake/Regrinding/Hofflog/Hofflog.csproj"),
  ]);
  const regOrderService = repo("OrderService", "Regrinding", [
    pkgRef(AUTH, "6.0.0", "/fake/Regrinding/OrderService/OrderService.csproj"),
  ]);

  const groups: DomainGroup[] = [
    {
      name: "Calibration",
      path: "/fake/Calibration",
      commonRepo: calCommon,
      services: [calCore, calProduct],
    },
    {
      name: "Regrinding",
      path: "/fake/Regrinding",
      commonRepo: regCommon,
      services: [regProduct, regHofflog, regOrderService],
    },
  ];

  return { workspaceRoot: "/fake", groups, workspaceRepos: [] };
}

test("buildPlan_WhenPackageSharedAcrossGroupsAndRepoImageMapsToCalibration_ThenOwnershipScopedToCalibrationOnly", () => {
  const topo = buildTwoGroupSharedPackageTopology();
  const f = finding({
    id: "CVE-A-COMMON",
    resource: "Microsoft.AspNetCore.Authentication",
    installedVersion: "6.0.0",
    fixedVersion: "6.0.5", // same major -> Lane A eligible
    affectedServices: ["calibration-product"],
  });
  const plan = buildPlan(report([f]), topo);

  const row = [...plan.laneA, ...plan.laneB][0];

  // owner.group must be the mapped group, not whichever group happened to be
  // iterated last.
  assert.equal(row.owner.group, "Calibration");

  // No Regrinding repo may appear in directRefs.
  const refGroups = new Set(row.owner.directRefs.map((r) => r.group));
  assert.equal(refGroups.has("Regrinding"), false, "Regrinding repos leaked into ownership");
  assert.ok([...refGroups].every((g) => g === "Calibration"));

  // Exactly the Calibration repos that reference the package: Common, CalCore, Product.
  const refRepos = row.owner.directRefs.map((r) => r.repo).sort();
  assert.deepEqual(refRepos, ["CalCore", "Common", "Product"]);

  // inCommon reflects Calibration's Common only.
  assert.equal(row.owner.inCommon, true);

  // Lane A (same major, referenced in the mapped group).
  assert.equal(row.lane, "A");
  assert.deepEqual(row.bump, {
    package: "Microsoft.AspNetCore.Authentication",
    from: "6.0.0",
    to: "6.0.5",
  });
});

test("buildPlan_WhenSharedPackageMajorBumpMapsToCalibration_ThenLaneBBreakingMajorScopedToCalibration", () => {
  const topo = buildTwoGroupSharedPackageTopology();
  const f = finding({
    id: "CVE-B-MAJOR",
    resource: "Microsoft.EntityFrameworkCore",
    installedVersion: "6.0.0",
    fixedVersion: "9.0.0", // major jump
    affectedServices: ["calibration-product"],
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "breaking-major");
  assert.equal(row.owner.group, "Calibration");
  const refGroups = new Set(row.owner.directRefs.map((r) => r.group));
  assert.equal(refGroups.has("Regrinding"), false);
  // EF is referenced in Calibration Common + Product only.
  const refRepos = row.owner.directRefs.map((r) => r.repo).sort();
  assert.deepEqual(refRepos, ["Common", "Product"]);
  assert.equal(row.owner.inCommon, true);
});

test("buildPlan_WhenRepoImageMappingIsAmbiguous_ThenGroupUndeterminedAndNoCrossGroupRefs", () => {
  const topo = buildTwoGroupSharedPackageTopology();
  // "product" alone matches Product in BOTH groups -> ambiguous mapping. We
  // must not guess a group; ownership stays empty and the ambiguous flag
  // drives the orchestrator to ask.
  const f = finding({
    id: "CVE-AMBIG",
    resource: "Microsoft.AspNetCore.Authentication",
    installedVersion: "6.0.0",
    fixedVersion: "6.0.5",
    affectedServices: ["product"],
  });
  const plan = buildPlan(report([f]), topo);

  const row = [...plan.laneA, ...plan.laneB][0];
  assert.equal(row.mappedServices[0].ambiguous, true);
  assert.equal(row.mappedServices[0].localRepo, null);

  // Group undetermined -> no guessed ownership, no cross-group refs.
  assert.equal(row.owner.group, null);
  assert.deepEqual(row.owner.directRefs, []);
  assert.equal(row.owner.inCommon, false);

  // Cannot safely auto-bump an unmapped finding -> Lane B, never Lane A.
  assert.equal(row.lane, "B");
});

// ---------------------------------------------------------------------------
// ambiguous-mapping vs not-a-packageref: a fixable NuGet package we recognize
// but cannot safely place is distinct from a genuine OS/base-image resource.
// ---------------------------------------------------------------------------

test("buildPlan_WhenFixableKnownPackageMapsAmbiguously_ThenLaneBReasonAmbiguousMapping", () => {
  const topo = buildTwoGroupSharedPackageTopology();
  const f = finding({
    id: "CVE-AMBIG-KNOWN",
    resource: "Microsoft.AspNetCore.Authentication", // a real direct ref in both groups
    installedVersion: "6.0.0",
    fixedVersion: "6.0.5", // non-empty: would be fixable if we could place it
    affectedServices: ["product"], // Product exists in both groups -> ambiguous
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 0);
  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "ambiguous-mapping");
  assert.equal(row.bump, null);
  // Ownership stays empty — we never guess which group/repo owns it.
  assert.equal(row.owner.group, null);
  assert.deepEqual(row.owner.directRefs, []);
  assert.equal(row.mappedServices[0].ambiguous, true);
});

test("buildPlan_WhenFixableUnknownResourceMapsAmbiguously_ThenLaneBReasonNotAPackageRef", () => {
  const topo = buildTwoGroupSharedPackageTopology();
  const f = finding({
    id: "CVE-OS-1",
    resource: "zlib", // matches no PackageReference anywhere -> genuine OS/base-image
    installedVersion: "1.2.11",
    fixedVersion: "1.3.1", // fixable, but not a NuGet package we ship
    affectedServices: ["product"], // ambiguous mapping too, but resource is the deciding factor
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "not-a-packageref");
  assert.equal(row.bump, null);
  assert.equal(row.owner.group, null);
  assert.deepEqual(row.owner.directRefs, []);
});

// ---------------------------------------------------------------------------
// Manual image->repo map (optional 3rd arg): authoritative override for the
// basename heuristic in join iii.
// ---------------------------------------------------------------------------

function imageMap(entries: Array<{ group: string | null; repo: string; images: string[] }>): RepoImageMap {
  const byImage: RepoImageMap["byImage"] = {};
  for (const e of entries) {
    for (const img of e.images) byImage[img] = { group: e.group, repo: e.repo };
  }
  return { entries, byImage };
}

test("buildPlan_WhenRepoImageMapPinsOtherwiseAmbiguousImage_ThenMappedUnambiguouslyAndLaneAResolved", () => {
  // "product" alone is ambiguous per buildTwoGroupSharedPackageTopology (Product
  // exists in both Calibration and Regrinding). The map pins it to Calibration.
  const topo = buildTwoGroupSharedPackageTopology();
  const map = imageMap([{ group: "Calibration", repo: "Product", images: ["product"] }]);
  const f = finding({
    id: "CVE-MAP-1",
    resource: "Microsoft.AspNetCore.Authentication", // directly referenced in Calibration/Product
    installedVersion: "6.0.0",
    fixedVersion: "6.0.5", // fixable minor bump, same major
    affectedServices: ["product"],
  });
  const plan = buildPlan(report([f]), topo, map);

  assert.equal(plan.laneA.length, 1, "previously Lane B (ambiguous-mapping); map resolves it");
  assert.equal(plan.laneB.length, 0);
  const row = plan.laneA[0];
  assert.equal(row.mappedServices[0].ambiguous, false);
  assert.equal(row.mappedServices[0].localRepo, "Product");
  assert.equal(row.mappedServices[0].group, "Calibration");
  assert.equal(row.owner.group, "Calibration");
  assert.equal(row.lane, "A");
  assert.equal(row.laneBReason, null);
});

test("buildPlan_WhenRepoImageMapUndefined_ThenHeuristicBehaviorUnchanged", () => {
  // No 3rd argument at all -> identical to every pre-existing test above.
  // "product" alone stays ambiguous without a map.
  const topo = buildTwoGroupSharedPackageTopology();
  const f = finding({
    resource: "Microsoft.AspNetCore.Authentication",
    installedVersion: "6.0.0",
    fixedVersion: "6.0.5",
    affectedServices: ["product"],
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneB.length, 1);
  assert.equal(plan.laneB[0].laneBReason, "ambiguous-mapping");
  assert.equal(plan.laneB[0].mappedServices[0].ambiguous, true);
});

test("buildPlan_WhenRepoImageMapConflictsWithHeuristic_ThenMapWinsAuthoritativelyOverHeuristic", () => {
  // The heuristic would resolve "calibration-product" to Calibration/Product
  // unambiguously (see the join-iii tests above). The map pins the same image
  // string to Regrinding/Product instead, and must win without the heuristic
  // ever running for this image.
  const topo = buildTopology();
  const map = imageMap([{ group: "Regrinding", repo: "Product", images: ["calibration-product"] }]);
  const f = finding({ affectedServices: ["calibration-product"] });
  const plan = buildPlan(report([f]), topo, map);

  const row = [...plan.laneA, ...plan.laneB][0];
  assert.equal(row.mappedServices[0].ambiguous, false);
  assert.equal(row.mappedServices[0].localRepo, "Product");
  assert.equal(row.mappedServices[0].group, "Regrinding");
});

// ---------------------------------------------------------------------------
// Never-auto-upgrade policy gate (optional 4th arg): a held package is routed
// to Lane B ("policy-hold") even when it would otherwise be a clean Lane A
// bump. Placed after the no-fix check, before every mapping/Lane-A branch.
// ---------------------------------------------------------------------------

test("buildPlan_WhenResourceIsOnNeverUpgradePolicy_ThenLaneBReasonPolicyHoldAndNoBump", () => {
  // Identical to the AC-1 Lane A case (Newtonsoft.Json minor bump referenced in
  // Common) — normally Lane A — but the package is on the neverUpgrade list.
  const topo = buildTopology();
  const f = finding({
    id: "CVE-POLICY-1",
    resource: "Newtonsoft.Json",
    installedVersion: "12.0.1",
    fixedVersion: "12.0.2",
    affectedServices: ["registry.example.com/calibration-product"],
  });
  const policy: VulnPolicy = { neverUpgrade: ["Newtonsoft.Json"] };
  const plan = buildPlan(report([f]), topo, undefined, policy);

  assert.equal(plan.laneA.length, 0);
  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.lane, "B");
  assert.equal(row.laneBReason, "policy-hold");
  assert.equal(row.bump, null);
  // Ownership/mapping is still computed as usual.
  assert.equal(row.owner.group, "Calibration");
  assert.equal(row.owner.inCommon, true);
});

test("buildPlan_WhenPolicyUndefined_ThenSameFindingStaysLaneA", () => {
  // Without the policy argument the held-elsewhere finding is unchanged: Lane A.
  const topo = buildTopology();
  const f = finding({
    resource: "Newtonsoft.Json",
    installedVersion: "12.0.1",
    fixedVersion: "12.0.2",
    affectedServices: ["registry.example.com/calibration-product"],
  });
  const plan = buildPlan(report([f]), topo);

  assert.equal(plan.laneA.length, 1);
  assert.equal(plan.laneB.length, 0);
  assert.equal(plan.laneA[0].laneBReason, null);
  assert.deepEqual(plan.laneA[0].bump, { package: "Newtonsoft.Json", from: "12.0.1", to: "12.0.2" });
});

test("buildPlan_WhenPolicyEntryDiffersInCaseFromResource_ThenStillHeldToLaneB", () => {
  // policy lists "automapper" (lower-case); the finding's resource is "AutoMapper".
  // The case-insensitive match must still route it to policy-hold (rather than
  // the not-a-packageref reason it would otherwise get).
  const topo = buildTopology();
  const f = finding({
    id: "CVE-POLICY-CI",
    resource: "AutoMapper",
    installedVersion: "13.0.1",
    fixedVersion: "13.0.2",
    affectedServices: ["calibration-product"],
  });
  const policy: VulnPolicy = { neverUpgrade: ["automapper"] };
  const plan = buildPlan(report([f]), topo, undefined, policy);

  assert.equal(plan.laneB.length, 1);
  const row = plan.laneB[0];
  assert.equal(row.laneBReason, "policy-hold");
  assert.equal(row.bump, null);
});
