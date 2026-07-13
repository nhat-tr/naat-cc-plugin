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

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as NodePath;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const DESKTOP = { width: 1_280, height: 900 };
const MOBILE = { width: 390, height: 844 };

function loadFixture(name: string): { revision: string; workspace_kind: string } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function sessionFixture(kind: string, revision: unknown): Record<string, unknown> {
  return { version: 1, cursor: 0, pendingTurns: 0, events: [{
    version: 1, id: `${kind}-event`, seq: 1, timestamp: 1_725_000_000_000, type: "user.turn", role: "user",
    clientTurnId: `${kind}-turn`, message: "Keep the layout purpose-specific and free of developer chrome.",
    annotations: [], choices: [], screen: { id: kind, file: "screen.json", revision },
  }] };
}

async function mount(page: Page, testInfo: TestInfo, fixtureName: string, viewport: { width: number; height: number }): Promise<string[]> {
  const screen = loadFixture(fixtureName);
  const html = buildStandaloneHtml(screen, sessionFixture(screen.workspace_kind, screen.revision));
  const file = testInfo.outputPath(`${screen.workspace_kind}.html`);
  fs.writeFileSync(file, html);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize(viewport);
  await page.goto(pathToFileURL(file).href);
  return pageErrors;
}

function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

async function boxes(locators: Locator[]): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const result = await Promise.all(locators.map(locator => locator.boundingBox()));
  result.forEach((box, index) => expect(box, `region ${index + 1} must have geometry`).not.toBeNull());
  return result.map(box => box!);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

// Developer chrome = raw serialized state, debug panels, or exposed schema keys.
// A reasoning surface for non-engineers must never leak them.
async function expectNoDeveloperChrome(root: Locator): Promise<void> {
  expect(await root.locator("pre, code, [data-debug], .debug, textarea").count()).toBe(0);
  const text = await root.innerText();
  for (const leak of ["workspace_kind", "component_id", "source_refs", "\"content\""]) {
    expect(text, `must not expose raw key ${leak}`).not.toContain(leak);
  }
}

test("Research board keeps confidence columns distinct and unknowns non-evidential", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "research-evidence.json", DESKTOP);
  const board = page.locator('[data-workspace-kind="research"]');
  await expect(board).toBeVisible();

  const columns = await boxes([
    page.locator('[data-confidence="high"]'),
    page.locator('[data-confidence="medium"]'),
    page.locator('[data-confidence="low"]'),
  ]);
  // Columns are side-by-side, none collapsed, none overlapping.
  for (let i = 0; i < columns.length; i += 1) {
    expect(columns[i]!.width, `column ${i + 1} is collapsed`).toBeGreaterThan(160);
    for (let j = i + 1; j < columns.length; j += 1) {
      expect(overlapArea(columns[i]!, columns[j]!), `columns ${i + 1}/${j + 1} overlap`).toBe(0);
    }
  }
  expect(columns[0]!.x).toBeLessThan(columns[1]!.x);
  expect(columns[1]!.x).toBeLessThan(columns[2]!.x);

  // Unknowns are visible but visually never evidence.
  const unknowns = page.locator('[data-unknown="true"]');
  expect(await unknowns.count()).toBeGreaterThan(0);
  expect(await unknowns.locator('[data-primitive="chip"][data-source-ref]').count()).toBe(0);

  await expectNoDeveloperChrome(board);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("research-desktop.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("Research board stacks confidence columns at mobile width", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "research-evidence.json", MOBILE);
  await expect(page.locator('[data-workspace-kind="research"]')).toBeVisible();
  const columns = await boxes([
    page.locator('[data-confidence="high"]'),
    page.locator('[data-confidence="medium"]'),
    page.locator('[data-confidence="low"]'),
  ]);
  // Stacked: each subsequent band starts below the previous one.
  expect(columns[0]!.y).toBeLessThan(columns[1]!.y);
  expect(columns[1]!.y).toBeLessThan(columns[2]!.y);
  await expectNoHorizontalOverflow(page);
  expect(pageErrors).toEqual([]);
});

test("Business canvas presents the journey spine and leads with actors and outcomes", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "business-reasoning.json", DESKTOP);
  const canvas = page.locator('[data-workspace-kind="business"]');
  await expect(canvas).toBeVisible();
  await expect(page.locator('[data-journey-spine="true"]')).toBeVisible();

  const stages = await boxes([
    page.locator('[data-brainstorm-id="stage-discover"]'),
    page.locator('[data-brainstorm-id="stage-evaluate"]'),
    page.locator('[data-brainstorm-id="stage-adopt"]'),
  ]);
  for (let i = 0; i < stages.length; i += 1) {
    for (let j = i + 1; j < stages.length; j += 1) {
      expect(overlapArea(stages[i]!, stages[j]!), `stages ${i + 1}/${j + 1} overlap`).toBe(0);
    }
  }
  // Actors/outcomes lead: the actor lead sits above the first stage.
  const actorLead = await boxes([page.locator('[data-actor="buyer"]').first()]);
  expect(actorLead[0]!.y).toBeLessThanOrEqual(stages[0]!.y);

  await expectNoDeveloperChrome(canvas);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("business-desktop.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("Business canvas stays readable and chrome-free at mobile width", async ({ page }, testInfo) => {
  const pageErrors = await mount(page, testInfo, "business-reasoning.json", MOBILE);
  const canvas = page.locator('[data-workspace-kind="business"]');
  await expect(canvas).toBeVisible();
  await expect(page.locator('[data-journey-spine="true"]')).toBeVisible();
  const stages = await boxes([
    page.locator('[data-journey-spine="true"] [data-brainstorm-id="stage-discover"]'),
    page.locator('[data-journey-spine="true"] [data-brainstorm-id="stage-evaluate"]'),
    page.locator('[data-journey-spine="true"] [data-brainstorm-id="stage-adopt"]'),
  ]);
  expect(stages[0]!.y).toBeLessThan(stages[1]!.y);
  expect(stages[1]!.y).toBeLessThan(stages[2]!.y);
  await expectNoDeveloperChrome(canvas);
  await expectNoHorizontalOverflow(page);
  expect(pageErrors).toEqual([]);
});
