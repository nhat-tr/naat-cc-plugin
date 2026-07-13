import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const __dirname: string;
declare const require: { (id: string): unknown };

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string): void;
}

interface PathModule {
  join(...parts: string[]): string;
}

interface UrlModule {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneRenderer {
  renderStandalone(input: {
    shell: string;
    styles: string;
    script: string;
    worker: string;
    screen: unknown;
    session: unknown;
  }): string;
}

interface WorkspaceDocumentContract {
  documentRevision(value: Record<string, unknown>): string;
}

interface ReviewActualChangeFixture {
  acceptance_criteria: string[];
  claimed_by: string[];
  component_id: string;
  evidence_ids: string[];
  hunk_id: string;
  path: string;
  source_preview: { end_line: number; lines: string[]; start_line: number };
  symbols: string[];
}

interface ReviewFixture extends Record<string, unknown> {
  components: Array<{ frame_id: string; id: string; label: string }>;
  frames: Array<{ component_ids: string[]; id: string; title: string }>;
  revision: string;
  title: string;
  content: {
    canonical_spec: { acceptance_criteria: Array<{ id: string }> };
    evidence_records: Array<{ id: string; result: Record<string, unknown> }>;
    patch_set_invalidations: Array<{
      affected_acceptance_criteria: string[];
      id: string;
      path: string;
      reason: string;
    }>;
    patch_set_review: { file_reviews: Array<{ path: string; viewed: boolean }> };
    review_slices: Array<{
      actual_changes: ReviewActualChangeFixture[];
      expected_files: string[];
      task_id: string;
    }>;
    source_evidence: Array<Record<string, unknown>>;
    verification_evidence: Array<{ evidence_ref: string; status: string }>;
  };
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { pathToFileURL } = require("node:url") as UrlModule;
const { renderStandalone } = require("../scripts/standalone.cjs") as StandaloneRenderer;
const { documentRevision } = require("../scripts/workspace-document.cjs") as WorkspaceDocumentContract;
const fixturePath = path.join(__dirname, "..", "fixtures", "feature-review-work.json");
const shellDirectory = path.join(__dirname, "..", "assets", "visual-shell");

function buildStandaloneHtml(screen: unknown, session: unknown): string {
  return renderStandalone({
    shell: fs.readFileSync(path.join(shellDirectory, "index.html"), "utf8"),
    styles: fs.readFileSync(path.join(shellDirectory, "styles.css"), "utf8"),
    script: fs.readFileSync(path.join(shellDirectory, "app.js"), "utf8"),
    worker: fs.readFileSync(path.join(shellDirectory, "elk-worker.min.js"), "utf8"),
    screen,
    session,
  });
}

function reviewFixture(): ReviewFixture {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ReviewFixture;
}

function sessionFixture(revision: string): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: "review-feedback-event",
      seq: 1,
      timestamp: 1_752_400_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "review-feedback-turn",
      message: "Keep the changed evidence state visible beside its source context.",
      annotations: [],
      choices: [],
      screen: { id: "review", file: "workspace.json", revision },
    }],
  };
}

async function mountReview(
  page: Page,
  testInfo: TestInfo,
  fixture = reviewFixture(),
  artifactName = "feature-review-workbench.html",
): Promise<string[]> {
  const html = buildStandaloneHtml(fixture, sessionFixture(fixture.revision));
  const file = testInfo.outputPath(artifactName);
  fs.writeFileSync(file, html);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: fixture.title, exact: true })).toBeVisible();
  await expect(page.locator('[data-workspace-kind="review"]')).toBeVisible();
  return pageErrors;
}

async function controlledPanel(tab: Locator, workbench: Locator): Promise<Locator> {
  const tabId = await tab.getAttribute("id");
  const panelId = await tab.getAttribute("aria-controls");
  expect(tabId).not.toBeNull();
  expect(panelId).not.toBeNull();
  if (!tabId || !panelId) return workbench.locator("[data-missing-controlled-panel]");
  const panel = workbench.locator(`#${panelId}`);
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", tabId);
  return panel;
}

