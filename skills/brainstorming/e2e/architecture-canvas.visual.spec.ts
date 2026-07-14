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

interface ArchitectureNodeFixture {
  id: string;
  modes: Array<"current" | "proposed">;
  owner_id: string;
}

interface ArchitectureEdgeFixture {
  id: string;
  modes: Array<"current" | "proposed">;
}

interface OwnershipBoundaryFixture {
  id: string;
  parent_id?: string | null;
}

interface ArchitectureDocument extends Record<string, unknown> {
  content: {
    edges: ArchitectureEdgeFixture[];
    initial_mode: "current" | "proposed";
  nodes: ArchitectureNodeFixture[];
  ownership_boundaries: OwnershipBoundaryFixture[];
  scenarios: Array<{ label: string }>;
  };
  revision: string;
  title: string;
  workspace_kind: "architecture";
}

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface PixelStats {
  colorBuckets: number;
  height: number;
  luminanceRange: number;
  opaquePixels: number;
  width: number;
}

interface ScreenshotBuffer {
  byteLength: number;
  toString(encoding: "base64"): string;
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const fixtureFile = require.resolve("../fixtures/architecture-large.json");

function architectureFixture(): ArchitectureDocument {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ArchitectureDocument;
}

function sessionFixture(revision: string): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: "architecture-visual-review",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "architecture-visual-review",
      message: "Keep shared topology stable across Current and Proposed.",
      annotations: [],
      choices: [],
      screen: { id: "architecture", file: "workspace.json", revision },
    }],
  };
}

async function openArchitectureCanvas(
  page: Page,
  testInfo: TestInfo,
  screen = architectureFixture(),
): Promise<ArchitectureDocument> {
  const html = buildStandaloneHtml(screen, sessionFixture(screen.revision));
  const file = testInfo.outputPath("architecture-visual.html");
  fs.writeFileSync(file, html);
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  await expect(page.locator('[data-workspace-kind="architecture"]')).toBeVisible();
  return screen;
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

async function nodeGeometry(viewport: Locator): Promise<Map<string, Box>> {
  const values = await viewport.locator("[data-architecture-node][data-node-id]").evaluateAll(elements => (
    elements
      .filter(element => element instanceof HTMLElement && element.getClientRects().length > 0)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-node-id") ?? "",
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })
      .filter(value => value.id.length > 0)
  ));
  return new Map(values.map(value => [value.id, value.box]));
}

async function expectCompoundGeometry(canvas: Locator, screen: ArchitectureDocument): Promise<void> {
  const geometry = await canvas.evaluate(root => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      boundaries: Array.from(root.querySelectorAll<HTMLElement>(
        "[data-ownership-boundary][data-boundary-id]",
      )).map(element => ({
        id: element.dataset.boundaryId ?? "",
        parentId: element.dataset.parentBoundaryId ?? null,
        box: box(element),
      })),
      nodes: Array.from(root.querySelectorAll<HTMLElement>(
        "[data-architecture-node][data-node-id][data-owner-id]",
      )).filter(element => element.getClientRects().length > 0).map(element => ({
        id: element.dataset.nodeId ?? "",
        ownerId: element.dataset.ownerId ?? "",
        box: box(element),
      })),
    };
  });

  expect(geometry.boundaries).toHaveLength(screen.content.ownership_boundaries.length);
  const boundaries = new Map(geometry.boundaries.map(boundary => [boundary.id, boundary]));
  for (const node of geometry.nodes) {
    const owner = boundaries.get(node.ownerId);
    expect(owner, `${node.id} must resolve ownership boundary ${node.ownerId}`).toBeDefined();
    if (!owner) continue;
    expect(node.box.x).toBeGreaterThanOrEqual(owner.box.x - 1);
    expect(node.box.y).toBeGreaterThanOrEqual(owner.box.y - 1);
    expect(node.box.x + node.box.width).toBeLessThanOrEqual(owner.box.x + owner.box.width + 1);
    expect(node.box.y + node.box.height).toBeLessThanOrEqual(owner.box.y + owner.box.height + 1);
  }
  for (const boundary of geometry.boundaries) {
    if (!boundary.parentId) continue;
    const parent = boundaries.get(boundary.parentId);
    expect(parent, `${boundary.id} must resolve parent boundary ${boundary.parentId}`).toBeDefined();
    if (!parent) continue;
    expect(boundary.box.x).toBeGreaterThanOrEqual(parent.box.x - 1);
    expect(boundary.box.y).toBeGreaterThanOrEqual(parent.box.y - 1);
    expect(boundary.box.x + boundary.box.width).toBeLessThanOrEqual(
      parent.box.x + parent.box.width + 1,
    );
    expect(boundary.box.y + boundary.box.height).toBeLessThanOrEqual(
      parent.box.y + parent.box.height + 1,
    );
  }

  const boxes = geometry.nodes.map(node => node.box);
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(overlapArea(boxes[left]!, boxes[right]!), `nodes ${left + 1}/${right + 1} overlap`)
        .toBeLessThanOrEqual(1);
    }
  }
}

