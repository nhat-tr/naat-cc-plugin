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
  label: string;
  modes: ArchitectureMode[];
  ports: Array<{ direction: "input" | "output" }>;
}

interface ArchitectureEdgeFixture {
  id: string;
  modes: ArchitectureMode[];
  source: { node_id: string };
  target: { node_id: string };
}

interface ArchitectureScenarioFixture {
  id: string;
  paths: Record<ArchitectureMode, {
    edge_ids: string[];
    node_ids: string[];
  }>;
}

interface ArchitectureDocumentFixture extends Record<string, unknown> {
  components: Array<{ frame_id: string; id: string; label: string }>;
  content: {
    nodes: ArchitectureNodeFixture[];
    edges: ArchitectureEdgeFixture[];
    ownership_boundaries: Array<{ id: string }>;
    scenarios: ArchitectureScenarioFixture[];
    annotation_targets: string[];
  };
  decisions: Array<{
    id: string;
    multiselect: boolean;
    option_component_ids: string[];
    title: string;
  }>;
  frames: Array<{ component_ids: string[]; id: string; title: string }>;
  revision?: string;
}

interface ArchitectureServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
  store: {
    snapshot(): {
      events: Array<{
        type?: string;
        choices?: Array<{
          componentId?: string;
          groupId?: string;
          label?: string;
          value?: string;
        }>;
      }>;
    };
  };
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

interface GraphGeometry {
  centers: Record<string, { x: number; y: number }>;
  diagonal: number;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { createBrainstormServer } = require("../scripts/server.cjs") as ArchitectureServerFactory;
const { normalizeKnownWorkspaceContent } = require("../scripts/workspace-content.cjs") as {
  normalizeKnownWorkspaceContent(content: unknown, context: unknown): Record<string, unknown>;
};
const { normalizeWorkspaceDocument } = require("../scripts/workspace-document.cjs") as {
  normalizeWorkspaceDocument(
    value: unknown,
    options: { contentValidator: typeof normalizeKnownWorkspaceContent },
  ): ArchitectureDocumentFixture;
};
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

async function graphIds(page: Page): Promise<{ edges: string[]; nodes: string[] }> {
  const viewport = page.locator("[data-architecture-viewport]");
  const [nodes, edges] = await Promise.all([
    viewport.locator("[data-architecture-node][data-node-id]").evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-node-id") ?? "").filter(Boolean).sort()
    )),
    viewport.locator("[data-architecture-edge][data-edge-id]").evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-edge-id") ?? "").filter(Boolean).sort()
    )),
  ]);
  return { edges, nodes };
}

async function graphGeometry(page: Page): Promise<GraphGeometry> {
  return page.locator("[data-architecture-viewport]").evaluate(root => {
    const flowRoot = root.querySelector<HTMLElement>(".react-flow");
    const flowViewport = root.querySelector<HTMLElement>(".react-flow__viewport");
    if (!flowRoot || !flowViewport) throw new Error("React Flow geometry is unavailable");

    const flowBox = flowRoot.getBoundingClientRect();
    const transform = getComputedStyle(flowViewport).transform;
    const inverse = (transform === "none"
      ? new DOMMatrixReadOnly()
      : new DOMMatrixReadOnly(transform)).inverse();
    const centers: Record<string, { x: number; y: number }> = {};
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const node of root.querySelectorAll<HTMLElement>("[data-architecture-node][data-node-id]")) {
      const id = node.dataset.nodeId;
      if (!id) continue;
      const box = node.getBoundingClientRect();
      const topLeft = new DOMPoint(box.left - flowBox.left, box.top - flowBox.top).matrixTransform(inverse);
      const bottomRight = new DOMPoint(box.right - flowBox.left, box.bottom - flowBox.top).matrixTransform(inverse);
      centers[id] = {
        x: (topLeft.x + bottomRight.x) / 2,
        y: (topLeft.y + bottomRight.y) / 2,
      };
      minX = Math.min(minX, topLeft.x);
      minY = Math.min(minY, topLeft.y);
      maxX = Math.max(maxX, bottomRight.x);
      maxY = Math.max(maxY, bottomRight.y);
    }

    if (!Object.keys(centers).length) throw new Error("Architecture graph contains no nodes");
    return {
      centers,
      diagonal: Math.hypot(maxX - minX, maxY - minY),
    };
  });
}

