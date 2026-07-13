# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: skills/brainstorming/e2e/accessibility-compatibility.spec.ts >> workspace fixtures: review is keyboard, WCAG, reflow, and offline compatible
- Location: skills/brainstorming/e2e/accessibility-compatibility.spec.ts:169:7

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator: locator('[data-review-workbench]').locator('[data-review-navigator]').locator('[data-review-tree][role=\'tree\']')
Expected pattern: /.+/u
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveAttribute" with timeout 5000ms
  - waiting for locator('[data-review-workbench]').locator('[data-review-navigator]').locator('[data-review-tree][role=\'tree\']')

```

```yaml
- banner:
  - text: Review
  - heading "Feature Review Workbench" [level=1]
  - list "Evidence":
    - listitem: Approved three-pane Review direction
    - listitem: Review Workspace contract tests
    - listitem: Feature Review Workbench browser verification
    - listitem: Authenticated source evidence boundary
    - listitem: Manual Review pilot outcome
  - text: rev 1e7c6a8b 1 Frame
  - button "Comfortable" [pressed]
  - button "Compact"
  - button "Save standalone export" [disabled]
  - button "Refresh Visual Session" [disabled]
- main:
  - tablist "Workspace frames":
    - tab "Feature review" [selected]
  - tabpanel "Feature review":
    - text: Feature Review Workbench
    - heading "Whole-feature review" [level=2]
    - strong: Current patch set
    - text: 6373120b 4 files File Viewed
    - strong: 2 of 4
    - text: Whole feature
    - strong: Rejected
    - status: 1 cross-slice 1 unmapped 1 invalidated evidence set
    - complementary:
      - heading "Intent navigator" [level=3]
      - paragraph: Acceptance Criteria and Review Slices
      - tablist "Acceptance Criteria":
        - tab "AC-1" [selected]
        - tab "AC-6"
        - tab "AC-15"
        - tab "AC-16"
        - tab "AC-18"
      - tabpanel "AC-1":
        - strong: Five purpose-built Workspace Kinds render distinct layouts
        - tree "AC-1 Review Slice source tree":
          - treeitem "10.1 Review contract tests 1" [selected]:
            - strong: "10.1"
            - text: Review contract tests 1
          - treeitem "10.3 Feature Review Workbench 2":
            - strong: "10.3"
            - text: Feature Review Workbench 2
          - treeitem "skills/brainstorming/tests/review-workspace.test.js Viewed" [selected]
          - treeitem "skills/brainstorming/scripts/server.cjs Not viewed"
          - treeitem "skills/brainstorming/ui/workspaces/review/FeatureReviewWorkbench.tsx Viewed"
    - text: Selected source
    - heading "skills/brainstorming/tests/review-workspace.test.js" [level=3]
    - text: Viewed
    - button "skills/brainstorming/tests/review-workspace.test.js" [pressed]
    - text: "Actual change: skills/brainstorming/tests/review-workspace.test.js Expected ownership Review Slice 10.1"
    - code: skills/brainstorming/e2e/feature-review-workbench.spec.ts
    - code: skills/brainstorming/fixtures/feature-review-work.json
    - code: skills/brainstorming/tests/review-workspace.test.js
    - heading "Changed symbols" [level=4]
    - code: compileReviewSchema
    - code: reviewFixture
    - heading "Hunk context" [level=4]
    - code: "1111111111111111"
    - text: Lines 1-212
    - list:
      - listitem:
        - code: Review schema contract
      - listitem:
        - code: Review Slice and patch-set linkage
      - listitem:
        - code: Patch-set invalidation assertions
    - heading "Acceptance and evidence" [level=4]
    - text: AC-1 AC-15 AC-16 AC-18 AC-6 EVD-002-review-contract
    - complementary:
      - heading "Verification and governance" [level=3]
      - paragraph: Evidence, findings, and lineage
      - heading "Verification evidence" [level=4]
      - article:
        - strong: EVD-001-design-direction-approval
        - text: design-direction-approval Three-pane density
      - article:
        - strong: EVD-002-review-contract
        - text: test Passed
      - article:
        - strong: EVD-003-review-functional
        - text: browser-test Passed
      - article:
        - strong: AC-1
        - text: Acceptance evidence Current
      - article:
        - strong: AC-6
        - text: Acceptance evidence Outdated
      - article:
        - strong: AC-15
        - text: Acceptance evidence Current
      - article:
        - strong: AC-16
        - text: Acceptance evidence Current
      - article:
        - strong: AC-18
        - text: Acceptance evidence Current
      - heading "Quality obligations" [level=4]
      - article:
        - strong: EQC-BASE
        - text: Intent maintainability Open
      - article:
        - strong: EQC-A11Y
        - text: Accessibility Frontend CODEOWNER Not applicable
      - heading "Findings" [level=4]
      - article:
        - strong: Source evidence boundary changed after verification
        - paragraph: The server hunk changed again, so only AC-6 and AC-19 evidence is outdated.
        - text: open
      - heading "Decisions and outcomes" [level=4]
      - article:
        - strong: DR-001-visual-companion-vnext
        - text: Structured Visual Companion vNext Accepted
      - article:
        - strong: OUT-001-review-pilot
        - text: Review context stayed visible, but stale server evidence blocked approval. Review context stayed visible, but stale server evidence blocked approval.
