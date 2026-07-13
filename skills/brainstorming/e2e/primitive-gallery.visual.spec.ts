import { expect, test, type Locator, type TestInfo } from "@playwright/test";

declare const require: { (id: string): unknown };

interface FileSystem {
  writeFileSync(file: string, contents: string): void;
}

interface NodeUrl {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

interface LegacyImporter {
  importLegacyVisualState(document: unknown, options: {
    workId: string;
    workspaceKind: "review";
    sessionSnapshot: unknown;
    evidenceRefs: Array<{ id: string; label: string }>;
  }): { document: Record<string, unknown>; session: unknown };
}

interface FeedbackStateDeriver {
  deriveFeedbackThreadState(
    thread: Record<string, unknown>,
    currentRevision: string,
    changes: { added: string[]; updated: string[]; removed: Array<{ id: string; label: string }> },
  ): "open" | "resolved" | "outdated";
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;

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

function galleryState(): { document: Record<string, unknown>; session: unknown } {
  const { importLegacyVisualState } = require("../scripts/legacy-visual-import.cjs") as LegacyImporter;
  const session = {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: "gallery-feedback-event",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "gallery-feedback-turn",
      message: "Use one primitive system across content and feedback.",
      annotations: [{
        id: "gallery-annotation",
        comment: "Warning treatment must retain a text label.",
        target: { componentId: "card-item-p1", selector: null, label: "Card Point" },
      }],
      choices: [{
        groupId: "gallery-decision",
        componentId: "gallery-option",
        value: "gallery-option",
        label: "Shared primitives",
      }],
      screen: { id: "screen", file: "screen.json", revision: "a1b2c3d4" },
    }],
  };
  const imported = importLegacyVisualState({
    version: 1,
    profile: "technical",
    audience: "Software developers",
    title: "Shared primitive gallery",
    summary: "Points, chips, tones, and flags retain one visual language in every host surface.",
    sections: [
      {
        kind: "cards",
        id: "gallery-cards",
        title: "Card surface",
        items: [{
          id: "card-item",
          title: "Warning card",
          detail: "Review Factory.cs:135 before approval.",
          tone: "warning",
          points: ["Card Point uses the shared claim geometry."],
        }],
      },
      {
        kind: "timeline",
        id: "gallery-timeline",
        title: "Timeline surface",
        items: [{
          id: "timeline-item",
          title: "Warning timeline step",
          detail: "Timeline detail remains in the content column.",
          tone: "warning",
          points: ["Timeline Point uses the shared claim geometry."],
        }],
      },
      {
        kind: "decision",
        id: "gallery-decision",
        title: "Decision surface",
        options: [{
          id: "gallery-option",
          label: "Shared primitives",
          detail: "One token vocabulary.",
          tone: "warning",
          points: ["Decision Point uses the shared claim geometry."],
        }, {
          id: "gallery-option-alternative",
          label: "Per-surface primitives",
          detail: "A valid comparison Option that intentionally remains unselected.",
          tone: "neutral",
        }],
      },
      {
        kind: "callout",
        id: "gallery-callout",
        title: "Warning callout",
        body: "Warning is labeled and never conveyed by color alone.",
        tone: "warning",
      },
    ],
  }, {
    workId: "work-20260712-visual-companion-vnext",
    workspaceKind: "review",
    sessionSnapshot: session,
    evidenceRefs: [{ id: "EVD-primitive-gallery", label: "Primitive parity evidence" }],
  });

  const threads = imported.document.feedback_threads as Array<Record<string, unknown>>;
  const { deriveFeedbackThreadState } = require("../assets/visual-shell/app.js") as FeedbackStateDeriver;
  const firstThread = threads[0];
  if (!firstThread) throw new Error("legacy gallery import must preserve its feedback thread");
  const outdated = deriveFeedbackThreadState(firstThread, "b2c3d4e5", {
    added: [],
    updated: [String(firstThread.component_id)],
    removed: [],
  });
  threads[0] = { ...firstThread, status: outdated };
  threads.push({
    id: "gallery-open-thread",
    component_id: "timeline-item",
    revision: "a1b2c3d4",
    type: "annotation",
    status: "open",
    comment: "Open state uses the same labeled flag primitive.",
    replies: [],
  });
  imported.document.revision = documentRevision(imported.document);
  return imported;
}