test.beforeEach(async ({ page }, testInfo) => {
  await mountReview(page, testInfo);
});

test("Feature Review Workbench coordinates intent, source context, and review evidence", async ({ page }) => {
  const workbench = page.locator("[data-review-workbench]");
  await expect(workbench).toBeVisible();
  await expect(workbench.locator("[data-review-navigator]")).toBeVisible();
  await expect(workbench.locator("[data-review-source]")).toBeVisible();
  await expect(workbench.locator("[data-review-evidence]")).toBeVisible();

  const slice = workbench.locator('[data-review-slice="10.3"]');
  await expect(slice).toContainText("Feature Review Workbench");
  await slice.click();

  const expectedPath = "skills/brainstorming/schemas/review-workspace.schema.json";
  const actualPath = "skills/brainstorming/scripts/server.cjs";
  await expect(workbench.locator(`[data-expected-file="${expectedPath}"]`)).toContainText(expectedPath);
  await expect(workbench.locator(`[data-actual-change="${actualPath}"]`)).toContainText(actualPath);

  const sourceChoice = workbench.locator(`[data-review-navigator] [data-source-path="${actualPath}"]`).first();
  await expect(sourceChoice).toContainText(actualPath);
  await sourceChoice.click();

  const source = workbench.locator("[data-review-source]");
  await expect(source.locator(`[data-source-path="${actualPath}"]`)).toContainText(actualPath);
  await expect(source).toContainText("createBrainstormServer");
  await expect(source).toContainText("Authenticated opaque evidence lookup");
  await expect(source).toContainText("2222222222222222");

  const evidence = workbench.locator("[data-review-evidence]");
  await expect(evidence.locator('[data-evidence-id="EVD-004-review-server"]')).toHaveAttribute(
    "data-evidence-state",
    "outdated",
  );
  await expect(evidence.locator('[data-finding="finding-evidence-boundary"]')).toContainText(
    "Source evidence boundary changed after verification",
  );
});

test("Acceptance Criteria tabs have reciprocal controls and expose exactly one active review path", async ({ page }) => {
  const fixture = reviewFixture();
  const workbench = page.locator("[data-review-workbench]");
  const navigator = workbench.locator("[data-review-navigator]");
  const tabs = navigator.locator('[role="tab"][data-acceptance-criterion]');
  const panels = workbench.locator('[role="tabpanel"][data-acceptance-criterion-panel]');

  await expect(tabs).toHaveCount(fixture.content.canonical_spec.acceptance_criteria.length);
  await expect(panels).toHaveCount(fixture.content.canonical_spec.acceptance_criteria.length);
  await expect(navigator.locator('[role="tab"][data-acceptance-criterion][aria-selected="true"]')).toHaveCount(1);
  await expect(workbench.locator('[role="tabpanel"][data-acceptance-criterion-panel]:visible')).toHaveCount(1);

  for (let index = 0; index < await tabs.count(); index += 1) {
    await controlledPanel(tabs.nth(index), workbench);
  }

  const directQualityTab = navigator.locator('[role="tab"][data-acceptance-criterion="AC-15"]');
  await directQualityTab.click();
  await expect(directQualityTab).toHaveAttribute("aria-selected", "true");
  const qualityPanel = await controlledPanel(directQualityTab, workbench);
  await expect(qualityPanel).toBeVisible();
  await expect(qualityPanel.locator('[data-review-slice="10.1"]')).toBeVisible();
  await expect(qualityPanel.locator('[data-review-slice="10.3"]')).toBeVisible();
  await expect(workbench.locator('[role="tabpanel"][data-acceptance-criterion-panel]:visible')).toHaveCount(1);
});

