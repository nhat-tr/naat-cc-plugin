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

interface PerformanceBudgets {
  architecture_route_quality: {
    all_components: RouteQualityBudget;
    fixture_revision: string;
    scenario_path: RouteQualityBudget;
  };
  host: {
    initial_render_ms: number;
    interaction_response_ms: number;
    max_dom_nodes: number;
    max_long_task_ms: number;
  };
  standalone_export: {
    generation_ms: number;
    max_bytes: number;
    open_to_interactive_ms: number;
  };
  stress_workload: {
    architecture_edges: number;
    architecture_nodes: number;
    changed_files: number;
  };
  version: number;
}

interface ArchitectureDocument extends Record<string, unknown> {
  content: {
    edges: Array<{
      id: string;
      modes: Array<"current" | "proposed">;
      source: { node_id: string; port_id: string };
      target: { node_id: string; port_id: string };
    }>;
    initial_mode: "current" | "proposed";
    layout: { engine: string };
    nodes: Array<Record<string, unknown>>;
  };
  revision: string;
  title: string;
}

interface TimedStandalone {
  generationMs: number;
  html: string;
  screen: ArchitectureDocument;
}

interface RouteQualityMetrics {
  coincidentRoutePairs: number;
  crossingEdgePairRatio: number;
  crossingEdgePairs: number;
  crossingSegmentPairs: number;
  edgeNodeIntrusions: number;
  emptyRoutes: number;
  nonOrthogonalSegments: number;
  overlappingEdgePairs: number;
  overlappingSegmentPairs: number;
  pairwiseSharedCollinearFactor: number;
  pairwiseSharedCollinearLength: number;
  routeCount: number;
  totalRouteLength: number;
  uniqueCrossingHotspots: number;
}

interface RouteQualityBudget {
  max_crossing_edge_pair_ratio: number;
  max_crossing_edge_pairs: number;
  max_overlapping_edge_pairs: number;
  max_pairwise_shared_collinear_factor: number;
  max_unique_crossing_hotspots: number;
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const fixtureFile = require.resolve("../fixtures/architecture-large.json");
const budgetFile = require.resolve("../fixtures/performance-budgets.json");

function budgets(): PerformanceBudgets {
  return JSON.parse(fs.readFileSync(budgetFile, "utf8")) as PerformanceBudgets;
}

function architectureFixture(): ArchitectureDocument {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ArchitectureDocument;
}

function standaloneFixture(): TimedStandalone {
  const screen = architectureFixture();
  const started = performance.now();
  const html = buildStandaloneHtml(screen, {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [],
  });
  return { generationMs: performance.now() - started, html, screen };
}

async function measureAttributeInteraction(
  trigger: Locator,
  targetSelector: string,
  attribute: string,
  expected: string,
  timeoutMs: number,
): Promise<number> {
  return trigger.evaluate((element, options) => new Promise<number>((resolve, reject) => {
    const target = document.querySelector(options.targetSelector);
    if (!target) {
      reject(new Error(`missing interaction target ${options.targetSelector}`));
      return;
    }
    const started = performance.now();
    let timeout = 0;
    const observer = new MutationObserver(() => {
      if (target.getAttribute(options.attribute) !== options.expected) return;
      clearTimeout(timeout);
      observer.disconnect();
      requestAnimationFrame(() => resolve(performance.now() - started));
    });
    observer.observe(target, { attributes: true, attributeFilter: [options.attribute] });
    timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(`${options.attribute} did not become ${options.expected}`));
    }, options.timeoutMs);
    (element as HTMLElement).click();
  }), { attribute, expected, targetSelector, timeoutMs });
}

async function measureTransformInteraction(trigger: Locator, timeoutMs: number): Promise<number> {
  return trigger.evaluate((element, timeout) => new Promise<number>((resolve, reject) => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) {
      reject(new Error("missing React Flow viewport"));
      return;
    }
    const before = viewport.style.transform;
    const started = performance.now();
    let timer = 0;
    const observer = new MutationObserver(() => {
      if (viewport.style.transform === before) return;
      clearTimeout(timer);
      observer.disconnect();
      requestAnimationFrame(() => resolve(performance.now() - started));
    });
    observer.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    timer = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error("camera transform did not change"));
    }, timeout);
    (element as HTMLElement).click();
  }), timeoutMs);
}

