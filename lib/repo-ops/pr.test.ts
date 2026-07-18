import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAzArgs, openPr, parseAzPrJson, parseAzureRemote, type OpenPrArgs } from "./pr.ts";

const baseArgs: OpenPrArgs = {
  repoPath: "/repos/Product/SecFix-20260716",
  repoName: "Product",
  branch: "security/CVE-2025-1234",
  targetBranch: "master",
  title: "Bump System.Text.Json to remediate CVE-2025-1234",
  description:
    "Remediates CVE-2025-1234 in System.Text.Json: installed 8.0.0 -> fixed 8.0.5. " +
    "Links: https://github.com/advisories/GHSA-xxxx",
  dryRun: false,
};

function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
}

test("buildAzArgs_WhenDescriptionCarriesCveId_ThenArgvIncludesCveIdAndTargetsGivenBranch", () => {
  const argv = buildAzArgs(baseArgs);

  assert.equal(argv[0], "repos");
  assert.equal(argv[1], "pr");
  assert.equal(argv[2], "create");
  assert.equal(flagValue(argv, "--source-branch"), baseArgs.branch);
  assert.equal(flagValue(argv, "--target-branch"), baseArgs.targetBranch);
  assert.equal(flagValue(argv, "--title"), baseArgs.title);
  assert.equal(flagValue(argv, "--output"), "json");

  const description = flagValue(argv, "--description");
  assert.ok(description, "--description must be present");
  assert.equal(description, baseArgs.description);
  assert.ok(description!.includes("CVE-2025-1234"), "description must carry the CVE id");
});

test("buildAzArgs_WhenCalled_ThenReturnsPlainArgvArrayWithoutLeadingAzToken", () => {
  const argv = buildAzArgs(baseArgs);

  assert.ok(Array.isArray(argv));
  assert.ok(!argv.includes("az"), "argv must not include the leading `az` binary token");
});

test("openPr_WhenDryRun_ThenPerformsNoExecutionAndEchoesRepoBranchTarget", () => {
  const result = openPr({ ...baseArgs, dryRun: true });

  assert.deepEqual(result, {
    repo: baseArgs.repoName,
    branch: baseArgs.branch,
    targetBranch: baseArgs.targetBranch,
    pullRequestId: null,
    url: null,
    dryRun: true,
  });
});

test("parseAzPrJson_WhenSampleAzOutputHasRepositoryWebUrl_ThenDerivesPullRequestIdAndNonNullUrl", () => {
  const sample = JSON.stringify({
    pullRequestId: 42,
    repository: { webUrl: "https://dev.azure.com/org/proj/_git/Repo" },
  });

  const { pullRequestId, url } = parseAzPrJson(sample);

  assert.equal(pullRequestId, 42);
  assert.equal(url, "https://dev.azure.com/org/proj/_git/Repo/pullrequest/42");
});

test("parseAzPrJson_WhenExplicitUrlFieldPresent_ThenUsesItDirectly", () => {
  const sample = JSON.stringify({ pullRequestId: 7, url: "https://dev.azure.com/org/proj/_git/Repo/pullrequest/7" });

  const { pullRequestId, url } = parseAzPrJson(sample);

  assert.equal(pullRequestId, 7);
  assert.equal(url, "https://dev.azure.com/org/proj/_git/Repo/pullrequest/7");
});

test("parseAzPrJson_WhenFieldsAreAbsentOrJsonIsMalformed_ThenReturnsNullsDefensively", () => {
  assert.deepEqual(parseAzPrJson("{}"), { pullRequestId: null, url: null });
  assert.deepEqual(parseAzPrJson("not json at all"), { pullRequestId: null, url: null });
  assert.deepEqual(parseAzPrJson(JSON.stringify({ pullRequestId: 1 })), { pullRequestId: 1, url: null });
});

// ---------------------------------------------------------------------------
// parseAzureRemote
// ---------------------------------------------------------------------------

const SSH_V3_URL =
  "dev-hoffmann-group-digital@vs-ssh.visualstudio.com:v3/dev-hoffmann-group-digital/Digital%20Twin/Hoffmann.DigitalTwin.AppHost";
