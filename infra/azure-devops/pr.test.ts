import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompleteArgs,
  buildCreateArgs,
  buildUpdateArgs,
  completePr,
  createPr,
  ensureTicketLine,
  formatDescription,
  parseAzPrJson,
  parseAzureRemote,
  ticketUrl,
  updatePr,
  type CreatePrArgs,
} from "./pr.ts";

const baseArgs: CreatePrArgs = {
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

// ---------------------------------------------------------------------------
// buildCreateArgs
// ---------------------------------------------------------------------------

test("buildCreateArgs_WhenDescriptionCarriesCveId_ThenArgvIncludesCveIdAndTargetsGivenBranch", () => {
  const argv = buildCreateArgs(baseArgs);

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

test("buildCreateArgs_WhenCalled_ThenReturnsPlainArgvArrayWithoutLeadingAzToken", () => {
  const argv = buildCreateArgs(baseArgs);

  assert.ok(Array.isArray(argv));
  assert.ok(!argv.includes("az"), "argv must not include the leading `az` binary token");
});

test("buildCreateArgs_WhenDraftRequested_ThenArgvIncludesDraftFlag", () => {
  const argv = buildCreateArgs({ ...baseArgs, draft: true });
  assert.equal(flagValue(argv, "--draft"), "true");
});

test("createPr_WhenDryRun_ThenPerformsNoExecutionAndEchoesRepoBranchTarget", () => {
  const result = createPr({ ...baseArgs, dryRun: true });

  assert.deepEqual(result, {
    repo: baseArgs.repoName,
    branch: baseArgs.branch,
    targetBranch: baseArgs.targetBranch,
    pullRequestId: null,
    url: null,
    dryRun: true,
  });
});

// ---------------------------------------------------------------------------
// parseAzPrJson
// ---------------------------------------------------------------------------

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
// buildCreateArgs — org/project/repository derivation from remoteUrl
// ---------------------------------------------------------------------------

test("buildCreateArgs_WhenRemoteUrlParsesAsAdo_ThenArgvIncludesOrgProjectRepositoryAndStillCarriesCve", () => {
  const argv = buildCreateArgs({ ...baseArgs, remoteUrl: SSH_V3_URL });

  assert.equal(flagValue(argv, "--org"), "https://dev.azure.com/dev-hoffmann-group-digital");
  assert.equal(flagValue(argv, "--project"), "Digital Twin");
  assert.equal(flagValue(argv, "--repository"), "Hoffmann.DigitalTwin.AppHost");

  const description = flagValue(argv, "--description");
  assert.ok(description?.includes("CVE-2025-1234"), "description must still carry the CVE id");
  assert.ok(!argv.includes("az"), "argv must not include the leading `az` binary token");
});

test("buildCreateArgs_WhenRemoteUrlAbsent_ThenNoOrgOrProjectFlagsAndFallsBackToRepoName", () => {
  const argv = buildCreateArgs(baseArgs);

  assert.equal(argv.includes("--org"), false);
  assert.equal(argv.includes("--project"), false);
  assert.equal(flagValue(argv, "--repository"), baseArgs.repoName);
});

test("buildCreateArgs_WhenRemoteUrlDoesNotParseAsAdo_ThenNoOrgOrProjectFlagsAndDoesNotCrash", () => {
  const argv = buildCreateArgs({ ...baseArgs, remoteUrl: "https://github.com/hoffmann-group/some-repo.git" });

  assert.equal(argv.includes("--org"), false);
  assert.equal(argv.includes("--project"), false);
  assert.equal(flagValue(argv, "--repository"), baseArgs.repoName);
});

// ---------------------------------------------------------------------------
// ticketUrl + formatDescription
// ---------------------------------------------------------------------------

test("ticketUrl_WhenWellFormedKey_ThenReturnsBrowseUrl", () => {
  assert.equal(ticketUrl("SCD-28"), "https://hoffmann-group-digital.atlassian.net/browse/SCD-28");
});

test("ticketUrl_WhenLowercaseOrPadded_ThenNormalisesToUppercaseKey", () => {
  assert.equal(ticketUrl("  scd-28 "), "https://hoffmann-group-digital.atlassian.net/browse/SCD-28");
});

test("ticketUrl_WhenNotATicketKey_ThenThrows", () => {
  assert.throws(() => ticketUrl(""), /not a Jira ticket key/);
  assert.throws(() => ticketUrl("nope"), /not a Jira ticket key/);
  assert.throws(() => ticketUrl("SCD"), /not a Jira ticket key/);
  assert.throws(() => ticketUrl("28"), /not a Jira ticket key/);
});

test("formatDescription_WhenTicketAndChanges_ThenTicketUrlLineThenBullets", () => {
  const desc = formatDescription({
    ticket: "SCD-28",
    changes: ["Bump System.Text.Json 8.0.0 -> 8.0.5", "Drop redundant Newtonsoft.Json reference"],
  });

  assert.equal(
    desc,
    "Ticket SCD-28: https://hoffmann-group-digital.atlassian.net/browse/SCD-28\n\n" +
      "- Bump System.Text.Json 8.0.0 -> 8.0.5\n" +
      "- Drop redundant Newtonsoft.Json reference",
  );
});

test("formatDescription_WhenBlankChangesMixedIn_ThenTheyAreDropped", () => {
  const desc = formatDescription({ ticket: "SCD-1", changes: ["  ", "real change", ""] });
  assert.equal(desc, "Ticket SCD-1: https://hoffmann-group-digital.atlassian.net/browse/SCD-1\n\n- real change");
});

test("formatDescription_WhenNoTicket_ThenThrowsSoTheSkillMustAskTheHuman", () => {
  assert.throws(() => formatDescription({ ticket: "", changes: ["x"] }), /not a Jira ticket key/);
});

test("formatDescription_WhenNoRealChanges_ThenThrows", () => {
  assert.throws(() => formatDescription({ ticket: "SCD-1", changes: ["   ", ""] }), /at least one change/);
});

// ---------------------------------------------------------------------------
// ensureTicketLine + formatDescription body mode (regression: first live run
// bypassed the CLI and shipped PRs with no ticket link)
// ---------------------------------------------------------------------------

test("ensureTicketLine_WhenBodyLacksTicket_ThenPrependsCanonicalLineAndBlankLine", () => {
  const out = ensureTicketLine("SCD-333", "Removes the fake-token warm-up.\n\nAdvances Common to abff5c0.");
  assert.equal(
    out,
    "Ticket SCD-333: https://hoffmann-group-digital.atlassian.net/browse/SCD-333\n\n" +
      "Removes the fake-token warm-up.\n\nAdvances Common to abff5c0.",
  );
});

test("ensureTicketLine_WhenBodyAlreadyLeadsWithTicketLine_ThenIdempotentNoDuplicate", () => {
  const already =
    "Ticket SCD-333: https://hoffmann-group-digital.atlassian.net/browse/SCD-333\n\nSome body.";
  assert.equal(ensureTicketLine("SCD-333", already), already);
});

test("ensureTicketLine_WhenLeadLineCasingOrSpacingDiffers_ThenStillTreatedAsPresent", () => {
  const already = "ticket  SCD-333 :  https://x/whatever\n\nbody";
  // Recognised as already-linked by the `Ticket <KEY>:` prefix, so left untouched.
  assert.equal(ensureTicketLine("SCD-333", already), already.trim());
});

test("ensureTicketLine_WhenBodyEmpty_ThenTicketLineOnly", () => {
  assert.equal(ensureTicketLine("SCD-1", "   "), "Ticket SCD-1: https://hoffmann-group-digital.atlassian.net/browse/SCD-1");
});

test("ensureTicketLine_WhenTicketMissing_ThenThrows", () => {
  assert.throws(() => ensureTicketLine("", "body"), /not a Jira ticket key/);
});

test("formatDescription_WhenBodyGiven_ThenBodyWinsOverBulletsAndTicketGuaranteed", () => {
  const desc = formatDescription({
    ticket: "SCD-333",
    changes: ["ignored bullet"],
    body: "Prose paragraph one.\n\nProse paragraph two with `abff5c0`.",
  });
  assert.equal(
    desc,
    "Ticket SCD-333: https://hoffmann-group-digital.atlassian.net/browse/SCD-333\n\n" +
      "Prose paragraph one.\n\nProse paragraph two with `abff5c0`.",
  );
});

test("formatDescription_WhenBodyAlreadyHasTicketLine_ThenNotDuplicated", () => {
  const body = "Ticket SCD-9: https://hoffmann-group-digital.atlassian.net/browse/SCD-9\n\nbody";
  assert.equal(formatDescription({ ticket: "SCD-9", body }), body);
});

// ---------------------------------------------------------------------------
// buildUpdateArgs
// ---------------------------------------------------------------------------

test("buildUpdateArgs_WhenOnlyDescriptionGiven_ThenAddressesByIdAndEmitsOnlyThatField", () => {
  const argv = buildUpdateArgs({ id: 99, description: "new body", dryRun: false });

  assert.equal(argv[0], "repos");
  assert.equal(argv[2], "update");
  assert.equal(flagValue(argv, "--id"), "99");
  assert.equal(flagValue(argv, "--description"), "new body");
  assert.equal(argv.includes("--title"), false, "must not touch title when not asked");
  assert.equal(argv.includes("--target-branch"), false);
});

test("buildUpdateArgs_WhenOrgAndFieldsGiven_ThenOrgAndEachFieldPresent", () => {
  const argv = buildUpdateArgs({
    id: 5,
    orgUrl: "https://dev.azure.com/dev-hoffmann-group-digital",
    title: "New title",
    targetBranch: "main",
    draft: false,
    dryRun: false,
  });

  assert.equal(flagValue(argv, "--org"), "https://dev.azure.com/dev-hoffmann-group-digital");
  assert.equal(flagValue(argv, "--title"), "New title");
  assert.equal(flagValue(argv, "--target-branch"), "main");
  assert.equal(flagValue(argv, "--draft"), "false");
});

test("updatePr_WhenDryRun_ThenNoExecutionAndEchoesId", () => {
  assert.deepEqual(updatePr({ id: 12, title: "x", dryRun: true }), {
    action: "update",
    id: 12,
    url: null,
    dryRun: true,
  });
});

// ---------------------------------------------------------------------------
// buildCompleteArgs
// ---------------------------------------------------------------------------

test("buildCompleteArgs_WhenDefaults_ThenAutoCompleteSquashAndDeleteSourceAllTrue", () => {
  const argv = buildCompleteArgs({ id: 77, dryRun: false });

  assert.equal(flagValue(argv, "--id"), "77");
  assert.equal(flagValue(argv, "--auto-complete"), "true");
  assert.equal(flagValue(argv, "--squash"), "true");
  assert.equal(flagValue(argv, "--delete-source-branch"), "true");
  // auto-complete flags the PR to merge on policy pass; it is NOT a forced merge.
  assert.equal(argv.includes("--status"), false, "complete must not force --status completed");
});

test("buildCompleteArgs_WhenOverridesAndMergeMessage_ThenReflected", () => {
  const argv = buildCompleteArgs({
    id: 3,
    orgUrl: "https://dev.azure.com/dev-hoffmann-group-digital",
    squash: false,
    deleteSourceBranch: false,
    mergeMessage: "Merge SCD-28",
    dryRun: false,
  });

  assert.equal(flagValue(argv, "--org"), "https://dev.azure.com/dev-hoffmann-group-digital");
  assert.equal(flagValue(argv, "--squash"), "false");
  assert.equal(flagValue(argv, "--delete-source-branch"), "false");
  assert.equal(flagValue(argv, "--merge-commit-message"), "Merge SCD-28");
});

test("completePr_WhenDryRun_ThenNoExecutionAndEchoesId", () => {
  assert.deepEqual(completePr({ id: 8, dryRun: true }), {
    action: "complete",
    id: 8,
    url: null,
    dryRun: true,
  });
});