async function measureRouteQuality(
  viewport: Locator,
  edgeContracts: ArchitectureDocument["content"]["edges"],
): Promise<RouteQualityMetrics> {
  return viewport.evaluate((root, contracts) => {
    interface Point { x: number; y: number }
    interface Segment {
      edgeId: string;
      endpointKeys: string[];
      orientation: "horizontal" | "vertical" | "other";
      start: Point;
      end: Point;
    }
    interface Route {
      id: string;
      key: string;
      segments: Segment[];
    }

    const epsilon = 0.01;
    const contractById = new Map(contracts.map(contract => [contract.id, contract]));
    const edgeElements = Array.from(root.querySelectorAll<SVGGElement>(
      "[data-architecture-edge][data-edge-id]",
    ));
    const referencePath = edgeElements[0]?.querySelector<SVGPathElement>(
      ".architecture-edge-path",
    );
    const screenMatrix = referencePath?.getScreenCTM();
    if (!screenMatrix) throw new Error("route quality requires an SVG screen transform");
    const inverseMatrix = screenMatrix.inverse();
    const nodes = new Map(Array.from(root.querySelectorAll<HTMLElement>(
      "[data-architecture-node][data-node-id]",
    )).map(element => {
      const rect = element.getBoundingClientRect();
      const topLeft = new DOMPoint(rect.left, rect.top).matrixTransform(inverseMatrix);
      const bottomRight = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverseMatrix);
      return [element.dataset.nodeId ?? "", {
        left: Math.min(topLeft.x, bottomRight.x),
        right: Math.max(topLeft.x, bottomRight.x),
        top: Math.min(topLeft.y, bottomRight.y),
        bottom: Math.max(topLeft.y, bottomRight.y),
      }] as const;
    }));

    let nonOrthogonalSegments = 0;
    let totalRouteLength = 0;
    const routes: Route[] = edgeElements.map(element => {
      const id = element.dataset.edgeId ?? "";
      const path = element.querySelector<SVGPathElement>(".architecture-edge-path");
      const values = path?.getAttribute("d")?.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/giu)
        ?.map(Number) ?? [];
      const parsedPoints: Point[] = [];
      for (let index = 0; index + 1 < values.length; index += 2) {
        parsedPoints.push({ x: values[index]!, y: values[index + 1]! });
      }
      const points: Point[] = [];
      for (const point of parsedPoints) {
        const previous = points.at(-1);
        if (previous
          && Math.abs(previous.x - point.x) <= epsilon
          && Math.abs(previous.y - point.y) <= epsilon) continue;
        points.push(point);
        while (points.length >= 3) {
          const before = points.at(-3)!;
          const middle = points.at(-2)!;
          const after = points.at(-1)!;
          const collinear = (
            Math.abs(before.x - middle.x) <= epsilon
            && Math.abs(middle.x - after.x) <= epsilon
          ) || (
            Math.abs(before.y - middle.y) <= epsilon
            && Math.abs(middle.y - after.y) <= epsilon
          );
          if (!collinear) break;
          points.splice(points.length - 2, 1);
        }
      }
      const contract = contractById.get(id);
      const segments: Segment[] = [];
      for (let index = 0; index + 1 < points.length; index += 1) {
        const start = points[index]!;
        const end = points[index + 1]!;
        const horizontal = Math.abs(start.y - end.y) <= epsilon;
        const vertical = Math.abs(start.x - end.x) <= epsilon;
        const orientation = horizontal ? "horizontal" : vertical ? "vertical" : "other";
        if (orientation === "other") nonOrthogonalSegments += 1;
        totalRouteLength += Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
        const endpointKeys: string[] = [];
        if (index === 0 && contract) {
          endpointKeys.push(`source:${contract.source.node_id}:${contract.source.port_id}`);
        }
        if (index === points.length - 2 && contract) {
          endpointKeys.push(`target:${contract.target.node_id}:${contract.target.port_id}`);
        }
        segments.push({ edgeId: id, endpointKeys, orientation, start, end });
      }
      const forwardKey = points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(";");
      const reverseKey = [...points].reverse()
        .map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(";");
      const key = forwardKey < reverseKey ? forwardKey : reverseKey;
      return { id, key, segments };
    });

    const emptyRoutes = routes.filter(route => route.segments.length === 0).length;

    let edgeNodeIntrusions = 0;
    for (const route of routes) {
      const contract = contractById.get(route.id);
      if (!contract) continue;
      for (const segment of route.segments) {
        if (segment.orientation === "other") continue;
        for (const [nodeId, node] of nodes) {
          if (nodeId === contract.source.node_id || nodeId === contract.target.node_id) continue;
          const crosses = segment.orientation === "horizontal"
            ? segment.start.y > node.top + epsilon
              && segment.start.y < node.bottom - epsilon
              && Math.min(segment.start.x, segment.end.x) < node.right - epsilon
              && Math.max(segment.start.x, segment.end.x) > node.left + epsilon
            : segment.start.x > node.left + epsilon
              && segment.start.x < node.right - epsilon
              && Math.min(segment.start.y, segment.end.y) < node.bottom - epsilon
              && Math.max(segment.start.y, segment.end.y) > node.top + epsilon;
          if (crosses) edgeNodeIntrusions += 1;
        }
      }
    }

    let coincidentRoutePairs = 0;
    let crossingEdgePairs = 0;
    let crossingSegmentPairs = 0;
    let overlappingEdgePairs = 0;
    let overlappingSegmentPairs = 0;
    let pairwiseSharedCollinearLength = 0;
    const crossingHotspots = new Set<string>();
    for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
      const left = routes[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
        const right = routes[rightIndex]!;
        if (left.key.length > 0 && left.key === right.key) coincidentRoutePairs += 1;
        let edgePairCrosses = false;
        let edgePairOverlaps = false;
        for (const leftSegment of left.segments) {
          for (const rightSegment of right.segments) {
            if (leftSegment.orientation === "other" || rightSegment.orientation === "other") {
              continue;
            }
            if (leftSegment.orientation !== rightSegment.orientation) {
              const horizontal = leftSegment.orientation === "horizontal" ? leftSegment : rightSegment;
              const vertical = leftSegment.orientation === "vertical" ? leftSegment : rightSegment;
              const crossingX = vertical.start.x;
              const crossingY = horizontal.start.y;
              const crossesHorizontalInterior = crossingX > Math.min(horizontal.start.x, horizontal.end.x) + epsilon
                && crossingX < Math.max(horizontal.start.x, horizontal.end.x) - epsilon;
              const crossesVerticalInterior = crossingY > Math.min(vertical.start.y, vertical.end.y) + epsilon
                && crossingY < Math.max(vertical.start.y, vertical.end.y) - epsilon;
              if (crossesHorizontalInterior && crossesVerticalInterior) {
                crossingSegmentPairs += 1;
                edgePairCrosses = true;
                crossingHotspots.add(`${crossingX.toFixed(2)},${crossingY.toFixed(2)}`);
              }
              continue;
            }
            const sameEndpoint = leftSegment.endpointKeys.some(key => (
              rightSegment.endpointKeys.includes(key)
            ));
            if (sameEndpoint) continue;
            const sameAxis = leftSegment.orientation === "horizontal"
              ? Math.abs(leftSegment.start.y - rightSegment.start.y) <= epsilon
              : Math.abs(leftSegment.start.x - rightSegment.start.x) <= epsilon;
            if (!sameAxis) continue;
            const leftStart = leftSegment.orientation === "horizontal" ? leftSegment.start.x : leftSegment.start.y;
            const leftEnd = leftSegment.orientation === "horizontal" ? leftSegment.end.x : leftSegment.end.y;
            const rightStart = rightSegment.orientation === "horizontal" ? rightSegment.start.x : rightSegment.start.y;
            const rightEnd = rightSegment.orientation === "horizontal" ? rightSegment.end.x : rightSegment.end.y;
            const overlap = Math.min(Math.max(leftStart, leftEnd), Math.max(rightStart, rightEnd))
              - Math.max(Math.min(leftStart, leftEnd), Math.min(rightStart, rightEnd));
            if (overlap <= epsilon) continue;
            overlappingSegmentPairs += 1;
            pairwiseSharedCollinearLength += overlap;
            edgePairOverlaps = true;
          }
        }
        if (edgePairCrosses) crossingEdgePairs += 1;
        if (edgePairOverlaps) overlappingEdgePairs += 1;
      }
    }

    const possibleEdgePairs = routes.length * (routes.length - 1) / 2;

    return {
      coincidentRoutePairs,
      crossingEdgePairRatio: possibleEdgePairs > 0 ? crossingEdgePairs / possibleEdgePairs : 0,
      crossingEdgePairs,
      crossingSegmentPairs,
      edgeNodeIntrusions,
      emptyRoutes,
      nonOrthogonalSegments,
      overlappingEdgePairs,
      overlappingSegmentPairs,
      pairwiseSharedCollinearFactor: totalRouteLength > 0
        ? pairwiseSharedCollinearLength / totalRouteLength
        : 0,
      pairwiseSharedCollinearLength,
      routeCount: routes.length,
      totalRouteLength,
      uniqueCrossingHotspots: crossingHotspots.size,
    };
  }, edgeContracts);
}

