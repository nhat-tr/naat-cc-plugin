---
name: mermaid-validate
description: "Use this skill whenever you write, edit, or review Mermaid diagram blocks inside Markdown files. Trigger automatically after any edit that touches a ```mermaid block — do not wait to be asked."
---

# Mermaid Diagram Validation

After writing or editing any Mermaid block, run the validator before reporting the task done.

**Every new diagram must start with a theme directive** to prevent the viewer's dark mode from overriding styles:

```
%%{init: {'theme': 'default'}}%%
flowchart TD
    ...
```

Without this, viewers (GitHub, VS Code, documentation sites) may apply their own dark theme, making sequence diagram participants black and overriding `classDef` colors.

## Validation command

```bash
~/.local/share/my-claude-code/bin/validate-mermaid <file.md>   # one file
~/.local/share/my-claude-code/bin/validate-mermaid              # all docs/**/*.md
```

Requires `mmdc` — install once with `npm install -g @mermaid-js/mermaid-cli`.

## Mandatory workflow

1. Write or edit the Mermaid block.
2. Run `validate-mermaid <file>`.
3. Fix every `FAIL` line before reporting done.

Never claim a diagram task is complete without a clean validate run.

---

## Common errors and fixes

### `direction` inside a subgraph — requires `flowchart`, not `graph`

`direction` inside a subgraph is only valid in `flowchart` diagrams. Using it inside a `graph` block causes a parse error that silently drops all `classDef` styles.

```
# Wrong
graph TD
  subgraph Foo
    direction LR    ← parse error in graph mode
  end

# Fix: switch the root declaration
flowchart TD
  subgraph Foo
    direction LR    ← valid
  end
```

### `classDef` property with a space in the value

Mermaid's `classDef` parser treats spaces as delimiters. A value like `5 5` in `stroke-dasharray` is silently truncated.

```
# Wrong — space after colon breaks parsing
classDef future fill:#f5f5f5,stroke-dasharray: 5 5

# Fix — no space after colon
classDef future fill:#f5f5f5,stroke-dasharray:5 5
```

### `class` references a node ID that doesn't exist

Every ID in `class X,Y classname` must exist as a declared node. Stale IDs after a rename are silently ignored — the named nodes render unstyled.

### HTML angle brackets in node labels

Use `&lt;` / `&gt;` for `<` / `>` inside `"..."` node labels. Bare angle brackets may be misread as HTML tags and corrupt the label.

### `stateDiagram-v2` — no `classDef` support

`stateDiagram-v2` does not support `classDef` or `class` statements. Use `style StateId fill:...` for individual state styling instead.

---

## What the validator catches vs. what it doesn't

`mmdc` (and therefore this validator) only catches **parse errors** — diagrams that fail to render at all. It does **not** catch:

- `classDef` rules that are defined but silently ignored (e.g., due to a stale node ID in a `class` statement after a rename)
- CSS class application issues that only surface in specific viewers (GitHub, VS Code plugin) with different Mermaid versions

### How Mermaid applies `classDef` styles

`classDef` styles are injected into a `<style>` block in the SVG output as CSS rules (e.g., `.singleton>*{fill:#e8f5e9!important}`), **not** as inline `fill=` attributes. This means:

- SVG `fill=` attribute counts will be low — that is expected and correct
- Styled nodes carry a CSS class (e.g., `class="node default singleton flowchart-label"`) that the browser resolves against the `<style>` block
- `grep` for fill hex values in SVG output will miss most nodes — use `grep class=` to verify class attachment instead

### Verifying `classDef`/`class` consistency

After editing a diagram, check that every class name in `class NodeA,NodeB classname` statements exists in a `classDef classname ...` definition, and that every node ID listed in `class` statements exists as a declared node. Stale IDs after a rename are silently ignored — the named nodes render unstyled with no parse error.