async function expectRoutedEdges(viewport: Locator, expectedCount: number): Promise<void> {
  const routes = await viewport.locator("[data-architecture-edge][data-edge-id]").evaluateAll(elements => (
    elements
      .filter(element => element.getClientRects().length > 0)
      .map(element => {
        const path = element instanceof SVGPathElement
          ? element
          : element.querySelector<SVGPathElement>("path");
        return {
          id: element.getAttribute("data-edge-id") ?? "",
          length: path?.getTotalLength() ?? 0,
          path: path?.getAttribute("d") ?? "",
          routePoints: Number(element.getAttribute("data-route-points") ?? "0"),
        };
      })
  ));
  expect(routes).toHaveLength(expectedCount);
  expect(routes.every(route => route.id.length > 0 && route.length > 4 && route.path.length > 4)).toBe(true);
  expect(routes.every(route => route.routePoints >= 2)).toBe(true);
  expect(routes.some(route => route.routePoints >= 3)).toBe(true);
}

async function expectCanvasPixelEvidence(
  page: Page,
  viewport: Locator,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshot = await viewport.screenshot({
    animations: "disabled",
    caret: "hide",
    path: testInfo.outputPath(name),
  }) as unknown as ScreenshotBuffer;
  expect(screenshot.byteLength, `${name} must not be a blank encoded surface`).toBeGreaterThan(8_000);
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
      height: canvas.height,
      luminanceRange: maximumLuminance - minimumLuminance,
      opaquePixels,
      width: canvas.width,
    };
  }, screenshot.toString("base64"));
  expect(stats.width * stats.height).toBeGreaterThan(20_000);
  expect(stats.opaquePixels).toBeGreaterThan(10_000);
  expect(stats.colorBuckets).toBeGreaterThan(12);
  expect(stats.luminanceRange).toBeGreaterThan(40);
}

async function expectControlsReachable(page: Page, root: Locator): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const controls = root.locator("button:not([disabled]), select, [role='tab'][tabindex='0']");
  expect(await controls.count()).toBeGreaterThan(0);
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box, `Architecture control ${index + 1} must have geometry`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  }
}