function expectRouteQuality(
  actual: RouteQualityMetrics,
  budget: RouteQualityBudget,
): void {
  const evidence = JSON.stringify(actual);
  expect(actual.nonOrthogonalSegments, evidence).toBe(0);
  expect(actual.edgeNodeIntrusions, evidence).toBe(0);
  expect(actual.emptyRoutes, evidence).toBe(0);
  expect(actual.coincidentRoutePairs, evidence).toBe(0);
  expect(actual.crossingEdgePairs, evidence)
    .toBeLessThanOrEqual(budget.max_crossing_edge_pairs);
  expect(actual.crossingEdgePairRatio, evidence)
    .toBeLessThanOrEqual(budget.max_crossing_edge_pair_ratio);
  expect(actual.uniqueCrossingHotspots, evidence)
    .toBeLessThanOrEqual(budget.max_unique_crossing_hotspots);
  expect(actual.overlappingEdgePairs, evidence)
    .toBeLessThanOrEqual(budget.max_overlapping_edge_pairs);
  expect(actual.pairwiseSharedCollinearFactor, evidence)
    .toBeLessThanOrEqual(budget.max_pairwise_shared_collinear_factor);
}

test("architecture canvas large graph meets offline ELK layout, export, and interaction budgets", async ({ context, page }, testInfo: TestInfo) => {
  const limits = budgets();
  expect(limits.version).toBe(1);
  expect(limits.stress_workload.changed_files).toBe(300);

  const { generationMs, html, screen } = standaloneFixture();
  expect(screen.content.layout.engine).toBe("elk");
  expect(screen.revision).toBe(limits.architecture_route_quality.fixture_revision);
  expect(screen.content.nodes).toHaveLength(limits.stress_workload.architecture_nodes);
  expect(screen.content.edges).toHaveLength(limits.stress_workload.architecture_edges);
  for (const node of screen.content.nodes) {
    expect(node).not.toHaveProperty("x");
    expect(node).not.toHaveProperty("y");
    expect(node).not.toHaveProperty("position");
  }
  expect(generationMs).toBeLessThanOrEqual(limits.standalone_export.generation_ms);
  expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(
    limits.standalone_export.max_bytes,
  );

  const file = testInfo.outputPath("architecture-large-offline.html");
  fs.writeFileSync(file, html);
  const networkRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", request => {
    if (!/^(?:file|data|blob):/u.test(request.url())) networkRequests.push(request.url());
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(window, "__architectureLongTasks", {
      configurable: false,
      enumerable: false,
      value: durations,
      writable: false,
    });
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) durations.push(entry.duration);
      });
      observer.observe({ buffered: true, type: "longtask" });
    } catch {
      // Long-task entries are optional browser evidence; interaction timings remain mandatory.
    }
  });
  await context.setOffline(true);
  const openedAt = performance.now();
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  await expect(page.locator('[data-workspace-kind="architecture"]')).toBeVisible();

  const canvasSelector = '[data-architecture-canvas][data-layout-engine="elk"]';
  const canvas = page.locator(canvasSelector);
  await expect(canvas).toHaveAttribute("data-layout-status", "ready");
  const initialMode = screen.content.initial_mode;
  const scenarioViewport = canvas.locator(
    `[data-architecture-viewport][data-mode="${initialMode}"]`,
  );
  const scenarioRouteQuality = await measureRouteQuality(scenarioViewport, screen.content.edges);
  await testInfo.attach("architecture-scenario-route-quality.json", {
    body: JSON.stringify(scenarioRouteQuality, null, 2),
    contentType: "application/json",
  });
  expectRouteQuality(scenarioRouteQuality, limits.architecture_route_quality.scenario_path);
  const openToInteractiveMs = performance.now() - openedAt;
  expect(openToInteractiveMs).toBeLessThanOrEqual(limits.host.initial_render_ms);
  expect(openToInteractiveMs).toBeLessThanOrEqual(limits.standalone_export.open_to_interactive_ms);

  const allComponentsStartedAt = performance.now();
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(canvas).toHaveAttribute("data-presentation-scope", "all");
  await expect(canvas).toHaveAttribute("data-layout-status", "ready");
  expect(performance.now() - allComponentsStartedAt)
    .toBeLessThanOrEqual(limits.host.initial_render_ms);
  await expect(canvas).toHaveAttribute(
    "data-layout-node-count",
    String(limits.stress_workload.architecture_nodes),
  );
  await expect(canvas).toHaveAttribute(
    "data-layout-edge-count",
    String(limits.stress_workload.architecture_edges),
  );

  const alternateMode = initialMode === "current" ? "proposed" : "current";
  const viewport = canvas.locator(`[data-architecture-viewport][data-mode="${initialMode}"]`);
  await expect(viewport).toBeVisible();
  const visibleNodes = viewport.locator("[data-architecture-node][data-node-id]");
  const visibleEdges = viewport.locator("[data-architecture-edge][data-edge-id]");
  expect(await visibleNodes.count()).toBeGreaterThan(0);
  expect(await visibleEdges.count()).toBeGreaterThan(0);
  const geometry = await viewport.evaluate(root => ({
    edges: Array.from(root.querySelectorAll<SVGPathElement>(
      "[data-architecture-edge] path, path[data-architecture-edge]",
    )).filter(path => path.getTotalLength() > 4).length,
    nodes: Array.from(root.querySelectorAll<HTMLElement>("[data-architecture-node]")).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && (rect.x !== 0 || rect.y !== 0);
    }).length,
  }));
  expect(geometry.nodes).toBeGreaterThan(0);
  expect(geometry.edges).toBeGreaterThan(0);

  const allComponentsRouteQuality = await measureRouteQuality(viewport, screen.content.edges);
  await testInfo.attach("architecture-all-components-route-quality.json", {
    body: JSON.stringify(allComponentsRouteQuality, null, 2),
    contentType: "application/json",
  });
  expectRouteQuality(
    allComponentsRouteQuality,
    limits.architecture_route_quality.all_components,
  );

  const interactionTimeout = limits.host.interaction_response_ms * 4;
  const modeSwitchMs = await measureAttributeInteraction(
    page.getByRole("tablist", { name: "Architecture state" })
      .getByRole("tab", { name: alternateMode === "current" ? "Current" : "Proposed", exact: true }),
    "[data-architecture-viewport]",
    "data-mode",
    alternateMode,
    interactionTimeout,
  );
  expect(modeSwitchMs).toBeLessThanOrEqual(limits.host.interaction_response_ms);

  const zoomMs = await measureTransformInteraction(
    page.getByRole("button", { name: "Zoom in", exact: true }),
    interactionTimeout,
  );
  expect(zoomMs).toBeLessThanOrEqual(limits.host.interaction_response_ms);
  expect(await page.locator("body *").count()).toBeLessThanOrEqual(limits.host.max_dom_nodes);

  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const longTasks = await page.evaluate(() => (
    (window as Window & { __architectureLongTasks?: number[] }).__architectureLongTasks ?? []
  ));
  expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(limits.host.max_long_task_ms);
  expect(networkRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
