# DR-001: Visible tmux runtime host

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260719-pair-loop-observable-control`
- **Origin Spec:** `docs/work/work-20260719-pair-loop-observable-control/spec.md`
- **Acceptance Criteria:** AC-4, AC-5, AC-9, AC-13, AC-14
- **Supersedes:** none
- **Superseded By:** none

## Context

The canonical specification selects a visible coordinator but does not define the process host or the visible independent-review boundary. Current Neovim Pair control uses terminal jobs and cancellation stops those jobs, while the repository reconnaissance found tmux 3.7b with navigator, resurrect, and continuum already installed. The user explicitly rejected any headless implementation path for this Work and needs plan and implementation review to remain inspectable without turning process persistence into a custom daemon.

## Decision

Use tmux as the durable process host and Neovim as its editing and control surface.

- Keep exactly three persistent panes: Neovim, the visible coordinator/main agent session, and one reusable independent Review Session.
- The visible coordinator owns the main agent session, Work continuation, ordinary tests-first implementation, and integration of all repository changes.
- The Review Session is a separate read-only identity. Plan review, implementation review, and cumulative review reuse the same reviewer pane and bind every verdict to the exact plan or complete-patch digest supplied by the coordinator.
- Pair exposes a stable status/control boundary and exact-digest plan-approval command. In the separate dotfiles Work, Neovim `<leader>pa` previews `plan-reviews/summary.md`, prompts for the approval reason, and invokes that exact-digest command.
- This Work has no headless implementation path. Future explicit parallel workers are a separate extension and may not inherit coordinator continuation ownership.
- Status and history open as a Neovim scratch view or tmux popup instead of consuming another persistent pane.

## Rationale

tmux preserves the agent and reviewer processes independently of Neovim terminal-job lifetime while keeping all work visible and steerable. Three panes make ownership legible without building a daemon or multiplying idle agents. A separate reviewer identity preserves independent review while the visible coordinator removes the opacity that caused the redesign.

## Alternatives Rejected

- **Neovim terminal jobs only (6/10):** simple, but closing or stopping the editor job loses the process and turns pause into restart.
- **Custom session daemon (4/10):** durable, but duplicates process-hosting, pane, and recovery behavior already provided by tmux.
- **Observable headless implementation (7/10):** improves logs but still hides the implementation interaction the user needs to inspect.
- **Per-slice headless opt-in now (3/10):** reintroduces execution ambiguity before the visible baseline is proven.

## Consequences

- Pair setup and status must detect or create the three-pane tmux layout idempotently and must not duplicate panes on resume.
- This repository owns the stable Pair status/control commands and tmux-host contract. The external dotfiles repository owns the Neovim mappings and presentation and therefore requires a separate Work; this plan cannot safely write across repository boundaries.
- Neovim commands in that separate Work control tmux-hosted sessions instead of owning their lifetime through `termopen`.
- Reviewer output remains visible, bounded, read-only, and digest-bound; reviewers cannot continue, pause, take over, or write implementation files.
- Legacy CLI flags remain compatibility aliases, but bare `pair-loop` and the visible coordinator are the canonical path.
- Any future worktree implementation must return an immutable patch or commit digest to the coordinator for central integration and cumulative gates.

## Evidence

- Approved Architecture Canvas Revision: `57462d46`
- Current Neovim Pair control: terminal jobs use `termopen` and cancellation uses `jobstop`
- Current Neovim Pair mappings live in `<dotfiles-repo>/home/config/nvim/lua/nhat/pair.lua` and `<dotfiles-repo>/home/config/nvim/lua/nhat/core/keymaps.lua`; `<leader>pa` is currently unassigned
- Installed host: tmux 3.7b with navigator, resurrect, and continuum
- Current reviewers: non-interactive subprocesses with byte heartbeats rather than a steerable Review Session
- Canonical decisions: `docs/work/work-20260719-pair-loop-observable-control/spec.md#d-3-visible-coordinator-by-default`

## Implementation

- Base: not started
- Changes: not started

## Outcomes

None yet.

## Learning

Visibility and process durability are separate concerns: Neovim is the control surface, tmux is the process host, and repository state remains the recovery authority.
