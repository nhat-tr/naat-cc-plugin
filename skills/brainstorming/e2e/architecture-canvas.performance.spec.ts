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
    edges: Array<Record<string, unknown>>;
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

test("architecture canvas large graph meets offline ELK layout, export, and interaction budgets", async ({ context, page }, testInfo: TestInfo) => {
  const limits = budgets();
  expect(limits.version).toBe(1);
  expect(limits.stress_workload.changed_files).toBe(300);

  const { generationMs, html, screen } = standaloneFixture();
  expect(screen.content.layout.engine).toBe("elk");
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
  const openToInteractiveMs = performance.now() - openedAt;
  expect(openToInteractiveMs).toBeLessThanOrEqual(limits.host.initial_render_ms);
  expect(openToInteractiveMs).toBeLessThanOrEqual(limits.standalone_export.open_to_interactive_ms);
  await expect(canvas).toHaveAttribute(
    "data-layout-node-count",
    String(limits.stress_workload.architecture_nodes),
  );
  await expect(canvas).toHaveAttribute(
    "data-layout-edge-count",
    String(limits.stress_workload.architecture_edges),
  );

  const initialMode = screen.content.initial_mode;
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
