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

interface ScreenshotBuffer {
  byteLength: number;
  toString(encoding: "base64"): string;
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

interface PixelStats {
  colorBuckets: number;
  luminanceRange: number;
  naturalHeight: number;
  naturalWidth: number;
  opaquePixels: number;
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
  {
    fixture: "product-concept-set.json",
    kind: "product",
    regions: "[data-product-concept]",
    root: "[data-product-concept-studio]",
  },
  {
    fixture: "architecture-large.json",
    kind: "architecture",
    regions: "[data-architecture-viewport], [data-architecture-inspector]",
    root: "[data-architecture-canvas]",
  },
  {
    fixture: "research-evidence.json",
    kind: "research",
    regions: "[data-confidence]",
    root: "[data-research-evidence-board]",
  },
  {
    fixture: "business-reasoning.json",
    kind: "business",
    regions: "[data-journey-spine] > [data-brainstorm-id]",
    root: "[data-business-reasoning-canvas]",
  },
  {
    fixture: "feature-review-work.json",
    kind: "review",
    regions: "[data-review-navigator], [data-review-source], [data-review-evidence]",
    root: "[data-review-workbench]",
  },
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
      id: `${screen.workspace_kind}-visual-event`,
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: `${screen.workspace_kind}-visual-turn`,
      message: "Keep the purpose-specific workspace readable at this width.",
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

async function mount(
  page: Page,
  testInfo: TestInfo,
  screen: WorkspaceDocument,
  viewport: (typeof VIEWPORTS)[number],
): Promise<string[]> {
  const file = testInfo.outputPath(`${screen.workspace_kind}-${viewport.name}.html`);
  fs.writeFileSync(file, buildStandaloneHtml(screen, session(screen)));
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize(viewport);
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  return pageErrors;
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

async function expectPurposeGeometry(page: Page, regions: Locator, kind: string): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const count = await regions.count();
  expect(count, `${kind} must expose multiple purpose-specific regions`).toBeGreaterThanOrEqual(2);
  const boxes: Box[] = [];
  for (let index = 0; index < count; index += 1) {
    const region = regions.nth(index);
    await expect(region, `${kind} region ${index + 1} must be visible`).toBeVisible();
    const box = await region.boundingBox();
    expect(box, `${kind} region ${index + 1} must have geometry`).not.toBeNull();
    expect(box!.width, `${kind} region ${index + 1} collapsed`).toBeGreaterThan(80);
    expect(box!.height, `${kind} region ${index + 1} collapsed`).toBeGreaterThan(24);
    expect(box!.x, `${kind} region ${index + 1} is unreachable on the left`).toBeGreaterThanOrEqual(-1);
    expect(
      box!.x + box!.width,
      `${kind} region ${index + 1} is unreachable on the right`,
    ).toBeLessThanOrEqual(viewport!.width + 1);
    boxes.push(box!);
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(
        overlapArea(boxes[left]!, boxes[right]!),
        `${kind} regions ${left + 1}/${right + 1} overlap`,
      ).toBe(0);
    }
  }
}

async function expectNoClippedText(root: Locator, kind: string): Promise<void> {
  const clipped = await root.locator("h2, h3, h4, p, li, button, [role='tab']").evaluateAll(elements => (
    elements.filter(element => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest("[data-architecture-viewport]")) return false;
      if (element.closest(".sr-only")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) {
        return false;
      }
      return element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1;
    }).map(element => element.textContent?.trim().slice(0, 100) || element.tagName)
  ));
  expect(clipped, `${kind} clipped text: ${clipped.join(" | ")}`).toEqual([]);
}

async function pixelEvidence(
  page: Page,
  root: Locator,
  testInfo: TestInfo,
  name: string,
): Promise<PixelStats> {
  const screenshot = await root.screenshot({
    animations: "disabled",
    caret: "hide",
    path: testInfo.outputPath(name),
  }) as unknown as ScreenshotBuffer;
  expect(screenshot.byteLength, `${name} must contain encoded visual evidence`).toBeGreaterThan(7_000);
  const stats = await page.evaluate(async (base64): Promise<PixelStats> => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(image.naturalWidth, 320);
    canvas.height = Math.min(image.naturalHeight, 240);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("pixel evidence requires a 2D canvas context");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    let minimumLuminance = 255;
    let maximumLuminance = 0;
    let opaquePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha < 16) continue;
      opaquePixels += 1;
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
      colors.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
    }
    return {
      colorBuckets: colors.size,
      luminanceRange: maximumLuminance - minimumLuminance,
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
      opaquePixels,
    };
  }, screenshot.toString("base64"));
  expect(stats.opaquePixels).toBeGreaterThan(8_000);
  expect(stats.colorBuckets).toBeGreaterThan(8);
  expect(stats.luminanceRange).toBeGreaterThan(30);
  return stats;
}

