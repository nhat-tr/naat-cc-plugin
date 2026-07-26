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

interface UmlServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
}

interface UmlServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): UmlServer;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LabelBox extends Box {
  edgeId: string;
  text: string;
}

interface ArrowBox extends Box {
  edgeId: string;
}

interface NodeBox extends Box {
  nodeId: string;
}

interface ClippedCard {
  nodeId: string;
  clientHeight: number;
  scrollHeight: number;
  clientWidth: number;
  scrollWidth: number;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { createBrainstormServer } = require("../scripts/server.cjs") as UmlServerFactory;
const fixtureFile = require.resolve("../fixtures/uml-component.json");

const FIXTURE_EDGE_COUNT = 4;

let app: UmlServer | undefined;

function overlap(left: Box, right: Box): { x: number; y: number } {
  return {
    x: Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
    y: Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  };
}

function overlaps(left: Box, right: Box, tolerance = 1): boolean {
  const area = overlap(left, right);
  return area.x > tolerance && area.y > tolerance;
}

async function requiredBox(locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} must be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} must have geometry`).not.toBeNull();
  return box!;
}

function expectSamePosition(before: Box, after: Box): void {
  expect(Math.abs(after.x - before.x), "the reference card must not move").toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y), "the reference card must not move").toBeLessThanOrEqual(1);
}

function distanceToBox(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

async function openUmlComponentDiagram(page: Page, testInfo: TestInfo): Promise<void> {
  app = createBrainstormServer({
    sessionDir: testInfo.outputPath("uml-diagram-session"),
    host: "127.0.0.1",
    port: 0,
    token: "uml-diagram-test-capability",
    sessionId: `uml-diagram-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    path.join(app.contentDir, "workspace.json"),
    fs.readFileSync(fixtureFile, "utf8"),
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
  await expect(page.locator("[data-uml-viewport]")).toHaveAttribute("data-layout-status", "ready");
  await expect(page.locator(".uml-node").first()).toBeVisible();
  await settleCanvas(page);
}

// The first fitView lands one animation frame after the layout resolves, so anything measured
// before the camera stops moving is measured at a zoom that is about to change.
async function settleCanvas(page: Page): Promise<void> {
  await expect(viewport(page).locator(".uml-edge-path")).toHaveCount(FIXTURE_EDGE_COUNT);
  await expect(viewport(page).locator(".uml-arrow")).toHaveCount(FIXTURE_EDGE_COUNT);
  await page.waitForFunction(() => new Promise<boolean>(resolve => {
    const read = (): string => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
    const first = read();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(first !== "" && read() === first)));
  }));
}

function viewport(page: Page): Locator {
  return page.locator("[data-uml-viewport]");
}