async function feedbackOptionIds(page: Page): Promise<string[]> {
  return page.locator("#feedback-target option").evaluateAll(options => (
    options.map(option => (option as HTMLOptionElement).value).sort()
  ));
}

async function presentedArchitectureComponentIds(
  page: Page,
  annotationTargets: string[],
): Promise<string[]> {
  return page.locator("[data-architecture-canvas] [data-brainstorm-id]").evaluateAll(
    (elements, permittedIds) => {
      const permitted = new Set(permittedIds);
      const presented = new Set<string>();
      for (const element of elements) {
        const id = element.getAttribute("data-brainstorm-id");
        if (!id || !permitted.has(id) || element.closest("[hidden]")) continue;
        const style = getComputedStyle(element);
        if (style.display !== "none" && style.visibility !== "hidden") presented.add(id);
      }
      return [...presented].sort();
    },
    annotationTargets,
  );
}

async function expectFeedbackMatchesPresentedScope(
  page: Page,
  annotationTargets: string[],
  state: string,
): Promise<void> {
  const expected = await presentedArchitectureComponentIds(page, annotationTargets);
  await expect.poll(
    () => feedbackOptionIds(page),
    { message: `${state}: Feedback Components must equal presented filtered Components` },
  ).toEqual(expected);
}

async function selectShowScope(page: Page, label: string): Promise<void> {
  const show = page.getByRole("combobox", { name: "Show" });
  await expect(show).toBeVisible();
  await show.selectOption({ label });
  await expect(page.locator("[data-architecture-canvas]")).toHaveAttribute("data-layout-status", "ready");
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
  await selectShowScope(page, "All Components");
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

test("architecture canvas fullscreen toggle maximizes only the graph viewport and restores it", async ({ page }) => {
  const canvas = page.locator("[data-architecture-canvas]");
  const viewport = page.locator("[data-architecture-viewport]");
  const toggle = viewport.locator("[data-architecture-fullscreen]");
  await expect(canvas).toHaveAttribute("data-layout-status", "ready");

  // Exercise the CSS-overlay fallback deterministically: headless Chromium's native
  // Fullscreen API is flaky, and the toggle falls back to the [data-fullscreen] maximize
  // whenever requestFullscreen is unavailable (for example inside a sandboxed iframe).
  await page.evaluate(() => {
    delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });

  await expect(viewport).not.toHaveAttribute("data-fullscreen", "");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  // Only the viewport is maximized; the surrounding canvas chrome is not.
  await expect(viewport).toHaveAttribute("data-fullscreen", "");
  await expect(canvas).not.toHaveAttribute("data-fullscreen", "");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("title", "Exit fullscreen");
  expect(await viewport.evaluate(element => getComputedStyle(element).position)).toBe("fixed");
  expect(await canvas.evaluate(element => getComputedStyle(element).position)).not.toBe("fixed");

  await page.keyboard.press("Escape");
  await expect(viewport).not.toHaveAttribute("data-fullscreen", "");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("title", "Fullscreen");
});

test("saving a standalone export confirms the written snapshot in the header", async ({ page }) => {
  const saveButton = page.getByRole("button", { name: "Save standalone export" });
  await expect(saveButton).toBeEnabled();
  const status = page.locator(".document-actions [data-save-status]");
  await expect(status).toHaveCount(0);

  // Clicking must visibly confirm the save — the defect was a silent success that made the
  // action look like a no-op.
  await saveButton.click();
  await expect(status).toHaveAttribute("data-save-status", "saved");
  await expect(status).toContainText(/Saved visual-\d+\.html/u);
});

test("architecture canvas renders envelope Decision Options and reports them as visible Feedback Components", async ({ page }) => {
  const candidate = architectureFixture();
  const options = [
    { id: "foreground-wait", frame_id: "topology", label: "Foreground Wait" },
    { id: "channel-delivery", frame_id: "topology", label: "Channel delivery" },
  ];
  delete candidate.revision;
  candidate.components.push(...options);
  candidate.frames[0]!.component_ids.push(...options.map(option => option.id));
  candidate.decisions.push({
    id: "feedback-receiver",
    title: "Choose the feedback receiver",
    multiselect: false,
    option_component_ids: options.map(option => option.id),
  });
  const document = normalizeWorkspaceDocument(candidate, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
  fs.writeFileSync(
    path.join(app!.contentDir, "workspace.json"),
    `${JSON.stringify(document)}\n`,
    { mode: 0o600 },
  );
  await page.getByLabel("Document status")
    .getByRole("button", { name: "Refresh Visual Session" })
    .click();

  await expect(page.getByRole("region", { name: "Decisions" })).toBeVisible();
  const foreground = page.getByRole("button", { name: "Foreground Wait", exact: true });
  const channel = page.getByRole("button", { name: "Channel delivery", exact: true });
  await expect(foreground).toBeVisible();
  await expect(channel).toBeVisible();
  await expect.poll(async () => (
    await presentedArchitectureComponentIds(page, candidate.content.annotation_targets)
  ).length).toBeGreaterThan(0);
  const presentedTopologyIds = await presentedArchitectureComponentIds(
    page,
    candidate.content.annotation_targets,
  );
  await expect.poll(() => feedbackOptionIds(page)).toEqual([
    ...new Set([...presentedTopologyIds, ...options.map(option => option.id)]),
  ].sort());

  await channel.click();
  await expect(channel).toHaveAttribute("aria-pressed", "true");
  await expect(foreground).toHaveAttribute("aria-pressed", "false");
});

test("architecture canvas presents a Decision-only Frame without repeating the topology", async ({ page }) => {
  const candidate = architectureFixture();
  const options = [
    { id: "tool-render", frame_id: "mechanism", label: "Tool-rendered component" },
    { id: "structured-output", frame_id: "mechanism", label: "Structured turn output" },
  ];
  delete candidate.revision;
  candidate.components.push(...options);
  candidate.frames.push({
    id: "mechanism",
    title: "Choose the response mechanism",
    component_ids: options.map(option => option.id),
  });
  candidate.decisions.push({
    id: "response-mechanism",
    title: "How should the response become a component?",
    multiselect: false,
    option_component_ids: options.map(option => option.id),
  });
  const document = normalizeWorkspaceDocument(candidate, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
  fs.writeFileSync(
    path.join(app!.contentDir, "workspace.json"),
    `${JSON.stringify(document)}\n`,
    { mode: 0o600 },
  );
  await page.getByLabel("Document status")
    .getByRole("button", { name: "Refresh Visual Session" })
    .click();
  await page.getByRole("tab", { name: "Choose the response mechanism" }).click();

  await expect(page.getByRole("region", { name: "Decisions" })).toBeVisible();
  await expect(page.locator("[data-architecture-canvas]")).toHaveCount(0);
  await expect.poll(() => feedbackOptionIds(page)).toEqual(
    options.map(option => option.id).sort(),
  );

  const structuredOutput = page.getByRole("button", { name: "Structured turn output", exact: true });
  await structuredOutput.click();
  await expect(structuredOutput).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Component", { exact: true })).toHaveValue("structured-output");
  await expect(structuredOutput).toHaveAttribute("data-annotation-selected", "true");
  await page.getByRole("button", { name: "Save feedback batch" }).click();
  await expect.poll(() => app?.store.snapshot().events.filter(event => event.type === "user.turn").length)
    .toBe(1);
  const feedback = app!.store.snapshot().events.find(event => event.type === "user.turn");
  expect(feedback?.choices).toEqual([{
    groupId: "response-mechanism",
    componentId: "structured-output",
    value: "structured-output",
    label: "Structured turn output",
  }]);
});

test("architecture canvas names its inspector complementary landmark", async ({ page }) => {
  await expect(page.getByRole("complementary", { name: "Architecture inspector" })).toBeVisible();
});

test("architecture canvas exposes one named graph application inside a named region", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Architecture topology viewport" })).toHaveCount(1);
  await expect(page.getByRole("application", { name: "Architecture topology graph" })).toHaveCount(1);
  await expect(page.getByRole("application")).toHaveCount(1);
});

test("architecture canvas defaults a large graph to a compact active Scenario Path scope", async ({ page }) => {
  const fixture = architectureFixture();
  const proposedPath = fixture.content.scenarios[0]!.paths.proposed;
  const show = page.getByRole("combobox", { name: "Show" });

  await expect(show).toBeVisible();
  await expect(show.locator("option")).toHaveCount(3);
  await expect(show.getByRole("option", { name: "All Components", exact: true })).toHaveCount(1);
  await expect(show.getByRole("option", { name: "Scenario Path", exact: true })).toHaveCount(1);
  await expect(show.getByRole("option", { name: "Selected Component", exact: true })).toHaveCount(1);
  await expect(show.locator("option:checked")).toHaveText("Scenario Path");
  await expect.poll(() => graphIds(page)).toEqual({
    edges: [...proposedPath.edge_ids].sort(),
    nodes: [...proposedPath.node_ids].sort(),
  });
  await expectFeedbackMatchesPresentedScope(page, fixture.content.annotation_targets, "Scenario Path scope");

  const scenarioGeometry = await graphGeometry(page);
  await selectShowScope(page, "All Components");
  await expect.poll(() => graphIds(page)).toEqual({
    edges: fixture.content.edges.filter(edge => edge.modes.includes("proposed")).map(edge => edge.id).sort(),
    nodes: fixture.content.nodes.filter(node => node.modes.includes("proposed")).map(node => node.id).sort(),
  });
  await expectFeedbackMatchesPresentedScope(page, fixture.content.annotation_targets, "All Components scope");

  const allGeometry = await graphGeometry(page);
  expect(
    scenarioGeometry.diagonal,
    "Scenario Path layout must use less than half the full graph span",
  ).toBeLessThan(allGeometry.diagonal * 0.5);

  const allDeliveryPosition = allGeometry.centers["delivery-core"]!;
  await selectShowScope(page, "Scenario Path");
  await expect(page.locator("[data-architecture-node][data-node-id]")).toHaveCount(proposedPath.node_ids.length);
  await selectShowScope(page, "All Components");
  await expect(page.locator("[data-architecture-node][data-node-id]"))
    .toHaveCount(activeCount(fixture.content.nodes, "proposed"));
  const restoredDeliveryPosition = (await graphGeometry(page)).centers["delivery-core"]!;
  expect(Math.abs(restoredDeliveryPosition.x - allDeliveryPosition.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restoredDeliveryPosition.y - allDeliveryPosition.y)).toBeLessThanOrEqual(1);
});

test("Selected Component scope presents the selected node and its direct one-hop graph", async ({ page }) => {
  const fixture = architectureFixture();
  const selectedId = "delivery-core";
  const incidentEdges = fixture.content.edges.filter(edge => (
    edge.modes.includes("proposed")
    && (edge.source.node_id === selectedId || edge.target.node_id === selectedId)
  ));
  const oneHopNodeIds = [...new Set([
    selectedId,
    ...incidentEdges.flatMap(edge => [edge.source.node_id, edge.target.node_id]),
  ])].sort();

  const selectedNode = page.locator(
    `[data-architecture-node][data-node-id="${selectedId}"]`,
  );
  await selectedNode.click();
  await expect(selectedNode).toHaveAttribute("data-focused", "true");
  await selectShowScope(page, "Selected Component");

  await expect.poll(() => graphIds(page)).toEqual({
    edges: incidentEdges.map(edge => edge.id).sort(),
    nodes: oneHopNodeIds,
  });
  await expectFeedbackMatchesPresentedScope(
    page,
    fixture.content.annotation_targets,
    "Selected Component scope",
  );
});

test("architecture canvas keeps one exclusive viewport and shared node positions stable across modes", async ({ page }) => {
  const fixture = architectureFixture();
  const stateTabs = page.getByRole("tablist", { name: "Architecture state" });
  const current = stateTabs.getByRole("tab", { name: "Current" });
  const proposed = stateTabs.getByRole("tab", { name: "Proposed" });
  const deliveryCore = page.locator('[data-brainstorm-id="delivery-core"][data-architecture-node]');

  await selectShowScope(page, "All Components");
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

test("architecture canvas renders a directed arrow marker for every visible edge", async ({ page }) => {
  const viewport = page.locator("[data-architecture-viewport]");
  const edgePaths = viewport.locator(".architecture-edge-path");

  await expect(edgePaths).not.toHaveCount(0);
  const markers = await edgePaths.evaluateAll(paths => (
    paths.map(pathElement => pathElement.getAttribute("marker-end") ?? "")
  ));
  expect(markers.every(marker => /^url\(/u.test(marker)), "visible edges must render directed arrow markers").toBe(true);
});

test("architecture canvas shows active Scenario Path Start and End in both modes", async ({ page }) => {
  const fixture = architectureFixture();
  const scenarioFixture = fixture.content.scenarios[0]!;
  const viewport = page.locator("[data-architecture-viewport]");
  const scenario = page.getByRole("combobox", { name: "Scenario" });

  const expectPathDirection = async (mode: ArchitectureMode): Promise<void> => {
    const path = scenarioFixture.paths[mode];
    const startId = path.node_ids[0]!;
    const endId = path.node_ids.at(-1)!;
    const startLabel = fixture.content.nodes.find(node => node.id === startId)?.label;
    const endLabel = fixture.content.nodes.find(node => node.id === endId)?.label;
    const start = viewport.locator(
      `[data-architecture-node][data-node-id="${startId}"][data-scenario-endpoint="start"]`,
    );
    const end = viewport.locator(
      `[data-architecture-node][data-node-id="${endId}"][data-scenario-endpoint="end"]`,
    );

    await expect(viewport.locator('[data-scenario-endpoint="start"]')).toHaveCount(1);
    await expect(viewport.locator('[data-scenario-endpoint="end"]')).toHaveCount(1);
    await expect(start).toContainText("Start");
    await expect(end).toContainText("End");
    const direction = page.getByRole("group", { name: "Scenario Path start and end" });
    await expect(direction.locator('[data-scenario-start-id]')).toHaveAttribute("data-scenario-start-id", startId);
    await expect(direction.locator('[data-scenario-end-id]')).toHaveAttribute("data-scenario-end-id", endId);
    await expect(direction.locator('[data-scenario-start-id]')).toContainText(`Start${startLabel}`);
    await expect(direction.locator('[data-scenario-end-id]')).toContainText(`End${endLabel}`);
  };

  await scenario.selectOption(scenarioFixture.id);
  await expectPathDirection("proposed");

  await page.getByRole("tablist", { name: "Architecture state" })
    .getByRole("tab", { name: "Current" })
    .click();
  await expect(viewport).toHaveAttribute("data-mode", "current");
  await expectPathDirection("current");
});

test("architecture camera controls remain one four-button row", async ({ page }) => {
  const controls = page.locator("[data-camera-controls]");

  await expect(controls.getByRole("button")).toHaveCount(4);
  // The fullscreen toggle lives on the viewport, not in the camera-controls toolbar.
  await expect(controls.locator("[data-architecture-fullscreen]")).toHaveCount(0);
  const columns = await controls.evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean)
  ));
  expect(columns).toHaveLength(4);
});

test("architecture viewport separator resizes the graph height accessibly and persists", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const viewport = page.locator("[data-architecture-viewport]");
  const flowRoot = viewport.locator(".react-flow");
  const separator = page.getByRole("separator", { name: "Architecture viewport height" });

  await expect(viewport).toHaveAttribute("data-mode", "proposed");
  await expect(flowRoot).toBeVisible();
  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-controls", "architecture-topology");
  await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  await expect(separator).toHaveAttribute("aria-valuemin", /^\d+$/u);
  await expect(separator).toHaveAttribute("aria-valuemax", /^\d+$/u);
  await expect(separator).toHaveAttribute("aria-valuenow", /^\d+$/u);
  await expect(separator).toHaveAttribute("aria-valuetext", /Architecture viewport .* high/iu);

  const beforeViewport = await requiredBox(viewport, "Architecture viewport before resizing");
  const beforeFlow = await requiredBox(flowRoot, "React Flow root before resizing");
  const beforeValue = Number(await separator.getAttribute("aria-valuenow"));
  await separator.focus();
  await expect(separator).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  const resizedViewport = await requiredBox(viewport, "Architecture viewport after resizing");
  const resizedFlow = await requiredBox(flowRoot, "React Flow root after resizing");
  const resizedValue = Number(await separator.getAttribute("aria-valuenow"));
  expect(resizedViewport.height).toBeGreaterThan(beforeViewport.height + 1);
  expect(resizedFlow.height).toBeGreaterThan(beforeFlow.height + 1);
  expect(Math.abs(
    (resizedViewport.height - beforeViewport.height) - (resizedFlow.height - beforeFlow.height),
  )).toBeLessThanOrEqual(1);
  expect(resizedValue).toBeGreaterThan(beforeValue);
  const persistedHeight = resizedViewport.height;

  await page.getByRole("tablist", { name: "Architecture state" })
    .getByRole("tab", { name: "Current" })
    .click();
  await expect(viewport).toHaveAttribute("data-mode", "current");
  const currentHeight = (await requiredBox(viewport, "Current Architecture viewport")).height;
  expect(Math.abs(currentHeight - persistedHeight)).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Agent feedback delivery architecture" })).toBeVisible();
  await expect(page.locator("[data-architecture-canvas]")).toHaveAttribute("data-layout-status", "ready");
  const reloadedHeight = (await requiredBox(viewport, "Reloaded Architecture viewport")).height;
  expect(Math.abs(reloadedHeight - persistedHeight)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(separator).toBeVisible();
  const mobileSeparator = await requiredBox(separator, "Mobile Architecture viewport separator");
  expect(mobileSeparator.x).toBeGreaterThanOrEqual(0);
  expect(mobileSeparator.x + mobileSeparator.width).toBeLessThanOrEqual(390);
  const mobileBefore = await requiredBox(viewport, "Mobile Architecture viewport before resizing");
  await separator.focus();
  await page.keyboard.press("ArrowUp");
  const mobileAfter = await requiredBox(viewport, "Mobile Architecture viewport after resizing");
  expect(mobileAfter.height).toBeLessThan(mobileBefore.height - 1);
  await expect(separator).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("architecture canvas supports scenario, camera, focus, and annotation workflows", async ({ page }) => {
  const canvas = page.locator("[data-architecture-canvas]");
  const deliveryCore = page.locator('[data-brainstorm-id="delivery-core"][data-architecture-node]');
  const scenario = page.getByRole("combobox", { name: "Scenario" });

  await scenario.selectOption("feedback-delivery");
  await expect(page.locator('[data-scenario-path][data-scenario-id="feedback-delivery"]')).not.toHaveCount(0);
  const scenarioEdge = page.locator(
    '[data-brainstorm-id="edge-004"][data-architecture-edge][data-scenario-path]',
  );
  await expect(scenarioEdge).toHaveCount(1);
  expect(await scenarioEdge.locator(".architecture-edge-path").evaluate(path => (
    (path as SVGPathElement).getTotalLength()
  ))).toBeGreaterThan(4);

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

  const componentSelect = page.getByLabel("Component", { exact: true });
  await deliveryCore.locator("strong").click();
  await expect(componentSelect).toHaveValue("delivery-core");
  await expect(deliveryCore).toHaveAttribute("data-annotation-selected", "true");
  await expect(deliveryCore).toHaveAttribute("data-focused", "true");
  const selectedNodeStyle = await deliveryCore.evaluate(element => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(selectedNodeStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(selectedNodeStyle.outlineWidth)).toBeGreaterThan(0);

  const targetedNote = page.getByLabel("Targeted note");
  await targetedNote.fill("Keep retry ownership explicit at this boundary.");
  await page.getByRole("button", { name: "Add targeted note" }).click();
  const pendingFeedback = page.getByLabel("Pending feedback");
  await expect(pendingFeedback).toHaveAttribute("aria-live", "polite");
  await expect(pendingFeedback).toHaveAttribute("aria-relevant", /additions/u);
  await expect(pendingFeedback).toContainText("Delivery core");
  await expect(targetedNote).toBeFocused();

  await scenarioEdge.locator(".architecture-edge-hit").click({ force: true });
  await expect(componentSelect).toHaveValue("edge-004");
  await expect(scenarioEdge).toHaveAttribute("data-annotation-selected", "true");
  await expect(deliveryCore).not.toHaveAttribute("data-annotation-selected", "true");
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
  await expect(page.getByLabel("Component", { exact: true })).toBeVisible();
});
