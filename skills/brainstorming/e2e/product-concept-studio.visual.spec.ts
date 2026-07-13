import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const require: { (id: string): unknown };

interface FileSystem {
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, contents: string, options?: { mode?: number }): void;
}

interface BrainstormServer {
  close(reason?: string): Promise<void>;
  listen(): Promise<{ connection_url: string }>;
}

interface BrainstormServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): BrainstormServer;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const fs = require("node:fs") as FileSystem;
const { createBrainstormServer } = require("../scripts/server.cjs") as BrainstormServerFactory;
const fixturePath = "skills/brainstorming/fixtures/product-concept-set.json";
const conceptLabels = [
  "Concept A · Command center",
  "Concept B · Guided review",
  "Concept C · Direct manipulation",
] as const;

function productDocument(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

async function openProductStudio(
  page: Page,
  testInfo: TestInfo,
  purpose: string,
): Promise<BrainstormServer> {
  const sessionDir = testInfo.outputPath(purpose);
  const contentDir = `${sessionDir}/content`;
  const stateDir = `${sessionDir}/state`;
  fs.mkdirSync(contentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    `${contentDir}/workspace.json`,
    `${JSON.stringify(productDocument())}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    `${stateDir}/visual-format.json`,
    `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: "content/screen.json",
      v2_document: "content/workspace.json",
    })}\n`,
    { mode: 0o600 },
  );

  const app = createBrainstormServer({
    sessionDir,
    host: "127.0.0.1",
    port: 0,
    token: "product-visual-capability",
    sessionId: `product-${purpose}`,
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  try {
    await page.goto(address.connection_url);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
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

async function visibleBoxes(locator: Locator, label: string): Promise<Box[]> {
  const count = await locator.count();
  const boxes: Box[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    await expect(item, `${label} ${index + 1} must be visible`).toBeVisible();
    const box = await item.boundingBox();
    expect(box, `${label} ${index + 1} must have geometry`).not.toBeNull();
    boxes.push(box!);
  }
  return boxes;
}

function expectNoPairOverlap(boxes: Box[], label: string): void {
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(
        overlapArea(boxes[left]!, boxes[right]!),
        `${label} ${left + 1} and ${right + 1} overlap`,
      ).toBe(0);
    }
  }
}

function expectComparableDimensions(boxes: Box[]): void {
  const widths = boxes.map(box => box.width);
  const heights = boxes.map(box => box.height);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  for (const box of boxes) expect(box.width * box.height).toBeGreaterThan(1_000);
}

async function expectNoClippedProductText(scope: Locator): Promise<void> {
  const clipped = await scope.locator("h1, h2, h3, h4, p, li, button, [role='tab']").evaluateAll(elements => elements
    .filter(element => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest(".sr-only")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) {
        return false;
      }
      return element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1;
    })
    .map(element => element.textContent?.trim().slice(0, 100) || element.tagName));
  expect(clipped, `clipped Product Concept Studio text: ${clipped.join(" | ")}`).toEqual([]);
}

async function expectHorizontalReachability(page: Page, scope: Locator): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const controls = scope.locator("button:not([disabled]), a[href], [role='tab'][tabindex='0']");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box, `Product control ${index + 1} must have geometry`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  }
}

async function captureVisual(
  page: Page,
  testInfo: TestInfo,
  name: string,
  minimumBytes: number,
): Promise<void> {
  const screenshot = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: testInfo.outputPath(name),
  });
  expect(screenshot.byteLength, `${name} must contain nonblank visual evidence`).toBeGreaterThan(minimumBytes);
}

test("product concept set visual keeps three comparable frames in the approved desktop and mobile walls", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_440, height: 900 });
  const app = await openProductStudio(page, testInfo, "concept-wall");

  try {
    const studio = page.locator("[data-product-concept-studio]");
    await expect(studio).toBeVisible();
    const wall = studio.locator("[data-product-concept-wall]");
    const concepts = wall.locator("[data-product-concept][data-concept-id]");
    await expect(wall).toHaveAttribute("data-layout", "desktop-stacked");
    await expect(concepts).toHaveCount(3);
    for (const label of conceptLabels) await expect(wall.getByText(label, { exact: true })).toBeVisible();
    await expect(studio.locator("[data-product-difference-lens]")).toBeVisible();

    const desktopBoxes = await visibleBoxes(concepts, "desktop concept frame");
    expectComparableDimensions(desktopBoxes);
    expectNoPairOverlap(desktopBoxes, "desktop concept frames");
    expect(Math.max(...desktopBoxes.map(box => box.x)) - Math.min(...desktopBoxes.map(box => box.x)))
      .toBeLessThanOrEqual(2);
    for (let index = 1; index < desktopBoxes.length; index += 1) {
      expect(desktopBoxes[index]!.y).toBeGreaterThanOrEqual(
        desktopBoxes[index - 1]!.y + desktopBoxes[index - 1]!.height,
      );
    }
    await expectNoClippedProductText(studio);
    await expectHorizontalReachability(page, studio);
    await captureVisual(page, testInfo, "product-concept-wall-desktop.png", 20_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(wall).toHaveAttribute("data-layout", "mobile-three-up");
    const mobileBoxes = await visibleBoxes(concepts, "mobile concept frame");
    expectComparableDimensions(mobileBoxes);
    expectNoPairOverlap(mobileBoxes, "mobile concept frames");
    expect(Math.max(...mobileBoxes.map(box => box.y)) - Math.min(...mobileBoxes.map(box => box.y)))
      .toBeLessThanOrEqual(2);
    for (let index = 1; index < mobileBoxes.length; index += 1) {
      expect(mobileBoxes[index]!.x).toBeGreaterThanOrEqual(
        mobileBoxes[index - 1]!.x + mobileBoxes[index - 1]!.width,
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expectNoClippedProductText(studio);
    await expectHorizontalReachability(page, studio);
    await captureVisual(page, testInfo, "product-concept-wall-mobile.png", 12_000);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("product concept set visual keeps the selected concept readable in desktop and mobile focus views", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_440, height: 900 });
  const app = await openProductStudio(page, testInfo, "selected-focus");

  try {
    const studio = page.locator("[data-product-concept-studio]");
    await expect(studio).toBeVisible();
    await studio.getByRole("button", { name: `Select ${conceptLabels[1]}`, exact: true }).click();
    await expect(studio.getByRole("button", { name: `Select ${conceptLabels[1]}`, exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await studio.getByRole("button", { name: `Inspect ${conceptLabels[1]}`, exact: true }).click();

    const focus = studio.locator('[data-product-focus][data-concept-id="concept-b"]');
    const statePreview = focus.locator("[data-product-focus-state]");
    const responsivePreview = focus.locator("[data-product-responsive-preview]");
    const details = focus.locator([
      '[data-brainstorm-id="focus-states"]',
      '[data-brainstorm-id="focus-responsive"]',
      '[data-brainstorm-id="focus-accessibility"]',
      '[data-brainstorm-id="focus-handoff"]',
    ].join(", "));
    await expect(focus).toBeVisible();
    await expect(statePreview).toBeVisible();
    await expect(responsivePreview).toBeVisible();
    await expect(details).toHaveCount(4);
    for (const state of ["Default", "Loading", "Empty", "Error"]) {
      await expect(focus.getByRole("tab", { name: state, exact: true })).toBeVisible();
    }
    await expect(focus.getByRole("heading", { name: /accessibility/i })).toBeVisible();
    await expect(focus.getByRole("heading", { name: /handoff/i })).toBeVisible();

    await focus.getByRole("button", { name: "Desktop", exact: true }).click();
    const desktopParts = await visibleBoxes(details, "desktop focus surface");
    expectNoPairOverlap(desktopParts, "desktop focus surfaces");
    expect((await responsivePreview.boundingBox())!.width).toBeGreaterThan(480);
    await expectNoClippedProductText(focus);
    await expectHorizontalReachability(page, focus);
    await captureVisual(page, testInfo, "product-concept-focus-desktop.png", 20_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await focus.getByRole("button", { name: "Mobile", exact: true }).click();
    await expect(focus).toHaveAttribute("data-concept-id", "concept-b");
    const mobileParts = await visibleBoxes(details, "mobile focus surface");
    expectNoPairOverlap(mobileParts, "mobile focus surfaces");
    for (let index = 1; index < mobileParts.length; index += 1) {
      expect(mobileParts[index]!.y).toBeGreaterThanOrEqual(
        mobileParts[index - 1]!.y + mobileParts[index - 1]!.height,
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expectNoClippedProductText(focus);
    await expectHorizontalReachability(page, focus);
    await captureVisual(page, testInfo, "product-concept-focus-mobile.png", 12_000);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
