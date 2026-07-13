import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string): void;
}

interface NodeUrl {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

interface ActualChange {
  path: string;
  source_preview: { lines: string[] };
  symbols: string[];
}

interface ReviewDocument extends Record<string, unknown> {
  content: {
    review_slices: Array<{ actual_changes: ActualChange[] }>;
  };
  revision: string;
  title: string;
  workspace_kind: "review";
}

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const fixtureFile = require.resolve("../fixtures/feature-review-work.json");

function reviewFixture(): ReviewDocument {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ReviewDocument;
}

function sessionFixture(revision: string): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: "feature-review-visual-feedback",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "feature-review-visual-feedback",
      message: "Keep intent, source context, and evidence visible together.",
      annotations: [],
      choices: [],
      screen: { id: "review", file: "workspace.json", revision },
    }],
  };
}

async function openReviewWorkbench(
  page: Page,
  testInfo: TestInfo,
  viewport: { height: number; width: number },
): Promise<{ pageErrors: string[]; screen: ReviewDocument }> {
  const screen = reviewFixture();
  const html = buildStandaloneHtml(screen, sessionFixture(screen.revision));
  const file = testInfo.outputPath(`feature-review-${viewport.width}.html`);
  fs.writeFileSync(file, html);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();

  // The envelope must reach the existing generic Review fallback before this RED
  // assertion asks for the missing purpose-built renderer.
  await expect(page.locator('[data-workspace-kind="review"]')).toBeVisible();
  await expect(page.locator("[data-review-workbench]")).toBeVisible();
  return { pageErrors, screen };
}

function overlapArea(left: Box, right: Box): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

async function visibleBox(locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} must have geometry`).not.toBeNull();
  return box!;
}

async function expectNoClippedReviewText(root: Locator): Promise<void> {
  const clipped = await root.locator("h1, h2, h3, h4, p, li, button, [role='tab']")
    .evaluateAll(elements => elements.filter(element => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1;
    }).map(element => element.textContent?.trim().slice(0, 100) || element.tagName));
  expect(clipped, `clipped Feature Review Workbench text: ${clipped.join(" | ")}`).toEqual([]);
}

async function expectHorizontalFit(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function captureVisual(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: testInfo.outputPath(name),
  });
  expect(screenshot.byteLength, `${name} must contain nonblank visual evidence`).toBeGreaterThan(18_000);
}

test("Feature Review Workbench visual keeps dense intent, source, and evidence panes in context", async ({ page }, testInfo) => {
  const { pageErrors, screen } = await openReviewWorkbench(
    page,
    testInfo,
    { width: 1_440, height: 900 },
  );
  const workbench = page.locator("[data-review-workbench]");
  const navigator = workbench.locator("[data-review-navigator]");
  const source = workbench.locator("[data-review-source]");
  const evidence = workbench.locator("[data-review-evidence]");
  const [navigatorBox, sourceBox, evidenceBox] = await Promise.all([
    visibleBox(navigator, "intent navigator"),
    visibleBox(source, "source context"),
    visibleBox(evidence, "verification and governance"),
  ]);

  expect(navigatorBox.x).toBeLessThan(sourceBox.x);
  expect(sourceBox.x).toBeLessThan(evidenceBox.x);
  expect(sourceBox.width).toBeGreaterThan(navigatorBox.width);
  expect(sourceBox.width).toBeGreaterThan(evidenceBox.width);
  expect(overlapArea(navigatorBox, sourceBox)).toBe(0);
  expect(overlapArea(sourceBox, evidenceBox)).toBe(0);

  await expect(navigator.locator("[data-acceptance-criterion]").first()).toBeVisible();
  await expect(navigator.locator("[data-review-slice]").first()).toBeVisible();
  const firstSource = screen.content.review_slices[0]!.actual_changes[0]!;
  const sourcePath = source.locator("[data-source-path]").filter({ hasText: firstSource.path }).first();
  await expect(sourcePath).toHaveAttribute("data-source-path", firstSource.path);
  await expect(source).toContainText(firstSource.symbols[0]!);
  await expect(source).toContainText(firstSource.source_preview.lines[0]!);

  const viewedProgress = workbench.locator("[data-viewed-progress]");
  const wholeFeatureVerdict = workbench.locator("[data-whole-feature-verdict]");
  await expect(workbench.locator("[data-patch-set-status]")).toBeVisible();
  await expect(viewedProgress).toBeVisible();
  await expect(wholeFeatureVerdict).toBeVisible();
  expect(await viewedProgress.evaluate(element => {
    const verdict = document.querySelector("[data-whole-feature-verdict]");
    return verdict !== null && element !== verdict && !element.contains(verdict) && !verdict.contains(element);
  }), "File Viewed progress and the whole-feature verdict must be separate state").toBe(true);

  for (const selector of [
    "[data-quality-obligation]",
    "[data-finding]",
    "[data-decision-record]",
    "[data-outcome-record]",
  ]) {
    await expect(evidence.locator(selector).first()).toBeVisible();
  }

  await expectNoClippedReviewText(workbench);
  await expectHorizontalFit(page);
  await captureVisual(page, testInfo, "feature-review-workbench-desktop.png");
  expect(pageErrors).toEqual([]);
});

test("Feature Review Workbench visual collapses its three panes without losing review state", async ({ page }, testInfo) => {
  const { pageErrors } = await openReviewWorkbench(
    page,
    testInfo,
    { width: 390, height: 844 },
  );
  const workbench = page.locator("[data-review-workbench]");
  const navigator = workbench.locator("[data-review-navigator]");
  const source = workbench.locator("[data-review-source]");
  const evidence = workbench.locator("[data-review-evidence]");
  const [navigatorBox, sourceBox, evidenceBox] = await Promise.all([
    visibleBox(navigator, "mobile intent navigator"),
    visibleBox(source, "mobile source context"),
    visibleBox(evidence, "mobile verification and governance"),
  ]);

  expect(navigatorBox.y + navigatorBox.height).toBeLessThanOrEqual(sourceBox.y + 1);
  expect(sourceBox.y + sourceBox.height).toBeLessThanOrEqual(evidenceBox.y + 1);
  for (const box of [navigatorBox, sourceBox, evidenceBox]) {
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(box.width).toBeGreaterThan(280);
  }

  await expect(workbench.locator("[data-viewed-progress]")).toBeVisible();
  await expect(workbench.locator("[data-whole-feature-verdict]")).toBeVisible();
  await expect(workbench.locator("[data-source-path]").first()).toBeVisible();
  await expectNoClippedReviewText(workbench);
  await expectHorizontalFit(page);
  await captureVisual(page, testInfo, "feature-review-workbench-mobile.png");
  expect(pageErrors).toEqual([]);
});
