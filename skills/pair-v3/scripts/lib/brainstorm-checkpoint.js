const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A brainstorming Agent Conversation Checkpoint is only ever refreshed when the model calls
// `pair-loop --brainstorm-checkpoint`; live data shows that call never happens, so sealed
// handovers carry an empty bootstrap. This module gives brainstorming the same mechanical
// treatment pair conversations already get from derivePairCheckpoint (handover-state.js): a
// best-effort deriver that merges on-disk Visual Companion state into the existing checkpoint.

const MAX_SESSION_EVENTS_BYTES = 2 * 1024 * 1024; // Guard: never parse a runaway session.jsonl.

// Exact text of handover-state.js's brainstormBootstrapCheckpoint().currentDirection, once it has
// passed through normalizeCheckpoint's safeText. Only ever replaced when the checkpoint still
// carries this literal placeholder — any model-authored direction is left untouched.
const BOOTSTRAP_CURRENT_DIRECTION =
  'Brainstorming in progress; the semantic Agent Conversation Checkpoint is pending an explicit refresh.';

// Same replace-only-the-placeholder contract for nextAction: the exact bootstrap literal is
// swapped for a concrete resume command so an adopting Agent Conversation can reattach to the
// Visual Companion state instead of guessing; any model-authored next action is left untouched.
const BOOTSTRAP_NEXT_ACTION =
  'Refresh the Agent Conversation Checkpoint with the confirmed Core Anchor at the next material boundary.';

// The following three helpers mirror skills/brainstorming/scripts/visual-session.cjs's
// scratchRoot() / activeKey() / defaultActiveFile() (lines ~70-84) byte-for-byte. They are
// duplicated rather than required from the brainstorming skill on purpose: pair-v3 and
// brainstorming are packaged and versioned independently, and pair-v3 must not take a hard
// dependency on brainstorming's internal module layout.
function scratchRoot() {
  return path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
}

function activeSessionPointerFile(root) {
  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  const key = `${path.basename(root)}-${digest}`;
  return path.join(scratchRoot(), key, 'brainstorm', 'active-session.json');
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pointedSessionLocation(root) {
  let pointer;
  try {
    pointer = readJsonFile(activeSessionPointerFile(root));
  } catch {
    return null;
  }
  const sessionDir = String(pointer.session_dir || '');
  if (!sessionDir) return null;
  return {
    // visual-session.cjs itself falls back to the directory basename when session_id is absent
    // from metadata (visualHtmlFile, ~line 325); the same convention applies here.
    sessionId: String(pointer.session_id || '') || path.basename(sessionDir),
    sessionDir,
    // Persistent sessions (visual-session start --project-dir) already resolve session_dir to
    // <root>/.brainstorm/<sessionId>; scratch sessions resolve it under scratchRoot(). Both are
    // handled uniformly here because the pointer's own content_dir/state_dir (or the session_dir
    // fallback) are trusted directly rather than re-derived.
    contentDir: pointer.content_dir || path.join(sessionDir, 'content'),
    stateDir: pointer.state_dir || path.join(sessionDir, 'state'),
  };
}

// visual-session.cjs removes active-session.json whenever the companion stops, and sealing only
// runs after the Agent Conversation has gone cold — usually long after the companion stopped.
// Without this fallback the deriver would seal the bootstrap husk while the session's content
// still sits on disk. Scan both places visual-session.cjs creates session directories (scratch:
// beside the pointer file; persistent: <root>/.brainstorm) and trust the newest workspace.json,
// matching the skill's single-live-visual-session-per-repo invariant.
function newestSessionLocation(root) {
  const sessionRoots = [path.dirname(activeSessionPointerFile(root)), path.join(root, '.brainstorm')];
  let newest = null;
  for (const sessionsRoot of sessionRoots) {
    let entries;
    try {
      entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(sessionsRoot, entry.name);
      let modifiedMs;
      try {
        modifiedMs = fs.statSync(path.join(sessionDir, 'content', 'workspace.json')).mtimeMs;
      } catch {
        continue;
      }
      if (newest && newest.modifiedMs >= modifiedMs) continue;
      newest = {
        modifiedMs,
        location: {
          sessionId: entry.name,
          sessionDir,
          contentDir: path.join(sessionDir, 'content'),
          stateDir: path.join(sessionDir, 'state'),
        },
      };
    }
  }
  return newest ? newest.location : null;
}

// Forgiving read of session.jsonl: a single unparsable line (e.g. a truncated crash-time
// append) must not sink the rest of the session's history, mirroring
// skills/brainstorming/scripts/session-store.cjs's SessionStore._readEvents.
function readSessionEvents(stateDir) {
  const file = path.join(stateDir, 'session.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_SESSION_EVENTS_BYTES) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip the unparsable line; see the function comment above.
    }
  }
  return events;
}

