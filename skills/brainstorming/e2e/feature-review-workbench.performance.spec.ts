import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string, options?: { mode?: number }): void;
}

interface ReviewIndex {
  buildPatchSet(input: Record<string, unknown>): Record<string, unknown> & { patch_set_id: string };
  createPatchSetReview(input: Record<string, unknown>): Record<string, unknown>;
}

interface SessionEvent {
  message?: string;
  seq?: number;
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

interface PerformanceBudgets {
  host: {
    feedback_persistence_ms: number;
    initial_render_ms: number;
    interaction_response_ms: number;
    max_dom_nodes: number;
    max_long_task_ms: number;
  };
  stress_workload: { changed_files: number };
  version: number;
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
  source_preview: {
    end_line: number;
    lines: string[];
    start_line: number;
  };
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

const fs = require("node:fs") as FileSystem;
const { createBrainstormServer } = require("../scripts/server.cjs") as ReviewServerFactory;
const reviewIndex = require("../../pair-v3/scripts/review-index.cjs") as ReviewIndex;
const fixtureFile = require.resolve("../fixtures/feature-review-work.json");
const budgetFile = require.resolve("../fixtures/performance-budgets.json");

function budgets(): PerformanceBudgets {
  return JSON.parse(fs.readFileSync(budgetFile, "utf8")) as PerformanceBudgets;
}

function reviewFixture(): ReviewDocument {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ReviewDocument;
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
  const screen = reviewFixture();
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

  const patchSet = reviewIndex.buildPatchSet({
    ...screen.content.patch_set,
    files,
  });
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

async function measureSourceSelection(
  trigger: Locator,
  sourcePanel: Locator,
  expectedPath: string,
  timeoutMs: number,
): Promise<number> {
  return trigger.evaluate((element, options) => new Promise<number>((resolve, reject) => {
    const source = document.querySelector(options.sourceSelector);
    if (!source) {
      reject(new Error(`missing source context ${options.sourceSelector}`));
      return;
    }
    const matches = (): boolean => source.textContent?.includes(options.expectedPath) === true;
    const started = performance.now();
    let timeout = 0;
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      clearTimeout(timeout);
      observer.disconnect();
      requestAnimationFrame(() => resolve(performance.now() - started));
    });
    observer.observe(source, { attributes: true, childList: true, subtree: true });
    timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(`source context did not select ${options.expectedPath}`));
    }, options.timeoutMs);
    (element as HTMLElement).click();
  }), {
    expectedPath,
    sourceSelector: await sourcePanel.evaluate(element => {
      if (!element.id) element.id = "review-source-performance-target";
      return `#${CSS.escape(element.id)}`;
    }),
    timeoutMs,
  });
}

test("Feature Review Workbench keeps 300 changed files interactive while feedback persists", async ({ page }, testInfo: TestInfo) => {
  const limits = budgets();
  expect(limits.version).toBe(1);
  expect(limits.stress_workload.changed_files).toBe(300);
  const screen = expandedReviewFixture(limits.stress_workload.changed_files);
  expect(screen.content.patch_set.files).toHaveLength(300);
  expect(screen.content.review_slices[0]!.actual_changes).toHaveLength(300);

  const app = createBrainstormServer({
    sessionDir: testInfo.outputPath("feature-review-performance-session"),
    host: "127.0.0.1",
    port: 0,
    token: "feature-review-performance-capability",
    sessionId: `feature-review-performance-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    `${app.contentDir}/workspace.json`,
    `${JSON.stringify(screen)}\n`,
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
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(window, "__reviewLongTasks", { value: durations });
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) durations.push(entry.duration);
      });
      observer.observe({ buffered: true, type: "longtask" });
    } catch {
      // Long-task entries are optional evidence; render, interaction, and persistence are mandatory.
    }
  });
  await page.setViewportSize({ width: 1_440, height: 900 });
  const address = await app.listen();

  try {
    const openedAt = performance.now();
    await page.goto(address.connection_url);
    await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
    await expect(page.locator('[data-workspace-kind="review"]')).toBeVisible();

    // RED boundary: the canonical 300-file document has reached the current generic
    // Review fallback; only the purpose-built renderer contract is absent.
    const workbench = page.locator("[data-review-workbench]");
    await expect(workbench).toBeVisible();
    expect(performance.now() - openedAt).toBeLessThanOrEqual(limits.host.initial_render_ms);
    await expect(workbench).toHaveAttribute("data-changed-file-count", "300");

    const navigator = workbench.locator("[data-review-navigator]");
    const sourcePanel = workbench.locator("[data-review-source]");
    const secondPath = stressPath(1);
    const secondFile = navigator.locator("[data-source-path]")
      .filter({ hasText: secondPath })
      .first();
    await expect(secondFile).toHaveAttribute("data-source-path", secondPath);
    const responseMs = await measureSourceSelection(
      secondFile,
      sourcePanel,
      secondPath,
      limits.host.interaction_response_ms * 4,
    );
    expect(responseMs).toBeLessThanOrEqual(limits.host.interaction_response_ms);

    const note = "Persist feedback while the 300-file Review workspace remains mounted.";
    await page.getByLabel("Summary Note").fill(note);
    const persistenceStarted = performance.now();
    await page.getByRole("button", { name: "Save feedback batch" }).click();
    await expect.poll(() => app.store.snapshot().events.some(event => (
      event.type === "user.turn" && event.message === note
    ))).toBe(true);
    expect(performance.now() - persistenceStarted)
      .toBeLessThanOrEqual(limits.host.feedback_persistence_ms);

    expect(await page.locator("body *").count()).toBeLessThanOrEqual(limits.host.max_dom_nodes);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const longTasks = await page.evaluate(() => (
      (window as Window & { __reviewLongTasks?: number[] }).__reviewLongTasks ?? []
    ));
    expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(limits.host.max_long_task_ms);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