test("architecture canvas visual keeps compound ELK geometry and routed edges stable across exclusive modes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const screen = await openArchitectureCanvas(page, testInfo);

  const canvas = page.locator(
    '[data-architecture-canvas][data-layout-engine="elk"][data-layout-status="ready"]',
  );
  const initialMode = screen.content.initial_mode;
  const alternateMode = initialMode === "current" ? "proposed" : "current";
  const viewport = canvas.locator("[data-architecture-viewport]");
  await expect(canvas).toBeVisible();
  await expect(viewport).toBeVisible();
  await expect(viewport).toHaveAttribute("data-mode", initialMode);
  await expect(canvas.locator("[data-camera-controls]")).toBeVisible();
  await expect(canvas.locator("[data-architecture-minimap]")).toBeVisible();
  const scenarioPaths = canvas.locator("[data-scenario-path] .architecture-edge-path");
  expect(await scenarioPaths.count()).toBeGreaterThan(0);
  expect(await scenarioPaths.evaluateAll(paths => paths.every(path => (
    path instanceof SVGGeometryElement
    && path.getTotalLength() > 4
    && getComputedStyle(path).stroke !== "none"
  )))).toBe(true);
  const scenarioLabel = canvas.locator(".architecture-scenario > span");
  expect(await scenarioLabel.evaluate(element => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.25;
  })).toBe(true);
  const show = page.getByRole("combobox", { name: "Show" });
  await expect(show).toBeVisible();
  await show.selectOption({ label: "All Components" });
  await expect(canvas).toHaveAttribute("data-layout-status", "ready");

  const initialNodeCount = screen.content.nodes.filter(node => node.modes.includes(initialMode)).length;
  const initialEdgeCount = screen.content.edges.filter(edge => edge.modes.includes(initialMode)).length;
  await expect(viewport.locator("[data-architecture-node][data-node-type]")).toHaveCount(initialNodeCount);
  await expectRoutedEdges(viewport, initialEdgeCount);
  await expectCompoundGeometry(canvas, screen);

  const initialGeometry = await nodeGeometry(viewport);
  await page.getByRole("tablist", { name: "Architecture state" })
    .getByRole("tab", { name: alternateMode === "current" ? "Current" : "Proposed", exact: true })
    .click();
  await expect(viewport).toHaveAttribute("data-mode", alternateMode);
  const alternateGeometry = await nodeGeometry(viewport);
  const sharedIds = screen.content.nodes
    .filter(node => node.modes.includes("current") && node.modes.includes("proposed"))
    .map(node => node.id);
  expect(sharedIds.length).toBeGreaterThan(0);
  for (const id of sharedIds) {
    const initial = initialGeometry.get(id);
    const alternate = alternateGeometry.get(id);
    expect(initial, `${id} needs ${initialMode} geometry`).toBeDefined();
    expect(alternate, `${id} needs ${alternateMode} geometry`).toBeDefined();
    if (!initial || !alternate) continue;
    expect(Math.abs(initial.x - alternate.x), `${id} moved horizontally`).toBeLessThanOrEqual(1);
    expect(Math.abs(initial.y - alternate.y), `${id} moved vertically`).toBeLessThanOrEqual(1);
  }

  await expectControlsReachable(page, canvas);
  await expectCanvasPixelEvidence(page, viewport, testInfo, "architecture-canvas-desktop.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("architecture toolbar keeps labels readable beside long scenario names", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const screen = architectureFixture();
  screen.content.scenarios[0]!.label = "Response-driven UI (the gap -> target)";
  await openArchitectureCanvas(page, testInfo, screen);

  const scenarioLabel = page.locator(".architecture-scenario > span");
  expect(await scenarioLabel.evaluate(element => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.25;
  })).toBe(true);
});

test("architecture canvas visual keeps the graph and external controls reachable at mobile width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openArchitectureCanvas(page, testInfo);

  const canvas = page.locator(
    '[data-architecture-canvas][data-layout-engine="elk"][data-layout-status="ready"]',
  );
  const viewport = canvas.locator("[data-architecture-viewport]");
  await expect(canvas).toBeVisible();
  await expect(viewport).toBeVisible();
  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(viewportBox!.x).toBeGreaterThanOrEqual(-1);
  expect(viewportBox!.x + viewportBox!.width).toBeLessThanOrEqual(391);
  expect(viewportBox!.width).toBeGreaterThan(280);
  expect(viewportBox!.height).toBeGreaterThan(320);
  await expect(canvas.locator("[data-camera-controls]")).toBeVisible();
  await expect(canvas.locator("[data-architecture-inspector]")).toBeVisible();
  await expectControlsReachable(page, canvas);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expectCanvasPixelEvidence(page, viewport, testInfo, "architecture-canvas-mobile.png");
  expect(pageErrors).toEqual([]);
});