// Latest recorded choice per groupId (session-store.cjs's user.turn.choices[].groupId), keeping
// only the most recent occurrence across the whole event history. Only choice.label/choice.value
// and decision.title are ever read here — user.turn.message and annotations[].comment are
// transcript-adjacent content and are never copied into handover state (AC-10).
function latestChoicesByGroup(events) {
  const latest = new Map();
  for (const event of events) {
    if (event?.type !== 'user.turn' || !Array.isArray(event.choices)) continue;
    for (const choice of event.choices) {
      const groupId = typeof choice?.groupId === 'string' ? choice.groupId : '';
      if (!groupId) continue;
      latest.set(groupId, choice);
    }
  }
  return latest;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// existing entries first, so a repeated derive against unchanged on-disk state dedupes back to
// the same list via normalizeCheckpoint's safeList (exact-string Set dedupe) instead of growing.
function mergeStringLists(existingList, derivedList) {
  return [...(Array.isArray(existingList) ? existingList : []), ...derivedList];
}

// Dedupe by path: the two derived artifacts (.pair/spec.md, the session's visual.json) always
// win with a freshly computed digest; any other existing artifact is preserved verbatim.
function mergeArtifacts(existingArtifacts, derivedArtifacts) {
  const derivedPaths = new Set(derivedArtifacts.map(artifact => artifact.path));
  const kept = (Array.isArray(existingArtifacts) ? existingArtifacts : [])
    .filter(artifact => !derivedPaths.has(artifact?.path));
  return [...kept, ...derivedArtifacts];
}

/**
 * Best-effort brainstorming Agent Conversation Checkpoint deriver. Merges on-disk Visual
 * Companion state (the session's workspace.json decisions and session.jsonl choices) into
 * `existingCheckpoint`, preserving every model-authored field verbatim. Never throws: any
 * missing, corrupt, or oversized on-disk state simply returns `existingCheckpoint` unchanged.
 * Discovery is pointer-first — a live active-session pointer is authoritative — with the newest
 * on-disk session directory as fallback for the common seal-time case where the companion has
 * already stopped and removed the pointer.
 *
 * KNOWN CAVEAT: discovery below is repo-scoped (both the active-session pointer and the fallback
 * scan roots are keyed only by the repo root — see activeSessionPointerFile and
 * newestSessionLocation), reflecting the brainstorming skill's own
 * single-live-visual-session-per-repo invariant. If two brainstorming Agent Conversations were
 * ever live against the same repo at once, both would resolve to the same on-disk visual state
 * and merge it into their checkpoints; nothing on disk today can disambiguate which conversation
 * actually owns that session.
 */
function deriveBrainstormingCheckpoint(root, existingCheckpoint) {
  try {
    const existing = existingCheckpoint && typeof existingCheckpoint === 'object' ? existingCheckpoint : {};

    const location = pointedSessionLocation(root) || newestSessionLocation(root);
    if (!location) return existingCheckpoint;
    const { contentDir, stateDir, sessionId } = location;

    // `content/workspace.json` is always "the currently active document" (workspace-tabs.cjs's own
    // header comment, and visual-session.cjs's writeDocumentIntoLiveSession, confirmed as of the
    // Workspace Tabs addition): tabs are a pure additive persistence mechanism filed alongside it
    // under tab-<id>.json and never redirect or reshape this file, so no tab-aggregation is needed
    // here — a Decision's option_component_ids only has meaning within its own document's frames
    // anyway. Still, schema drift is tolerated defensively: an unrecognized version or a missing
    // decisions[] array (workspace-document.cjs's normalizeWorkspaceDocument always emits both on a
    // valid v2 document) simply returns existingCheckpoint unchanged rather than guessing.
    const workspace = readJsonFile(path.join(contentDir, 'workspace.json'));
    if (!workspace || typeof workspace !== 'object' || workspace.version !== 2 || !Array.isArray(workspace.decisions)) {
      return existingCheckpoint;
    }

    const latestChoices = latestChoicesByGroup(readSessionEvents(stateDir));

    const derivedConfirmedChoices = [];
    const derivedUnresolvedDecisions = [];
    for (const decision of workspace.decisions) {
      const decisionId = String(decision?.id || '');
      const title = (typeof decision?.title === 'string' && decision.title) ? decision.title : decisionId;
      const choice = latestChoices.get(decisionId);
      if (choice) {
        const label = (typeof choice.label === 'string' && choice.label) ? choice.label : String(choice.value || '');
        derivedConfirmedChoices.push(`${title}: ${label}`);
      } else {
        derivedUnresolvedDecisions.push(title);
      }
    }

    const derivedArtifacts = [];
    const specFile = path.join(root, '.pair', 'spec.md');
    if (isRegularFile(specFile)) derivedArtifacts.push({ path: '.pair/spec.md', sha256: sha256File(specFile) });
    if (sessionId) {
      const visualJsonRelativePath = `.artifacts/brainstorm/${sessionId}/visual.json`;
      const visualJsonFile = path.join(root, visualJsonRelativePath);
      if (isRegularFile(visualJsonFile)) {
        derivedArtifacts.push({ path: visualJsonRelativePath, sha256: sha256File(visualJsonFile) });
      }
    }

    const currentDirection = existing.current_direction === BOOTSTRAP_CURRENT_DIRECTION
      ? `Brainstorming '${workspace.title || ''}' at revision ${workspace.revision || ''}.`
      : existing.current_direction;

    const nextAction = existing.next_action === BOOTSTRAP_NEXT_ACTION
      ? `Reattach to the prior Visual Companion state with visual-session.cjs resume --session-dir ${location.sessionDir}, then refresh this Agent Conversation Checkpoint.`
      : existing.next_action;

    // Lazily required (at call time, not module load time) to break the circular dependency:
    // handover-state.js requires this module at the top of its file, so a top-level require here
    // would capture handover-state's exports before its `module.exports = {...}` assignment runs
    // and would leave normalizeCheckpoint permanently undefined.
    const { normalizeCheckpoint } = require('./handover-state');
    return normalizeCheckpoint({
      core_anchor: existing.core_anchor,
      findings: existing.findings,
      confirmed_choices: mergeStringLists(existing.confirmed_choices, derivedConfirmedChoices),
      rejected_alternatives: existing.rejected_alternatives,
      current_direction: currentDirection,
      unresolved_decisions: mergeStringLists(existing.unresolved_decisions, derivedUnresolvedDecisions),
      next_action: nextAction,
      artifacts: mergeArtifacts(existing.artifacts, derivedArtifacts),
    });
  } catch {
    return existingCheckpoint;
  }
}

module.exports = { deriveBrainstormingCheckpoint };