- complementary "Feedback batch":
  - text: Feedback Batch
  - heading "Review notes" [level=2]
  - 'status "Feedback delivery: Offline export"': Offline export
  - region "Feedback Threads":
    - heading "Feedback Threads" [level=3]
    - text: "1"
    - article:
      - text: finding outdated
      - paragraph: Recheck the authenticated source evidence boundary after the server patch changed.
  - region "Draft feedback":
    - heading "Draft feedback" [level=3]
    - button "Clear feedback draft" [disabled]
    - button "Refresh Visual Session" [disabled]
    - text: Component
    - combobox "Component" [disabled]:
      - 'option "AC-1: five purpose-built Workspace Kinds" [selected]'
      - 'option "AC-6: navigate intent through review evidence"'
      - 'option "AC-15: govern Engineering Quality Contract obligations"'
      - 'option "AC-16: build deterministic Review Slice manifests"'
      - 'option "AC-18: patch-set-specific review progress"'
      - 'option "Review Slice 10.1: Review contract tests"'
      - 'option "Review Slice 10.3: Feature Review Workbench"'
      - 'option "Review Slice 10.4: aggregate quality verification"'
      - option "Review Workspace contract test changes"
      - option "Authenticated source evidence endpoint changes"
      - option "Feature Review Workbench renderer changes"
      - 'option "Finding: stale evidence boundary remains open"'
      - option "EQC-A11Y accessibility obligation"
      - 'option "DR-001: Structured Visual Companion vNext"'
      - 'option "OUT-001: Review pilot outcome"'
    - text: Targeted note
    - textbox "Targeted note" [disabled]:
      - /placeholder: What should change or be clarified?
    - button "Add targeted note" [disabled]
    - text: Summary Note
    - textbox "Summary Note" [disabled]:
      - /placeholder: Add one summary note…
    - paragraph: Read-only export. Feedback is disabled in this standalone copy.
    - button "Save feedback batch" [disabled]
  - region "Session history":
    - heading "Session history" [level=3]
    - article:
      - strong: You
      - time: 08:40 AM
      - paragraph: Review this workspace with keyboard and assistive technology.
