# Visual Shell Design Contract

The Visual Shell is a quiet engineering-document surface. It renders Visual Documents; Workspace Kind renderers provide structure without introducing a second visual system.

## Tokens

`styles/tokens.css` is the only source of shared color, spacing, typography, radius, focus, and density values.

- `--vc-accent`, `--vc-accent-strong`, and `--vc-accent-soft` are reserved for interaction, selection, focus, and Revision-linked state.
- Positive, warning, and critical tokens retain distinct foreground and soft-surface pairs. Every state also carries visible text.
- `--tone`, `--tone-ink`, and `--tone-soft` are assigned by `data-tone` or the compatibility `tone-*` classes.
- Data, identifiers, Revision values, chips, and flags use `--vc-font-mono` with tabular numerals.
- Radius values stop at 8px. The Visual Shell uses no gradients or decorative floating shapes.
- Comfortable and compact density change spacing and control height; they do not hide evidence, Components, Points, feedback threads, or controls.

## Shared Primitives

Primitive identity is explicit so browser tests can prove parity across Workspace Kinds and the v1 compatibility path.

| Primitive | Required contract | Purpose |
| --- | --- | --- |
| Point | `.point`, `.point-text`, stable `data-brainstorm-id` | One claim-sized, annotatable Component |
| Chip | `data-primitive="chip"` | Evidence, Choice, or Draft metadata |
| Tone | `data-primitive="tone"` plus `data-tone` | Semantic surface treatment with a text label |
| Flag | `data-primitive="flag"` | Labeled Change Flag or feedback-thread state |

A Point has the same type metrics in cards, timeline items, and Decision Options. Timeline items reserve the first grid column for `.timeline-index`; every other child uses the full content column.

## Host Structure

- `.page-header` owns Visual Document identity, Revision, read-only state, and the `.density-control`.
- `.workspace` contains `.frame-nav`, `.workspace-slot`, and `.feedback-panel` as peer surfaces. Page sections are unframed; cards are reserved for repeated Components and feedback entries.
- `.frame-nav` implements the `tablist`/`tab` contract. `.frame-panel` owns the selected Frame's `tabpanel`.
- `.workspace-slot` is neutral. Concrete Workspace Kind renderers mount inside it later without changing shared host tokens.
- `.feedback-thread-gutter` shows typed, Revision-bound threads for the selected Frame. `.history` remains separate from Choices and the Summary Note Draft.
- `.feedback-panel` is sticky on wide screens and follows the Visual Document at narrow widths.
- A `.document-actions` toggle collapses the whole right column (`.feedback-panel` plus its canvas `PaneSeparator`), giving `.workspace-canvas` full width; the toggle stays visible and keyboard-reachable as the sole restore affordance and is never disabled by read-only or density state. A second, horizontal `PaneSeparator` sits between `.feedback-compose` and `.history`, letting the visitor trade height between drafting and Session History with a 120px floor on each side; both states persist per document identity.

## Accessibility And Reflow

All interactive controls expose native button, input, textarea, tab, or tabpanel semantics. `:focus-visible` uses a three-pixel teal outline. State is never communicated by color alone: Tone, Change Flag, and thread-state surfaces keep a visible label.

At 980px the three host columns become one reading flow. At 620px Frame tabs use stable equal tracks and controls use the available width. Content keeps `min-width: 0` and wraps long identifiers at 320 CSS pixels. Reduced-motion preference removes animation, transition duration, and smooth scrolling.

## Compatibility

The v1 compatibility renderer keeps `visual-section`, Section, Item / Node, Point, Decision, Mockup, Region, Element, and Tone class contracts. Profile selectors do not change the accent system. `assets/visual-shell/index.html` contains only the fixed `visual-shell-root` mount; the build owns the generated JavaScript and stylesheet assets.