test("File Viewed progress, cumulative verdict, governance, and lineage remain separate", async ({ page }) => {
  const workbench = page.locator("[data-review-workbench]");
  const progress = workbench.locator("[data-viewed-progress]");
  const verdict = workbench.locator("[data-whole-feature-verdict]");

  await expect(progress).toHaveAttribute("data-viewed", "2");
  await expect(progress).toHaveAttribute("data-total", "4");
  await expect(progress).toContainText("2 of 4");
  await expect(verdict).toHaveAttribute("data-whole-feature-verdict", "rejected");
  await expect(verdict).toContainText("Rejected");
  await expect(workbench.locator('[data-can-approve="false"]')).toBeVisible();
  expect(await progress.evaluate(element => element === document.querySelector("[data-whole-feature-verdict]"))).toBe(false);

  await expect(
    workbench.locator('[data-file-review][data-source-path="skills/brainstorming/tests/review-workspace.test.js"]'),
  ).toHaveAttribute("data-file-viewed", "true");
  await expect(
    workbench.locator('[data-file-review][data-source-path="skills/brainstorming/scripts/server.cjs"]'),
  ).toHaveAttribute("data-file-viewed", "false");
  await expect(workbench.locator('[data-acceptance-evidence="AC-6"]')).toHaveAttribute(
    "data-evidence-state",
    "outdated",
  );
  await expect(workbench.locator('[data-acceptance-evidence="AC-15"]')).toHaveAttribute(
    "data-evidence-state",
    "current",
  );

  const evidence = workbench.locator("[data-review-evidence]");
  await expect(evidence.locator('[data-quality-obligation="EQC-BASE"]')).toContainText("Open");
  await expect(evidence.locator('[data-quality-obligation="EQC-A11Y"]')).toContainText("Not applicable");
  await expect(evidence.locator('[data-quality-obligation="EQC-A11Y"]')).toContainText("CODEOWNER");
  await expect(evidence.locator('[data-decision-record="DR-001-visual-companion-vnext"]')).toContainText("Accepted");
  await expect(evidence.locator('[data-outcome-record="OUT-001-review-pilot"]')).toContainText(
    "stale server evidence blocked approval",
  );
  await expect(workbench.getByRole("button", { name: /record verdict/i })).toHaveCount(0);
});

test("verification state comes from verification evidence when the evidence record result diverges", async ({ page }, testInfo) => {
  const fixture = reviewFixture();
  const evidenceId = "EVD-004-review-server";
  const record = fixture.content.evidence_records.find(item => item.id === evidenceId);
  const verification = fixture.content.verification_evidence.find(item => item.evidence_ref === evidenceId);
  expect(record).toBeDefined();
  expect(verification).toBeDefined();
  if (!record || !verification) return;
  record.result.status = "passed";
  verification.status = "outdated";
  fixture.revision = documentRevision(fixture);

  await mountReview(page, testInfo, fixture, "verification-authority.html");
  await page.locator('[data-review-navigator] [data-acceptance-criterion="AC-6"]').click();
  const renderedEvidence = page.locator(`[data-verification-evidence="${evidenceId}"]`);
  await expect(renderedEvidence).toHaveAttribute("data-evidence-state", "outdated");
  await expect(renderedEvidence).toContainText("Outdated");
});

test("every Patch Set file review path remains navigable and auditable, including unmapped files", async ({ page }) => {
  const fixture = reviewFixture();
  const workbench = page.locator("[data-review-workbench]");
  const navigator = workbench.locator("[data-review-navigator]");
  const expectedPaths = fixture.content.patch_set_review.file_reviews.map(file => file.path).sort();
  const navigablePaths = await navigator.locator("[data-file-review][data-source-path]").evaluateAll(elements => (
    elements.map(element => element.getAttribute("data-source-path")).filter((path): path is string => path !== null).sort()
  ));
  expect(navigablePaths).toEqual(expectedPaths);

  const unmappedPath = "README.md";
  const unmappedFile = navigator.locator(`[data-file-review][data-source-path="${unmappedPath}"]`);
  await expect(unmappedFile).toHaveAttribute("data-file-viewed", "false");
  await unmappedFile.click();
  const source = workbench.locator("[data-review-source]");
  await expect(source.locator(`[data-selected-source-path="${unmappedPath}"]`)).toBeVisible();
  await expect(source).toContainText("Unexpected path");
});

