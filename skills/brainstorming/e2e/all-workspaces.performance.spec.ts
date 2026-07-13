import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const __dirname: string;
declare const require: { (id: string): unknown };

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string, options?: { mode?: number }): void;
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

interface ReviewIndex {
  buildPatchSet(input: Record<string, unknown>): Record<string, unknown> & { patch_set_id: string };
  createPatchSetReview(input: Record<string, unknown>): Record<string, unknown>;
}

interface SessionEvent {
  message?: string;
  type?: string;
}

interface ReviewServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
  store: { snapshot(): { events: SessionEvent[] } };
}

interface ReviewServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): ReviewServer;
}

interface WorkspaceDocument extends Record<string, unknown> {
  revision: string;
  title: string;
  workspace_kind: string;
}

interface PerformanceBudgets {
  host: {
    feedback_persistence_ms: number;
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

interface PerformanceMetrics {
  domNodes: number;
  exportBytes: number;
  generationMs: number;
  interactionMs: number;
  longTasks: number[];
  openToInteractiveMs: number;
}

interface PatchFile extends Record<string, unknown> {
  acceptance_criteria: string[];
  attribution: Record<string, unknown>;
  patch_digest: string;
  path: string;
}

interface ActualChange extends Record<string, unknown> {
  component_id: string;
  evidence_ids: string[];
  hunk_id: string;
  path: string;
  source_preview: { end_line: number; lines: string[]; start_line: number };
  symbols: string[];
}

interface ReviewDocument extends Record<string, unknown> {
  components: Array<{ frame_id: string; id: string; label: string }>;
  content: {
    patch_set: Record<string, unknown> & { files: PatchFile[] };
    patch_set_review: Record<string, unknown>;
    review_slices: Array<Record<string, unknown> & {
      actual_changes: ActualChange[];
      expected_files: string[];
    }>;
  };
  frames: Array<{ component_ids: string[]; id: string }>;
  revision: string;
  title: string;
  workspace_kind: "review";
}

interface ArchitectureDocument extends WorkspaceDocument {
  content: { edges: unknown[]; nodes: unknown[] };
  workspace_kind: "architecture";
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as NodePath;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const { createBrainstormServer } = require("../scripts/server.cjs") as ReviewServerFactory;
const reviewIndex = require("../../pair-v3/scripts/review-index.cjs") as ReviewIndex;

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");
const BUDGET_FILE = path.join(FIXTURE_DIR, "performance-budgets.json");
const WORKSPACES = [
  { fixture: "product-concept-set.json", kind: "product", root: "[data-product-concept-studio]" },
  { fixture: "architecture-large.json", kind: "architecture", root: "[data-architecture-canvas]" },
  { fixture: "research-evidence.json", kind: "research", root: "[data-research-evidence-board]" },
  { fixture: "business-reasoning.json", kind: "business", root: "[data-business-reasoning-canvas]" },
  { fixture: "feature-review-work.json", kind: "review", root: "[data-review-workbench]" },
] as const;

function fixture(name: string): WorkspaceDocument {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as WorkspaceDocument;
}

function budgets(): PerformanceBudgets {
  return JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")) as PerformanceBudgets;
}

function documentRevision(value: Record<string, unknown>): string {
  const semantic = structuredClone(value);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stressPath(index: number): string {
  return `skills/brainstorming/generated/review-file-${String(index + 1).padStart(3, "0")}.ts`;
}

function stressDigest(index: number): string {
  return String(index + 1).padStart(64, "0");
}

function expandedReviewFixture(fileCount: number): ReviewDocument {
  const screen = fixture("feature-review-work.json") as ReviewDocument;
  screen.read_only = false;
  const slice = screen.content.review_slices[0];
  const baseFile = screen.content.patch_set.files[0];
  const baseChange = slice?.actual_changes[0];
  const frame = screen.frames[0];
  if (!slice || !baseFile || !baseChange || !frame) {
    throw new TypeError("feature Review fixture must include one linked file, change, and frame");
  }

  const files = Array.from({ length: fileCount }, (_, index): PatchFile => ({
    ...structuredClone(baseFile),
    acceptance_criteria: [...baseFile.acceptance_criteria],
    attribution: structuredClone(baseFile.attribution),
    patch_digest: stressDigest(index),
    path: stressPath(index),
  }));
  const actualChanges = Array.from({ length: fileCount }, (_, index): ActualChange => ({
    ...structuredClone(baseChange),
    component_id: `actual-review-file-${String(index + 1).padStart(3, "0")}`,
    evidence_ids: [...baseChange.evidence_ids],
    hunk_id: stressDigest(index),
    path: stressPath(index),
    symbols: [`reviewSymbol${index + 1}`],
    source_preview: {
      start_line: index + 1,
      end_line: index + 1,
      lines: [`export const reviewSymbol${index + 1} = ${index + 1};`],
    },
  }));

  const patchSet = reviewIndex.buildPatchSet({ ...screen.content.patch_set, files });
  screen.content.patch_set = { ...screen.content.patch_set, ...patchSet, files };
  const indexedReview = reviewIndex.createPatchSetReview(patchSet) as Record<string, unknown> & {
    files: Record<string, Record<string, unknown>>;
  };
  const { files: indexedFiles, ...reviewState } = indexedReview;
  screen.content.patch_set_review = {
    ...reviewState,
    file_reviews: Object.entries(indexedFiles).map(([path, state]) => ({ path, ...state })),
  };
  slice.actual_changes = actualChanges;
  slice.expected_files = files.map(file => file.path);
  const generatedComponents = actualChanges.map(change => ({
    id: change.component_id,
    frame_id: frame.id,
    label: `${change.path} actual change`,
  }));
  screen.components.push(...generatedComponents);
  frame.component_ids.push(...generatedComponents.map(component => component.id));
  screen.revision = documentRevision(screen);
  return screen;
}

function session(screen: WorkspaceDocument): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [{
      version: 1,
      id: `${screen.workspace_kind}-performance-event`,
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: `${screen.workspace_kind}-performance-turn`,
      message: "Keep review interaction available while the workspace is under representative load.",
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

async function measureNextPaint(control: Locator, timeoutMs: number): Promise<number> {
  return control.evaluate((element, timeout) => new Promise<number>((resolve, reject) => {
    const started = performance.now();
    const timer = window.setTimeout(() => reject(new Error("interaction did not reach next paint")), timeout);
    (element as HTMLElement).click();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    }));
  }), timeoutMs);
}

for (const workspace of WORKSPACES) {
  test(`workspace fixtures: ${workspace.kind} meets aggregate export, render, DOM, and interaction budgets`, async ({ context, page }, testInfo: TestInfo) => {
    const limits = budgets();
    expect(limits.version).toBe(1);
    const screen = fixture(workspace.fixture);
    expect(screen.workspace_kind).toBe(workspace.kind);

    const generationStarted = performance.now();
    const html = buildStandaloneHtml(screen, session(screen));
    const generationMs = performance.now() - generationStarted;
    const exportBytes = new TextEncoder().encode(html).byteLength;
    expect(generationMs).toBeLessThanOrEqual(limits.standalone_export.generation_ms);
    expect(exportBytes).toBeLessThanOrEqual(limits.standalone_export.max_bytes);

    const file = testInfo.outputPath(`${workspace.kind}-aggregate-performance.html`);
    fs.writeFileSync(file, html);
    const networkRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on("request", request => {
      if (!/^(?:file|data|blob):/u.test(request.url())) networkRequests.push(request.url());
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const durations: number[] = [];
      Object.defineProperty(window, "__workspaceLongTasks", {
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
        // Browser support for long-task entries is optional; other timings remain mandatory.
      }
    });
    await page.setViewportSize({ width: 1_440, height: 900 });
    await context.setOffline(true);

    const openedAt = performance.now();
    await page.goto(pathToFileURL(file).href);
    await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
    const root = page.locator(workspace.root);
    await expect(root).toBeVisible();
    if (workspace.kind === "architecture") {
      await expect(root).toHaveAttribute("data-layout-status", "ready");
    }
    const openToInteractiveMs = performance.now() - openedAt;
    expect(openToInteractiveMs).toBeLessThanOrEqual(limits.host.initial_render_ms);
    expect(openToInteractiveMs).toBeLessThanOrEqual(limits.standalone_export.open_to_interactive_ms);

    const purposeControl = root.locator(
      "button:not([disabled]), select:not([disabled]), [role='tab'][tabindex='0']",
    ).filter({ visible: true }).first();
    const control = await purposeControl.count() > 0
      ? purposeControl
      : page.getByRole("tablist", { name: /workspace frames/i }).getByRole("tab").first();
    await expect(control).toBeVisible();
    const interactionMs = await measureNextPaint(control, limits.host.interaction_response_ms * 4);
    expect(interactionMs).toBeLessThanOrEqual(limits.host.interaction_response_ms);

    const domNodes = await page.locator("body *").count();
    expect(domNodes).toBeLessThanOrEqual(limits.host.max_dom_nodes);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const longTasks = await page.evaluate(() => (
      (window as Window & { __workspaceLongTasks?: number[] }).__workspaceLongTasks ?? []
    ));
    expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(limits.host.max_long_task_ms);

    const metrics: PerformanceMetrics = {
      domNodes,
      exportBytes,
      generationMs,
      interactionMs,
      longTasks,
      openToInteractiveMs,
    };
    await testInfo.attach(`${workspace.kind}-performance.json`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });
    expect(networkRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test("workspace fixtures keep Feedback Batch persistence responsive under combined 300-file Review and large Architecture load", async ({ context, page }, testInfo) => {
  const limits = budgets();
  expect(limits.stress_workload.changed_files).toBe(300);
  const review = expandedReviewFixture(limits.stress_workload.changed_files);
  const architecture = fixture("architecture-large.json") as ArchitectureDocument;
  expect(review.content.patch_set.files).toHaveLength(limits.stress_workload.changed_files);
  expect(review.content.review_slices[0]!.actual_changes).toHaveLength(
    limits.stress_workload.changed_files,
  );
  const patchSetReview = review.content.patch_set_review as {
    file_reviews: unknown[];
    viewed_progress: { total: number };
  };
  expect(patchSetReview.file_reviews).toHaveLength(limits.stress_workload.changed_files);
  expect(patchSetReview.viewed_progress.total).toBe(limits.stress_workload.changed_files);
  expect(architecture.content.nodes).toHaveLength(limits.stress_workload.architecture_nodes);
  expect(architecture.content.edges).toHaveLength(limits.stress_workload.architecture_edges);

  const architectureFile = testInfo.outputPath("combined-architecture-load.html");
  fs.writeFileSync(architectureFile, buildStandaloneHtml(architecture, session(architecture)));
  const app = createBrainstormServer({
    sessionDir: testInfo.outputPath("combined-review-load"),
    host: "127.0.0.1",
    port: 0,
    token: "combined-workspace-performance-capability",
    sessionId: `combined-workspace-performance-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    `${app.contentDir}/workspace.json`,
    `${JSON.stringify(review)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    `${app.stateDir}/visual-format.json`,
    `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: "content/screen.json",
      v2_document: "content/workspace.json",
    })}\n`,
    { mode: 0o600 },
  );

  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(`review: ${error.message}`));
  const architecturePage = await context.newPage();
  architecturePage.on("pageerror", error => pageErrors.push(`architecture: ${error.message}`));
  await page.setViewportSize({ width: 1_440, height: 900 });
  await architecturePage.setViewportSize({ width: 1_440, height: 900 });
  const address = await app.listen();

  try {
    await Promise.all([
      page.goto(address.connection_url),
      architecturePage.goto(pathToFileURL(architectureFile).href),
    ]);
    await expect(page.locator('[data-workspace-kind="review"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: review.title, exact: true })).toBeVisible();
    const workbench = page.locator("[data-review-workbench]");
    await expect(workbench).toBeVisible();
    await expect(workbench).toHaveAttribute(
      "data-changed-file-count",
      String(limits.stress_workload.changed_files),
    );
    const architectureCanvas = architecturePage.locator("[data-architecture-canvas]");
    await expect(architectureCanvas).toHaveAttribute("data-layout-status", "ready");

    const note = "Persist this Feedback Batch while Review and Architecture remain under load.";
    await page.getByLabel("Summary Note").fill(note);
    const feedbackResponse = page.waitForResponse(response => (
      response.request().method() === "POST" && response.url().endsWith("/api/feedback")
    ));
    const architectureReload = architecturePage.reload().then(async () => {
      await expect(architecturePage.locator("[data-architecture-canvas]"))
        .toHaveAttribute("data-layout-status", "ready");
    });
    const persistenceStarted = performance.now();
    await page.getByRole("button", { name: "Save feedback batch" }).click();
    const response = await feedbackResponse;
    const persistenceMs = performance.now() - persistenceStarted;
    expect(response.status()).toBe(201);
    expect(persistenceMs).toBeLessThanOrEqual(limits.host.feedback_persistence_ms);
    expect(app.store.snapshot().events.some(event => (
      event.type === "user.turn" && event.message === note
    ))).toBe(true);
    await architectureReload;

    const reviewDomNodes = await page.locator("body *").count();
    const architectureDomNodes = await architecturePage.locator("body *").count();
    expect(reviewDomNodes).toBeLessThanOrEqual(limits.host.max_dom_nodes);
    expect(architectureDomNodes).toBeLessThanOrEqual(limits.host.max_dom_nodes);
    await testInfo.attach("combined-load-performance.json", {
      body: JSON.stringify({
        architectureDomNodes,
        architectureEdges: limits.stress_workload.architecture_edges,
        architectureNodes: limits.stress_workload.architecture_nodes,
        changedFiles: limits.stress_workload.changed_files,
        persistenceMs,
        reviewDomNodes,
      }, null, 2),
      contentType: "application/json",
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await architecturePage.close();
    await app.close();
  }
});
