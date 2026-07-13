import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string, options?: { mode?: number }): void;
}

interface PathModule {
  join(...parts: string[]): string;
}

type ArchitectureMode = "current" | "proposed";

interface ArchitectureNodeFixture {
  id: string;
  modes: ArchitectureMode[];
  ports: Array<{ direction: "input" | "output" }>;
}

interface ArchitectureEdgeFixture {
  id: string;
  modes: ArchitectureMode[];
}

interface ArchitectureDocumentFixture extends Record<string, unknown> {
  content: {
    nodes: ArchitectureNodeFixture[];
    edges: ArchitectureEdgeFixture[];
    ownership_boundaries: Array<{ id: string }>;
  };
}

interface ArchitectureServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
}

interface ArchitectureServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): ArchitectureServer;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { createBrainstormServer } = require("../scripts/server.cjs") as ArchitectureServerFactory;
const fixtureFile = require.resolve("../fixtures/architecture-large.json");

let app: ArchitectureServer | undefined;

function architectureFixture(): ArchitectureDocumentFixture {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ArchitectureDocumentFixture;
}

function activeCount(values: Array<{ modes: ArchitectureMode[] }>, mode: ArchitectureMode): number {
  return values.filter(value => value.modes.includes(mode)).length;
}

async function openArchitectureCanvas(page: Page, testInfo: TestInfo): Promise<void> {
  app = createBrainstormServer({
    sessionDir: testInfo.outputPath("architecture-canvas-session"),
    host: "127.0.0.1",
    port: 0,
    token: "architecture-canvas-test-capability",
    sessionId: `architecture-canvas-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    path.join(app.contentDir, "workspace.json"),
    `${JSON.stringify(architectureFixture())}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(app.stateDir, "visual-format.json"),
    `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: "content/screen.json",
      v2_document: "content/workspace.json",
    })}\n`,
    { mode: 0o600 },
  );

  const address = await app.listen();
  await page.goto(address.connection_url);
  await expect(page.getByRole("heading", { name: "Agent feedback delivery architecture" })).toBeVisible();
}

async function requiredBox(locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} must have geometry`).not.toBeNull();
  return box!;
}

function expectSamePosition(before: Box, after: Box): void {
  expect(Math.abs(after.x - before.x), "shared node x must remain stable across modes").toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y), "shared node y must remain stable across modes").toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }, testInfo) => {
  await openArchitectureCanvas(page, testInfo);
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
});

test("architecture canvas renders typed large topology, ports, and nested ownership", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const fixture = architectureFixture();
  const canvas = page.locator("[data-architecture-canvas]");
  const viewport = page.locator('[data-architecture-viewport][data-mode="proposed"]');

  await expect(page.locator('[data-workspace-kind="architecture"]')).toBeVisible();
  await expect(canvas).toHaveAttribute("data-layout-engine", "elk");
  await expect(canvas).toHaveAttribute("data-layout-status", "ready");
  await expect(viewport).toHaveCount(1);
  await expect(viewport.locator("[data-architecture-node]"))
    .toHaveCount(activeCount(fixture.content.nodes, "proposed"));
  await expect(viewport.locator("[data-architecture-edge]"))
    .toHaveCount(activeCount(fixture.content.edges, "proposed"));
  await expect(viewport.locator("[data-architecture-port]"))
    .toHaveCount(activeCount(fixture.content.nodes, "proposed") * 2);
  await expect(viewport.locator("[data-ownership-boundary]"))
    .toHaveCount(fixture.content.ownership_boundaries.length);
  await expect(viewport.locator(
    ".react-flow__node[tabindex='0'], .react-flow__edge[tabindex='0']",
  )).toHaveCount(0);

  await expect(viewport.locator('[data-node-type="service"]')).not.toHaveCount(0);
  await expect(viewport.locator('[data-edge-type="command"]')).not.toHaveCount(0);
  await expect(viewport.locator('[data-port-direction="input"]')).not.toHaveCount(0);
  await expect(viewport.locator('[data-port-direction="output"]')).not.toHaveCount(0);
  await expect(viewport.locator('[data-brainstorm-id="delivery-core"][data-owner-id="boundary-delivery"]'))
    .toBeVisible();
  await expect(viewport.locator(
    '[data-boundary-id="boundary-delivery"][data-parent-boundary-id="boundary-runtime"]',
  )).toBeVisible();
});

test("architecture canvas names its inspector complementary landmark", async ({ page }) => {
  await expect(page.getByRole("complementary", { name: "Architecture inspector" })).toBeVisible();
});

test("architecture canvas exposes one named graph application inside a named region", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Architecture topology viewport" })).toHaveCount(1);
  await expect(page.getByRole("application", { name: "Architecture topology graph" })).toHaveCount(1);
  await expect(page.getByRole("application")).toHaveCount(1);
});

test("architecture canvas keeps one exclusive viewport and shared node positions stable across modes", async ({ page }) => {
  const fixture = architectureFixture();
  const stateTabs = page.getByRole("tablist", { name: "Architecture state" });
  const current = stateTabs.getByRole("tab", { name: "Current" });
  const proposed = stateTabs.getByRole("tab", { name: "Proposed" });
  const deliveryCore = page.locator('[data-brainstorm-id="delivery-core"][data-architecture-node]');

  await expect(proposed).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-architecture-viewport]:visible")).toHaveCount(1);
  await expect(page.locator('[data-brainstorm-id="codex-idle-worker"][data-architecture-node]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="legacy-poll-worker"][data-architecture-node]')).toHaveCount(0);
  const proposedPosition = await requiredBox(deliveryCore, "Delivery core in Proposed");

  await current.click();
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-architecture-viewport][data-mode="current"]')).toHaveCount(1);
  await expect(page.locator("[data-architecture-viewport]:visible")).toHaveCount(1);
  await expect(page.locator("[data-architecture-node]"))
    .toHaveCount(activeCount(fixture.content.nodes, "current"));
  await expect(page.locator('[data-brainstorm-id="legacy-poll-worker"][data-architecture-node]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="codex-idle-worker"][data-architecture-node]')).toHaveCount(0);
  const currentPosition = await requiredBox(deliveryCore, "Delivery core in Current");
  expectSamePosition(proposedPosition, currentPosition);

  await proposed.click();
  const restoredPosition = await requiredBox(deliveryCore, "Delivery core after returning to Proposed");
  expectSamePosition(proposedPosition, restoredPosition);
});

test("architecture canvas supports scenario, camera, focus, and annotation workflows", async ({ page }) => {
  const canvas = page.locator("[data-architecture-canvas]");
  const deliveryCore = page.locator('[data-brainstorm-id="delivery-core"][data-architecture-node]');
  const scenario = page.getByRole("combobox", { name: "Scenario" });

  await scenario.selectOption("feedback-delivery");
  await expect(page.locator('[data-scenario-path][data-scenario-id="feedback-delivery"]')).not.toHaveCount(0);
  await expect(page.locator(
    '[data-brainstorm-id="edge-004"][data-architecture-edge][data-scenario-path]',
  )).toBeVisible();

  const controls = page.locator("[data-camera-controls]");
  const initialNode = await requiredBox(deliveryCore, "Delivery core before zoom");
  await controls.getByRole("button", { name: "Zoom in" }).click();
  const zoomedNode = await requiredBox(deliveryCore, "Delivery core after zoom");
  expect(zoomedNode.width).toBeGreaterThan(initialNode.width);
  await controls.getByRole("button", { name: "Zoom out" }).click();
  await controls.getByRole("button", { name: "Fit view" }).click();
  await expect(page.locator("[data-architecture-minimap]")).toBeVisible();

  const canvasBox = await requiredBox(canvas, "Architecture canvas");
  const beforePan = await requiredBox(deliveryCore, "Delivery core before pan");
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 48, canvasBox.y + canvasBox.height / 2 + 24);
  await page.mouse.up();
  const afterPan = await requiredBox(deliveryCore, "Delivery core after pan");
  expect(Math.abs(afterPan.x - beforePan.x) + Math.abs(afterPan.y - beforePan.y)).toBeGreaterThan(20);
  await controls.getByRole("button", { name: "Fit view" }).click();

  await page.getByRole("button", { name: "Focus Delivery core" }).click();
  await expect(deliveryCore).toHaveAttribute("data-focused", "true");
  await expect(page.locator("[data-architecture-inspector]")).toContainText("Delivery core");

  await page.getByLabel("Component").selectOption("delivery-core");
  const targetedNote = page.getByLabel("Targeted note");
  await targetedNote.fill("Keep retry ownership explicit at this boundary.");
  await page.getByRole("button", { name: "Add targeted note" }).click();
  const pendingFeedback = page.getByLabel("Pending feedback");
  await expect(pendingFeedback).toHaveAttribute("aria-live", "polite");
  await expect(pendingFeedback).toHaveAttribute("aria-relevant", /additions/u);
  await expect(pendingFeedback).toContainText("Delivery core");
  await expect(targetedNote).toBeFocused();

  await page.getByLabel("Component").selectOption("edge-004");
  await targetedNote.fill("Show the App Server protocol on this edge.");
  await page.getByRole("button", { name: "Add targeted note" }).click();
  await expect(targetedNote).toBeFocused();
  await expect(page.getByLabel("Pending feedback")).toContainText("command edge-004");
});

test("architecture canvas keeps mode, focus, annotation, and camera controls keyboard and mobile usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  const proposed = page.getByRole("tab", { name: "Proposed" });
  const current = page.getByRole("tab", { name: "Current" });
  await proposed.focus();
  await expect(proposed).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(current).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(proposed).toHaveAttribute("aria-selected", "true");

  const graphViewport = page.getByRole("region", { name: "Architecture topology viewport" });
  await graphViewport.focus();
  await expect(graphViewport).toBeFocused();
  await page.keyboard.press("+");
  await page.keyboard.press("-");

  const focusDelivery = page.getByRole("button", { name: "Focus Delivery core" });
  await focusDelivery.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-brainstorm-id="delivery-core"][data-focused="true"]')).toBeVisible();

  const geometry = await page.evaluate(() => ({
    innerWidth: globalThis.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth + 1);

  const controls = await requiredBox(page.locator("[data-camera-controls]"), "mobile camera controls");
  expect(controls.x).toBeGreaterThanOrEqual(0);
  expect(controls.x + controls.width).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("Component")).toBeVisible();
});