```

# Test source

```ts
  49  |   return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as WorkspaceDocument;
  50  | }
  51  | 
  52  | function session(screen: WorkspaceDocument): Record<string, unknown> {
  53  |   return {
  54  |     version: 1,
  55  |     cursor: 0,
  56  |     pendingTurns: 0,
  57  |     events: [{
  58  |       version: 1,
  59  |       id: `${screen.workspace_kind}-a11y-event`,
  60  |       seq: 1,
  61  |       timestamp: 1_725_000_000_000,
  62  |       type: "user.turn",
  63  |       role: "user",
  64  |       clientTurnId: `${screen.workspace_kind}-a11y-turn`,
  65  |       message: "Review this workspace with keyboard and assistive technology.",
  66  |       annotations: [],
  67  |       choices: [],
  68  |       screen: {
  69  |         id: screen.workspace_kind,
  70  |         file: "workspace.json",
  71  |         revision: screen.revision,
  72  |       },
  73  |     }],
  74  |   };
  75  | }
  76  | 
  77  | async function mountOffline(
  78  |   page: Page,
  79  |   testInfo: TestInfo,
  80  |   screen: WorkspaceDocument,
  81  |   viewport: (typeof VIEWPORTS)[number],
  82  | ): Promise<{ networkRequests: string[]; pageErrors: string[] }> {
  83  |   const file = testInfo.outputPath(`${screen.workspace_kind}-${viewport.name}-a11y.html`);
  84  |   fs.writeFileSync(file, buildStandaloneHtml(screen, session(screen)));
  85  |   const networkRequests: string[] = [];
  86  |   const pageErrors: string[] = [];
  87  |   page.on("request", request => {
  88  |     if (!/^(?:file|data|blob):/u.test(request.url())) networkRequests.push(request.url());
  89  |   });
  90  |   page.on("pageerror", error => pageErrors.push(error.message));
  91  |   await page.setViewportSize(viewport);
  92  |   await page.emulateMedia({ reducedMotion: "reduce" });
  93  |   await page.context().setOffline(true);
  94  |   await page.goto(pathToFileURL(file).href);
  95  |   await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  96  |   return { networkRequests, pageErrors };
  97  | }
  98  | 
  99  | async function expectVisibleFocus(page: Page, root: Locator): Promise<void> {
  100 |   const purposeControl = root.locator(
  101 |     "button:not([disabled]), select:not([disabled]), a[href], [tabindex='0']",
  102 |   ).filter({ visible: true }).first();
  103 |   const control = await purposeControl.count() > 0
  104 |     ? purposeControl
  105 |     : page.getByRole("tablist", { name: /workspace frames/i }).getByRole("tab").first();
  106 |   await expect(control).toBeVisible();
  107 |   await control.focus();
  108 |   await expect(control).toBeFocused();
  109 |   const style = await control.evaluate(element => {
  110 |     const computed = getComputedStyle(element);
  111 |     return {
  112 |       outlineStyle: computed.outlineStyle,
  113 |       outlineWidth: Number.parseFloat(computed.outlineWidth),
  114 |     };
  115 |   });
  116 |   expect(style.outlineStyle).not.toBe("none");
  117 |   expect(style.outlineWidth).toBeGreaterThan(0);
  118 |   const box = await control.boundingBox();
  119 |   const viewport = page.viewportSize();
  120 |   expect(box).not.toBeNull();
  121 |   expect(viewport).not.toBeNull();
  122 |   expect(box!.x).toBeGreaterThanOrEqual(-1);
  123 |   expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  124 | }
  125 | 
  126 | async function expectReducedMotion(page: Page): Promise<void> {
  127 |   expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  128 |   const movingElements = await page.locator("body *").evaluateAll(elements => {
  129 |     const milliseconds = (value: string): number => Math.max(...value.split(",").map(token => {
  130 |       const duration = token.trim();
  131 |       const amount = Number.parseFloat(duration);
  132 |       return duration.endsWith("ms") ? amount : amount * 1_000;
  133 |     }));
  134 |     return elements.filter(element => {
  135 |       const style = getComputedStyle(element);
  136 |       const animated = style.animationName !== "none" && milliseconds(style.animationDuration) > 1;
  137 |       const movingTransition = /transform|translate|rotate|scale|left|right|top|bottom|all/u
  138 |         .test(style.transitionProperty)
  139 |         && milliseconds(style.transitionDuration) > 1;
  140 |       return animated || movingTransition || style.scrollBehavior === "smooth";
  141 |     }).map(element => `${element.tagName.toLowerCase()}#${element.id}`);
  142 |   });
  143 |   expect(movingElements).toEqual([]);
  144 | }
  145 | 
  146 | async function expectReviewTreeKeyboard(page: Page, root: Locator): Promise<void> {
  147 |   const navigator = root.locator("[data-review-navigator]");
  148 |   const tree = navigator.locator("[data-review-tree][role='tree']");
> 149 |   await expect(tree).toHaveAttribute("aria-label", /.+/u);
      |                      ^ Error: expect(locator).toHaveAttribute(expected) failed
  150 |   const items = tree.locator("[role='treeitem']");
  151 |   expect(await items.count()).toBeGreaterThanOrEqual(3);
  152 |   const first = items.first();
  153 |   await first.focus();
  154 |   await page.keyboard.press("ArrowDown");
  155 |   await expect(items.nth(1)).toBeFocused();
  156 |   await page.keyboard.press("End");
  157 |   await expect(items.last()).toBeFocused();
  158 |   await page.keyboard.press("Home");
  159 |   await expect(first).toBeFocused();
  160 |   const focusedState = await first.evaluate(element => ({
  161 |     selected: element.getAttribute("aria-selected"),
  162 |     viewed: element.getAttribute("data-viewed"),
  163 |   }));
  164 |   expect(focusedState.selected).not.toBeNull();
  165 |   expect(focusedState.viewed).not.toBeNull();
  166 | }
  167 | 
  168 | for (const workspace of WORKSPACES) {
  169 |   test(`workspace fixtures: ${workspace.kind} is keyboard, WCAG, reflow, and offline compatible`, async ({ page }, testInfo) => {
  170 |     const screen = fixture(workspace.fixture);
  171 |     expect(screen.workspace_kind).toBe(workspace.kind);
  172 | 
  173 |     for (const viewport of VIEWPORTS) {
  174 |       const evidence = await mountOffline(page, testInfo, screen, viewport);
  175 |       const root = page.locator(workspace.root);
  176 |       await expect(root).toBeVisible();
  177 |       if (workspace.kind === "architecture") {
  178 |         await expect(root).toHaveAttribute("data-layout-status", "ready");
  179 |       }
  180 |       await expect(page.getByRole("main")).toBeVisible();
  181 |       await expect(root.getByRole("heading").first()).toBeVisible();
  182 |       await expectVisibleFocus(page, root);
  183 |       await expectReducedMotion(page);
  184 |       expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  185 | 
  186 |       if (workspace.kind === "review") {
  187 |         await expectReviewTreeKeyboard(page, root);
  188 |       }
  189 | 
  190 |       const results = await new AxeBuilder({ page })
  191 |         .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
  192 |         .analyze();
  193 |       await testInfo.attach(`${workspace.kind}-${viewport.name}-axe.json`, {
  194 |         body: JSON.stringify(results.violations, null, 2),
  195 |         contentType: "application/json",
  196 |       });
  197 |       const blocking = results.violations.filter(violation => (
  198 |         violation.impact === "critical" || violation.impact === "serious"
  199 |       ));
  200 |       expect(
  201 |         blocking.map(violation => ({ id: violation.id, nodes: violation.nodes.length })),
  202 |         `${workspace.kind} has blocking automated accessibility findings`,
  203 |       ).toEqual([]);
  204 |       expect(evidence.networkRequests).toEqual([]);
  205 |       expect(evidence.pageErrors).toEqual([]);
  206 |     }
  207 |   });
  208 | }
  209 | 
```