async function nodeBoxes(page: Page): Promise<NodeBox[]> {
  return viewport(page).locator(".uml-node[data-node-id]").evaluateAll(elements => (
    elements.map(element => {
      const box = element.getBoundingClientRect();
      return {
        nodeId: element.getAttribute("data-node-id") ?? "",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    })
  ));
}

async function labelBoxes(page: Page): Promise<LabelBox[]> {
  return viewport(page).locator(".uml-edge-label").evaluateAll(elements => (
    elements.map(element => {
      const rect = element.querySelector("rect");
      const box = (rect ?? element).getBoundingClientRect();
      return {
        edgeId: element.closest("[data-edge-id]")?.getAttribute("data-edge-id") ?? "",
        text: element.textContent ?? "",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    })
  ));
}

async function arrowBoxes(page: Page): Promise<ArrowBox[]> {
  return viewport(page).locator(".uml-arrow").evaluateAll(elements => (
    elements.map(element => {
      const box = element.getBoundingClientRect();
      return {
        edgeId: element.closest("[data-edge-id]")?.getAttribute("data-edge-id") ?? "",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    })
  ));
}

async function clippedCards(page: Page): Promise<ClippedCard[]> {
  return viewport(page).locator(".uml-node[data-node-id] .uml-node-body").evaluateAll(elements => (
    elements
      .map(element => ({
        nodeId: element.closest("[data-node-id]")?.getAttribute("data-node-id") ?? "",
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      .filter(card => (
        card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1
      ))
  ));
}

async function spillingLabels(page: Page): Promise<string[]> {
  return viewport(page).locator(".uml-edge-label").evaluateAll(elements => (
    elements.flatMap(element => {
      const rect = element.querySelector("rect");
      const text = element.querySelector("text");
      if (!rect || !text) return [];
      const rectBox = rect.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      if (textBox.width <= rectBox.width + 1 && textBox.height <= rectBox.height + 1) return [];
      return [`"${text.textContent ?? ""}" text ${Math.round(textBox.width)}x${Math.round(textBox.height)}px spills its ${Math.round(rectBox.width)}x${Math.round(rectBox.height)}px background`];
    })
  ));
}

async function edgeCountsDuringDrag(
  page: Page,
  card: Locator,
  delta: { x: number; y: number },
): Promise<number[]> {
  await page.evaluate(() => {
    const sampler = globalThis as unknown as { __edgeSamples?: number[]; __raf?: number };
    sampler.__edgeSamples = [];
    const tick = (): void => {
      sampler.__edgeSamples?.push(document.querySelectorAll(".uml-edge-path").length);
      sampler.__raf = requestAnimationFrame(tick);
    };
    sampler.__raf = requestAnimationFrame(tick);
  });
  const box = await requiredBox(card, "card sampled during the drag");
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box.x + box.width / 2 + (delta.x * step) / 8, box.y + 10 + (delta.y * step) / 8);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  return page.evaluate(() => {
    const sampler = globalThis as unknown as { __edgeSamples: number[]; __raf: number };
    cancelAnimationFrame(sampler.__raf);
    return sampler.__edgeSamples;
  });
}

// Flow-space geometry: immune to the page scrolling when a toolbar button takes focus.
async function labelSlot(page: Page, edgeId: string): Promise<{ x: number; y: number }> {
  return viewport(page).locator(`[data-edge-label="${edgeId}"] rect`).evaluate(element => ({
    x: Number(element.getAttribute("x")),
    y: Number(element.getAttribute("y")),
  }));
}

async function selectedComponentIds(page: Page): Promise<string[]> {
  return page.locator('[data-annotation-selected="true"]').evaluateAll(elements => (
    elements.map(element => element.getAttribute("data-brainstorm-id") ?? "")
  ));
}

test.afterEach(async () => {
  await app?.close("uml diagram test complete");
  app = undefined;
});

test.describe("UML component diagram legibility", () => {
  test("keeps every edge label clear of the cards it connects", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const [labels, nodes] = await Promise.all([labelBoxes(page), nodeBoxes(page)]);
    expect(labels.length, "every labelled edge renders its label").toBe(FIXTURE_EDGE_COUNT);

    const collisions = labels.flatMap(label => nodes
      .filter(node => overlaps(label, node, 2))
      .map(node => {
        const area = overlap(label, node);
        return `"${label.text}" (${label.edgeId}) is covered by ${node.nodeId} by ${Math.round(area.x)}x${Math.round(area.y)}px`;
      }));
    expect(collisions, "edge labels must sit in reserved space, never under a card").toEqual([]);
  });

  test("renders one arrowhead per edge that no label covers", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const [arrows, labels] = await Promise.all([arrowBoxes(page), labelBoxes(page)]);
    expect(arrows.map(arrow => arrow.edgeId).sort(), "every edge draws its arrowhead").toEqual([
      "api-hosts-session",
      "choke-writes-artifacts",
      "pipeline-tool-calls",
      "session-builds-pipeline",
    ]);

    const hidden = arrows.flatMap(arrow => labels
      .filter(label => overlaps(arrow, label, 0))
      .map(label => `${arrow.edgeId} arrowhead is painted over by label "${label.text}"`));
    expect(hidden, "an edge label must never paint over an arrowhead").toEqual([]);
  });

  test("reserves enough card height to show every point in full", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const clipped = await clippedCards(page);
    expect(
      clipped.map(card => (
        `${card.nodeId} clips ${Math.max(card.scrollHeight - card.clientHeight, 0)}px vertically`
        + ` and ${Math.max(card.scrollWidth - card.clientWidth, 0)}px horizontally`
      )),
      "a card must reserve room for the text it renders",
    ).toEqual([]);

    expect(
      await spillingLabels(page),
      "an edge label's text must fit the background drawn behind it",
    ).toEqual([]);
  });

  test("lets a reviewer drag a card and keeps its edges attached", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const card = viewport(page).locator('.uml-node[data-node-id="tool-invocation-middleware"]');
    // Measured against a card nobody drags, so panning the canvas cannot pass this test.
    const anchor = viewport(page).locator('.uml-node[data-node-id="turn-pipeline"]');
    const before = await card.boundingBox();
    const anchorBefore = await anchor.boundingBox();
    expect(before, "dragged card must have geometry").not.toBeNull();
    expect(anchorBefore, "anchor card must have geometry").not.toBeNull();

    await page.mouse.move(before!.x + before!.width / 2, before!.y + 12);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2 + 90, before!.y + 12 + 120, { steps: 12 });
    await page.mouse.up();

    const after = await card.boundingBox();
    const anchorAfter = await anchor.boundingBox();
    expect(after, "dragged card must keep geometry").not.toBeNull();
    const shift = {
      x: (after!.x - anchorAfter!.x) - (before!.x - anchorBefore!.x),
      y: (after!.y - anchorAfter!.y) - (before!.y - anchorBefore!.y),
    };
    expect(Math.round(shift.x), "card moves relative to the cards around it").toBeGreaterThan(60);
    expect(Math.round(shift.y), "card moves relative to the cards around it").toBeGreaterThan(80);

    const arrows = await arrowBoxes(page);
    const incoming = arrows.find(arrow => arrow.edgeId === "pipeline-tool-calls");
    expect(incoming, "incoming edge keeps its arrowhead after the drag").toBeDefined();
    const tip = { x: incoming!.x + incoming!.width / 2, y: incoming!.y + incoming!.height / 2 };
    expect(
      Math.round(distanceToBox(tip, after!)),
      "the incoming edge re-routes to the card's new position",
    ).toBeLessThanOrEqual(24);

    const resetLayout = viewport(page).locator("[data-reset-layout]");
    await resetLayout.click();
    const restored = await card.boundingBox();
    const anchorRestored = await anchor.boundingBox();
    expect(
      Math.round((restored!.x - anchorRestored!.x) - (before!.x - anchorBefore!.x)),
      "reset layout puts the card back where the layout engine placed it",
    ).toBeLessThanOrEqual(1);
    await expect(resetLayout, "reset is only offered while a card sits off-layout").toBeDisabled();
  });
  test("keeps every edge on screen for the whole drag", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const card = viewport(page).locator('.uml-node[data-node-id="tool-invocation-middleware"]');
    const samples = await edgeCountsDuringDrag(page, card, { x: 70, y: 120 });

    expect(samples.length, "the drag must be sampled across several frames").toBeGreaterThan(10);
    // A frame that renders zero edges is the flicker: React Flow drops every edge whenever a
    // rebuilt node object arrives without `measured`, then restores them the next frame.
    expect(
      [...new Set(samples)].sort((left, right) => left - right),
      "the edge layer must never empty mid-drag",
    ).toEqual([FIXTURE_EDGE_COUNT]);
  });

  test("lets a reviewer drag a colliding edge label off the label it overlaps", async ({ page }, testInfo) => {
    await openUmlComponentDiagram(page, testInfo);

    const label = viewport(page).locator('[data-edge-label="pipeline-tool-calls"] rect');
    const anchorCard = viewport(page).locator('.uml-node[data-node-id="turn-pipeline"]');
    const before = await requiredBox(label, "edge label before the drag");
    const anchorBefore = await requiredBox(anchorCard, "anchor card before the drag");
    const slotBefore = await labelSlot(page, "pipeline-tool-calls");

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(before.x + before.width / 2 + step * 6, before.y + before.height / 2 - step * 9);
    }
    await page.mouse.up();

    const after = await requiredBox(label, "edge label after the drag");
    const anchorAfter = await requiredBox(anchorCard, "anchor card after the drag");
    expectSamePosition(anchorBefore, anchorAfter);
    expect(Math.round(after.x - before.x), "the label follows the pointer horizontally").toBe(48);
    expect(Math.round(after.y - before.y), "the label follows the pointer vertically").toBe(-72);
    await expect(
      viewport(page).locator('[data-edge-label="pipeline-tool-calls"] .uml-edge-label-leader'),
      "a nudged label keeps a leader line back to its edge",
    ).toHaveCount(1);
    expect(
      await selectedComponentIds(page),
      "dragging a label must not also pick it as the annotation target",
    ).toEqual([]);

    const resetLayout = viewport(page).locator("[data-reset-layout]");
    await resetLayout.click();
    expect(
      await labelSlot(page, "pipeline-tool-calls"),
      "restore returns the label to the slot the layout reserved",
    ).toEqual(slotBefore);

    // A plain click is still how a reviewer targets the relationship for feedback.
    const restored = await requiredBox(label, "edge label after restoring the layout");
    await page.mouse.click(restored.x + restored.width / 2, restored.y + restored.height / 2);
    expect(await selectedComponentIds(page), "clicking a label selects its edge").toEqual([
      "pipeline-tool-calls",
    ]);
  });
});