const HTTPS_DEV_AZURE_URL =
  "https://someuser@dev.azure.com/dev-hoffmann-group-digital/Digital%20Twin/_git/Hoffmann.DigitalTwin.AppHost";
const HTTPS_VISUALSTUDIO_URL =
  "https://dev-hoffmann-group-digital.visualstudio.com/Digital%20Twin/_git/Hoffmann.DigitalTwin.AppHost";
const EXPECTED_PARSED = {
  orgUrl: "https://dev.azure.com/dev-hoffmann-group-digital",
  project: "Digital Twin",
  repo: "Hoffmann.DigitalTwin.AppHost",
};

test("parseAzureRemote_WhenSshV3VisualStudioUrl_ThenReturnsDecodedOrgProjectRepo", () => {
  assert.deepEqual(parseAzureRemote(SSH_V3_URL), EXPECTED_PARSED);
});

test("parseAzureRemote_WhenHttpsDevAzureUrl_ThenReturnsDecodedOrgProjectRepo", () => {
  assert.deepEqual(parseAzureRemote(HTTPS_DEV_AZURE_URL), EXPECTED_PARSED);
});

test("parseAzureRemote_WhenHttpsVisualStudioComUrl_ThenReturnsDecodedOrgProjectRepo", () => {
  assert.deepEqual(parseAzureRemote(HTTPS_VISUALSTUDIO_URL), EXPECTED_PARSED);
});

test("parseAzureRemote_WhenHttpsDevAzureUrlHasNoUserPrefix_ThenStillParses", () => {
  const url = "https://dev.azure.com/dev-hoffmann-group-digital/Digital%20Twin/_git/Hoffmann.DigitalTwin.AppHost";
  assert.deepEqual(parseAzureRemote(url), EXPECTED_PARSED);
});

test("parseAzureRemote_WhenUrlIsNotAnAdoRemote_ThenReturnsNull", () => {
  assert.equal(parseAzureRemote("https://github.com/hoffmann-group/some-repo.git"), null);
  assert.equal(parseAzureRemote("git@github.com:hoffmann-group/some-repo.git"), null);
});

// ---------------------------------------------------------------------------
// buildAzArgs — org/project/repository derivation from remoteUrl
// ---------------------------------------------------------------------------

test("buildAzArgs_WhenRemoteUrlParsesAsAdo_ThenArgvIncludesOrgProjectRepositoryAndStillCarriesCve", () => {
  const argv = buildAzArgs({ ...baseArgs, remoteUrl: SSH_V3_URL });

  assert.equal(flagValue(argv, "--org"), "https://dev.azure.com/dev-hoffmann-group-digital");
  assert.equal(flagValue(argv, "--project"), "Digital Twin");
  assert.equal(flagValue(argv, "--repository"), "Hoffmann.DigitalTwin.AppHost");

  const description = flagValue(argv, "--description");
  assert.ok(description?.includes("CVE-2025-1234"), "description must still carry the CVE id");
  assert.ok(!argv.includes("az"), "argv must not include the leading `az` binary token");
});

test("buildAzArgs_WhenRemoteUrlAbsent_ThenNoOrgOrProjectFlagsAndFallsBackToRepoName", () => {
  const argv = buildAzArgs(baseArgs);

  assert.equal(argv.includes("--org"), false);
  assert.equal(argv.includes("--project"), false);
  assert.equal(flagValue(argv, "--repository"), baseArgs.repoName);
});

test("buildAzArgs_WhenRemoteUrlDoesNotParseAsAdo_ThenNoOrgOrProjectFlagsAndDoesNotCrash", () => {
  const argv = buildAzArgs({ ...baseArgs, remoteUrl: "https://github.com/hoffmann-group/some-repo.git" });

  assert.equal(argv.includes("--org"), false);
  assert.equal(argv.includes("--project"), false);
  assert.equal(flagValue(argv, "--repository"), baseArgs.repoName);
});
