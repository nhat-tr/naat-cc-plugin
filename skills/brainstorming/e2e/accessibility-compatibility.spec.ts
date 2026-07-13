import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const __dirname: string;
declare const require: { (id: string): unknown };

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string): void;
}

interface NodePath {
  join(...parts: string[]): string;
}

interface NodeUrl {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

interface WorkspaceDocument extends Record<string, unknown> {
  revision: string;
  title: string;
  workspace_kind: string;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as NodePath;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const VIEWPORTS = [
  { name: "desktop", width: 1_440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const WORKSPACES = [
  { fixture: "product-concept-set.json", kind: "product", root: "[data-product-concept-studio]" },
  { fixture: "architecture-large.json", kind: "architecture", root: "[data-architecture-canvas]" },
  { fixture: "research-evidence.json", kind: "research", root: "[data-research-evidence-board]" },
  { fixture: "business-reasoning.json", kind: "business", root: "[data-business-reasoning-canvas]" },
  { fixture: "feature-review-work.json", kind: "review", root: "[data-review-workbench]" },
] as const;

function fixture(name: string): WorkspaceDocument {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as WorkspaceDocument;
}

function session(screen: WorkspaceDocument): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: `${screen.workspace_kind}-a11y-event`,
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: `${screen.workspace_kind}-a11y-turn`,
      message: "Review this workspace with keyboard and assistive technology.",
      annotations: [],
      choices: [],
      screen: {
        id: screen.workspace_kind,
        file: "workspace.json",
        revision: screen.revision,
      },
    }],
  };
}

async function mountOffline(
  page: Page,
  testInfo: TestInfo,
  screen: WorkspaceDocument,
  viewport: (typeof VIEWPORTS)[number],
): Promise<{ networkRequests: string[]; pageErrors: string[] }> {
  const file = testInfo.outputPath(`${screen.workspace_kind}-${viewport.name}-a11y.html`);
  fs.writeFileSync(file, buildStandaloneHtml(screen, session(screen)));
  const networkRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", request => {
    if (!/^(?:file|data|blob):/u.test(request.url())) networkRequests.push(request.url());
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  return { networkRequests, pageErrors };
}

async function expectVisibleFocus(page: Page, root: Locator): Promise<void> {
  const purposeControl = root.locator(
    "button:not([disabled]), select:not([disabled]), a[href], [tabindex='0']",
  ).filter({ visible: true }).first();
  const control = await purposeControl.count() > 0
    ? purposeControl
    : page.getByRole("tablist", { name: /workspace frames/i }).getByRole("tab").first();
  await expect(control).toBeVisible();
  await control.focus();
  await expect(control).toBeFocused();
  const style = await control.evaluate(element => {
    const computed = getComputedStyle(element);
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth),
    };
  });
  expect(style.outlineStyle).not.toBe("none");
  expect(style.outlineWidth).toBeGreaterThan(0);
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

async function expectReducedMotion(page: Page): Promise<void> {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const movingElements = await page.locator("body *").evaluateAll(elements => {
    const milliseconds = (value: string): number => Math.max(...value.split(",").map(token => {
      const duration = token.trim();
      const amount = Number.parseFloat(duration);
      return duration.endsWith("ms") ? amount : amount * 1_000;
    }));
    return elements.filter(element => {
      const style = getComputedStyle(element);
      const animated = style.animationName !== "none" && milliseconds(style.animationDuration) > 1;
      const movingTransition = /transform|translate|rotate|scale|left|right|top|bottom|all/u
        .test(style.transitionProperty)
        && milliseconds(style.transitionDuration) > 1;
      return animated || movingTransition || style.scrollBehavior === "smooth";
    }).map(element => `${element.tagName.toLowerCase()}#${element.id}`);
  });
  expect(movingElements).toEqual([]);
}

async function expectReviewTreeKeyboard(page: Page, root: Locator): Promise<void> {
  const navigator = root.locator("[data-review-navigator]");
  const tree = navigator.locator("[data-review-tree][role='tree']");
  await expect(tree).toHaveAttribute("aria-label", /.+/u);
  const items = tree.locator("[role='treeitem']");
  expect(await items.count()).toBeGreaterThanOrEqual(3);
  const first = items.first();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  const focusedState = await first.evaluate(element => ({
    selected: element.getAttribute("aria-selected"),
    viewed: element.getAttribute("data-viewed"),
  }));
  expect(focusedState.selected).not.toBeNull();
  expect(focusedState.viewed).not.toBeNull();
}

for (const workspace of WORKSPACES) {
  test(`workspace fixtures: ${workspace.kind} is keyboard, WCAG, reflow, and offline compatible`, async ({ page }, testInfo) => {
    const screen = fixture(workspace.fixture);
    expect(screen.workspace_kind).toBe(workspace.kind);

    for (const viewport of VIEWPORTS) {
      const evidence = await mountOffline(page, testInfo, screen, viewport);
      const root = page.locator(workspace.root);
      await expect(root).toBeVisible();
      if (workspace.kind === "architecture") {
        await expect(root).toHaveAttribute("data-layout-status", "ready");
      }
      await expect(page.getByRole("main")).toBeVisible();
      await expect(root.getByRole("heading").first()).toBeVisible();
      await expectVisibleFocus(page, root);
      await expectReducedMotion(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

      if (workspace.kind === "review") {
        await expect(root.getByRole("complementary", { name: "Review navigator" })).toBeVisible();
        await expectReviewTreeKeyboard(page, root);
      }

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      await testInfo.attach(`${workspace.kind}-${viewport.name}-axe.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });
      const blocking = results.violations.filter(violation => (
        violation.impact === "critical" || violation.impact === "serious"
      ));
      expect(
        blocking.map(violation => ({ id: violation.id, nodes: violation.nodes.length })),
        `${workspace.kind} has blocking automated accessibility findings`,
      ).toEqual([]);
      expect(evidence.networkRequests).toEqual([]);
      expect(evidence.pageErrors).toEqual([]);
    }
  });
}
