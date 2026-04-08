---
name: browser-agent-audit
description: Audit browser agent input compatibility for a frontend codebase. Runs a live DOM inspection via CDP, discovers all interactive input components, checks visibility filter behaviour, detects dependency-gated fields, and produces a written compatibility report. Use when setting up the browser agent on a new codebase, after major UI changes, or when a component type stops working.
---

# Browser Agent Input Compatibility Audit

Produce a written report of which input components in this codebase the browser agent can scan, see, and fill — and which it cannot.

## When to use

- Setting up the browser agent on a new codebase for the first time
- After significant UI library version bumps (Ant Design, HDS, etc.)
- When the AI reports it cannot find/interact with elements that visually exist
- After changes to `scanner.ts`, `visibility.ts`, or `executor.ts`

## Prerequisites

- Chrome/Chromium running with `--remote-debugging-port=9222`
- Dev server running (e.g. `npm run dev`)
- User is authenticated in the browser (log in first — the audit navigates real pages)
- `ws` npm package available: `node -e "require('ws')"` (it's in devDependencies)

---

## Process

### Step 1 — Locate the audit script

Check if `scripts/audit-browser-agent.cjs` exists in the project root.

- **If it exists**: proceed to Step 2.
- **If not**: this codebase has not been set up for audit. Tell the user and stop — the script must be created first (see the WorkFrontendCopilot project as the reference implementation).

### Step 2 — Locate or create the pages definition

Check for `scripts/audit-pages.json`.

- **If it exists**: read it and verify the URLs match the running dev server. Update any stale URLs. Check whether prereq labels match the current app language (the app might be in EN or DE — labels in `audit-pages.json` must match).
- **If not**: create it now. Follow Step 2a.

#### Step 2a — Discover pages and prerequisites

For each major feature area of the app, identify:

1. **The URL** — read route files (e.g. `src/core/app/router.*.tsx`) to list routes
2. **Phases** — does this page have any dependency-gated inputs?

To detect dependency gates, read the relevant form component source and look for:
- `disabled={!someValue}` props
- `disabled={!formWatch('fieldName')}` patterns
- Components that conditionally render based on a prior selection

**Common dependency patterns in this codebase:**
- Create-order form: "Purchaser" select must be filled before other fields enable
- Order detail page: "Added Tools" tab must be clicked before the table appears; a row checkbox must be selected before action buttons enable
- Any form with a customer/product search autocomplete that gates a full section

For each dependency gate, define the prereq steps. Use these action types:

| Action | When to use |
|--------|-------------|
| `ant-autocomplete` | Typing in a search field (Ant Select with showSearch, AutoComplete) |
| `ant-select` | Opening a dropdown and picking an exact option value |
| `click` | Clicking a tab, button, or link by its visible text or CSS selector |
| `click-dropdown-option` | Clicking the Nth option in an already-open dropdown |
| `fill` | Setting a plain text/number input value |
| `wait` | Pausing after an async operation (API call, animation) |

**Important:** Labels in prereqs are language-sensitive. Check the current app language (look for a language switcher button in the UI or check `localStorage.getItem('i18nextLng')`). Use the label text that matches the current language.

### Step 3 — Run the audit

```bash
# Safe read-only scan (no fill probes — won't modify any data):
node scripts/audit-browser-agent.cjs --pages scripts/audit-pages.json --no-fill --out browser-agent-audit.json

# Full audit with fill probes (verifies native setter + React events work):
node scripts/audit-browser-agent.cjs --pages scripts/audit-pages.json --out browser-agent-audit.json
```

**Use `--no-fill` by default.** Fill probes write to form fields and may trigger network requests (search APIs, validation calls) that could cause auth redirects or unexpected state changes. Only use full fill mode if the session is stable and you accept the side effects.

Wait for completion. The script prints a summary to stdout and writes full JSON to the output file.

### Step 4 — Interpret the JSON output

Read `browser-agent-audit.json`. The structure is:

```
{
  summary: {
    families: { [componentFamily]: { seen, active, disabled, dropped, fillOk, fillFail } }
    dropReasons: { [reason]: count }
    fillIssues: [{ url, phase, el }]
    dependencyPatterns: [{ url, phase, unlockedCount, unlocked }]
  }
  pages: [
    {
      url,
      phases: [
        {
          name,
          stats: { total, active, disabled, dropped },
          scan: { elements: [...] },
          diff: { unlocked, appeared, locked, newFillIssue }   // absent on first phase
        }
      ]
    }
  ]
}
```

For each component family in `summary.families`, assess:

- `dropped > 0` → visibility filter is dropping real elements. Check `dropReasons`.
  - `zero-bbox` is usually fine (hidden portals, off-screen modals) — verify by looking at which elements dropped in the detailed scan
  - `opacity:0` without `onContainer: true` → missing Ant container in `filterVisible`
  - `occluded` → something covering the element; could be legitimate (modal open) or a false positive
- `disabled > 0` → elements exist but are gated. Check `summary.dependencyPatterns` — if those phases correctly unlock them, they're handled. If no phase unlocks them, investigate whether they need additional prereqs.
- `fillFail > 0` → native setter + React events didn't persist. Check `summary.fillIssues` for which elements and why.

**Key things to flag in the report:**

1. Any component family with `dropped > 0` where the drop reason isn't `zero-bbox`
2. Any `disabled` elements that no phase unlocks (missing prereq definition)
3. Any fill failures that aren't `readOnly` or `ant-select` (those are expected skips)
4. New component families not seen in the reference report (`docs/copilot/browser-agent-input-compatibility.md`)

### Step 5 — Write the report

Write to `docs/copilot/browser-agent-input-compatibility.md` (update if it exists, create if not).

Structure the report as:

1. **Executive summary** — what works, what doesn't, what's new since last audit
2. **Component compatibility table** — one row per family: scanned / visible / fill / gap
3. **Dependency gates** — list each gated section, what gate it, what unlocks it
4. **Visibility filter issues** — any drops that indicate a missing fix in `visibility.ts`
5. **Fill issues** — any components where fill doesn't persist and why
6. **Recommendations** — prioritised fixes

Ground every finding in the audit JSON — cite element labels, page URLs, phase names. Do not make assertions the audit didn't measure.

### Step 6 — Check for fixable issues

For each `opacity:0` drop where `onContainer` is false, check if `visibility.ts` needs a new container class added (same pattern as `.ant-checkbox-wrapper`).

For each `readOnly` fill skip on a component that should be fillable (e.g. DatePicker), note it as a gap requiring a new `executor.ts` branch.

Do NOT apply fixes during the audit. This skill produces a report only. Fixes are a separate task.

---

## What the script does NOT cover

- **Async fill validation** — the fill probe fires set+events+150ms wait. If a component validates on blur or after a debounce, the probe may report false `persisted: false`.
- **Dropdown option selection** — `ant-select` fill is always skipped (`requires dropdown interaction`). The audit only checks whether the element is visible; actual option-fill is tested manually.
- **Auth-gated pages** — if a page redirects to SSO during navigation, the scan returns 0 elements with an error. The user must be logged in before running the audit.
- **Dynamically generated content** — tables that load data from an API will only show rows if the backend returns data. The audit measures what is in the DOM at scan time.

---

## Rerunning on a new codebase

1. Copy `scripts/audit-browser-agent.cjs` into the new project (no changes needed — it has no project-specific code).
2. Run `npm install ws` if not already present.
3. Create `scripts/audit-pages.json` fresh for that codebase following Step 2a above.
4. Run the audit and produce the report.

The script itself is codebase-agnostic. Only `audit-pages.json` is project-specific.
