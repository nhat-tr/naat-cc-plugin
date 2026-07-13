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

interface WorkspaceFixture extends Record<string, unknown> {
  content: Record<string, unknown>;
  revision: string;
  workspace_kind: string;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as NodePath;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

function loadFixture(name: string): WorkspaceFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as WorkspaceFixture;
}

function sessionFixture(kind: string, revision: unknown): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: `${kind}-feedback-event`,
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: `${kind}-feedback-turn`,
      message: "Keep the purpose-specific layout legible without developer chrome.",
      annotations: [],
      choices: [],
      screen: { id: kind, file: "screen.json", revision },
    }],
  };
}

async function mountDocument(page: Page, testInfo: TestInfo, screen: WorkspaceFixture): Promise<string[]> {
  const html = buildStandaloneHtml(screen, sessionFixture(screen.workspace_kind, screen.revision));
  const file = testInfo.outputPath(`${screen.workspace_kind}.html`);
  fs.writeFileSync(file, html);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto(pathToFileURL(file).href);
  return pageErrors;
}

async function mount(page: Page, testInfo: TestInfo, fixtureName: string): Promise<string[]> {
  return mountDocument(page, testInfo, loadFixture(fixtureName));
}

async function expectSelectedFramePanel(page: Page, tabName: string): Promise<void> {
  const tab = page.getByRole("tab", { name: tabName, exact: true });
  const panelId = await tab.getAttribute("aria-controls");
  expect(panelId).not.toBeNull();
  if (!panelId) return;
  await expect(page.locator(`#${panelId}`)).toHaveAttribute("role", "tabpanel");
  await expect(page.locator(`#${panelId}`)).toHaveAttribute("aria-labelledby", await tab.getAttribute("id") ?? "");
}

function overlapArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

async function expectNoPairOverlap(locators: Locator[]): Promise<void> {
  const boxes = await Promise.all(locators.map(locator => locator.boundingBox()));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(boxes[left], `item ${left + 1} must have geometry`).not.toBeNull();
      expect(boxes[right], `item ${right + 1} must have geometry`).not.toBeNull();
      expect(overlapArea(boxes[left]!, boxes[right]!), `items ${left + 1} and ${right + 1} overlap`).toBe(0);
    }
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(fits, "page must not scroll horizontally").toBe(true);
}

test("Research Evidence Board renders confidence columns with sourced claims", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "research-evidence.json");

  const board = page.locator('[data-workspace-kind="research"]');
  await expect(board).toBeVisible();
  await expectSelectedFramePanel(page, "Evidence board");

  // Confidence is the primary axis (approved "Confidence columns" direction).
  const high = page.locator('[data-confidence="high"]');
  const medium = page.locator('[data-confidence="medium"]');
  const low = page.locator('[data-confidence="low"]');
  await expect(high).toBeVisible();
  await expect(medium).toBeVisible();
  await expect(low).toBeVisible();

  // At desktop width the three bands read left-to-right and never overlap.
  await expectNoPairOverlap([high, medium, low]);
  const highBox = await high.boundingBox();
  const mediumBox = await medium.boundingBox();
  const lowBox = await low.boundingBox();
  expect(highBox!.x).toBeLessThan(mediumBox!.x);
  expect(mediumBox!.x).toBeLessThan(lowBox!.x);

  // A high-confidence claim sits in the high band and links its sources.
  const durableWait = high.locator('[data-brainstorm-id="claim-durable-wait"]');
  await expect(durableWait).toBeVisible();
  await expect(durableWait.locator('[data-primitive="chip"][data-source-ref="EVD-wait-durability"]')).toBeVisible();
  expect(await durableWait.locator('[data-primitive="chip"][data-source-ref]').count()).toBe(3);

  // Contradictions are surfaced as a non-color-only flag.
  await expect(
    page.locator('[data-brainstorm-id="claim-idle-ordering"] [data-primitive="flag"][data-flag="contradiction"]'),
  ).toBeVisible();

  // Unknowns stay visible in the low band but never look like evidence.
  const unknown = low.locator('[data-brainstorm-id="unknown-claude-preview"][data-unknown="true"]');
  await expect(unknown).toBeVisible();
  expect(await unknown.locator('[data-primitive="chip"][data-source-ref]').count()).toBe(0);

  // Decision relevance is a filter/label, not the axis.
  await expect(page.locator('[data-decision-relevance-filter]')).toBeVisible();

  const bodyText = (await board.innerText()).trim();
  expect(bodyText.length).toBeGreaterThan(100);
  await expectNoHorizontalOverflow(page);
  expect(pageErrors).toEqual([]);
});

