import { expect, test, type Page, type TestInfo } from "@playwright/test";

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

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as NodePath;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const DESKTOP_VIEWPORT = { width: 1_440, height: 900 };
const MIN_PANE_HEIGHT = 119; // 7.5rem (120px) floor, minus 1px of rounding slack.

function fixture(name: string): WorkspaceDocument {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as WorkspaceDocument;
}

// A synthetic session with a user turn and an agent reply, so `.history` renders real
// content instead of the empty state while the split and collapse controls are exercised.
function session(screen: WorkspaceDocument): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: `${screen.workspace_kind}-feedback-column-turn`,
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: `${screen.workspace_kind}-feedback-column-turn`,
      message: "Keep the feedback column usable while resizing and collapsing it.",
      annotations: [],
      choices: [],
      screen: { id: screen.workspace_kind, file: "workspace.json", revision: screen.revision },
    }, {
      version: 1,
      id: `${screen.workspace_kind}-feedback-column-reply`,
      seq: 2,
      timestamp: 1_725_000_001_000,
      type: "agent.message",
      role: "agent",
      replyTo: 1,
      message: "Noted — the threads and history split stays reachable at every size.",
    }],
  };
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

async function mount(page: Page, testInfo: TestInfo): Promise<WorkspaceDocument> {
  const screen = fixture("product-concept-set.json");
  const file = testInfo.outputPath("feedback-column.html");
  fs.writeFileSync(file, buildStandaloneHtml(screen, session(screen)));
  await page.context().setOffline(true);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  return screen;
}

test("localStorage on file:// persists across a reload in this browser", async ({ page }, testInfo) => {
  // Feature 1/2 persistence depends on this; verify it directly instead of assuming it,
  // per the task's own instruction to check before relying on a reload-based assertion.
  await mount(page, testInfo);
  await page.evaluate(() => localStorage.setItem("feedback-column-probe", "reload-check"));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const restored = await page.evaluate(() => localStorage.getItem("feedback-column-probe"));
  expect(restored).toBe("reload-check");
});

