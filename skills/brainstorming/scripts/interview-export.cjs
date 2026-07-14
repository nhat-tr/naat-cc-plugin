'use strict';

// Agent-readable sidecars written next to every exported visual.html. A coding agent
// revisiting a brainstorming session re-reads these instead of parsing the self-contained
// HTML bundle (which inlines the ~600 KB shell script + styles): `<base>.json` carries the
// lossless document plus the full interview history, and `<base>.interview.md` is a compact,
// skimmable transcript of the interview turns, annotations, decisions, and agent replies.

const path = require('node:path');

const { exportSession } = require('./standalone.cjs');

const INTERVIEW_SCHEMA = 'brainstorm-interview/v1';

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function documentIdentity(screen) {
  const doc = screen && typeof screen === 'object' && !Array.isArray(screen) ? screen : {};
  return {
    workspace_kind: textOrNull(doc.workspace_kind) ?? textOrNull(doc.profile),
    title: textOrNull(doc.title),
    revision: textOrNull(doc.revision),
  };
}

// The lossless structured record: everything the HTML embeds, as plain JSON. `document` is
// the active Visual Document; `history` is the allowlisted, ordered interview (same shape the
// standalone HTML embeds), so re-reading never has to touch the shell bundle.
function buildInterviewDigest(screen, session) {
  const identity = documentIdentity(screen);
  return {
    schema: INTERVIEW_SCHEMA,
    workspace_kind: identity.workspace_kind,
    title: identity.title,
    revision: identity.revision,
    document: screen == null ? null : structuredClone(screen),
    history: exportSession(session),
  };
}

function annotationLine(annotation) {
  const target = annotation.target && typeof annotation.target === 'object' ? annotation.target : {};
  const reference = textOrNull(target.componentId) ?? textOrNull(target.selector) ?? 'component';
  const label = textOrNull(target.label) ? ` (${target.label})` : '';
  const comment = textOrNull(annotation.comment) ?? '';
  return `- \`${reference}\`${label}: ${comment}`.trimEnd();
}

function choiceLine(choice) {
  const where = textOrNull(choice.groupId) ?? textOrNull(choice.componentId) ?? 'decision';
  const pick = textOrNull(choice.label) ?? textOrNull(choice.value) ?? '(cleared)';
  return `- ${where} → ${pick}`;
}

function renderTurn(event, lines) {
  lines.push(`### Turn ${event.seq} · reviewer`, '');
  lines.push(textOrNull(event.message) ?? '_(no chat note)_', '');
  const annotations = Array.isArray(event.annotations) ? event.annotations : [];
  if (annotations.length > 0) {
    lines.push('**Annotations**', '');
    for (const annotation of annotations) lines.push(annotationLine(annotation));
    lines.push('');
  }
  const choices = Array.isArray(event.choices) ? event.choices : [];
  if (choices.length > 0) {
    lines.push('**Decisions**', '');
    for (const choice of choices) lines.push(choiceLine(choice));
    lines.push('');
  }
}

function renderReply(event, lines) {
  const to = Number.isInteger(event.replyTo) ? ` → turn ${event.replyTo}` : '';
  lines.push(`### Reply${to} · agent`, '');
  lines.push(textOrNull(event.message) ?? '_(empty reply)_', '');
}

// A skimmable transcript. `links` optionally cross-references the sibling files by basename so
// the agent knows where the lossless data and the rendered visual live.
function renderInterviewMarkdown(screen, session, links = {}) {
  const digest = buildInterviewDigest(screen, session);
  const events = Array.isArray(digest.history.events) ? digest.history.events : [];
  const turnCount = events.filter(event => event.type === 'user.turn').length;

  const lines = [];
  lines.push(`# ${digest.title ?? 'Brainstorming session'} — interview`, '');
  lines.push(`- **Workspace kind:** ${digest.workspace_kind ?? 'unknown'}`);
  if (digest.revision) lines.push(`- **Revision:** ${digest.revision}`);
  lines.push(`- **Reviewer turns:** ${turnCount}`);
  if (textOrNull(links.jsonName)) lines.push(`- **Full document + structured history:** ${links.jsonName}`);
  if (textOrNull(links.htmlName)) lines.push(`- **Rendered visual:** ${links.htmlName}`);
  lines.push('');
  lines.push(
    '> Re-read this transcript instead of the HTML bundle. The `.json` sidecar holds the '
    + 'full Visual Document and the machine-readable interview history.',
    '',
  );
  lines.push('## Interview', '');
  if (events.length === 0) {
    lines.push('_No interview turns were recorded._', '');
  }
  for (const event of events) {
    if (event.type === 'user.turn') renderTurn(event, lines);
    else if (event.type === 'agent.message') renderReply(event, lines);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// Sibling paths for an exported HTML file: visual.html -> visual.json + visual.interview.md.
function interviewSidecarPaths(htmlPath) {
  const directory = path.dirname(htmlPath);
  const base = path.basename(htmlPath).replace(/\.html?$/iu, '');
  return {
    json: path.join(directory, `${base}.json`),
    markdown: path.join(directory, `${base}.interview.md`),
  };
}

// Write both sidecars beside an already-written HTML export. `write` is the caller's atomic
// writer so the sidecars inherit the same atomicity and 0o600 permissions as the HTML.
function writeInterviewSidecars(htmlPath, screen, session, write) {
  const paths = interviewSidecarPaths(htmlPath);
  const digest = buildInterviewDigest(screen, session);
  const links = { jsonName: path.basename(paths.json), htmlName: path.basename(htmlPath) };
  write(paths.json, `${JSON.stringify(digest, null, 2)}\n`);
  write(paths.markdown, renderInterviewMarkdown(screen, session, links));
  return paths;
}

module.exports = {
  INTERVIEW_SCHEMA,
  buildInterviewDigest,
  interviewSidecarPaths,
  renderInterviewMarkdown,
  writeInterviewSidecars,
};