test("Business Reasoning Canvas renders the actor journey spine with attached reasoning", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "business-reasoning.json");

  const canvas = page.locator('[data-workspace-kind="business"]');
  await expect(canvas).toBeVisible();
  await expectSelectedFramePanel(page, "Actor journey");

  // Journey spine is the approved reading order.
  const spine = page.locator('[data-journey-spine="true"]');
  await expect(spine).toBeVisible();

  const stages = ["stage-discover", "stage-evaluate", "stage-adopt"].map(id => spine.locator(`[data-brainstorm-id="${id}"]`));
  for (const stage of stages) await expect(stage).toBeVisible();
  const boxes = await Promise.all(stages.map(stage => stage.boundingBox()));
  expect(boxes[0]!.x + boxes[0]!.y).toBeLessThan(boxes[1]!.x + boxes[1]!.y);
  expect(boxes[1]!.x + boxes[1]!.y).toBeLessThan(boxes[2]!.x + boxes[2]!.y);

  // Actors and outcomes lead the reading order.
  await expect(page.locator('[data-actor="buyer"]')).toBeVisible();
  await expect(page.locator('[data-outcome="time-to-value"]')).toBeVisible();

  // Business reasoning kinds attach to their stage.
  await expect(page.locator('[data-brainstorm-id="stage-discover"] [data-kind="assumption"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="stage-evaluate"] [data-kind="economics"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="stage-adopt"] [data-kind="evidence"]')).toBeVisible();

  const bodyText = (await canvas.innerText()).trim();
  expect(bodyText.length).toBeGreaterThan(100);
  await expectNoHorizontalOverflow(page);
  expect(pageErrors).toEqual([]);
});

test("Research Evidence Board always offers an unfiltered decision view", async ({ page }, testInfo) => {
  const screen = loadFixture("research-evidence.json");
  screen.content.decision_relevance_options = ["Runtime support"];
  const pageErrors = await mountDocument(page, testInfo, screen);

  const filter = page.getByRole("combobox", { name: "Decision relevance" });
  await expect(filter.getByRole("option", { name: "All decisions", exact: true })).toHaveCount(1);
  await expect(filter).toHaveValue("All decisions");
  await expect(page.locator('[data-brainstorm-id="claim-durable-wait"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="unknown-300-file"]')).toBeVisible();

  await filter.selectOption("Runtime support");
  await expect(page.locator('[data-brainstorm-id="claim-durable-wait"]')).toHaveCount(0);
  await expect(page.locator('[data-brainstorm-id="claim-idle-ordering"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="unknown-claude-preview"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Business Reasoning Canvas does not imply a journey when its spine is disabled", async ({ page }, testInfo) => {
  const screen = loadFixture("business-reasoning.json");
  screen.content.journey_spine = false;
  const pageErrors = await mountDocument(page, testInfo, screen);

  const reasoningAreas = page.locator('[data-journey-spine="false"]');
  await expect(reasoningAreas).toBeVisible();
  await expect(reasoningAreas.locator(".business-stage-number")).toHaveCount(0);
  await expect(reasoningAreas).not.toContainText("Journey stage");
  await expect(reasoningAreas.getByRole("heading", { name: "Discover", exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