test("selective Patch Set invalidation exposes its path, affected Acceptance Criteria, and reason", async ({ page }) => {
  const fixture = reviewFixture();
  const invalidation = fixture.content.patch_set_invalidations[0];
  expect(invalidation).toBeDefined();
  if (!invalidation) return;

  const rendered = page.locator(`[data-patch-set-invalidation="${invalidation.id}"]`);
  await expect(rendered).toContainText(invalidation.path);
  for (const criterion of invalidation.affected_acceptance_criteria) {
    await expect(rendered).toContainText(criterion);
  }
  await expect(rendered).toContainText(invalidation.reason);
});

test("an expected-only file can be selected and explicitly shows no actual change", async ({ page }) => {
  const fixture = reviewFixture();
  const slice = fixture.content.review_slices.find(item => item.task_id === "10.3");
  expect(slice).toBeDefined();
  if (!slice) return;
  const actualPaths = new Set(slice.actual_changes.map(change => change.path));
  const expectedOnlyPath = slice.expected_files.find(path => !actualPaths.has(path));
  expect(expectedOnlyPath).toBeDefined();
  if (!expectedOnlyPath) return;

  const workbench = page.locator("[data-review-workbench]");
  const expectedOnlyFile = workbench.locator(
    `[data-review-navigator] [data-source-path="${expectedOnlyPath}"]`,
  );
  await expect(expectedOnlyFile).toBeVisible();
  await expectedOnlyFile.click();
  const source = workbench.locator("[data-review-source]");
  await expect(source.locator(`[data-selected-source-path="${expectedOnlyPath}"]`)).toBeVisible();
  await expect(source).toContainText("No actual change");
  await expect(source.locator(`[data-actual-change="${expectedOnlyPath}"]`)).toHaveCount(0);
});

test("two hunks for the same full path remain separately navigable", async ({ page }, testInfo) => {
  const fixture = reviewFixture();
  const slice = fixture.content.review_slices.find(item => item.task_id === "10.3");
  const first = slice?.actual_changes.find(change => change.path === "skills/brainstorming/scripts/server.cjs");
  const frame = fixture.frames[0];
  expect(first).toBeDefined();
  expect(frame).toBeDefined();
  if (!slice || !first || !frame) return;

  const secondHunkId = "5555555555555555555555555555555555555555555555555555555555555555";
  const secondComponentId = "source-review-server-feedback";
  const second: ReviewActualChangeFixture = {
    ...structuredClone(first),
    claimed_by: ["10.3"],
    component_id: secondComponentId,
    hunk_id: secondHunkId,
    source_preview: {
      start_line: 450,
      end_line: 452,
      lines: ["Persist Feedback Batch", "Acknowledge durable delivery", "Retain source context"],
    },
    symbols: ["persistFeedbackBatch"],
  };
  slice.actual_changes.push(second);
  fixture.components.push({
    id: secondComponentId,
    frame_id: frame.id,
    label: "Feedback persistence hunk in the authenticated Review server",
  });
  frame.component_ids.push(secondComponentId);
  fixture.content.source_evidence.push({
    id: secondComponentId,
    component_id: secondComponentId,
    path: second.path,
    hunk_id: second.hunk_id,
    symbols: second.symbols,
    start_line: second.source_preview.start_line,
    end_line: second.source_preview.end_line,
  });
  fixture.revision = documentRevision(fixture);

  await mountReview(page, testInfo, fixture, "same-path-hunks.html");
  await page.locator('[data-review-navigator] [data-acceptance-criterion="AC-6"]').click();
  const hunkChoices = page.locator(
    `[data-review-navigator] [data-source-path="${second.path}"][data-hunk-id]`,
  );
  await expect(hunkChoices).toHaveCount(2);
  await expect(hunkChoices.nth(0)).not.toHaveAttribute("data-hunk-id", secondHunkId);
  await expect(hunkChoices.nth(1)).toHaveAttribute("data-hunk-id", secondHunkId);
  await hunkChoices.nth(1).click();
  const source = page.locator("[data-review-source]");
  await expect(source.locator(`[data-hunk-id="${secondHunkId}"]`)).toBeVisible();
  await expect(source).toContainText("persistFeedbackBatch");
});