async function primitiveStyle(locator: Locator): Promise<Record<string, string>> {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      borderRadius: style.borderRadius,
    };
  });
}

function overlapArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

test("shared primitive gallery renders identical Points, chip geometry, tone tokens, and labeled flags", async ({ page }, testInfo: TestInfo) => {
  const gallery = galleryState();
  const html = buildStandaloneHtml(gallery.document, gallery.session);
  const file = testInfo.outputPath("primitive-gallery.html");
  fs.writeFileSync(file, html);

  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto(pathToFileURL(file).href);

  await expect(page.getByRole("heading", { name: "Shared primitive gallery" })).toBeVisible();
  await expect(page.getByText("Primitive parity evidence", { exact: true })).toBeVisible();
  const frameNavigation = page.getByRole("tablist", { name: /workspace frames/i });
  const frames = [
    { name: "Card surface", pointId: "card-item-p1", threadState: "outdated" },
    { name: "Timeline surface", pointId: "timeline-item-p1", threadState: "open" },
    { name: "Decision surface", pointId: "gallery-option-p1", threadState: null },
    { name: "Warning callout", pointId: null, threadState: null },
  ] as const;
  const pointStyles: Array<Record<string, string>> = [];
  const chipStyles: Array<Record<string, string>> = [];
  const warningTokens: Array<{ tone: string; ink: string }> = [];

  for (const frame of frames) {
    await frameNavigation.getByRole("tab", { name: frame.name }).click();
    const panel = page.getByRole("tabpanel", { name: frame.name });
    await expect(panel).toBeVisible();
    const chip = panel.locator('[data-primitive="chip"]').first();
    const warning = panel.locator('[data-primitive="tone"][data-tone="warning"]').first();
    await expect(chip).toBeVisible();
    await expect(warning).toBeVisible();
    chipStyles.push(await primitiveStyle(chip));
    warningTokens.push(await warning.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        tone: style.getPropertyValue("--tone").trim(),
        ink: style.getPropertyValue("--tone-ink").trim(),
      };
    }));

    const visiblePrimitives: Locator[] = [chip];
    if (frame.pointId) {
      const point = panel.locator(`[data-brainstorm-id="${frame.pointId}"]`);
      await expect(point).toBeVisible();
      pointStyles.push(await primitiveStyle(point));
      visiblePrimitives.push(point);
    }
    if (frame.threadState) {
      const flag = page.locator(`.thread-state:text-is("${frame.threadState}")`);
      await expect(flag).toBeVisible();
      expect((await flag.innerText()).trim()).toBe(frame.threadState);
      visiblePrimitives.push(flag);
    }
    const boxes = await Promise.all(visiblePrimitives.map(locator => locator.boundingBox()));
    for (let left = 0; left < boxes.length; left += 1) {
      expect(boxes[left]).not.toBeNull();
      for (let right = left + 1; right < boxes.length; right += 1) {
        expect(boxes[right]).not.toBeNull();
        expect(overlapArea(boxes[left]!, boxes[right]!)).toBe(0);
      }
    }
  }

  expect(pointStyles[1]).toEqual(pointStyles[0]);
  expect(pointStyles[2]).toEqual(pointStyles[0]);
  const baseChipStyle = chipStyles[0];
  expect(baseChipStyle).toBeDefined();
  if (!baseChipStyle) throw new Error("primitive gallery requires one reference chip");
  for (const style of chipStyles.slice(1)) {
    expect(style.fontFamily).toBe(baseChipStyle.fontFamily);
    expect(style.fontSize).toBe(baseChipStyle.fontSize);
    expect(style.borderRadius).toBe(baseChipStyle.borderRadius);
  }
  expect(new Set(warningTokens.map(token => token.tone)).size).toBe(1);
  expect(new Set(warningTokens.map(token => token.ink)).size).toBe(1);
  await expect(page.getByText("Warning is labeled and never conveyed by color alone.", { exact: true })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Warning callout" }).getByText("Warning", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(pageErrors).toEqual([]);

  const screenshot = await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
});