test("the collapse toggle hides the feedback column, grows the canvas, and restores it", async ({ page }, testInfo) => {
  await mount(page, testInfo);
  const canvas = page.locator(".workspace-canvas");
  const feedback = page.getByRole("complementary", { name: "Feedback batch" });
  const hideToggle = page.getByRole("button", { name: "Hide feedback panel" });

  await expect(feedback).toBeVisible();
  await expect(hideToggle).toHaveAttribute("aria-expanded", "true");
  await expect(hideToggle).toHaveAttribute("aria-controls", "feedback-panel");
  const expandedCanvasBox = await canvas.boundingBox();
  expect(expandedCanvasBox).not.toBeNull();

  await hideToggle.click();

  const showToggle = page.getByRole("button", { name: "Show feedback panel" });
  await expect(feedback).toBeHidden();
  await expect(showToggle).toHaveAttribute("aria-expanded", "false");
  await expect(showToggle).toBeVisible();
  await expect(showToggle).toBeEnabled();

  const collapsedCanvasBox = await canvas.boundingBox();
  expect(collapsedCanvasBox).not.toBeNull();
  expect(collapsedCanvasBox!.width).toBeGreaterThan(expandedCanvasBox!.width + 1);
  expect(collapsedCanvasBox!.width).toBeGreaterThanOrEqual(DESKTOP_VIEWPORT.width - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await showToggle.click();

  await expect(feedback).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide feedback panel" })).toHaveAttribute("aria-expanded", "true");
  const restoredCanvasBox = await canvas.boundingBox();
  expect(restoredCanvasBox).not.toBeNull();
  expect(Math.abs(restoredCanvasBox!.width - expandedCanvasBox!.width)).toBeLessThanOrEqual(1);
});

test("the collapse toggle is keyboard-operable and reflects aria-expanded", async ({ page }, testInfo) => {
  await mount(page, testInfo);
  const feedback = page.getByRole("complementary", { name: "Feedback batch" });

  await page.getByRole("button", { name: "Hide feedback panel" }).focus();
  await expect(page.getByRole("button", { name: "Hide feedback panel" })).toBeFocused();

  await page.keyboard.press("Enter");
  const showToggle = page.getByRole("button", { name: "Show feedback panel" });
  await expect(showToggle).toHaveAttribute("aria-expanded", "false");
  await expect(feedback).toBeHidden();
  await expect(showToggle).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide feedback panel" })).toHaveAttribute("aria-expanded", "true");
  await expect(feedback).toBeVisible();
});

test("the threads/history separator resizes both panes via keyboard without overlap or shrinking past the minimum", async ({ page }, testInfo) => {
  await mount(page, testInfo);
  const compose = page.locator(".feedback-compose");
  const history = page.locator(".history");
  const separator = page.getByRole("separator", { name: "Session history height" });

  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-controls", "feedback-history");
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");

  const initialCompose = await compose.boundingBox();
  const initialHistory = await history.boundingBox();
  expect(initialCompose).not.toBeNull();
  expect(initialHistory).not.toBeNull();
  expect(overlapArea(initialCompose!, initialHistory!)).toBe(0);

  await separator.focus();
  await expect(separator).toBeFocused();

  // "End" drives the tracked value (Session history height) to its maximum.
  await page.keyboard.press("End");
  const grownHistory = await history.boundingBox();
  const shrunkCompose = await compose.boundingBox();
  expect(grownHistory).not.toBeNull();
  expect(shrunkCompose).not.toBeNull();
  expect(grownHistory!.height).toBeGreaterThan(initialHistory!.height + 1);
  expect(overlapArea(shrunkCompose!, grownHistory!)).toBe(0);
  expect(shrunkCompose!.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);
  expect(grownHistory!.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);

  // "Home" drives it back down to its minimum.
  await page.keyboard.press("Home");
  const shrunkHistory = await history.boundingBox();
  const grownCompose = await compose.boundingBox();
  expect(shrunkHistory).not.toBeNull();
  expect(grownCompose).not.toBeNull();
  expect(shrunkHistory!.height).toBeLessThan(grownHistory!.height - 1);
  expect(shrunkHistory!.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);
  expect(grownCompose!.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);
  expect(overlapArea(grownCompose!, shrunkHistory!)).toBe(0);

  // A single arrow-key step nudges the split without breaking either invariant.
  const beforeArrow = await history.boundingBox();
  await page.keyboard.press("ArrowUp");
  const afterArrowHistory = await history.boundingBox();
  const afterArrowCompose = await compose.boundingBox();
  expect(beforeArrow).not.toBeNull();
  expect(afterArrowHistory).not.toBeNull();
  expect(afterArrowCompose).not.toBeNull();
  expect(afterArrowHistory!.height).toBeGreaterThan(beforeArrow!.height);
  expect(afterArrowCompose!.height).toBeGreaterThanOrEqual(MIN_PANE_HEIGHT);
  expect(overlapArea(afterArrowCompose!, afterArrowHistory!)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("collapsed state and the threads/history split persist across a reload", async ({ page }, testInfo) => {
  const screen = await mount(page, testInfo);
  const separator = page.getByRole("separator", { name: "Session history height" });

  await separator.focus();
  await page.keyboard.press("End");
  const historyHeightBefore = await page.locator(".history").evaluate(element => element.getBoundingClientRect().height);

  await page.getByRole("button", { name: "Hide feedback panel" }).click();
  await expect(page.getByRole("complementary", { name: "Feedback batch" })).toBeHidden();

  const storedKeys = await page.evaluate(() => Object.keys(localStorage));
  expect(storedKeys.some(key => key.startsWith("visual-feedback-collapsed:"))).toBe(true);
  expect(storedKeys.some(key => key.startsWith("visual-feedback-split:"))).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();

  const showToggle = page.getByRole("button", { name: "Show feedback panel" });
  await expect(showToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("complementary", { name: "Feedback batch" })).toBeHidden();

  await showToggle.click();
  await expect(page.getByRole("complementary", { name: "Feedback batch" })).toBeVisible();
  const historyHeightAfter = await page.locator(".history").evaluate(element => element.getBoundingClientRect().height);
  expect(Math.abs(historyHeightAfter - historyHeightBefore)).toBeLessThanOrEqual(2);
});
