#!/usr/bin/env node
// format-range — CSharpier, restricted to the lines this session actually changed.
//
//   node format-range.mjs <file.cs> [config-path]
//
// CSharpier formats whole files and has no range mode, so a one-line edit to a repo that wraps by hand comes
// back as a whole-file rewrite. Observed live in ParagonAgent: a 12-line change to a shared test fixture
// arrived as ~40 hunks of reformatting, and the Pair checkpoint built on it could not be reviewed — the
// reviewer's entire finding budget would have gone on whitespace.
//
// So the file is formatted in full, and then only the hunks overlapping the session's own changed lines are
// kept. Every other line keeps the exact bytes it was committed with. Same idea as `git clang-format`.
//
// The baseline is the committed version, not a snapshot taken before this one edit: over a session of many
// edits that converges on "format the lines this Work changed, and nothing else", and it needs no state to
// survive between hook invocations. A file with no committed version is all new lines, so all of it is in
// range. Diffs come from `git diff --no-index` rather than a hand-rolled one — git is already a hard
// dependency here, and its hunk arithmetic is not worth reimplementing.
//
// Silent on every failure: a formatter is never allowed to fail an edit.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [file, configPath] = process.argv.slice(2);
if (!file) process.exit(0);

function scratchDirectory() {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const directory = path.join(scratch, 'my-claude-code', 'format-range');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function git(args, options = {}) {
  const result = childProcess.spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) return null;
  return result;
}

// Ranges of NEW-side lines each hunk introduces, as [start, endInclusive]. A pure deletion reports length 0
// at the line it collapsed onto; that boundary line is where the edit landed, so it counts as touched.
function changedRanges(diff) {
  const ranges = [];
  for (const line of diff.split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push(length === 0 ? [start, start + 1] : [start, start + length - 1]);
  }
  return ranges;
}

// Hunks of `current` -> `formatted`, keyed by the OLD side, which is a line range in `current`.
function formattingHunks(diff) {
  const hunks = [];
  let open = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u);
    if (header) {
      if (open) hunks.push(open);
      const start = Number(header[1]);
      const length = header[2] === undefined ? 1 : Number(header[2]);
      open = { start, length, replacement: [] };
      continue;
    }
    if (!open) continue;
    if (line.startsWith('+')) open.replacement.push(line.slice(1));
    else if (!line.startsWith('-') && !line.startsWith('\\')) { hunks.push(open); open = null; }
  }
  if (open) hunks.push(open);
  return hunks;
}

function overlaps(hunk, ranges) {
  // A zero-length hunk is an insertion after `start`, so it belongs to the boundary it sits on.
  const from = hunk.length === 0 ? hunk.start : hunk.start;
  const to = hunk.length === 0 ? hunk.start + 1 : hunk.start + hunk.length - 1;
  return ranges.some(([low, high]) => from <= high && low <= to);
}

function applyHunks(currentLines, hunks) {
  const output = [];
  let cursor = 0; // 0-based index into currentLines
  for (const hunk of [...hunks].sort((left, right) => left.start - right.start)) {
    const from = hunk.length === 0 ? hunk.start : hunk.start - 1;
    if (from < cursor) continue; // overlapping hunks cannot both apply; the earlier one already did
    output.push(...currentLines.slice(cursor, from));
    output.push(...hunk.replacement);
    cursor = from + hunk.length;
  }
  output.push(...currentLines.slice(cursor));
  return output;
}

function unifiedDiff(left, right) {
  const result = git(['diff', '--no-index', '--no-color', '-U0', '--', left, right]);
  // Exit 1 means "files differ", which is the whole point; anything above that is a real failure.
  if (!result || result.status > 1) return null;
  return result.stdout;
}

function writeTemp(directory, name, body) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, body);
  return target;
}

let current;
try { current = fs.readFileSync(file, 'utf8'); } catch { process.exit(0); }

const repository = git(['rev-parse', '--show-toplevel'], { cwd: path.dirname(file) });
const root = repository && repository.status === 0 ? repository.stdout.trim() : null;

const formatArgs = ['format', '--write-stdout', '--stdin-path', file];
if (configPath && fs.existsSync(configPath)) formatArgs.push('--config-path', configPath);
const formatting = childProcess.spawnSync('csharpier', formatArgs, {
  input: current,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
// A formatter that is missing, errored, or produced nothing leaves the file exactly as the session wrote it.
if (formatting.error || formatting.status !== 0 || !formatting.stdout) process.exit(0);
const formatted = formatting.stdout;
if (formatted === current) process.exit(0);

// No repository, or no committed version: there is no baseline to be narrower than, so the file is all new.
let committed = null;
if (root) {
  const show = git(['show', `HEAD:${path.relative(root, file)}`], { cwd: root });
  if (show && show.status === 0) committed = show.stdout;
}
if (committed === null) {
  fs.writeFileSync(file, formatted);
  process.exit(0);
}

const directory = scratchDirectory();
const stamp = `${process.pid}-${path.basename(file)}`;
const baselinePath = writeTemp(directory, `${stamp}.baseline`, committed);
const currentPath = writeTemp(directory, `${stamp}.current`, current);
const formattedPath = writeTemp(directory, `${stamp}.formatted`, formatted);

try {
  const editDiff = unifiedDiff(baselinePath, currentPath);
  const formatDiff = unifiedDiff(currentPath, formattedPath);
  if (editDiff === null || formatDiff === null) process.exit(0);

  const ranges = changedRanges(editDiff);
  if (ranges.length === 0) process.exit(0); // the session changed nothing; formatting would be pure noise

  const kept = formattingHunks(formatDiff).filter(hunk => overlaps(hunk, ranges));
  if (kept.length === 0) process.exit(0);

  // Split on \n and rejoin, so a file's final-newline state is whatever `current` already had.
  const trailing = current.endsWith('\n');
  const lines = current.slice(0, trailing ? -1 : undefined).split('\n');
  const result = applyHunks(lines, kept).join('\n') + (trailing ? '\n' : '');
  if (result !== current) fs.writeFileSync(file, result);
} finally {
  for (const temporary of [baselinePath, currentPath, formattedPath]) fs.rmSync(temporary, { force: true });
}