for (const workspace of WORKSPACES) {
  test(`workspace fixtures: ${workspace.kind} has distinct, responsive visual geometry`, async ({ page }, testInfo) => {
    const screen = fixture(workspace.fixture);
    expect(screen.workspace_kind).toBe(workspace.kind);
    const pixelStats: PixelStats[] = [];

    for (const viewport of VIEWPORTS) {
      const pageErrors = await mount(page, testInfo, screen, viewport);
      const root = page.locator(workspace.root);
      await expect(root).toBeVisible();
      if (workspace.kind === "architecture") {
        await expect(root).toHaveAttribute("data-layout-status", "ready");
      }
      await expectPurposeGeometry(page, root.locator(workspace.regions), workspace.kind);
      await expectNoClippedText(root, workspace.kind);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      pixelStats.push(await pixelEvidence(
        page,
        root,
        testInfo,
        `${workspace.kind}-${viewport.name}.png`,
      ));
      expect(pageErrors).toEqual([]);
    }

    expect(pixelStats[0]!.naturalWidth).toBeGreaterThan(pixelStats[1]!.naturalWidth);
  });
}

test("maximized desktop Feedback Panel keeps every Workspace Kind within its resizable canvas", async ({ page }, testInfo) => {
  const desktop = VIEWPORTS[0];

  for (const workspace of WORKSPACES) {
    const screen = fixture(workspace.fixture);
    const pageErrors = await mount(page, testInfo, screen, desktop);
    const canvas = page.locator(".workspace-canvas");
    const feedback = page.getByRole("complementary", { name: "Feedback batch" });
    const splitter = page.getByRole("separator", { name: "Workspace canvas width" });
    const root = page.locator(workspace.root);

    await expect(root).toBeVisible();
    if (workspace.kind === "architecture") {
      await expect(root).toHaveAttribute("data-layout-status", "ready");
    }
    await expect(splitter).toBeVisible();
    await splitter.focus();
    await page.keyboard.press("End");
    const beforeCanvas = await canvas.boundingBox();
    const beforeFeedback = await feedback.boundingBox();
    expect(beforeCanvas).not.toBeNull();
    expect(beforeFeedback).not.toBeNull();

    await page.keyboard.press("Home");

    if (workspace.kind === "product") {
      await expect(root.locator("[data-product-concept-wall]"))
        .toHaveAttribute("data-layout", "mobile-three-up");
      await expect(root.locator("[data-product-difference-lens]"))
        .toBeHidden();
    }

    const canvasBox = await canvas.boundingBox();
    const feedbackBox = await feedback.boundingBox();
    const rootBox = await root.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(feedbackBox).not.toBeNull();
    expect(rootBox).not.toBeNull();
    expect(canvasBox!.width, `${workspace.kind} canvas must shrink`).toBeLessThan(beforeCanvas!.width - 1);
    expect(feedbackBox!.width, `${workspace.kind} Feedback Panel must grow`).toBeGreaterThan(beforeFeedback!.width + 1);
    expect(overlapArea(canvasBox!, feedbackBox!), `${workspace.kind} canvas and Feedback Panel overlap`).toBe(0);
    expect(rootBox!.x, `${workspace.kind} root escapes the canvas on the left`).toBeGreaterThanOrEqual(canvasBox!.x - 1);
    expect(
      rootBox!.x + rootBox!.width,
      `${workspace.kind} root escapes the canvas on the right`,
    ).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);

    const regions = root.locator(workspace.regions);
    await expectPurposeGeometry(page, regions, workspace.kind);
    for (let index = 0; index < await regions.count(); index += 1) {
      const regionBox = await regions.nth(index).boundingBox();
      expect(regionBox, `${workspace.kind} region ${index + 1} must have geometry`).not.toBeNull();
      expect(
        regionBox!.x,
        `${workspace.kind} region ${index + 1} escapes the canvas on the left`,
      ).toBeGreaterThanOrEqual(canvasBox!.x - 1);
      expect(
        regionBox!.x + regionBox!.width,
        `${workspace.kind} region ${index + 1} escapes the canvas on the right`,
      ).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);
    }

    await expectNoClippedText(root, workspace.kind);
    expect(
      await canvas.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
      `${workspace.kind} canvas has horizontal overflow`,
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await pixelEvidence(page, root, testInfo, `${workspace.kind}-max-feedback.png`);
    expect(pageErrors).toEqual([]);
  }
});
